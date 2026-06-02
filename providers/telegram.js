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
  async sendMessage(chatId, text, options = {}) {
    if (!this.bot) {
      throw new Error('Telegram Bot is not initialized.');
    }

    try {
      // Try sending with Markdown formatting
      await this.bot.telegram.sendMessage(chatId, text, {
        parse_mode: 'Markdown',
        ...options
      });
    } catch (err) {
      console.warn('Markdown sending failed, falling back to plain text. Error:', err.message);
      try {
        // Fallback to sending as unformatted plain text
        await this.bot.telegram.sendMessage(chatId, text, options);
      } catch (err2) {
        console.error('Critical: Failed to send Telegram message:', err2);
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
