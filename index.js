const fs = require('fs');
const path = require('path');
const { execFile, exec } = require('child_process');
require('dotenv').config();

const AGENT_API = '/Applications/Antigravity.app/Contents/Resources/bin/language_server';
const CONVERSATIONS_DIR = '/Users/thulsz/.gemini/antigravity/conversations';
const BRAIN_DIR = '/Users/thulsz/.gemini/antigravity/brain';
const CONFIG_PATH = path.join(__dirname, 'config.json');

// Ensure persistent config state
let config = {
  activeConversationId: null,
  model: 'flash'
};

if (fs.existsSync(CONFIG_PATH)) {
  try {
    config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (err) {
    console.error('Failed to parse config.json, resetting to default:', err.message);
  }
} else {
  saveConfig();
}

function saveConfig() {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
}

/**
 * Dynamically discover the active CSRF token and ports of the running language_server process
 * @returns {Promise<Object|null>} { csrfToken, ports } or null if not running
 */
function discoverActiveEnv() {
  return new Promise((resolve) => {
    exec('ps aux | grep language_server | grep -v grep', (err, stdout) => {
      if (err || !stdout) {
        return resolve(null);
      }
      
      const csrfMatch = stdout.match(/--csrf_token\s+([^\s]+)/);
      const csrfToken = csrfMatch ? csrfMatch[1] : null;
      
      const pidMatch = stdout.trim().match(/^[^\s]+\s+(\d+)/);
      const pid = pidMatch ? pidMatch[1] : null;
      
      if (!csrfToken || !pid) {
        return resolve(null);
      }
      
      exec(`lsof -a -p ${pid} -iTCP -sTCP:LISTEN -P -n`, (err2, stdout2) => {
        if (err2 || !stdout2) {
          return resolve(null);
        }
        
        const ports = [];
        const lines = stdout2.split('\n');
        for (const line of lines) {
          const m = line.match(/:(\d+)\s+\(LISTEN\)/);
          if (m) {
            ports.push(parseInt(m[1], 10));
          }
        }
        
        if (ports.length === 0) {
          return resolve(null);
        }
        
        // Sort descending to try HTTP/LSP (usually the higher port) first
        ports.sort((a, b) => b - a);
        
        resolve({
          csrfToken,
          ports
        });
      });
    });
  });
}

/**
 * Execute agentapi CLI safely using execFile on the language_server binary with dynamically discovered env
 * @param {string[]} args 
 * @returns {Promise<Object>} parsed JSON response
 */
async function runAgentCli(args) {
  const envInfo = await discoverActiveEnv();
  if (!envInfo) {
    throw new Error('Could not dynamically discover a running Antigravity instance. Please make sure the Antigravity desktop app is open.');
  }

  const fullArgs = ['agentapi', ...args];
  let lastError = null;

  for (const port of envInfo.ports) {
    try {
      const result = await new Promise((resolve, reject) => {
        const envVars = {
          ...process.env,
          HOME: process.env.HOME || '/Users/thulsz',
          ANTIGRAVITY_PROJECT_ID: process.env.ANTIGRAVITY_PROJECT_ID || 'outside-of-project',
          ANTIGRAVITY_LS_ADDRESS: `localhost:${port}`,
          ANTIGRAVITY_CSRF_TOKEN: envInfo.csrfToken
        };

        execFile(AGENT_API, fullArgs, { env: envVars, maxBuffer: 1024 * 1024 * 10 }, (error, stdout, stderr) => {
          if (error) {
            reject(new Error(stderr.trim() || error.message));
          } else {
            try {
              resolve(JSON.parse(stdout));
            } catch (err) {
              reject(new Error(`Failed to parse CLI output: ${stdout}`));
            }
          }
        });
      });
      return result; // Success!
    } catch (err) {
      lastError = err;
      console.warn(`[Connection Try] Port ${port} failed: ${err.message}. Trying next discovered port...`);
    }
  }

  throw lastError || new Error('All discovered connection ports failed.');
}

// Dynamically load messaging provider
const providerName = process.env.MESSAGING_PROVIDER || 'telegram';
let ProviderClass;
try {
  ProviderClass = require(`./providers/${providerName}`);
} catch (err) {
  console.error(`CRITICAL: Provider "${providerName}" could not be loaded:`, err.message);
  process.exit(1);
}

const provider = new ProviderClass();

// Map tracking active transcript monitors to prevent double-polling
const activePollers = new Map();
const processingMessages = new Map();

/**
 * Reads the transcript.jsonl and returns the parsed lines
 * @param {string} conversationId 
 * @returns {Object[]}
 */
function getTranscriptLines(conversationId) {
  const transcriptPath = path.join(BRAIN_DIR, conversationId, '.system_generated', 'logs', 'transcript.jsonl');
  if (!fs.existsSync(transcriptPath)) {
    return [];
  }
  try {
    const content = fs.readFileSync(transcriptPath, 'utf8');
    return content
      .split('\n')
      .filter(line => line.trim())
      .map(line => JSON.parse(line));
  } catch (err) {
    console.error('Error reading transcript file:', err.message);
    return [];
  }
}

/**
 * Dynamically extract a short user-friendly description of the conversation from step index 0
 * @param {string} conversationId 
 * @returns {string}
 */
function getConversationDescription(conversationId) {
  const transcriptPath = path.join(BRAIN_DIR, conversationId, '.system_generated', 'logs', 'transcript.jsonl');
  if (!fs.existsSync(transcriptPath)) {
    return 'Untitled Conversation';
  }
  try {
    const fileContent = fs.readFileSync(transcriptPath, 'utf8');
    const firstLine = fileContent.split('\n').find(line => line.trim());
    if (!firstLine) return 'Untitled Conversation';
    
    const step = JSON.parse(firstLine);
    if (step.step_index === 0 && step.content) {
      // Clean tags like <USER_REQUEST>
      let cleanText = step.content
        .replace(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/gi, '$1')
        .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gi, '')
        .trim();
      
      // Get the first line of the prompt
      cleanText = cleanText.split('\n')[0].trim();
      if (cleanText.length > 55) {
        cleanText = cleanText.substring(0, 52) + '...';
      }
      return cleanText || 'Untitled Conversation';
    }
  } catch (err) {
    // Fail silently, return fallback
  }
  return 'Untitled Conversation';
}

