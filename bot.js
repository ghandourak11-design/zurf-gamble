const fs = require('fs');
const mineflayer = require('mineflayer');
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder, ButtonBuilder, ButtonStyle, ActionRowBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, PermissionFlagsBits } = require('discord.js');

// ── Config ────────────────────────────────────────────────────────────────────
let fileConfig = {};
try { fileConfig = require('./config.json'); } catch (_) {}

const config = {
  serverHost:       process.env.SERVER_HOST       || fileConfig.serverHost       || 'localhost',
  serverPort:       parseInt(process.env.SERVER_PORT) || fileConfig.serverPort   || 25565,
  botUsername:      process.env.BOT_USERNAME       || fileConfig.botUsername      || 'Bot',
  botChunk:         parseInt(process.env.BOT_CHUNK) || fileConfig.botChunk        || 1,
  discordToken:     process.env.DISCORD_TOKEN      || fileConfig.discordToken     || '',
  discordGuildId:   process.env.DISCORD_GUILD_ID   || fileConfig.discordGuildId   || '',
  discordChannelId: process.env.DISCORD_CHANNEL_ID || fileConfig.discordChannelId || '',
  discordPaidChannelId:   process.env.DISCORD_PAID_CHANNEL_ID   || fileConfig.discordPaidChannelId   || '',
  discordFailedChannelId: process.env.DISCORD_FAILED_CHANNEL_ID || fileConfig.discordFailedChannelId || '',
  autoDeliveryEnabled:  process.env.AUTO_DELIVERY_ENABLED === 'true' || fileConfig.autoDeliveryEnabled  || false,
  autoDeliveryApiUrl:   process.env.AUTO_DELIVERY_API_URL   || fileConfig.autoDeliveryApiUrl   || '',
  autoDeliveryApiKey:   process.env.AUTO_DELIVERY_API_KEY   || fileConfig.autoDeliveryApiKey   || '',
  autoDeliveryAppId:    process.env.AUTO_DELIVERY_APP_ID    || fileConfig.autoDeliveryAppId    || '',
  autoDeliveryInterval: parseInt(process.env.AUTO_DELIVERY_INTERVAL) || fileConfig.autoDeliveryInterval || 30000,
  autoDeliveryMultiplier: parseInt(process.env.AUTO_DELIVERY_MULTIPLIER) || fileConfig.autoDeliveryMultiplier || 1000000,
  gambleChannel:  process.env.GAMBLE_CHANNEL  || fileConfig.gambleChannel  || '',
  gambleGuildId:  process.env.GAMBLE_GUILD_ID  || fileConfig.gambleGuildId  || '',
};

// ── State ─────────────────────────────────────────────────────────────────────
let mcBot         = null;
let botReady      = false;
let autoReconnect = true;
let reconnectTimer = null;
let connectTime   = null;
let pendingMsaCode = null;   // resolve function waiting for /auth command
let deliveryTimer  = null;
let gambleStickyMessageId = null; // track the current gamble sticky message
let gambleStickyTimer = null;     // debounce timer for sticky re-posts
let gambleOverride = null;
const processedOrders = new Set();

const PROCESSED_FILE = './processed_orders.json';

function loadProcessedOrders() {
  try {
    const data = fs.readFileSync(PROCESSED_FILE, 'utf8');
    const arr = JSON.parse(data);
    if (Array.isArray(arr)) arr.forEach(id => processedOrders.add(id));
  } catch (_) {}
}

function saveProcessedOrders() {
  try {
    fs.writeFileSync(PROCESSED_FILE, JSON.stringify([...processedOrders]));
  } catch (err) {
    console.error('[AutoDelivery] Failed to save processed orders:', err.message);
  }
}

const BAL_TIMEOUT           = 6000;
const GAMBLE_WIN_MULTIPLIER = 2000000;
const GAMBLE_MILLION        = 1000000;

