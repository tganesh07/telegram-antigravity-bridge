const fs = require('fs');
const path = require('path');
const { execFile, exec } = require('child_process');
require('dotenv').config();

const AGENT_API = '/Applications/Antigravity.app/Contents/Resources/bin/language_server';
const CONVERSATIONS_DIR = '/Users/thulsz/.gemini/antigravity/conversations';
const BRAIN_DIR = '/Users/thulsz/.gemini/antigravity/brain';
const CONFIG_PATH = path.join(__dirname, 'config.json');
const NAMES_PATH = path.join(__dirname, 'names.json');

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

// Ensure persistent custom conversation names mapping
let conversationNames = {};
if (fs.existsSync(NAMES_PATH)) {
  try {
    conversationNames = JSON.parse(fs.readFileSync(NAMES_PATH, 'utf8'));
  } catch (err) {
    console.error('Failed to parse names.json:', err.message);
  }
}

function saveNames() {
  fs.writeFileSync(NAMES_PATH, JSON.stringify(conversationNames, null, 2), 'utf8');
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
  if (conversationNames[conversationId]) {
    return conversationNames[conversationId];
  }
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

// Map tracking the paginated conversation listing state for deletion flows (chatId -> { offset })
const deleteUserState = new Map();

/**
 * Get all conversation IDs
 * @returns {string[]}
 */
function getAllConversationIds() {
  if (!fs.existsSync(CONVERSATIONS_DIR)) {
    return [];
  }
  return fs.readdirSync(CONVERSATIONS_DIR)
    .filter(f => f.endsWith('.db'))
    .map(f => f.replace('.db', ''));
}

/**
 * Resolves a conversation ID prefix/suffix/full ID
 * @param {string} input 
 * @returns {Object} { status: 'found'|'ambiguous'|'not_found', id?: string, matches?: string[] }
 */
function resolveConversationId(input) {
  if (!input) return { status: 'not_found' };
  const ids = getAllConversationIds();
  
  if (ids.includes(input)) {
    return { status: 'found', id: input };
  }

  const matches = ids.filter(id => id.endsWith(input));

  if (matches.length === 1) {
    return { status: 'found', id: matches[0] };
  }
  if (matches.length > 1) {
    return { status: 'ambiguous', matches };
  }
  
  return { status: 'not_found' };
}

/**
 * Delete all conversation database and workspace folder files for an ID
 * @param {string} conversationId 
 * @returns {boolean} true if deletion completed
 */
function deleteConversationFiles(conversationId) {
  try {
    const dbPath = path.join(CONVERSATIONS_DIR, `${conversationId}.db`);
    const walPath = path.join(CONVERSATIONS_DIR, `${conversationId}.db-wal`);
    const shmPath = path.join(CONVERSATIONS_DIR, `${conversationId}.db-shm`);
    const pbPath = path.join(CONVERSATIONS_DIR, `${conversationId}.pb`);

    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    if (fs.existsSync(walPath)) fs.unlinkSync(walPath);
    if (fs.existsSync(shmPath)) fs.unlinkSync(shmPath);
    if (fs.existsSync(pbPath)) fs.unlinkSync(pbPath);

    const brainPath = path.join(BRAIN_DIR, conversationId);
    if (fs.existsSync(brainPath)) {
      fs.rmSync(brainPath, { recursive: true, force: true });
    }

    if (conversationNames[conversationId]) {
      delete conversationNames[conversationId];
      saveNames();
    }
    return true;
  } catch (err) {
    console.error(`Failed to delete conversation files for ${conversationId}:`, err.message);
    return false;
  }
}

/**
 * Send a paginated list of conversations starting from the given offset
 * @param {string} chatId 
 * @param {number} offset 
 */
async function sendPaginatedList(chatId, offset) {
  if (!fs.existsSync(CONVERSATIONS_DIR)) {
    await provider.sendMessage(chatId, `📁 No conversations directory found.`);
    return;
  }

  const files = fs.readdirSync(CONVERSATIONS_DIR)
    .filter(f => f.endsWith('.db'))
    .map(f => f.replace('.db', ''));

  if (files.length === 0) {
    await provider.sendMessage(chatId, `📁 No past conversations found.`);
    deleteUserState.delete(chatId);
    return;
  }

  // Sort files by last modified time (newest first)
  const sorted = files
    .map(id => {
      const dbPath = path.join(CONVERSATIONS_DIR, `${id}.db`);
      const mtime = fs.existsSync(dbPath) ? fs.statSync(dbPath).mtimeMs : 0;
      return { id, mtime };
    })
    .sort((a, b) => b.mtime - a.mtime)
    .map(c => c.id);

  if (offset >= sorted.length) {
    await provider.sendMessage(chatId, `📁 No more past conversations to display.`);
    deleteUserState.delete(chatId); // reset pagination state
    return;
  }

  const chunk = sorted.slice(offset, offset + 5);

  let responseText = `📁 *Past Conversations (showing ${offset + 1} - ${offset + chunk.length} of ${sorted.length}):*\n\n`;
  chunk.forEach((id, idx) => {
    const desc = getConversationDescription(id);
    responseText += `${offset + idx + 1}. 📝 *${desc}*\n   • ID: \`${id}\`\n\n`;
  });

  responseText += `👉 Use \`/resume <id>\` to resume, or \`/delete <id>\` to delete.\n`;
  if (offset + chunk.length < sorted.length) {
    responseText += `👉 Send \`/more\` to view the next 5 conversations.`;
  }

  await provider.sendMessage(chatId, responseText);
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
          `• \`/rename <new_name>\` - Rename the currently active conversation\n` +
          `• \`/delete [id]\` - Delete active conversation (or specified ID) & show last 5\n` +
          `• \`/more\` - View the next 5 conversations in the list\n` +
          `• \`/explain\` - View a clean summary of steps executed in the last turn\n` +
          `• \`/stop\` - Disconnect the active conversation\n\n` +
          `*Usage:*\n` +
          `Simply type any standard message (without a slash) to continue prompting your active conversation!`
        );
        break;

      case '/status':
        if (config.activeConversationId) {
          const desc = getConversationDescription(config.activeConversationId);
          await provider.sendMessage(chatId, 
            `🟢 *Bridge Status:* ACTIVE\n` +
            `• *Active Name:* *${desc}*\n` +
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
        } else {
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
        
        const resumeResolution = resolveConversationId(arg);
        if (resumeResolution.status === 'ambiguous') {
          await provider.sendMessage(chatId, `⚠️ Ambiguous ID suffix "${arg}". Multiple matching conversations found:\n` + 
            resumeResolution.matches.map(m => `• \`${m}\` (${getConversationDescription(m)})`).join('\n'));
          return;
        } else if (resumeResolution.status === 'not_found') {
          await provider.sendMessage(chatId, `❌ No conversation found matching "${arg}".`);
          return;
        }

        const resumeId = resumeResolution.id;
        config.activeConversationId = resumeId;
        saveConfig();
        const resumeDesc = getConversationDescription(resumeId);
        await provider.sendMessage(chatId, `🔄 Resumed conversation *${resumeDesc}* (\`${resumeId}\`). Send a prompt to continue!`);
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

      case '/rename':
        if (!arg) {
          await provider.sendMessage(chatId, `❌ Please specify the new name. E.g., \`/rename My Awesome Project\` or \`/rename <id_or_suffix> My Awesome Project\``);
          return;
        }

        const renameParts = arg.split(' ');
        const firstWord = renameParts[0];
        const remainingName = renameParts.slice(1).join(' ').trim();

        let targetId = null;
        if (renameParts.length > 1) {
          const resolution = resolveConversationId(firstWord);
          if (resolution.status === 'ambiguous') {
            await provider.sendMessage(chatId, `⚠️ Ambiguous ID suffix "${firstWord}". Multiple matching conversations found:\n` + 
              resolution.matches.map(m => `• \`${m}\` (${getConversationDescription(m)})`).join('\n'));
            return;
          } else if (resolution.status === 'found') {
            targetId = resolution.id;
          }
        }

        if (!targetId) {
          // Fallback to active conversation
          if (!config.activeConversationId) {
            await provider.sendMessage(chatId, `⚠️ No active conversation. Start one using \`/new <your prompt>\` or specify a target ID/suffix, e.g., \`/rename <id_or_suffix> <new name>\`.`);
            return;
          }
          targetId = config.activeConversationId;
        }

        const nameToUse = targetId === config.activeConversationId && renameParts.length === 1 ? arg : remainingName;
        if (!nameToUse) {
          await provider.sendMessage(chatId, `❌ Please specify the new name.`);
          return;
        }

        conversationNames[targetId] = nameToUse;
        saveNames();
        await provider.sendMessage(chatId, `✅ Conversation successfully renamed to:\n*${nameToUse}* (ID: \`${targetId}\`)`);
        break;

      case '/delete':
        let idToDeleteInput = arg;
        let idToDelete = null;
        let isDeletingActive = false;

        if (!idToDeleteInput) {
          if (!config.activeConversationId) {
            await provider.sendMessage(chatId, `❌ No active conversation to delete. Please specify an ID. E.g., \`/delete <conversation_id>\``);
            return;
          }
          idToDelete = config.activeConversationId;
          isDeletingActive = true;
        } else {
          const deleteResolution = resolveConversationId(idToDeleteInput);
          if (deleteResolution.status === 'ambiguous') {
            await provider.sendMessage(chatId, `⚠️ Ambiguous ID suffix "${idToDeleteInput}". Multiple matching conversations found:\n` + 
              deleteResolution.matches.map(m => `• \`${m}\` (${getConversationDescription(m)})`).join('\n'));
            return;
          } else if (deleteResolution.status === 'not_found') {
            await provider.sendMessage(chatId, `❌ No conversation found matching "${idToDeleteInput}".`);
            return;
          }
          idToDelete = deleteResolution.id;
          isDeletingActive = (idToDelete === config.activeConversationId);
        }

        await provider.sendMessage(chatId, `🗑️ Deleting conversation \`${idToDelete}\`...`);
        const success = deleteConversationFiles(idToDelete);

        if (success) {
          if (isDeletingActive) {
            config.activeConversationId = null;
            saveConfig();
            await provider.sendMessage(chatId, `🗑️ Active conversation successfully deleted! The bot is now IDLE.`);
          } else {
            await provider.sendMessage(chatId, `🗑️ Conversation \`${idToDelete}\` successfully deleted!`);
          }
          
          // Reset deletion pagination list state and show the first 5
          deleteUserState.set(chatId, { offset: 5 });
          await sendPaginatedList(chatId, 0);
        } else {
          await provider.sendMessage(chatId, `❌ Failed to delete conversation \`${idToDelete}\`. Please check files or logs.`);
        }
        break;

      case '/more':
        const pageState = deleteUserState.get(chatId) || { offset: 0 };
        await sendPaginatedList(chatId, pageState.offset);
        // Increment offset by 5
        pageState.offset += 5;
        deleteUserState.set(chatId, pageState);
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
