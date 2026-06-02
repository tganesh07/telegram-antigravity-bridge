#!/bin/bash

# =========================================================================
# PLUGGABLE ANTI-GRAVITY MESSAGING BRIDGE INSTALLER FOR macOS
# =========================================================================

set -e

PROJECT_DIR="/Users/thulsz/.gemini/antigravity/scratch/telegram-antigravity-bridge"
PLIST_PATH="$HOME/Library/LaunchAgents/com.antigravity.telegrambridge.plist"

echo "--------------------------------------------------------"
echo "🛠️ Starting Anti-Gravity Messaging Bridge Installation..."
echo "--------------------------------------------------------"

# 1. Verify Node.js and npm
if ! command -v node >/dev/null 2>&1; then
    echo "❌ Error: Node.js is not in your current PATH."
    echo "Please make sure Node.js is installed."
    exit 1
fi

NODE_PATH=$(which node)
echo "✅ Found Node.js: $NODE_PATH"

# 2. Setup project directory
cd "$PROJECT_DIR"

# 3. Install npm dependencies
echo "📦 Installing npm packages (telegraf, dotenv)..."
npm install --no-audit --no-fund

# 4. Setup .env file
if [ ! -f .env ]; then
    echo "📄 Creating new .env configuration file from example..."
    cp .env.example .env
    echo "⚠️ NOTE: Please edit the '.env' file in $PROJECT_DIR"
    echo "   and add your TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID."
else
    echo "✅ Existing .env file found. Skipping template copy."
fi

# 5. Generate LaunchAgent plist file
echo "⚙️ Generating macOS LaunchAgent configuration plist..."
cat <<EOF > "$PLIST_PATH"
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.antigravity.telegrambridge</string>
    <key>ProgramArguments</key>
    <array>
        <string>$NODE_PATH</string>
        <string>$PROJECT_DIR/index.js</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$PROJECT_DIR</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>$PROJECT_DIR/output.log</string>
    <key>StandardErrorPath</key>
    <string>$PROJECT_DIR/error.log</string>
</dict>
</plist>
EOF

chmod 644 "$PLIST_PATH"
echo "✅ Plist file generated at: $PLIST_PATH"

# 6. Load the LaunchAgent daemon
echo "🚀 Registering and starting background service..."

# Unload first if already loaded to apply changes
launchctl unload "$PLIST_PATH" >/dev/null 2>&1 || true
launchctl load "$PLIST_PATH"

echo "--------------------------------------------------------"
echo "🎉 Installation Completed Successfully! 🎉"
echo "--------------------------------------------------------"
echo "• The bridge is registered as a background service on your Mac."
echo "• It will automatically run at login."
echo "• To check background logs, run: tail -f output.log"
echo "• IMPORTANT: Do not forget to edit your configuration:"
echo "  [nano/open] $PROJECT_DIR/.env"
echo "--------------------------------------------------------"