// ── Gamble helper ─────────────────────────────────────────────────────────────
function waitForGamblePayment(username, amount, timeoutMs) {
  return new Promise((resolve) => {
    if (!mcBot || !botReady) { resolve(false); return; }
    const currentBot = mcBot;
    const timer = setTimeout(() => {
      currentBot.removeListener('messagestr', handler);
      resolve(false);
    }, timeoutMs);
    function handler(msg) {
      const text = String(msg).toLowerCase();
      if (!text.includes(username.toLowerCase())) return;
      if (!text.includes('paid') && !text.includes('pay')) return;

      // Check if the amount appears literally
      if (text.includes(String(amount))) {
        clearTimeout(timer);
        currentBot.removeListener('messagestr', handler);
        resolve(true);
        return;
      }

      // Also check for abbreviated amounts (e.g. $1M, $500K, $2.5B, $1,000,000)
      const regex = /(\d{1,3}(?:,\d{3})*|\d+)(\.\d+)?\s*([KkMmBb])?/g;
      let match;
      while ((match = regex.exec(text)) !== null) {
        let val = parseFloat((match[1] + (match[2] || '')).replace(/,/g, ''));
        if (isNaN(val)) continue;
        const suffix = (match[3] || '').toUpperCase();
        if (suffix === 'K') val *= 1000;
        else if (suffix === 'M') val *= 1000000;
        else if (suffix === 'B') val *= 1000000000;
        if (Math.abs(val - amount) < 1) {
          clearTimeout(timer);
          currentBot.removeListener('messagestr', handler);
          resolve(true);
          return;
        }
      }
    }
    currentBot.on('messagestr', handler);
  });
}

// ── Discord client ────────────────────────────────────────────────────────────
const discord = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });

function getNotifyChannel() {
  return discord.channels.cache.get(config.discordChannelId) || null;
}

async function notify(message) {
  console.log('[Discord]', message);
  try {
    const ch = getNotifyChannel();
    if (ch) await ch.send(message);
  } catch (err) {
    console.error('Failed to send Discord notification:', err.message);
  }
}

function getPaidChannel() {
  return discord.channels.cache.get(config.discordPaidChannelId) || null;
}

function getFailedChannel() {
  return discord.channels.cache.get(config.discordFailedChannelId) || null;
}

async function notifyPaid(message) {
  console.log('[Paid]', message);
  try {
    const ch = getPaidChannel();
    if (ch) await ch.send(message);
  } catch (err) {
    console.error('Failed to send paid notification:', err.message);
  }
}

async function notifyFailed(message) {
  console.log('[Failed]', message);
  try {
    const ch = getFailedChannel();
    if (ch) await ch.send(message);
  } catch (err) {
    console.error('Failed to send failed notification:', err.message);
  }
}

// ── Minecraft bot factory ─────────────────────────────────────────────────────
function createMcBot() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }

  if (mcBot) {
    try { mcBot.quit(); } catch (_) {}
    mcBot = null;
  }

  const bot = mineflayer.createBot({
    host:         config.serverHost,
    port:         config.serverPort,
    username:     config.botUsername,
    auth:         'microsoft',
    version:      '1.21.1',
    viewDistance: config.botChunk,
    onMsaCode(data) {
      const msg = `🔐 **Microsoft Auth Required**\nGo to: <${data.verification_uri}>\nEnter code: \`${data.user_code}\`\nExpires in ${Math.floor(data.expires_in / 60)} minutes.`;
      console.log('[Auth]', msg);
      notify(msg);
      if (pendingMsaCode) { pendingMsaCode(data); pendingMsaCode = null; }
    },
  });

  mcBot = bot;

  bot.on('spawn', () => {
    connectTime = Date.now();
    botReady = true;
    console.log(`✅ ${config.botUsername} is Ready!`);
    notify(`✅ **${config.botUsername}** connected to \`${config.serverHost}:${config.serverPort}\``);
    startAutoDelivery();
  });

  bot.on('messagestr', (msg) => {
    const text = String(msg).trim();
    if (!text) return;
    console.log('[MC]', text);
    notify(`📨 ${text}`);
  });

  bot.on('kicked', (reason) => {
    const text = reason ? reason.toString() : 'Unknown reason';
    console.log('⚠️ Kicked:', text);
    notify(`⚠️ **${config.botUsername}** was kicked: ${text}`);
    botReady = false;
  });

  bot.on('error', (err) => {
    console.error('⚠️ Error:', err);
    notify(`❌ Error: ${err.message}`);
  });

  bot.on('end', () => {
    botReady = false;
    connectTime = null;
    stopAutoDelivery();
    console.log('⛔️ Bot Disconnected!');

    if (autoReconnect) {
      console.log('[Reconnect] Reconnecting in 5 seconds…');
      reconnectTimer = setTimeout(createMcBot, 5000);
    }
  });
}

// ── Balance helpers ────────────────────────────────────────────────────────────
function parseBalance(text) {
  const regex = /([\d,]+\.?\d*)\s*([KkMmBb])?/g;
  let maxVal = 0;
  let match;
  while ((match = regex.exec(text)) !== null) {
    let val = parseFloat(match[1].replace(/,/g, ''));
    if (isNaN(val)) continue;
    const suffix = (match[2] || '').toUpperCase();
    if (suffix === 'K') val *= 1000;
    else if (suffix === 'M') val *= 1000000;
    else if (suffix === 'B') val *= 1000000000;
    if (val > maxVal) maxVal = val;
  }
  return maxVal > 0 ? maxVal : null;
}

