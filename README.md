<!-- Last updated: 2026-03-22 -->
# 🤖 Minecraft AFK Bot + Discord Controller

A Minecraft Java AFK bot powered by [Mineflayer](https://github.com/PrismarineJS/mineflayer) with a full [Discord.js](https://discord.js.org/) bot for remote control via slash commands. It connects to your server, performs random anti-AFK actions to avoid being kicked, and lets you manage it entirely from Discord — including Microsoft account authentication when running on Railway.

---

## ✨ Features

- Connects to Minecraft Java servers with **Microsoft (online-mode) authentication**
- **Anti-AFK movement** — randomly walks, jumps, looks around, swings arm, and sneaks every 15–30 seconds to prevent the server from kicking the bot
- **Discord slash commands** to connect, disconnect, chat, pay players, run commands, and check status
- **Real-time Discord notifications** for connections, kicks (with the actual parsed reason), and real errors
- **Silent auto-reconnect** — reconnects quietly after disconnection; no Discord spam for routine cycles
- **Kick rate limiting** — detects rapid kicks and automatically slows reconnect to 60 s, notifying Discord once
- **`/auth` command** surfaces the Microsoft device-code flow directly in Discord (no console required)
- **Environment variable support** for Railway deployment — no credentials in source code

---

## ⚡ Setup

### 1. Clone the repository

```bash
git clone https://github.com/nuekkis/Minecraft-AFK-Bot.git
cd Minecraft-AFK-Bot
```

### 2. Install dependencies

```bash
npm install
```

### 3. Create a Discord bot

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications) and create a new application.
2. Under **Bot**, click **Add Bot** and copy the **Token**.
3. Under **OAuth2 → URL Generator**, select the **`bot`** and **`applications.commands`** scopes, then invite the bot to your server.
4. Enable the **Guilds** and **Guild Messages** intents if required.
5. Copy your server's (guild's) ID (right-click the server → Copy ID) and the ID of the channel you want notifications sent to.

### 4. Configure `config.json` (local) or environment variables (Railway)

```json
{
  "serverHost": "yourserver.aternos.me",
  "serverPort": 25565,
  "botUsername": "MyBot",
  "botChunk": 1,
  "discordToken": "YOUR_DISCORD_BOT_TOKEN",
  "discordGuildId": "YOUR_DISCORD_GUILD_ID",
  "discordChannelId": "YOUR_DISCORD_NOTIFICATION_CHANNEL_ID",
  "discordPaidChannelId": "YOUR_DISCORD_PAID_CHANNEL_ID",
  "discordFailedChannelId": "YOUR_DISCORD_FAILED_CHANNEL_ID",
  "gambleChannel": "YOUR_GAMBLE_CHANNEL_ID",
  "gambleGuildId": "YOUR_GAMBLE_GUILD_ID",
  "autoReconnect": true,
  "reconnectDelay": 30000
}
```

> ⚠️ Never commit real tokens to your repository. Use environment variables on Railway instead.

### 5. Start the bot

```bash
npm start
```

---

## 🎮 Discord Slash Commands

| Command | Description |
|---|---|
| `/auth` | Triggers Microsoft device-code authentication. The bot posts the URL + code in Discord so you can log in without console access. |
| `/connect` | Connects the Minecraft bot to the server and re-enables auto-reconnect. |
| `/disconnect` | Disconnects the Minecraft bot and **disables** auto-reconnect until `/connect` is used. |
| `/pay <user> <amount>` | Sends `/pay <user> <amount>` in-game with balance before/after verification. |
| `/chat <message>` | Sends a chat message in-game. |
| `/cmd <command>` | Runs any arbitrary in-game command (e.g. `/cmd spawn` runs `/spawn`). |
| `/bal` | Sends `/bal` in-game and waits up to 5 seconds for the server response, then shows the balance in Discord. |
| `/status` | Reports connection status, server, uptime, and auto-reconnect state. |
| `/balance <channel>` | Sets a channel whose name is updated with the bot's in-game balance every 10 minutes. |

---

## 💬 Text Prefix Commands

Quick text commands you can type in any channel instead of using slash commands.

| Command | Description |
|---|---|
| `!pa <user> <amount>` | Sends `/pay <user> <amount>` in-game. |
| `!cmd <command>` | Runs any in-game command (e.g. `!cmd spawn` runs `/spawn`). |
| `!chat <message>` | Sends a chat message in-game. |
| `!bal` | Checks the bot's in-game balance. |
| `!status` | Shows bot connection status, server, uptime, and auto-reconnect state. |
| `!connect` | Connects the bot to the Minecraft server. |
| `!disconnect` | Disconnects the bot and disables auto-reconnect. |

---

## 🎰 Gambling

Gambling is done via a **stickied button message** in the configured gamble channel. When the bot starts, it automatically posts an embed with a **🎰 Gamble** button in that channel (replacing any previous sticky). The message is **sticky** — whenever anyone sends a message in the gamble channel, the bot deletes the old gamble message and re-posts it at the bottom so it's always visible. The embed also displays the **max bet** (the bot's current balance). Users click the button to open a form where they enter their Minecraft username and the amount they want to bet (in millions). No slash commands or text commands are needed — just click the button!

- **Win chance:** 50% win
- **Minimum bet:** $1,000,000
- **Maximum bet:** The bot's current in-game balance (shown in the embed)

---

## 🔔 Discord Notifications

