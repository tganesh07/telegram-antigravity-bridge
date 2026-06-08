# Telegram Anti-Gravity Bridge

A pluggable, lightweight bridge connecting Telegram and other messaging channels to the **Anti-Gravity CLI** on macOS. This bridge allows you to prompt, monitor, and control your Mac's autonomous AI software engineer remotely from any chat screen.

---

## ✨ Features

- **Autonomous Agent Control**: Prompt your Mac's Antigravity agent from your phone or any other device running Telegram.
- **Real-Time Progress Tracking**: The bridge polls the agent's internal `transcript.jsonl` files in real-time, displaying status updates and notifying you as soon as the agent completes its turn.
- **Secure Access Control**: Restricts access strictly to an authorized Chat ID or Telegram username, ensuring only you can issue commands or execute code on your Mac.
- **Automated Message Chunking**: Safely splits long responses (e.g. large file contents, code outputs) exceeding Telegram's message size limit (~4096 characters) so they are delivered sequentially without losing format.
- **Action Summaries (`/explain`)**: Analyzes the log transcript of the latest turn to list every single file modified, command executed, or tool called.
- **Persisted State**: Maintains conversation context and performance settings across server restarts in `config.json`.
- **Launchd Integration**: Includes a macOS installer script to configure the bridge as a background LaunchAgent daemon that launches at boot.

---

## 🏗️ Architecture

```
                    ┌────────────────────────┐
                    │      Telegram App      │
                    └───────────┬────────────┘
                                │ (HTTPS)
                                ▼
         ┌──────────────────────────────────────────────┐
         │ Telegram Anti-Gravity Bridge Daemon (Node.js)│
         └──────┬────────────────────────────────┬──────┘
                │ (IPC / CLI exec)               │ (File system poll)
                ▼                                ▼
┌───────────────────────────────┐      ┌───────────────────────────────┐
│       Antigravity CLI         │      │      Transcript Logs          │
│ (/language_server agentapi)   │      │ (~/.gemini/antigravity/brain) │
└───────────────────────────────┘      └───────────────────────────────┘
```

---

## 🚀 Getting Started

### Prerequisites
* macOS 10.15+ (Catalina or later)
* [Node.js](https://nodejs.org/) (v16+) and `npm` installed on your path.
* The **Antigravity Desktop Application** installed and active on your Mac.

### 1. Configuration
First, initialize your environment variables:
1. Copy `.env.example` to `.env`:
   ```bash
   cp .env.example .env
   ```
2. Open `.env` and fill in the configuration details:
   - **`TELEGRAM_BOT_TOKEN`**: Create a new bot on Telegram by messaging [@BotFather](https://t.me/BotFather) and paste the token here.
   - **`TELEGRAM_CHAT_ID`**: Restrict the bot to respond only to your account. You can find your user/chat ID by messaging [@userinfobot](https://t.me/userinfobot).
   - **`DEFAULT_MODEL`**: Set default model performance tier (`pro`, `flash`, or `flash_lite`).

### 2. Installation
Run the automated installation script:
```bash
chmod +x install.sh
./install.sh
```
This script will:
1. Install npm dependencies (`telegraf`, `dotenv`).
2. Generate a LaunchAgent configuration file at `~/Library/LaunchAgents/com.antigravity.telegrambridge.plist`.
3. Register and start the background daemon.

### 3. Monitoring & Management
- **View logs**:
  ```bash
  tail -f output.log
  ```
- **View errors**:
  ```bash
  tail -f error.log
  ```
- **Stop the background service**:
  ```bash
  launchctl unload ~/Library/LaunchAgents/com.antigravity.telegrambridge.plist
  ```
- **Restart the background service**:
  ```bash
  launchctl load ~/Library/LaunchAgents/com.antigravity.telegrambridge.plist
  ```

---

## 🤖 Usage & Commands

Once configured and running, start a chat with your Telegram Bot. You can interact using standard text or the following slash commands:

| Command | Argument | Description |
| :--- | :--- | :--- |
| `/start` or `/help` | *None* | Lists available commands and usage instructions. |
| `/status` | *None* | Displays current bridge status (active, idle, configured model, active conversation ID). |
| `/new` | `<prompt>` | Creates a brand new conversation workspace with the given prompt. |
| `/resume` | `<id>` | Resumes a past conversation by its unique ID. |
| `/list` | *None* | Lists the last 10 local conversation IDs in your Antigravity client history. |
| `/model` / `/performance`| `pro` \| `flash` \| `flash_lite` | Sets the model tier for future runs. |
| `/explain` | *None* | Compiles and lists all tools, files edited, and commands executed in the last active turn. |
| `/stop` | *None* | Detaches from the active conversation, setting the bridge to idle. |

### Sending Prompts
If a conversation is active (attached via `/new` or `/resume`), any normal message you send to the bot is forwarded directly to the agent. The bot will show a loading status (`⚡ Antigravity is working...`) and respond with the output when execution completes.

---

## 🛡️ Security
This bridge is intended for **personal use**. Because the agent has terminal capability (`run_command`) and file manipulation abilities on your Mac, access controls are strictly enforced:
- Messages sent by unauthorized users/chat IDs are rejected with a security warning.
- Ensure your `TELEGRAM_CHAT_ID` is set correctly in `.env` to prevent unauthorized commands.