/**
 * Watches the conversation transcript in real-time and updates the user
 */
function monitorTranscript(chatId, conversationId, lastStepIndex) {
  // If there's already a poller running for this chat/conversation, stop it
  if (activePollers.has(chatId)) {
    clearInterval(activePollers.get(chatId));
  }

  let lastReportedStepIndex = lastStepIndex;

  const pollInterval = setInterval(async () => {
    const lines = getTranscriptLines(conversationId);
    if (lines.length === 0) return;

    // Find new steps
    const newLines = lines.filter(line => line.step_index > lastReportedStepIndex);
    if (newLines.length === 0) return;

    // Process each new line in order
    for (const step of newLines) {
      lastReportedStepIndex = step.step_index;

      // Check ONLY for the final response (MODEL PLANNER_RESPONSE with no tool calls)
      if (step.source === 'MODEL' && step.type === 'PLANNER_RESPONSE' && (!step.tool_calls || step.tool_calls.length === 0)) {
        clearInterval(pollInterval);
        activePollers.delete(chatId);

        // Delete the loading "⚡ Antigravity is working..." message
        const procMsg = processingMessages.get(chatId);
        if (procMsg && procMsg.message_id) {
          await provider.deleteMessage(chatId, procMsg.message_id);
          processingMessages.delete(chatId);
        }

        let finalResponse = step.content || '';
        
        // Clean and format response
        try {
          if (finalResponse.trim()) {
            // Send response back
            await provider.sendMessage(chatId, `🤖 *Antigravity response:*\n\n${finalResponse}`);
          } else {
            await provider.sendMessage(chatId, '🤖 Antigravity completed its turn but returned an empty response.');
          }
        } catch (err) {
          console.error('Failed to deliver final message:', err.message);
          try {
            await provider.sendMessage(chatId, `❌ Failed to deliver final response: ${err.message}`);
          } catch (err2) {
            console.error('Failed to deliver error message:', err2.message);
          }
        }
        return;
      }
    }
  }, 2000);

  activePollers.set(chatId, pollInterval);
}

