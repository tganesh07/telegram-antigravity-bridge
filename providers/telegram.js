const { Telegraf } = require('telegraf');

class TelegramProvider {
  constructor() {
    this.bot = null;
    this.authorizedChatId = null;
    this.messageCallback = null;
  }

  /**
   * Initialize the Telegram Bot
   * @param {Object} config
   * @param {string} config.token
   * @param {string} config.authorizedChatId
   */
  async initialize(config) {
    if (!config.token) {
      throw new Error('Telegram Bot Token is required but missing from environment configuration.');
    }
    
    // Ensure chat ID is parsed as integer if it's numeric, or string
    this.authorizedChatId = String(config.authorizedChatId).trim();
    if (!this.authorizedChatId) {
      console.warn('WARNING: TELEGRAM_CHAT_ID is empty. Bot will be inaccessible to all users.');
    }

    this.bot = new Telegraf(config.token);

    // Setup basic command mapping or text router
    this.bot.on('text', async (ctx) => {
      const chatId = String(ctx.chat.id);
      const text = ctx.message.text;

      // Security: verify that the message is from the authorized user (checks numeric ID or @username)
      const username = ctx.message && ctx.message.from && ctx.message.from.username ? String(ctx.message.from.username) : '';
      const isAuthorized = !this.authorizedChatId || 
                           (chatId === this.authorizedChatId) || 
                           (username && username.toLowerCase() === this.authorizedChatId.replace('@', '').toLowerCase());

      if (!isAuthorized) {
        console.warn(`[Security] Unauthorized access attempt from Chat ID: ${chatId}, Username: @${username}`);
        await ctx.reply('⚠️ Unauthorized: Access is restricted to the owner of this Mac.');
        return;
      }

      if (this.messageCallback) {
        try {
          await this.messageCallback(chatId, text);
        } catch (err) {
          console.error('Error handling message callback:', err);
          await ctx.reply(`❌ Internal error processing command: ${err.message}`);
        }
      }
    });

    // Handle generic errors to prevent bot crash
    this.bot.catch((err, ctx) => {
      console.error(`Telegraf error for update ${ctx.update.update_id}:`, err);
    });

    // Start bot
    await this.bot.launch();
    console.log('🤖 Telegram Bot Provider successfully launched and listening.');
  }

  /**
   * Register listener for incoming authorized messages
   * @param {Function} callback - Async function (chatId, text) => Promise
   */
  onMessage(callback) {
    this.messageCallback = callback;
  }

  /**
   * Send message back to a chat
   * @param {string} chatId 
   * @param {string} text 
   * @param {Object} options 
   */
  /**
   * Send message back to a chat, with automatic chunking if the message exceeds Telegram length limits
   * @param {string} chatId 
   * @param {string} text 
   * @param {Object} options 
   */
  async sendMessage(chatId, text, options = {}) {
    if (!this.bot) {
      throw new Error('Telegram Bot is not initialized.');
    }

    const MAX_LENGTH = 4000; // Telegram limit is 4096
    
    if (text.length <= MAX_LENGTH) {
      return await this._sendSingleMessage(chatId, text, options);
    }

    console.log(`Message exceeds Telegram limit (${text.length} chars). Splitting into chunks...`);
    const chunks = [];
    let remaining = text;

    while (remaining.length > 0) {
      if (remaining.length <= MAX_LENGTH) {
        chunks.push(remaining);
        break;
      }

      // Find a clean newline to split on
      let cutIndex = remaining.lastIndexOf('\n', MAX_LENGTH);
      if (cutIndex === -1 || cutIndex < MAX_LENGTH * 0.7) {
        // Fallback: split by space
        cutIndex = remaining.lastIndexOf(' ', MAX_LENGTH);
      }
      if (cutIndex === -1 || cutIndex < MAX_LENGTH * 0.5) {
        // Hard cut if no spaces/newlines
        cutIndex = MAX_LENGTH;
      }

      chunks.push(remaining.substring(0, cutIndex));
      remaining = remaining.substring(cutIndex).trim();
    }

    let lastResult = null;
    for (let i = 0; i < chunks.length; i++) {
      const partPrefix = chunks.length > 1 ? `📝 _[Part ${i + 1}/${chunks.length}]_\n\n` : '';
      lastResult = await this._sendSingleMessage(chatId, partPrefix + chunks[i], options);
      // Wait slightly to ensure Telegram receives and displays them in order
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    return lastResult;
  }

  /**
   * Helper to deliver a single un-chunked message
   */
  async _sendSingleMessage(chatId, text, options = {}) {
    try {
      // Try sending with Markdown formatting
      return await this.bot.telegram.sendMessage(chatId, text, {
        parse_mode: 'Markdown',
        ...options
      });
    } catch (err) {
      console.warn('Markdown sending failed, falling back to plain text. Error:', err.message);
      try {
        // Fallback to sending as unformatted plain text
        return await this.bot.telegram.sendMessage(chatId, text, options);
      } catch (err2) {
        console.error('Critical: Failed to send Telegram message:', err2);
        throw err2;
      }
    }
  }

  /**
   * Delete a message
   * @param {string} chatId 
   * @param {number} messageId 
   */
  async deleteMessage(chatId, messageId) {
    if (!this.bot) return;
    try {
      await this.bot.telegram.deleteMessage(chatId, messageId);
    } catch (err) {
      // Ignore deletion errors
    }
  }

  /**
   * Stop the bot service gracefully
   */
  async stop() {
    if (this.bot) {
      await this.bot.stop();
    }
  }
}

module.exports = TelegramProvider;