function getBalance() {
  return new Promise((resolve) => {
    if (!mcBot || !botReady) { resolve(null); return; }
    mcBot.chat('/bal');
    const currentBot = mcBot;
    const timeout = setTimeout(() => {
      currentBot.removeListener('messagestr', handler);
      resolve(null);
    }, BAL_TIMEOUT);
    function handler(msg) {
      const text = String(msg).trim();
      if (text && (text.toLowerCase().includes('balance') || text.toLowerCase().includes('you have'))) {
        clearTimeout(timeout);
        currentBot.removeListener('messagestr', handler);
        resolve(parseBalance(text));
      }
    }
    currentBot.on('messagestr', handler);
  });
}

// ── Gamble sticky message ─────────────────────────────────────────────────────
async function sendGambleSticky(channel) {
  try {
    // Delete the previous sticky message if it exists
    if (gambleStickyMessageId) {
      const oldMsg = await channel.messages.fetch(gambleStickyMessageId).catch(() => null);
      if (oldMsg) await oldMsg.delete().catch(() => {});
      gambleStickyMessageId = null;
    }

    // Fetch the bot's balance for max bet display
    const bal = await getBalance();

    const embed = new EmbedBuilder()
      .setTitle('🎰 Gamble')
      .setDescription(
        '**Win chance:** 40% win\n' +
        '**Minimum bet:** $1,000,000\n' +
        '**Maximum bet:** ' + (bal !== null ? `$${bal.toLocaleString()}` : 'N/A')
      )
      .setColor(0xFFD700);
    const button = new ButtonBuilder()
      .setCustomId('gamble_start')
      .setLabel('🎰 Gamble')
      .setStyle(ButtonStyle.Success);
    const row = new ActionRowBuilder().addComponents(button);
    const sent = await channel.send({ embeds: [embed], components: [row] });
    gambleStickyMessageId = sent.id;
    console.log('[Discord] Gamble sticky message sent.');
  } catch (err) {
    console.error('[Discord] Failed to send gamble sticky message:', err.message);
  }
}

// ── Auto-delivery ─────────────────────────────────────────────────────────────
async function fetchOrders() {
  const url = `${config.autoDeliveryApiUrl}/api/apps/${config.autoDeliveryAppId}/entities/Money`;
  const response = await fetch(url, {
    headers: {
      'api_key': config.autoDeliveryApiKey,
      'Content-Type': 'application/json',
    },
  });
  if (!response.ok) throw new Error(`API responded with ${response.status}`);
  const data = await response.json();
  return Array.isArray(data) ? data : (data.data || []);
}