The bot sends real-time notifications to your configured channel for:

| Event | Message |
|---|---|
| ✅ Connected | `Bot has connected to server:port` (first connection, or after 60+ seconds offline) |
| ⚠️ Kicked | `Bot was kicked: <reason>` (actual server kick reason, properly parsed — never blank or `[object Object]`) |
| ⛔ Disconnected | `Bot disconnected from server` (only when auto-reconnect is disabled) |
| ❌ Error | `Error: <message>` |
| 💀 Died | `Bot died!` |
| 💬 In-game messages | Every server message is forwarded to Discord |
| ✅ Order Paid | Logged to the paid channel when an auto-delivery payment is verified via balance change |
| ❌ Order Failed | Logged to the failed channel when an auto-delivery payment fails (insufficient balance or no balance change) |
| ⚠️ Rate-limited | `Bot is being repeatedly kicked. Slowing reconnect to 60s.` (sent once after 5+ kicks in 2 minutes) |

> **Note:** Routine disconnect/reconnect cycles are **silent** — no Discord spam. Only genuine kick reasons and real errors are reported.

---

## 🏃 Anti-AFK Behavior

The bot performs a random action every **15–30 seconds** to prevent the server's anti-AFK plugin from kicking it:

- Walk forward for 1–2 seconds then stop
- Jump
- Look in a random direction
- Swing arm
- Sneak on/off briefly

Anti-AFK starts automatically on `spawn` and stops when the bot disconnects.

---

## 🔐 Microsoft Authentication

The bot uses Microsoft OAuth device-code flow (built into Mineflayer via `prismarine-auth`).

1. Run `/auth` in Discord (or let the bot auto-connect on startup).
2. The bot will post a message like:
   > 🔐 **Microsoft Authentication Required**
   > Open `https://microsoft.com/link` and enter the code **`ABCD-1234`** to log in.
3. Open the link, enter the code, and log in with your Microsoft account.
4. The bot will automatically connect to the Minecraft server once authenticated.

Auth tokens are cached by `prismarine-auth` so you typically only need to authenticate once.

---

## 🔄 Auto-Reconnect

- The bot automatically reconnects **10 seconds** after any disconnect (silent, no Discord spam).
- If the bot is kicked **5 or more times within 2 minutes**, the reconnect delay increases to **60 seconds** and Discord is notified once: *"Bot is being repeatedly kicked. Slowing reconnect to 60s."*
- The delay resets to 10 seconds once the bot successfully connects and spawns.
- Use `/disconnect` to disconnect **without** auto-reconnect (useful for maintenance).
- Use `/connect` to reconnect manually and re-enable auto-reconnect.
- A "✅ Bot connected" notification is only sent on the **first** connection, or after the bot has been offline for more than **60 seconds**.

---

## 🚀 Railway Deployment

Set the following environment variables in your Railway project instead of editing `config.json`:

| Variable | Description |
|---|---|
| `SERVER_HOST` | Minecraft server hostname |
| `SERVER_PORT` | Minecraft server port |
| `BOT_USERNAME` | Minecraft account username |
| `BOT_CHUNK` | View distance / chunk radius |
| `DISCORD_TOKEN` | Your Discord bot token |
| `DISCORD_GUILD_ID` | Your Discord server (guild) ID |
| `DISCORD_CHANNEL_ID` | Channel ID for notifications |
| `DISCORD_PAID_CHANNEL_ID` | Channel ID for paid order logs |
| `DISCORD_FAILED_CHANNEL_ID` | Channel ID for failed order logs |
| `GAMBLE_CHANNEL` | Channel ID where gamble commands are allowed |
| `GAMBLE_GUILD_ID` | Discord server (guild) ID where gamble commands work (if different from main guild; the bot must be invited to this server) |

---

## ⚙️ Configuration Reference

| Key | Env var | Description |
|---|---|---|
| `serverHost` | `SERVER_HOST` | IP or domain of your Minecraft server |
| `serverPort` | `SERVER_PORT` | Server port (default 25565) |
| `botUsername` | `BOT_USERNAME` | The bot's Minecraft account username |
| `botChunk` | `BOT_CHUNK` | Loaded chunk radius (recommended: 1–4) |
| `discordToken` | `DISCORD_TOKEN` | Discord bot token |
| `discordGuildId` | `DISCORD_GUILD_ID` | Discord guild (server) ID |
| `discordChannelId` | `DISCORD_CHANNEL_ID` | Notification channel ID |
| `discordPaidChannelId` | `DISCORD_PAID_CHANNEL_ID` | Channel ID for successful payment logs |
| `discordFailedChannelId` | `DISCORD_FAILED_CHANNEL_ID` | Channel ID for failed payment logs |
| `gambleChannel` | `GAMBLE_CHANNEL` | Channel ID where gamble commands are allowed |
| `gambleGuildId` | `GAMBLE_GUILD_ID` | Discord guild (server) ID where gamble commands work (if different from the main guild; leave empty to use main guild) |

---

## 📚 Resources

- [Mineflayer Docs](https://mineflayer.prismarine.js.org/)
- [Discord.js Guide](https://discordjs.guide/)
- [PrismarineJS GitHub](https://github.com/PrismarineJS/)

Feel free to contribute by opening a pull request or submitting an issue.

---

## 📄 License

This project is licensed under the MIT License.

---

Keep your server active 24/7 and control your bot from Discord! ⛏️