// Setup incoming message handler
provider.onMessage(async (chatId, text) => {
  const trimmed = text.trim();

  // Route Commands
  if (trimmed.startsWith('/')) {
    const parts = trimmed.split(' ');
    const command = parts[0].toLowerCase();
    const arg = parts.slice(1).join(' ').trim();

    switch (command) {
      case '/start':
      case '/help':
        await provider.sendMessage(chatId, 
          `🚀 *Welcome to the Anti-Gravity Bridge!* 🚀\n\n` +
          `Control your Mac's autonomous development agent from anywhere.\n\n` +
          `*Commands:*\n` +
          `• \`/new <prompt>\` - Create a new project / conversation\n` +
          `• \`/model <tier>\` - Set model for next run (\`pro\`, \`flash\`, \`flash_lite\`)\n` +
          `• \`/performance <tier>\` - Same as \`/model\`\n` +
          `• \`/status\` - Show active conversation and model configuration\n` +
          `• \`/list\` - List all local conversations\n` +
          `• \`/resume <id>\` - Resume a past conversation by ID\n` +
          `• \`/explain\` - View a clean summary of steps executed in the last turn\n` +
          `• \`/stop\` - Disconnect the active conversation\n\n` +
          `*Usage:*\n` +
          `Simply type any standard message (without a slash) to continue prompting your active conversation!`
        );
        break;

      case '/status':
        if (config.activeConversationId) {
          await provider.sendMessage(chatId, 
            `🟢 *Bridge Status:* ACTIVE\n` +
            `• *Active ID:* \`${config.activeConversationId}\`\n` +
            `• *Configured Model:* \`${config.model}\` (Performance tier)`
          );
        } else {
          await provider.sendMessage(chatId, 
            `⚪ *Bridge Status:* IDLE\n` +
            `• *Configured Model:* \`${config.model}\` (Performance tier)\n\n` +
            `Use \`/new <prompt>\` or \`/resume <id>\` to get started.`
          );
        }
        break;

      case '/model':
      case '/performance':
        const tier = arg.toLowerCase();
        if (['pro', 'flash', 'flash_lite'].includes(tier)) {
          config.model = tier;
          saveConfig();
          await provider.sendMessage(chatId, `✅ Model performance successfully set to: \`${tier}\` for future runs.`);
          await provider.sendMessage(chatId, `❌ Invalid tier. Choose from: \`pro\`, \`flash\`, \`flash_lite\`.`);
        }
        break;

      case '/new':
        if (!arg) {
          await provider.sendMessage(chatId, `❌ Please provide a prompt, e.g., \`/new Create a hello-world app\``);
          return;
        }

        const newMsgObj = await provider.sendMessage(chatId, `⚡ *Antigravity is starting your new project...*`);
        if (newMsgObj) {
          processingMessages.set(chatId, newMsgObj);
        }

        try {
          const cliResult = await runAgentCli(['new-conversation', `--model=${config.model}`, arg]);
          const newId = cliResult.response.newConversation.conversationId;
          
          config.activeConversationId = newId;
          saveConfig();

          // Monitor this brand-new conversation (starting index -1)
          monitorTranscript(chatId, newId, -1);
        } catch (err) {
          // Delete status message on error
          const procMsg = processingMessages.get(chatId);
          if (procMsg && procMsg.message_id) {
            await provider.deleteMessage(chatId, procMsg.message_id);
            processingMessages.delete(chatId);
          }
          await provider.sendMessage(chatId, `❌ Failed to create conversation: ${err.message}`);
        }
        break;

      case '/resume':
        if (!arg) {
          await provider.sendMessage(chatId, `❌ Please specify a conversation ID to resume.`);
          return;
        }
        
        // Basic folder existence check
        const targetDir = path.join(BRAIN_DIR, arg);
        if (!fs.existsSync(targetDir)) {
          await provider.sendMessage(chatId, `⚠️ Warning: Conversation folder for \`${arg}\` not found in \`${BRAIN_DIR}\`.`);
        }

        config.activeConversationId = arg;
        saveConfig();
        await provider.sendMessage(chatId, `🔄 Resumed conversation \`${arg}\`. Send a prompt to continue!`);
        break;

      case '/list':
        try {
          if (!fs.existsSync(CONVERSATIONS_DIR)) {
            await provider.sendMessage(chatId, `📁 No conversations directory found yet.`);
            return;
          }

          const files = fs.readdirSync(CONVERSATIONS_DIR)
            .filter(f => f.endsWith('.db'))
            .map(f => f.replace('.db', ''));

          if (files.length === 0) {
            await provider.sendMessage(chatId, `📁 No past conversations found.`);
            return;
          }

          let responseText = `📁 *Past Conversations (${files.length}):*\n\n`;
          files.slice(-10).forEach((id, idx) => {
            const desc = getConversationDescription(id);
            responseText += `${idx + 1}. 📝 *${desc}*\n   • ID: \`${id}\`\n\n`;
          });
          
          if (files.length > 10) {
            responseText += `_(Showing last 10 conversations)_`;
          }

          await provider.sendMessage(chatId, responseText);
        } catch (err) {
          await provider.sendMessage(chatId, `❌ Error listing conversations: ${err.message}`);
        }
        break;

      case '/explain':
        if (!config.activeConversationId) {
          await provider.sendMessage(chatId, `⚠️ No active conversation. Start one using \`/new <your prompt>\`.`);
          return;
        }
        
        try {
          const lines = getTranscriptLines(config.activeConversationId);
          if (lines.length === 0) {
            await provider.sendMessage(chatId, `ℹ️ No transcript logs found for the active conversation.`);
            return;
          }
          
          // Find the last user input or system message (which started the turn)
          let lastUserTurnIndex = -1;
          for (let i = lines.length - 1; i >= 0; i--) {
            if (lines[i].source === 'USER_EXPLICIT' || (lines[i].source === 'SYSTEM' && lines[i].type === 'SYSTEM_MESSAGE')) {
              lastUserTurnIndex = i;
              break;
            }
          }
          
          if (lastUserTurnIndex === -1) {
            await provider.sendMessage(chatId, `ℹ️ Could not find the start of the last turn in logs.`);
            return;
          }
          
          // Extract all model actions after the last user turn
          const actions = [];
          for (let i = lastUserTurnIndex + 1; i < lines.length; i++) {
            const step = lines[i];
            if (step.source === 'MODEL') {
              if (step.type === 'PLANNER_RESPONSE' && step.tool_calls) {
                for (const tc of step.tool_calls) {
                  let desc = '';
                  if (tc.name === 'run_command' && tc.args && tc.args.CommandLine) {
                    desc = `💻 Ran command: \`${tc.args.CommandLine}\``;
                  } else if (tc.name === 'write_to_file' && tc.args && tc.args.TargetFile) {
                    desc = `📝 Created file: \`${path.basename(tc.args.TargetFile)}\``;
                  } else if (tc.name === 'replace_file_content' && tc.args && tc.args.TargetFile) {
                    desc = `✍️ Modified file: \`${path.basename(tc.args.TargetFile)}\``;
                  } else if (tc.name === 'multi_replace_file_content' && tc.args && tc.args.TargetFile) {
                    desc = `✍️ Modified file: \`${path.basename(tc.args.TargetFile)}\``;
                  } else if (tc.name === 'view_file' && tc.args && tc.args.AbsolutePath) {
                    desc = `🔍 Analyzed file: \`${path.basename(tc.args.AbsolutePath)}\``;
                  } else if (tc.name === 'list_dir' && tc.args && tc.args.DirectoryPath) {
                    desc = `📁 Listed directory: \`${path.basename(tc.args.DirectoryPath)}\``;
                  } else {
                    desc = `⚙️ Executed tool: \`${tc.name}\``;
                  }
                  actions.push(desc);
                }
              }
            }
          }
          
          if (actions.length === 0) {
            await provider.sendMessage(chatId, `ℹ️ No intermediate steps were performed during the last turn.`);
            return;
          }
          
          // Remove duplicates to keep it extremely concise!
          const uniqueActions = [...new Set(actions)];
          
          let responseText = `🔍 *Steps performed during the last turn (${uniqueActions.length}):*\n\n`;
          responseText += uniqueActions.map((act, index) => `${index + 1}. ${act}`).join('\n');
          
          await provider.sendMessage(chatId, responseText);
        } catch (err) {
          await provider.sendMessage(chatId, `❌ Error compiling explanation: ${err.message}`);
        }
        break;

      case '/stop':
        config.activeConversationId = null;
        saveConfig();
        await provider.sendMessage(chatId, `⏹️ Active conversation disconnected. Bot is now IDLE.`);
        break;

      default:
        await provider.sendMessage(chatId, `❓ Unknown command. Send \`/help\` to see all commands.`);
    }
  } else {
    // Treat as regular prompt to active conversation
    if (!config.activeConversationId) {
      await provider.sendMessage(chatId, `⚠️ No active conversation. Start one using \`/new <your prompt>\` or resume using \`/resume <id>\`.`);
      return;
    }

    const conversationId = config.activeConversationId;
    
    // 1. Count current lines in transcript to get last index
    const lines = getTranscriptLines(conversationId);
    const lastStepIndex = lines.length > 0 ? Math.max(...lines.map(l => l.step_index)) : -1;

    const msgObj = await provider.sendMessage(chatId, `⚡ *Antigravity is working...*`);
    if (msgObj) {
      processingMessages.set(chatId, msgObj);
    }

    try {
      // 2. Deliver message via CLI
      await runAgentCli(['send-message', conversationId, trimmed]);

      // 3. Monitor for responses starting from current max step index
      monitorTranscript(chatId, conversationId, lastStepIndex);
    } catch (err) {
      // Delete status message on error
      const procMsg = processingMessages.get(chatId);
      if (procMsg && procMsg.message_id) {
        await provider.deleteMessage(chatId, procMsg.message_id);
        processingMessages.delete(chatId);
      }
      await provider.sendMessage(chatId, `❌ Error delivering prompt: ${err.message}`);
    }
  }
});

// Load parameters and startup
(async () => {
  try {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const authorizedChatId = process.env.TELEGRAM_CHAT_ID;

    if (providerName === 'telegram') {
      await provider.initialize({ token, authorizedChatId });
    } else {
      // Standard interface fallback
      await provider.initialize({});
    }

    console.log(`🚀 Bridge application fully running. Mode: [${providerName}]`);
  } catch (err) {
    console.error('Initialization error during startup:', err);
    process.exit(1);
  }
})();