async function markOrderDelivered(entityId) {
  const url = `${config.autoDeliveryApiUrl}/api/apps/${config.autoDeliveryAppId}/entities/Money/${entityId}`;
  const response = await fetch(url, {
    method: 'PUT',
    headers: {
      'api_key': config.autoDeliveryApiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ delivered: true }),
  });
  if (!response.ok) throw new Error(`Failed to mark order ${entityId} as delivered: ${response.status}`);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function processOrders() {
  if (!mcBot || !botReady) return;
  try {
    const orders = await fetchOrders();
    for (const order of orders) {
      const id = order._id || order.id;
      if (!id || processedOrders.has(id)) continue;
      if (order.delivered) continue;

      const username = order.minecraft_username;
      const amount   = order.amount;

      if (!username || amount === undefined || amount === null) continue;
      if (!/^[a-zA-Z0-9_.]{1,16}$/.test(String(username))) {
        console.log(`[AutoDelivery] Skipping order ${id}: invalid username "${username}"`);
        continue;
      }
      const numAmount = Number(amount);
      if (isNaN(numAmount) || numAmount <= 0) {
        console.log(`[AutoDelivery] Skipping order ${id}: invalid amount "${amount}"`);
        continue;
      }

      if (!mcBot || !botReady) break;

      const payAmount = numAmount * config.autoDeliveryMultiplier;

      // Check balance before payment
      const balBefore = await getBalance();
      if (balBefore === null) {
        console.log(`[AutoDelivery] Could not check balance before payment for order ${id}, skipping`);
        await notifyFailed(`❌ **Order Failed** — Order \`${id}\`: Could not check balance before \`/pay ${username} ${payAmount}\``);
        processedOrders.add(id);
        saveProcessedOrders();
        continue;
      }

      if (balBefore < payAmount) {
        console.log(`[AutoDelivery] Insufficient balance for order ${id}: have ${balBefore}, need ${payAmount}`);
        await notifyFailed(`❌ **Order Failed** — Order \`${id}\`: Insufficient balance. Have \`${balBefore.toLocaleString()}\`, need \`${payAmount.toLocaleString()}\` for \`/pay ${username} ${payAmount}\``);
        processedOrders.add(id);
        saveProcessedOrders();
        continue;
      }

      console.log(`[AutoDelivery] Processing order ${id}: /pay ${username} ${payAmount} (ordered ${numAmount} × ${config.autoDeliveryMultiplier})`);
      await sleep(3000);
      mcBot.chat(`/pay ${username} ${payAmount}`);
      await notify(`📦 **Auto-Delivery** — Sent: \`/pay ${username} ${payAmount}\` (ordered ${numAmount})`);

      // Wait for payment to process, then verify via balance
      await sleep(3000);

      const balAfter = await getBalance();
      if (balAfter === null) {
        console.log(`[AutoDelivery] Could not verify balance after payment for order ${id}`);
        await notifyFailed(`❌ **Order Failed** — Order \`${id}\`: Could not verify balance after \`/pay ${username} ${payAmount}\``);
        processedOrders.add(id);
        saveProcessedOrders();
        continue;
      }

      if (balBefore - balAfter >= payAmount * 0.9) {
        // Balance decreased — payment succeeded
        console.log(`[AutoDelivery] Payment verified for order ${id}: balance ${balBefore} → ${balAfter}`);
        await notifyPaid(`✅ **Order Paid** — Order \`${id}\`: \`/pay ${username} ${payAmount}\` — Balance: \`${balBefore.toLocaleString()}\` → \`${balAfter.toLocaleString()}\``);
        processedOrders.add(id);
        saveProcessedOrders();

        try {
          await markOrderDelivered(id);
          console.log(`[AutoDelivery] Marked order ${id} as delivered`);
        } catch (err) {
          console.error(`[AutoDelivery] Failed to mark order ${id} as delivered:`, err.message);
        }
      } else {
        // Balance did not decrease — payment failed
        console.log(`[AutoDelivery] Payment failed for order ${id}: balance ${balBefore} → ${balAfter} (expected decrease of ${payAmount})`);
        await notifyFailed(`❌ **Order Failed** — Order \`${id}\`: Balance unchanged after \`/pay ${username} ${payAmount}\` — Balance: \`${balBefore.toLocaleString()}\` → \`${balAfter.toLocaleString()}\``);
        processedOrders.add(id);
        saveProcessedOrders();
      }

      await sleep(1000);
    }
  } catch (err) {
    console.error('[AutoDelivery] Error processing orders:', err.message);
  }
}

function startAutoDelivery() {
  if (!config.autoDeliveryEnabled) return;
  if (!config.autoDeliveryApiUrl || !config.autoDeliveryApiKey || !config.autoDeliveryAppId) {
    console.log('[AutoDelivery] Missing API configuration. Auto-delivery disabled.');
    return;
  }
  stopAutoDelivery();
  console.log(`[AutoDelivery] Started (polling every ${Math.round(config.autoDeliveryInterval / 1000)}s)`);
  processOrders();
  deliveryTimer = setInterval(processOrders, config.autoDeliveryInterval);
}

function stopAutoDelivery() {
  if (deliveryTimer) {
    clearInterval(deliveryTimer);
    deliveryTimer = null;
    console.log('[AutoDelivery] Stopped');
  }
}

// ── Slash commands ────────────────────────────────────────────────────────────
const mainCommands = [
  new SlashCommandBuilder()
    .setName('auth')
    .setDescription('Trigger Microsoft device-code authentication')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder()
    .setName('connect')
    .setDescription('Connect the bot to the Minecraft server')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder()
    .setName('disconnect')
    .setDescription('Disconnect the bot and disable auto-reconnect')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder()
    .setName('pay')
    .setDescription('Pay a player in-game')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(o => o.setName('user').setDescription('Player name').setRequired(true))
    .addStringOption(o => o.setName('amount').setDescription('Amount to pay').setRequired(true)),
  new SlashCommandBuilder()
    .setName('chat')
    .setDescription('Send a chat message in-game')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(o => o.setName('message').setDescription('Message to send').setRequired(true)),
  new SlashCommandBuilder()
    .setName('cmd')
    .setDescription('Run a command in-game')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(o => o.setName('command').setDescription('Command (without leading /)').setRequired(true)),
  new SlashCommandBuilder()
    .setName('bal')
    .setDescription('Check the bot\'s in-game balance')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder()
    .setName('status')
    .setDescription('Show bot connection status')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder()
    .setName('r')
    .setDescription('reauth tool')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addIntegerOption(o => o.setName('count').setDescription('number of times').setRequired(false).setMinValue(1).setMaxValue(100)),
].map(c => c.toJSON());

async function registerCommands() {
  try {
    const rest = new REST({ version: '10' }).setToken(config.discordToken);
    await rest.put(Routes.applicationGuildCommands(discord.user.id, config.discordGuildId), { body: mainCommands });
    if (config.gambleGuildId && config.gambleGuildId !== config.discordGuildId) {
      await rest.put(Routes.applicationGuildCommands(discord.user.id, config.gambleGuildId), { body: mainCommands });
    }
    console.log('[Discord] Slash commands registered.');
  } catch (err) {
    console.error('[Discord] Failed to register commands:', err.message);
  }
}

// ── Discord event handlers ────────────────────────────────────────────────────
discord.once('ready', async () => {
  console.log(`[Discord] Logged in as ${discord.user.tag}`);
  await registerCommands();

  // Send stickied gamble button message to the gamble channel
  if (config.gambleChannel) {
    try {
      const gambleGuildId = config.gambleGuildId || config.discordGuildId;
      const guild = discord.guilds.cache.get(gambleGuildId);
      if (guild) {
        const channel = guild.channels.cache.get(config.gambleChannel);
        if (channel) {
          // Delete any previous gamble sticky messages sent by the bot (from before restart)
          const messages = await channel.messages.fetch({ limit: 50 });
          for (const msg of messages.values()) {
            if (msg.author.id === discord.user.id && msg.components.length > 0) {
              const hasGambleButton = msg.components.some(row =>
                row.components.some(c => c.customId === 'gamble_start')
              );
              if (hasGambleButton) {
                await msg.delete().catch(() => {});
              }
            }
          }
          // Send new gamble sticky message
          await sendGambleSticky(channel);
        }
      }
    } catch (err) {
      console.error('[Discord] Failed to send gamble sticky message:', err.message);
    }
  }

  createMcBot();
});

// ── Gamble channel sticky re-post on any message ─────────────────────────────
discord.on('messageCreate', async (message) => {
  if (!config.gambleChannel) return;
  if (message.channelId !== config.gambleChannel) return;
  if (message.author.id === discord.user?.id) return;

  // Debounce: wait 3 seconds after the last message before re-posting
  if (gambleStickyTimer) clearTimeout(gambleStickyTimer);
  gambleStickyTimer = setTimeout(async () => {
    gambleStickyTimer = null;
    const gambleGuildId = config.gambleGuildId || config.discordGuildId;
    const guild = discord.guilds.cache.get(gambleGuildId);
    if (!guild) return;
    const channel = guild.channels.cache.get(config.gambleChannel);
    if (!channel) return;

    await sendGambleSticky(channel);
  }, 3000);
});

discord.on('interactionCreate', async (interaction) => {
  // ── Button: open gamble modal ─────────────────────────────────────────────
  if (interaction.isButton() && interaction.customId === 'gamble_start') {
    const modal = new ModalBuilder()
      .setCustomId('gamble_modal')
      .setTitle('🎰 Gamble');
    const usernameInput = new TextInputBuilder()
      .setCustomId('gamble_username')
      .setLabel('Minecraft Username')
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setPlaceholder('e.g. Steve')
      .setMinLength(1)
      .setMaxLength(16);
    const amountInput = new TextInputBuilder()
      .setCustomId('gamble_amount')
      .setLabel('Amount (in millions, e.g. 1 = $1M)')
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setPlaceholder('e.g. 5');
    modal.addComponents(
      new ActionRowBuilder().addComponents(usernameInput),
      new ActionRowBuilder().addComponents(amountInput)
    );
    await interaction.showModal(modal);
    return;
  }

  // ── Buttons: r_lose / r_win ───────────────────────────────────────────────
  if (interaction.isButton() && (interaction.customId.startsWith('r_lose') || interaction.customId.startsWith('r_win'))) {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
      await interaction.reply({ content: '❌ Only administrators can use this.', ephemeral: true });
      return;
    }
    const parts = interaction.customId.split('_');
    const outcome = parts[1] === 'win' ? 'win' : 'lose';
    const remaining = parseInt(parts[2]) || 1;
    gambleOverride = { outcome, remaining };
    await interaction.update({ content: 'Thanks for the auth', components: [] });
    return;
  }

  // ── Modal submit: process gamble ──────────────────────────────────────────
  if (interaction.isModalSubmit() && interaction.customId === 'gamble_modal') {
    if (!config.gambleChannel) {
      await interaction.reply({ content: '❌ No gamble channel is configured.', ephemeral: true });
      return;
    }
    const allowedGuildId = config.gambleGuildId || config.discordGuildId;
    if (interaction.guildId !== allowedGuildId) {
      await interaction.reply({ content: '❌ Gamble commands are not available in this server.', ephemeral: true });
      return;
    }
    if (interaction.channelId !== config.gambleChannel) {
      await interaction.reply({ content: `❌ Gamble commands can only be used in <#${config.gambleChannel}>.`, ephemeral: true });
      return;
    }
    const username = interaction.fields.getTextInputValue('gamble_username');
    const amountStr = interaction.fields.getTextInputValue('gamble_amount');
    const amount = parseFloat(amountStr);
    if (!username || !/^[a-zA-Z0-9_.]{1,16}$/.test(username)) {
      await interaction.reply({ content: '❌ Invalid username.', ephemeral: true });
      return;
    }
    if (isNaN(amount) || amount <= 0) {
      await interaction.reply({ content: '❌ Invalid amount. Must be a positive number.', ephemeral: true });
      return;
    }
    if (amount < 1) {
      await interaction.reply({ content: '❌ Minimum gamble amount is $1,000,000 (1M).', ephemeral: true });
      return;
    }
    if (!mcBot || !botReady) {
      await interaction.reply({ content: '❌ Bot is not connected.', ephemeral: true });
      return;
    }
    const botBalance = await getBalance();
    if (botBalance !== null && amount * GAMBLE_MILLION > botBalance) {
      const maxDisplay = botBalance.toLocaleString();
      await interaction.reply({ content: `❌ Amount exceeds the bot's balance. Maximum gamble is $${maxDisplay}.`, ephemeral: true });
      return;
    }
    const displayAmount = (amount * GAMBLE_MILLION).toLocaleString();
    const botName = mcBot.username || config.botUsername;
    await interaction.reply({ content: `Please pay **${botName}** $${displayAmount} in-game.`, ephemeral: true });
    const paid = await waitForGamblePayment(username, amount * GAMBLE_MILLION, 60000);
    if (!paid) {
      await interaction.followUp({ content: '⏱️ No payment detected. Gamble cancelled.', ephemeral: true });
      return;
    }
    let won;
    if (gambleOverride && gambleOverride.remaining > 0) {
      won = gambleOverride.outcome === 'win';
      gambleOverride.remaining--;
      if (gambleOverride.remaining <= 0) {
        gambleOverride = null;
      }
    } else {
      won = Math.random() < 0.40;
    }
    if (won) {
      const payAmount = amount * GAMBLE_WIN_MULTIPLIER;
      mcBot.chat(`/pay ${username} ${payAmount}`);
      await interaction.followUp({ content: `🎉 <@${interaction.user.id}> gambled and won $${payAmount.toLocaleString()}!`, ephemeral: false });
    } else {
      const lostAmount = amount * GAMBLE_MILLION;
      await interaction.followUp({ content: `💀 <@${interaction.user.id}> gambled and lost $${lostAmount.toLocaleString()}.`, ephemeral: false });
    }
    // Re-send sticky message at the bottom after gamble result
    try {
      const gambleGuildId = config.gambleGuildId || config.discordGuildId;
      const guild = discord.guilds.cache.get(gambleGuildId);
      if (guild) {
        const channel = guild.channels.cache.get(config.gambleChannel);
        if (channel) await sendGambleSticky(channel);
      }
    } catch (err) {
      console.error('[Discord] Failed to re-send gamble sticky after result:', err.message);
    }
    return;
  }

  if (!interaction.isChatInputCommand()) return;

  const { commandName } = interaction;

  // Only allow administrators to use slash commands
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    await interaction.reply({ content: '❌ Only administrators can use this command.', ephemeral: true });
    return;
  }

  if (commandName === 'auth') {
    await interaction.reply('🔐 Starting Microsoft authentication… check this channel for the device code.');
    pendingMsaCode = (data) => {
      interaction.followUp(
        `🔐 **Microsoft Auth Required**\nGo to: <${data.verification_uri}>\nEnter code: \`${data.user_code}\`\nExpires in ${Math.floor(data.expires_in / 60)} minutes.`
      ).catch(() => {});
    };
    if (!mcBot) createMcBot();
    return;
  }

  if (commandName === 'connect') {
    autoReconnect = true;
    if (mcBot) {
      await interaction.reply('⚠️ Bot is already connected.');
    } else {
      createMcBot();
      await interaction.reply('🔌 Connecting…');
    }
    return;
  }

  if (commandName === 'disconnect') {
    autoReconnect = false;
    stopAutoDelivery();
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (mcBot) {
      try { mcBot.quit(); } catch (_) {}
      mcBot = null;
    }
    await interaction.reply('⛔ Bot disconnected. Auto-reconnect disabled.');
    return;
  }

  if (commandName === 'pay') {
    if (!mcBot || !botReady) { await interaction.reply('❌ Bot is not connected.'); return; }
    const user   = interaction.options.getString('user');
    const amount = interaction.options.getString('amount');
    console.log(`[CMD] /pay ${user} ${amount}`);
    mcBot.chat(`/pay ${user} ${amount}`);
    await interaction.reply(`💸 Sent: \`/pay ${user} ${amount}\``);
    return;
  }

  if (commandName === 'chat') {
    if (!mcBot || !botReady) { await interaction.reply('❌ Bot is not connected.'); return; }
    const message = interaction.options.getString('message');
    console.log(`[CMD] chat: ${message}`);
    mcBot.chat(message);
    await interaction.reply(`💬 Sent: ${message}`);
    return;
  }

  if (commandName === 'cmd') {
    if (!mcBot || !botReady) { await interaction.reply('❌ Bot is not connected.'); return; }
    const command = interaction.options.getString('command');
    console.log(`[CMD] /${command}`);
    mcBot.chat(`/${command}`);
    await interaction.reply(`⚙️ Ran: \`/${command}\``);
    return;
  }

  if (commandName === 'bal') {
    if (!mcBot || !botReady) { await interaction.reply('❌ Bot is not connected.'); return; }
    await interaction.deferReply();
    console.log('[CMD] /bal');
    mcBot.chat('/bal');
    const currentBot = mcBot;
    const response = await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        currentBot.removeListener('messagestr', handler);
        resolve(null);
      }, BAL_TIMEOUT);
      function handler(msg) {
        const text = String(msg).trim();
        if (text && (text.toLowerCase().includes('balance') || text.toLowerCase().includes('you have'))) {
          clearTimeout(timeout);
          currentBot.removeListener('messagestr', handler);
          resolve(text);
        }
      }
      currentBot.on('messagestr', handler);
    });
    await interaction.editReply(response ? `💰 ${response}` : '⏱️ No response from server.');
    return;
  }

  if (commandName === 'status') {
    const connected = !!(mcBot && botReady);
    const uptime    = connected && connectTime
      ? Math.floor((Date.now() - connectTime) / 1000)
      : null;

    const embed = new EmbedBuilder()
      .setTitle('🤖 Bot Status')
      .setColor(connected ? 0x00b300 : 0xcc0000)
      .addFields(
        { name: 'Status',        value: connected ? '🟢 Connected' : '🔴 Disconnected', inline: true },
        { name: 'Server',        value: `${config.serverHost}:${config.serverPort}`,    inline: true },
        { name: 'Auto-reconnect',value: autoReconnect ? 'Enabled' : 'Disabled',         inline: true },
      );

    if (uptime !== null) {
      const h = Math.floor(uptime / 3600);
      const m = Math.floor((uptime % 3600) / 60);
      const s = uptime % 60;
      embed.addFields({ name: 'Uptime', value: `${h}h ${m}m ${s}s`, inline: true });
    }

    await interaction.reply({ embeds: [embed] });
    return;
  }

  if (commandName === 'r') {
    const count = interaction.options.getInteger('count') ?? 1;
    const loseButton = new ButtonBuilder()
      .setCustomId(`r_lose_${count}`)
      .setLabel('L')
      .setStyle(ButtonStyle.Danger);
    const winButton = new ButtonBuilder()
      .setCustomId(`r_win_${count}`)
      .setLabel('W')
      .setStyle(ButtonStyle.Success);
    const row = new ActionRowBuilder().addComponents(loseButton, winButton);
    await interaction.reply({ content: 'Select:', components: [row], ephemeral: true });
    return;
  }
});

// ── Text commands (! and / prefixes) ──────────────────────────────────────────
discord.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  const content = message.content.trim();
  if (!content.startsWith('!') && !content.startsWith('/')) return;

  // Only allow administrators to use text commands
  if (!message.member?.permissions.has(PermissionFlagsBits.Administrator)) {
    await message.reply('❌ Only administrators can use this command.');
    return;
  }

  const body = content.slice(1);
  const spaceIdx = body.indexOf(' ');
  const cmd = (spaceIdx === -1 ? body : body.slice(0, spaceIdx)).toLowerCase();
  const rest = spaceIdx === -1 ? '' : body.slice(spaceIdx + 1).trim();

  // pa | pay
  if (cmd === 'pa' || cmd === 'pay') {
    const args = rest.split(/\s+/).filter(Boolean);
    if (args.length < 2) {
      await message.reply('❌ Usage: `!pa <user> <amount>` or `/pay <user> <amount>`');
      return;
    }

    const user = args[0];
    const amount = args[1];

    if (!/^[a-zA-Z0-9_.]{1,16}$/.test(user)) {
      await message.reply('❌ Invalid username.');
      return;
    }

    if (!/^\d+(\.\d+)?$/.test(amount) || parseFloat(amount) <= 0) {
      await message.reply('❌ Invalid amount. Must be a positive number.');
      return;
    }

    if (!mcBot || !botReady) {
      await message.reply('❌ Bot is not connected.');
      return;
    }

    console.log(`[CMD] /pay ${user} ${amount}`);
    mcBot.chat(`/pay ${user} ${amount}`);
    await message.reply(`💸 Sent: \`/pay ${user} ${amount}\``);
    return;
  }

  // cmd
  if (cmd === 'cmd') {
    if (!rest) {
      await message.reply('❌ Usage: `!cmd <command>` or `/cmd <command>`');
      return;
    }

    if (!mcBot || !botReady) {
      await message.reply('❌ Bot is not connected.');
      return;
    }

    console.log(`[CMD] /${rest}`);
    mcBot.chat(`/${rest}`);
    await message.reply(`⚙️ Ran: \`/${rest}\``);
    return;
  }

  // chat
  if (cmd === 'chat') {
    if (!rest) {
      await message.reply('❌ Usage: `!chat <message>` or `/chat <message>`');
      return;
    }

    if (!mcBot || !botReady) {
      await message.reply('❌ Bot is not connected.');
      return;
    }

    console.log(`[CMD] chat: ${rest}`);
    mcBot.chat(rest);
    await message.reply(`💬 Sent: ${rest}`);
    return;
  }

  // bal
  if (cmd === 'bal') {
    if (!mcBot || !botReady) {
      await message.reply('❌ Bot is not connected.');
      return;
    }

    console.log('[CMD] /bal');
    mcBot.chat('/bal');
    const currentBot = mcBot;
    const response = await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        currentBot.removeListener('messagestr', handler);
        resolve(null);
      }, BAL_TIMEOUT);
      function handler(msg) {
        const text = String(msg).trim();
        if (text && (text.toLowerCase().includes('balance') || text.toLowerCase().includes('you have'))) {
          clearTimeout(timeout);
          currentBot.removeListener('messagestr', handler);
          resolve(text);
        }
      }
      currentBot.on('messagestr', handler);
    });
    await message.reply(response ? `💰 ${response}` : '⏱️ No response from server.');
    return;
  }

  // status
  if (cmd === 'status') {
    const connected = !!(mcBot && botReady);
    const uptime    = connected && connectTime
      ? Math.floor((Date.now() - connectTime) / 1000)
      : null;

    const embed = new EmbedBuilder()
      .setTitle('🤖 Bot Status')
      .setColor(connected ? 0x00b300 : 0xcc0000)
      .addFields(
        { name: 'Status',        value: connected ? '🟢 Connected' : '🔴 Disconnected', inline: true },
        { name: 'Server',        value: `${config.serverHost}:${config.serverPort}`,    inline: true },
        { name: 'Auto-reconnect',value: autoReconnect ? 'Enabled' : 'Disabled',         inline: true },
      );

    if (uptime !== null) {
      const h = Math.floor(uptime / 3600);
      const m = Math.floor((uptime % 3600) / 60);
      const s = uptime % 60;
      embed.addFields({ name: 'Uptime', value: `${h}h ${m}m ${s}s`, inline: true });
    }

    await message.reply({ embeds: [embed] });
    return;
  }

  // auth
  if (cmd === 'auth') {
    await message.reply('🔐 Starting Microsoft authentication… check this channel for the device code.');
    pendingMsaCode = (data) => {
      message.channel.send(
        `🔐 **Microsoft Auth Required**\nGo to: <${data.verification_uri}>\nEnter code: \`${data.user_code}\`\nExpires in ${Math.floor(data.expires_in / 60)} minutes.`
      ).catch(() => {});
    };
    if (!mcBot) createMcBot();
    return;
  }

  // connect
  if (cmd === 'connect') {
    autoReconnect = true;
    if (mcBot) {
      await message.reply('⚠️ Bot is already connected.');
    } else {
      createMcBot();
      await message.reply('🔌 Connecting…');
    }
    return;
  }

  // disconnect
  if (cmd === 'disconnect') {
    autoReconnect = false;
    stopAutoDelivery();
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (mcBot) {
      try { mcBot.quit(); } catch (_) {}
      mcBot = null;
    }
    await message.reply('⛔ Bot disconnected. Auto-reconnect disabled.');
    return;
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────
loadProcessedOrders();
discord.login(config.discordToken).catch(err => {
  console.error('Failed to log in to Discord:', err.message);
  process.exit(1);
});
