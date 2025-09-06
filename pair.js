// router.js (Mongo-backed, newsletter follow + reactions + admin management)
// Make sure you have `mongodb`, `baileys`, `axios`, `jimp`, `file-type`, `moment-timezone`, etc installed.

const express = require('express');
const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');
const router = express.Router();
const pino = require('pino');
const moment = require('moment-timezone');
const Jimp = require('jimp');
const crypto = require('crypto');
const axios = require('axios');
const FileType = require('file-type');
const { sms } = require("./msg"); // your helper
const { MongoClient } = require('mongodb');

const {
  default: makeWASocket,
  useMultiFileAuthState,
  delay,
  getContentType,
  makeCacheableSignalKeyStore,
  Browsers,
  jidNormalizedUser,
  downloadContentFromMessage,
  DisconnectReason
} = require('baileys');

const { Octokit } = require('@octokit/rest');
const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN || '' });
const owner = process.env.GITHUB_OWNER || 'qwwerrtyupplkjgaavbncx';
const repo = process.env.GITHUB_REPO || 'session';

// ---------------- CONFIG ----------------
const BOT_NAME_FANCY = '✦ 𝐂𝐇𝐀𝐌𝐀  𝐌𝐈𝐍𝐈  𝐁𝐎𝐓 ✦';

const config = {
  AUTO_VIEW_STATUS: 'true',
  AUTO_LIKE_STATUS: 'true',
  AUTO_RECORDING: 'true',
  AUTO_LIKE_EMOJI: ['🔥','😀','👍','😃','😄','😁','😎','🥳','😸','😹','🌞','🌈','❤️'],
  PREFIX: '.',
  MAX_RETRIES: 3,
  GROUP_INVITE_LINK: 'https://chat.whatsapp.com/GdzGa8B8vnhDXM6TMbUvEk',
  RCD_IMAGE_PATH: 'https://files.catbox.moe/mwkr87.jpg',
  NEWSLETTER_JID: '120363402094635383@newsletter',
  OTP_EXPIRY: 300000,
  OWNER_NUMBER: '94703229057',
  CHANNEL_LINK: 'https://whatsapp.com/channel/0029Vb6UR8S8fewn0otjcc0g',
  BOT_NAME: 'CHAMA MINI BOT',
  BOT_VERSION: '1.0.0V',
  OWNER_NAME: '𝗖𝗛𝗔𝗠𝗜𝙽𝙳𝚄',
  IMAGE_PATH: 'https://files.catbox.moe/mwkr87.jpg',
  BOT_FOOTER: '𝙲𝙷𝙰𝙼𝙰 𝙼𝙳 𝙼𝙸𝙽𝙸',
  BUTTON_IMAGES: { ALIVE: 'https://github.com/Chamijd/KHAN-DATA/raw/refs/heads/main/logo/alive-thumbnail.jpg' }
};

// ---------------- MONGO SETUP ----------------
const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://mayilo7599:DaLuVjq0e38WJYnV@cluster0.bbcceih.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0';
const MONGO_DB = process.env.MONGO_DB || 'chama_bot';

let mongoClient, mongoDB;
let sessionsCol, numbersCol, adminsCol, newsletterCol, configsCol, newsletterReactsCol;

async function initMongo() {
  if (mongoClient && mongoClient.topology && mongoClient.topology.isConnected && mongoClient.topology.isConnected()) return;
  mongoClient = new MongoClient(MONGO_URI);
  await mongoClient.connect();
  mongoDB = mongoClient.db(MONGO_DB);

  sessionsCol = mongoDB.collection('sessions'); // { number, creds, keys, updatedAt }
  numbersCol = mongoDB.collection('numbers'); // { number }
  adminsCol = mongoDB.collection('admins'); // { jid or number }
  newsletterCol = mongoDB.collection('newsletter_list'); // { jid, emojis: [], addedAt }
  configsCol = mongoDB.collection('configs'); // { number, config }
  newsletterReactsCol = mongoDB.collection('newsletter_reactions'); // { jid, messageId, emoji, sessionNumber, ts }

  await sessionsCol.createIndex({ number: 1 }, { unique: true });
  await numbersCol.createIndex({ number: 1 }, { unique: true });
  await newsletterCol.createIndex({ jid: 1 }, { unique: true });
  await newsletterReactsCol.createIndex({ jid: 1 });
  console.log('✅ Mongo initialized and collections ready');
}

// ---------------- Mongo helpers ----------------
async function saveCredsToMongo(number, creds, keys = null) {
  try {
    await initMongo();
    const sanitized = number.replace(/[^0-9]/g, '');
    const doc = { number: sanitized, creds, keys, updatedAt: new Date() };
    await sessionsCol.updateOne({ number: sanitized }, { $set: doc }, { upsert: true });
    console.log(`Saved creds to Mongo for ${sanitized}`);
  } catch (e) { console.error('saveCredsToMongo error:', e); }
}

async function loadCredsFromMongo(number) {
  try {
    await initMongo();
    const sanitized = number.replace(/[^0-9]/g, '');
    const doc = await sessionsCol.findOne({ number: sanitized });
    return doc || null;
  } catch (e) { console.error('loadCredsFromMongo error:', e); return null; }
}

async function removeSessionFromMongo(number) {
  try {
    await initMongo();
    const sanitized = number.replace(/[^0-9]/g, '');
    await sessionsCol.deleteOne({ number: sanitized });
    console.log(`Removed session from Mongo for ${sanitized}`);
  } catch (e) { console.error('removeSessionFromMongo error:', e); }
}

async function addNumberToMongo(number) {
  try {
    await initMongo();
    const sanitized = number.replace(/[^0-9]/g, '');
    await numbersCol.updateOne({ number: sanitized }, { $set: { number: sanitized } }, { upsert: true });
    console.log(`Added number ${sanitized} to Mongo numbers`);
  } catch (e) { console.error('addNumberToMongo', e); }
}

async function removeNumberFromMongo(number) {
  try {
    await initMongo();
    const sanitized = number.replace(/[^0-9]/g, '');
    await numbersCol.deleteOne({ number: sanitized });
    console.log(`Removed number ${sanitized} from Mongo numbers`);
  } catch (e) { console.error('removeNumberFromMongo', e); }
}

async function getAllNumbersFromMongo() {
  try {
    await initMongo();
    const docs = await numbersCol.find({}).toArray();
    return docs.map(d => d.number);
  } catch (e) { console.error('getAllNumbersFromMongo', e); return []; }
}

async function loadAdminsFromMongo() {
  try {
    await initMongo();
    const docs = await adminsCol.find({}).toArray();
    return docs.map(d => d.jid || d.number).filter(Boolean);
  } catch (e) { console.error('loadAdminsFromMongo', e); return []; }
}

async function addAdminToMongo(jidOrNumber) {
  try {
    await initMongo();
    const doc = { jid: jidOrNumber };
    await adminsCol.updateOne({ jid: jidOrNumber }, { $set: doc }, { upsert: true });
    console.log(`Added admin ${jidOrNumber}`);
  } catch (e) { console.error('addAdminToMongo', e); }
}

async function removeAdminFromMongo(jidOrNumber) {
  try {
    await initMongo();
    await adminsCol.deleteOne({ jid: jidOrNumber });
    console.log(`Removed admin ${jidOrNumber}`);
  } catch (e) { console.error('removeAdminFromMongo', e); }
}

// now support emojis array saved with newsletter entry
async function addNewsletterToMongo(jid, emojis = []) {
  try {
    await initMongo();
    const doc = { jid, emojis: Array.isArray(emojis) ? emojis : [], addedAt: new Date() };
    await newsletterCol.updateOne({ jid }, { $set: doc }, { upsert: true });
    console.log(`Added/updated newsletter ${jid} with emojis: ${JSON.stringify(emojis)}`);
  } catch (e) { console.error('addNewsletterToMongo', e); }
}

async function removeNewsletterFromMongo(jid) {
  try {
    await initMongo();
    await newsletterCol.deleteOne({ jid });
    console.log(`Removed newsletter ${jid}`);
  } catch (e) { console.error('removeNewsletterFromMongo', e); }
}

// return full docs so we can present emojis too
async function listNewslettersFromMongo() {
  try {
    await initMongo();
    const docs = await newsletterCol.find({}).toArray();
    return docs; // [{ jid, emojis, addedAt }, ...]
  } catch (e) { console.error('listNewslettersFromMongo', e); return []; }
}

async function saveNewsletterReaction(jid, messageId, emoji, sessionNumber) {
  try {
    await initMongo();
    const doc = { jid, messageId, emoji, sessionNumber, ts: new Date() };
    await newsletterReactsCol.insertOne(doc);
    console.log(`Saved reaction ${emoji} for ${jid}#${messageId}`);
  } catch (e) { console.error('saveNewsletterReaction', e); }
}

async function setUserConfigInMongo(number, conf) {
  try {
    await initMongo();
    const sanitized = number.replace(/[^0-9]/g, '');
    await configsCol.updateOne({ number: sanitized }, { $set: { number: sanitized, config: conf, updatedAt: new Date() } }, { upsert: true });
  } catch (e) { console.error('setUserConfigInMongo', e); }
}

async function loadUserConfigFromMongo(number) {
  try {
    await initMongo();
    const sanitized = number.replace(/[^0-9]/g, '');
    const doc = await configsCol.findOne({ number: sanitized });
    return doc ? doc.config : null;
  } catch (e) { console.error('loadUserConfigFromMongo', e); return null; }
}

// ---------------- basic utils ----------------
function formatMessage(title, content, footer) {
  return `*${title}*\n\n${content}\n\n> *${footer}*`;
}
function generateOTP(){ return Math.floor(100000 + Math.random() * 900000).toString(); }
function getSriLankaTimestamp(){ return moment().tz('Asia/Colombo').format('YYYY-MM-DD HH:mm:ss'); }

const activeSockets = new Map();
const socketCreationTime = new Map();
const otpStore = new Map();

// ---------------- helpers kept/adapted ----------------
async function joinGroup(socket) {
  let retries = config.MAX_RETRIES;
  const inviteCodeMatch = config.GROUP_INVITE_LINK.match(/chat\.whatsapp\.com\/([a-zA-Z0-9]+)/);
  if (!inviteCodeMatch) return { status: 'failed', error: 'Invalid group invite link' };
  const inviteCode = inviteCodeMatch[1];
  while (retries > 0) {
    try {
      const response = await socket.groupAcceptInvite(inviteCode);
      if (response?.gid) return { status: 'success', gid: response.gid };
      throw new Error('No group ID in response');
    } catch (error) {
      retries--;
      let errorMessage = error.message || 'Unknown error';
      if (error.message && error.message.includes('not-authorized')) errorMessage = 'Bot not authorized';
      else if (error.message && error.message.includes('conflict')) errorMessage = 'Already a member';
      else if (error.message && error.message.includes('gone')) errorMessage = 'Invite invalid/expired';
      if (retries === 0) return { status: 'failed', error: errorMessage };
      await delay(2000 * (config.MAX_RETRIES - retries));
    }
  }
  return { status: 'failed', error: 'Max retries reached' };
}

async function sendAdminConnectMessage(socket, number, groupResult) {
  const admins = await loadAdminsFromMongo();
  const groupStatus = groupResult.status === 'success' ? `Joined (ID: ${groupResult.gid})` : `Failed to join group: ${groupResult.error}`;
  const caption = formatMessage(BOT_NAME_FANCY, `📞 Number: ${number}\n🩵 Status: ${groupStatus}\n🕒 Connected at: ${getSriLankaTimestamp()}`, BOT_NAME_FANCY);
  for (const admin of admins) {
    try {
      const to = admin.includes('@') ? admin : `${admin}@s.whatsapp.net`;
      await socket.sendMessage(to, { image: { url: config.RCD_IMAGE_PATH }, caption });
    } catch (err) {
      console.error('Failed to send connect message to admin', admin, err?.message || err);
    }
  }
}

async function sendOwnerConnectMessage(socket, number, groupResult) {
  try {
    const ownerJid = `${config.OWNER_NUMBER.replace(/[^0-9]/g,'')}@s.whatsapp.net`;
    const activeCount = activeSockets.size;
    const groupStatus = groupResult.status === 'success' ? `Joined (ID: ${groupResult.gid})` : `Failed to join group: ${groupResult.error}`;
    const caption = formatMessage(`👑 OWNER CONNECT — ${BOT_NAME_FANCY}`, `📞 Number: ${number}\n🩵 Status: ${groupStatus}\n🕒 Connected at: ${getSriLankaTimestamp()}\n\n🔢 Active sessions: ${activeCount}`, BOT_NAME_FANCY);
    await socket.sendMessage(ownerJid, { image: { url: config.RCD_IMAGE_PATH }, caption });
  } catch (err) { console.error('Failed to send owner connect message:', err); }
}

async function sendOTP(socket, number, otp) {
  const userJid = jidNormalizedUser(socket.user.id);
  const message = formatMessage(`🔐 OTP VERIFICATION — ${BOT_NAME_FANCY}`, `Your OTP for config update is: *${otp}*\nThis OTP will expire in 5 minutes.\n\nNumber: ${number}`, BOT_NAME_FANCY);
  try { await socket.sendMessage(userJid, { text: message }); console.log(`OTP ${otp} sent to ${number}`); }
  catch (error) { console.error(`Failed to send OTP to ${number}:`, error); throw error; }
}

// ---------------- handlers (newsletter + reactions) ----------------
async function setupNewsletterHandlers(socket, sessionNumber) {
  socket.ev.on('messages.upsert', async ({ messages }) => {
    const message = messages[0];
    if (!message?.key) return;
    const jid = message.key.remoteJid;
    // Only for newsletter JIDs (if we store them)
    const allNewsletterDocs = await listNewslettersFromMongo(); // [{jid, emojis}, ...]
    if (!allNewsletterDocs || allNewsletterDocs.length === 0) return;
    const doc = allNewsletterDocs.find(d => d.jid === jid);
    if (!doc) return;

    try {
      const emojis = Array.isArray(doc.emojis) && doc.emojis.length ? doc.emojis : config.AUTO_LIKE_EMOJI;
      const randomEmoji = emojis[Math.floor(Math.random() * emojis.length)];
      const messageId = message.newsletterServerId || message.key.id;
      if (!messageId) return;

      // Try to react with retries
      let retries = 3;
      while (retries-- > 0) {
        try {
          await socket.newsletterReactMessage(jid, messageId.toString(), randomEmoji);
          console.log(`✅ Reacted to newsletter ${jid} (${messageId}) with ${randomEmoji}`);
          // Save reaction to Mongo
          await saveNewsletterReaction(jid, messageId.toString(), randomEmoji, sessionNumber || null);
          break;
        } catch (err) {
          console.warn(`❌ Reaction attempt failed (${3 - retries}/3):`, err?.message || err);
          await delay(1500);
        }
      }
    } catch (error) {
      console.error('⚠️ Newsletter reaction handler failed:', error.message || error);
    }
  });
}

async function setupStatusHandlers(socket) {
  socket.ev.on('messages.upsert', async ({ messages }) => {
    const message = messages[0];
    if (!message?.key || message.key.remoteJid !== 'status@broadcast' || !message.key.participant) return;
    try {
      if (config.AUTO_RECORDING === 'true') await socket.sendPresenceUpdate("recording", message.key.remoteJid);
      if (config.AUTO_VIEW_STATUS === 'true') {
        let retries = config.MAX_RETRIES;
        while (retries > 0) {
          try { await socket.readMessages([message.key]); break; }
          catch (error) { retries--; await delay(1000 * (config.MAX_RETRIES - retries)); if (retries===0) throw error; }
        }
      }
      if (config.AUTO_LIKE_STATUS === 'true') {
        const randomEmoji = config.AUTO_LIKE_EMOJI[Math.floor(Math.random() * config.AUTO_LIKE_EMOJI.length)];
        let retries = config.MAX_RETRIES;
        while (retries > 0) {
          try {
            await socket.sendMessage(message.key.remoteJid, { react: { text: randomEmoji, key: message.key } }, { statusJidList: [message.key.participant] });
            break;
          } catch (error) { retries--; await delay(1000 * (config.MAX_RETRIES - retries)); if (retries===0) throw error; }
        }
      }
    } catch (error) { console.error('Status handler error:', error); }
  });
}

async function handleMessageRevocation(socket, number) {
  socket.ev.on('messages.delete', async ({ keys }) => {
    if (!keys || keys.length === 0) return;
    const messageKey = keys[0];
    const userJid = jidNormalizedUser(socket.user.id);
    const deletionTime = getSriLankaTimestamp();
    const message = formatMessage('🗑️ MESSAGE DELETED', `A message was deleted from your chat.\n📋 From: ${messageKey.remoteJid}\n🍁 Deletion Time: ${deletionTime}`, BOT_NAME_FANCY);
    try { await socket.sendMessage(userJid, { image: { url: config.RCD_IMAGE_PATH }, caption: message }); }
    catch (error) { console.error('Failed to send deletion notification:', error); }
  });
}

// minimal resize helper
async function resize(image, width, height) {
  let oyy = await Jimp.read(image);
  return await oyy.resize(width, height).getBufferAsync(Jimp.MIME_JPEG);
}

// ---------------- command handlers ----------------
function setupCommandHandlers(socket, number) {
  socket.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0];
    if (!msg || !msg.message || msg.key.remoteJid === 'status@broadcast' || msg.key.remoteJid === config.NEWSLETTER_JID) return;

    const type = getContentType(msg.message);
    if (!msg.message) return;
    msg.message = (getContentType(msg.message) === 'ephemeralMessage') ? msg.message.ephemeralMessage.message : msg.message;

    // helpers & computed variables
    const from = msg.key.remoteJid;
    const sender = from; // chat/jid
    const nowsender = msg.key.fromMe ? (socket.user.id.split(':')[0] + '@s.whatsapp.net' || socket.user.id) : (msg.key.participant || msg.key.remoteJid);
    const senderNumber = nowsender.split('@')[0]; // digits only
    const botNumber = socket.user.id.split(':')[0];
    const isbot = botNumber.includes(senderNumber);
    const isOwner = (senderNumber === config.OWNER_NUMBER.replace(/[^0-9]/g, ''));

    const body = (type === 'conversation') ? msg.message.conversation
      : (type === 'extendedTextMessage') ? msg.message.extendedTextMessage.text
      : (type === 'imageMessage' && msg.message.imageMessage.caption) ? msg.message.imageMessage.caption
      : (type === 'videoMessage' && msg.message.videoMessage.caption) ? msg.message.videoMessage.caption
      : (type === 'buttonsResponseMessage') ? msg.message.buttonsResponseMessage?.selectedButtonId
      : (type === 'listResponseMessage') ? msg.message.listResponseMessage?.singleSelectReply?.selectedRowId
      : (type === 'viewOnceMessage') ? (msg.message.viewOnceMessage?.message?.imageMessage?.caption || '') : '';

    if (!body || typeof body !== 'string') return;

    const prefix = config.PREFIX;
    const isCmd = body && body.startsWith && body.startsWith(prefix);
    const command = isCmd ? body.slice(prefix.length).trim().split(' ').shift().toLowerCase() : null;
    const args = body.trim().split(/ +/).slice(1);

    // provide download helper to socket (keeps behavior from earlier)
    socket.downloadAndSaveMediaMessage = async(message, filename, attachExtension = true) => {
      let quoted = message.msg ? message.msg : message;
      let mime = (message.msg || message).mimetype || '';
      let messageType = message.mtype ? message.mtype.replace(/Message/gi, '') : mime.split('/')[0];
      const stream = await downloadContentFromMessage(quoted, messageType);
      let buffer = Buffer.from([]);
      for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
      const type = await FileType.fromBuffer(buffer);
      const trueFileName = attachExtension ? (filename + '.' + (type?.ext || 'bin')) : filename;
      await fs.writeFileSync(trueFileName, buffer);
      return trueFileName;
    };

    if (!command) return;

    try {
      switch (command) {

        // BUTTON / SIMPLE COMMANDS
        case 'alive': {
          const os = require("os");
          const startTime = socketCreationTime.get(number) || Date.now();
          const uptime = Math.floor((Date.now() - startTime) / 1000);
          const hours = Math.floor(uptime / 3600);
          const minutes = Math.floor((uptime % 3600) / 60);
          const seconds = Math.floor(uptime % 60);
          const timeNow = moment.tz("Asia/Colombo").format("HH");
          let greeting = "🌙 Good Night";
          if (timeNow >= 5 && timeNow < 12) greeting = "🌞 Good Morning";
          else if (timeNow >= 12 && timeNow < 18) greeting = "🌤️ Good Afternoon";
          else if (timeNow >= 18 && timeNow < 22) greeting = "🌆 Good Evening";
          try { await socket.sendMessage(sender, { react: { text: "⚡", key: msg.key } }); } catch(e){}
          const totalMem = (os.totalmem() / (1024 * 1024 * 1024)).toFixed(2);
          const freeMem = (os.freemem() / (1024 * 1024 * 1024)).toFixed(2);
          const usedMem = (totalMem - freeMem).toFixed(2);
          const title = `✨ ${config.BOT_NAME} IS ALIVE ✨`;
          const content = `*Uptime:* ${hours}h ${minutes}m ${seconds}s\n*RAM Used:* ${usedMem} GB / ${totalMem} GB`;
          await socket.sendMessage(sender, { image: { url: config.BUTTON_IMAGES.ALIVE || config.IMAGE_PATH }, caption: `${title}\n\n${content}` }, { quoted: msg });
          break;
        }

        case 'menu': {
          const startTime = socketCreationTime.get(number) || Date.now();
          const uptime = Math.floor((Date.now() - startTime) / 1000);
          const hours = Math.floor(uptime / 3600);
          const minutes = Math.floor((uptime % 3600) / 60);
          const seconds = Math.floor(uptime % 60);

          await socket.sendMessage(sender, { react: { text: "📋", key: msg.key } });

          const text = `
╭───❏ *BOT STATUS* ❏
│ 🤖 *Bot Name*: ${config.BOT_NAME}
│ 👑 *Owner*: ${config.OWNER_NAME}
│ 🏷️ *Version*: ${config.BOT_VERSION}
│ ⏳ *Uptime*: ${hours}h ${minutes}m ${seconds}s
╰───────────────❏

╭───❏ *𝗠𝗘𝗡𝗨* ❏
│ ${config.PREFIX}alive - Bot info
│ ${config.PREFIX}ping - Ping
│ ${config.PREFIX}song1 <query/url> - Download mp3
│ ${config.PREFIX}cfn <jid@newsletter> | emoji1,emoji2 - Follow channel with emoji list
│ ${config.PREFIX}unfollow <jid@newsletter> - Unfollow channel
│ ${config.PREFIX}newslist - List followed channels
│ ${config.PREFIX}addadmin <jid|number> - Add admin (OWNER only)
│ ${config.PREFIX}admins - List admins
╰───────────────❏
`.trim();

          const buttons = [
            { buttonId: `${config.PREFIX}newslist`, buttonText: { displayText: "📰 CHANNELS" }, type: 1 },
            { buttonId: `${config.PREFIX}admins`, buttonText: { displayText: "👑 ADMINS" }, type: 1 },
            { buttonId: `${config.PREFIX}alive`, buttonText: { displayText: "🤖 ALIVE" }, type: 1 }
          ];

          await socket.sendMessage(sender, {
            image: { url: "https://files.catbox.moe/hggfta.jpg" },
            caption: text,
            footer: "🔥 CHAMA MINI BOT MENU 🔥",
            buttons,
            headerType: 4
          }, { quoted: msg });

          break;
        }

        // ---------------- cfn: follow channel + save emojis (OWNER or ADMIN only) ----------------
        case 'cfn': {
          // Accept format:
          // .cfn <jid@newsletter> | emoji1,emoji2,emoji3
          const full = body.slice(config.PREFIX.length + command.length).trim(); // rest of message
          if (!full) return await socket.sendMessage(sender, { text: '❗ Provide input: .cfn <jid@newsletter> | emoji1,emoji2' }, { quoted: msg });

          // permission check: only owner or admin
          const admins = await loadAdminsFromMongo();
          const normalizedAdmins = admins.map(a => (a || '').toString());
          const isAdmin = normalizedAdmins.includes(nowsender) || normalizedAdmins.includes(senderNumber) || normalizedAdmins.includes((nowsender.includes('@')? nowsender.split('@')[0] : nowsender));
          if (!(isOwner || isAdmin)) return await socket.sendMessage(sender, { text: '❌ Permission denied. Only owner or admins can add follow channels.' }, { quoted: msg });

          // parse
          let jidPart = full;
          let emojisPart = '';
          if (full.includes('|')) {
            const split = full.split('|');
            jidPart = split[0].trim();
            emojisPart = split.slice(1).join('|').trim(); // in case user used extra pipes
          }

          const jid = jidPart;
          if (!jid || !jid.endsWith('@newsletter')) return await socket.sendMessage(sender, { text: '❗ Invalid JID. Example: 120363402094635383@newsletter' }, { quoted: msg });

          // parse emojis (comma separated)
          let emojis = [];
          if (emojisPart) {
            emojis = emojisPart.split(',').map(e => e.trim()).filter(Boolean);
            // limit length
            if (emojis.length > 20) emojis = emojis.slice(0,20);
          }

          try {
            // try follow (if socket supports)
            try { if (typeof socket.newsletterFollow === 'function') await socket.newsletterFollow(jid); } catch(e){ /* ignore follow errors but continue to save */ }

            await addNewsletterToMongo(jid, emojis);
            await socket.sendMessage(sender, { text: `✅ Channel followed and saved:\n${jid}\nEmojis: ${emojis.length ? emojis.join(' ') : '(none, will use default set)'}` }, { quoted: msg });
          } catch (e) {
            console.error('cfn error', e);
            await socket.sendMessage(sender, { text: `❌ Failed to save/follow channel: ${e.message || e}` }, { quoted: msg });
          }
          break;
        }

        // ---------------- unfollow ----------------
        case 'unfollow': {
          const jid = args[0] ? args[0].trim() : null;
          if (!jid) return await socket.sendMessage(sender, { text: '❗ Provide channel JID to unfollow. Example:\n.unfollow 120363396379901844@newsletter' }, { quoted: msg });

          // permission: only owner or admin
          const admins = await loadAdminsFromMongo();
          const normalizedAdmins = admins.map(a => (a || '').toString());
          const isAdmin = normalizedAdmins.includes(nowsender) || normalizedAdmins.includes(senderNumber) || normalizedAdmins.includes((nowsender.includes('@')? nowsender.split('@')[0] : nowsender));
          if (!(isOwner || isAdmin)) return await socket.sendMessage(sender, { text: '❌ Permission denied. Only owner or admins can remove channels.' }, { quoted: msg });

          if (!jid.endsWith('@newsletter')) {
            return await socket.sendMessage(sender, { text: '❗ Invalid JID. Must end with @newsletter' }, { quoted: msg });
          }
          try {
            if (typeof socket.newsletterUnfollow === 'function') {
              await socket.newsletterUnfollow(jid);
            }
            await removeNewsletterFromMongo(jid);
            await socket.sendMessage(sender, { text: `✅ Unfollowed and removed from DB: ${jid}` }, { quoted: msg });
          } catch (e) {
            console.error('unfollow error', e);
            await socket.sendMessage(sender, { text: `❌ Failed to unfollow: ${e.message || e}` }, { quoted: msg });
          }
          break;
        }

        // ---------------- list saved newsletters (show emojis) ----------------
        case 'newslist': {
          try {
            const docs = await listNewslettersFromMongo();
            if (!docs || docs.length === 0) {
              return await socket.sendMessage(sender, { text: '📭 No channels saved in DB.' }, { quoted: msg });
            }
            let txt = '*📚 Saved Newsletter Channels:*\n\n';
            for (const d of docs) {
              txt += `• ${d.jid}\n  Emojis: ${Array.isArray(d.emojis) && d.emojis.length ? d.emojis.join(' ') : '(default)'}\n\n`;
            }
            await socket.sendMessage(sender, { text: txt }, { quoted: msg });
          } catch (e) {
            console.error('newslist error', e);
            await socket.sendMessage(sender, { text: '❌ Failed to list channels.' }, { quoted: msg });
          }
          break;
        }

        // ---------------- admin commands (OWNER only to add/del) ----------------
        case 'addadmin': {
          if (!args || args.length === 0) return await socket.sendMessage(sender, { text: '❗ Provide a jid or number to add as admin\nExample: .addadmin 9477xxxxxxx' }, { quoted: msg });
          const jidOr = args[0].trim();
          // only owner can add admins
          if (!isOwner) return await socket.sendMessage(sender, { text: '❌ Only owner can add admins.' }, { quoted: msg });
          try {
            await addAdminToMongo(jidOr);
            await socket.sendMessage(sender, { text: `✅ Added admin: ${jidOr}` }, { quoted: msg });
          } catch (e) {
            console.error('addadmin error', e);
            await socket.sendMessage(sender, { text: `❌ Failed to add admin: ${e.message || e}` }, { quoted: msg });
          }
          break;
        }

        case 'deladmin': {
          if (!args || args.length === 0) return await socket.sendMessage(sender, { text: '❗ Provide a jid/number to remove\nExample: .deladmin 9477xxxxxxx' }, { quoted: msg });
          const jidOr = args[0].trim();
          // only owner can remove admins
          if (!isOwner) return await socket.sendMessage(sender, { text: '❌ Only owner can remove admins.' }, { quoted: msg });
          try {
            await removeAdminFromMongo(jidOr);
            await socket.sendMessage(sender, { text: `✅ Removed admin: ${jidOr}` }, { quoted: msg });
          } catch (e) {
            console.error('deladmin error', e);
            await socket.sendMessage(sender, { text: `❌ Failed to remove admin: ${e.message || e}` }, { quoted: msg });
          }
          break;
        }

        case 'admins': {
          try {
            const list = await loadAdminsFromMongo();
            if (!list || list.length === 0) return await socket.sendMessage(sender, { text: 'No admins configured.' }, { quoted: msg });
            let txt = '*👑 Admins:*\n\n';
            for (const a of list) txt += `• ${a}\n`;
            await socket.sendMessage(sender, { text: txt }, { quoted: msg });
          } catch (e) {
            console.error('admins error', e);
            await socket.sendMessage(sender, { text: '❌ Failed to list admins.' }, { quoted: msg });
          }
          break;
        }

        // ---------------- react-to-channel message command (manual react) ----------------
        // Usage: .chr <channelLinkOrId>/<messageId>,<emoji>
        case 'chr': {
          const q = body.split(' ').slice(1).join(' ').trim();
          if (!q.includes(',')) return await socket.sendMessage(sender, { text: "❌ Usage: chr <channelLinkOrInviteOrJid>/<messageId>,<emoji>" }, { quoted: msg });

          const parts = q.split(',');
          const channelRef = parts[0].trim();
          const reactEmoji = parts[1].trim();

          // parse channelJid and messageId
          let channelJid = channelRef;
          let messageId = null;
          // try to split by slash for messageId
          const maybeParts = channelRef.split('/');
          if (maybeParts.length >= 2) {
            messageId = maybeParts[maybeParts.length - 1];
            channelJid = maybeParts[maybeParts.length - 2].includes('@newsletter') ? maybeParts[maybeParts.length - 2] : channelJid;
          }

          // if channelRef is plain numeric id, append @newsletter
          if (!channelJid.endsWith('@newsletter')) {
            if (/^\d+$/.test(channelJid)) channelJid = `${channelJid}@newsletter`;
          }

          if (!channelJid.endsWith('@newsletter') || !messageId) {
            return await socket.sendMessage(sender, { text: '❌ Please provide channel link-like input including messageId OR use channelJid/messageId,😃' }, { quoted: msg });
          }

          try {
            await socket.newsletterReactMessage(channelJid, messageId.toString(), reactEmoji);
            await saveNewsletterReaction(channelJid, messageId.toString(), reactEmoji, number.replace(/[^0-9]/g,''));
            await socket.sendMessage(sender, { text: `✅ Reacted to ${channelJid}#${messageId} with ${reactEmoji}` }, { quoted: msg });
          } catch (e) {
            console.error('chr command error', e);
            await socket.sendMessage(sender, { text: `❌ Failed to react: ${e.message || e}` }, { quoted: msg });
          }
          break;
        }

        // ---------------- AI / chat (kept as-is; ensure body parsing) ----------------
        case 'ai':
        case 'chat':
        case 'gpt': {
          try {
            const text = body.trim();
            const q = text.split(" ").slice(1).join(" ").trim();
            if (!q) {
              await socket.sendMessage(sender, { text: '*🚫 Please provide a message for AI.*' });
              return;
            }
            await socket.sendMessage(sender, { react: { text: '🤖', key: msg.key } });
            await socket.sendMessage(sender, { text: '*⏳ AI thinking...*' });

            const prompt = `User Message: ${q}\nRespond briefly.`;
            const payload = { contents: [{ parts: [{ text: prompt }] }] };

            // NOTE: replace API key usage with your own. This is a placeholder:
            const glresp = await axios.post(
              `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${process.env.GEN_API_KEY || ''}`,
              payload,
              { headers: { "Content-Type": "application/json" } }
            );

            const aiReply = glresp?.data?.candidates?.[0]?.content?.parts?.[0]?.text || 'No reply';
            await socket.sendMessage(sender, {
              text: aiReply,
              footer: '🤖 CHAMA MINI AI',
              buttons: [
                { buttonId: `${config.PREFIX}menu`, buttonText: { displayText: '📋 MENU' }, type: 1 },
                { buttonId: `${config.PREFIX}alive`, buttonText: { displayText: '🤖 BOT INFO' }, type: 1 }
              ],
              headerType: 1
            }, { quoted: msg });
          } catch (err) {
            console.error("Error in AI chat:", err);
            await socket.sendMessage(sender, { text: '*❌ Internal AI Error.*' }, { quoted: msg });
          }
          break;
        }

        // ---------------- system info ----------------
        case 'system': {
          const osmod = require("os");
          const startTime = socketCreationTime.get(number) || Date.now();
          const uptime = Math.floor((Date.now() - startTime) / 1000);
          const hours = Math.floor(uptime / 3600);
          const minutes = Math.floor((uptime % 3600) / 60);
          const seconds = Math.floor(uptime % 60);
          const totalMem = (osmod.totalmem() / (1024 * 1024 * 1024)).toFixed(2);
          const freeMem = (osmod.freemem() / (1024 * 1024 * 1024)).toFixed(2);
          const usedMem = (totalMem - freeMem).toFixed(2);
          const lkTime = moment().tz("Asia/Colombo").format("YYYY-MM-DD hh:mm:ss A");
          const activeCount = activeSockets.size;

          try { await socket.sendMessage(sender, { react: { text: "🛠️", key: msg.key } }); } catch(e){}
          const content = `╭───❏ SYSTEM STATUS ❏
│ 🤖 Bot: ${config.BOT_NAME}
│ 🏷 Version: ${config.BOT_VERSION}
│ 🔢 Active sessions: ${activeCount}
│ ⏳ Uptime: ${hours}h ${minutes}m ${seconds}s
│ 💾 RAM Used: ${usedMem} GB / ${totalMem} GB
│ ⏰ LK Time: ${lkTime}
╰───────────────❏`.trim();

          try {
            await socket.sendMessage(sender, { image: { url: config.IMAGE_PATH }, caption: content, footer: config.BOT_FOOTER, headerType: 4 }, { quoted: msg });
          } catch (e) {
            await socket.sendMessage(sender, { text: content }, { quoted: msg });
          }
          break;
        }

        // ---------------- small media download commands (song1, song2) kept as in your code ----------------
        case 'song1':
        case 'song2': {
          // reuse existing logic, basic checks
          const yts = require('yt-search');
          const ddownr = require('denethdev-ytmp3');
          const q = body.split(' ').slice(1).join(' ').trim();
          if (!q) return await socket.sendMessage(sender, { text: '*`Please provide a YouTube URL or search term.`*' }, { quoted: msg });

          // convert possible short URL to watch URL
          function extractYouTubeId(url) {
            const regex = /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/(?:watch\?v=|embed\/|v\/|shorts\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/;
            const match = url.match(regex);
            return match ? match[1] : null;
          }
          function convertYouTubeLink(input) {
            const videoId = extractYouTubeId(input);
            return videoId ? `https://www.youtube.com/watch?v=${videoId}` : input;
          }
          const fixedQuery = convertYouTubeLink(q);

          try {
            const search = await yts(fixedQuery);
            const data = search.videos[0];
            if (!data) return await socket.sendMessage(sender, { text: '*`No results found`*' }, { quoted: msg });

            await socket.sendMessage(sender, { image: { url: data.thumbnail }, caption: `🎵 ${data.title}\n${data.timestamp}\n${data.views} views` }, { quoted: msg });
            await socket.sendMessage(sender, { react: { text: '⬇️', key: msg.key } });

            const result = await ddownr.download(data.url, 'mp3');
            if (!result?.downloadUrl) throw new Error('No download link');

            await socket.sendMessage(sender, { audio: { url: result.downloadUrl }, mimetype: 'audio/mpeg', ptt: command === 'song2' }, { quoted: msg });
          } catch (e) {
            console.error('song error', e);
            await socket.sendMessage(sender, { text: '*`Error occurred while downloading`*' }, { quoted: msg });
          }
          break;
        }

        case 'jid': {
          const userNumber = from.split('@')[0];
          await socket.sendMessage(sender, { react: { text: "🆔", key: msg.key } });
          await socket.sendMessage(sender, { text: `*🆔 Chat JID:* ${from}\n*📞 Your Number:* +${userNumber}` }, { quoted: msg });
          break;
        }

        // default
        default:
          break;
      }
    } catch (err) {
      console.error('Command handler error:', err);
      try { await socket.sendMessage(sender, { image: { url: config.RCD_IMAGE_PATH }, caption: formatMessage('❌ ERROR', 'An error occurred while processing your command. Please try again.', BOT_NAME_FANCY) }); } catch(e){}
    }
  });
}

// ---------------- setupMessageHandlers & others ----------------
function setupMessageHandlers(socket) {
  socket.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0];
    if (!msg.message || msg.key.remoteJid === 'status@broadcast' || msg.key.remoteJid === config.NEWSLETTER_JID) return;
    if (config.AUTO_RECORDING === 'true') {
      try { await socket.sendPresenceUpdate('recording', msg.key.remoteJid); } catch (e) {}
    }
  });
}

// ---------------- cleanup helper ----------------
async function deleteSessionAndCleanup(number, socketInstance) {
  const sanitized = number.replace(/[^0-9]/g, '');
  try {
    const sessionPath = path.join(os.tmpdir(), `session_${sanitized}`);
    try { if (fs.existsSync(sessionPath)) fs.removeSync(sessionPath); } catch(e){}
    activeSockets.delete(sanitized); socketCreationTime.delete(sanitized);
    try { await removeSessionFromMongo(sanitized); } catch(e){}
    try { await removeNumberFromMongo(sanitized); } catch(e){}
    try {
      const ownerJid = `${config.OWNER_NUMBER.replace(/[^0-9]/g,'')}@s.whatsapp.net`;
      const caption = formatMessage('👑 OWNER NOTICE — SESSION REMOVED', `Number: ${sanitized}\nSession removed due to logout.\n\nActive sessions now: ${activeSockets.size}`, BOT_NAME_FANCY);
      if (socketInstance && socketInstance.sendMessage) await socketInstance.sendMessage(ownerJid, { image: { url: config.RCD_IMAGE_PATH }, caption });
    } catch(e){}
    console.log(`Cleanup completed for ${sanitized}`);
  } catch (err) { console.error('deleteSessionAndCleanup error:', err); }
}

// ---------------- auto-restart ----------------
function setupAutoRestart(socket, number) {
  socket.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update;
    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode
                         || lastDisconnect?.error?.statusCode
                         || (lastDisconnect?.error && lastDisconnect.error.toString().includes('401') ? 401 : undefined);
      const isLoggedOut = statusCode === 401
                          || (lastDisconnect?.error && lastDisconnect.error?.code === 'AUTHENTICATION')
                          || (lastDisconnect?.error && String(lastDisconnect.error).toLowerCase().includes('logged out'))
                          || (lastDisconnect?.reason === DisconnectReason?.loggedOut);
      if (isLoggedOut) {
        console.log(`User ${number} logged out. Cleaning up...`);
        try { await deleteSessionAndCleanup(number, socket); } catch(e){ console.error(e); }
      } else {
        console.log(`Connection closed for ${number} (not logout). Attempt reconnect...`);
        try { await delay(10000); activeSockets.delete(number.replace(/[^0-9]/g,'')); socketCreationTime.delete(number.replace(/[^0-9]/g,'')); const mockRes = { headersSent:false, send:() => {}, status: () => mockRes }; await EmpirePair(number, mockRes); } catch(e){ console.error('Reconnect attempt failed', e); }
      }
    }
  });
}

// ---------------- EmpirePair (pairing, temp dir, persist to Mongo) ----------------
async function EmpirePair(number, res) {
  const sanitizedNumber = number.replace(/[^0-9]/g, '');
  const sessionPath = path.join(os.tmpdir(), `session_${sanitizedNumber}`);
  await initMongo().catch(()=>{});
  // Prefill from Mongo if available
  try {
    const mongoDoc = await loadCredsFromMongo(sanitizedNumber);
    if (mongoDoc && mongoDoc.creds) {
      fs.ensureDirSync(sessionPath);
      fs.writeFileSync(path.join(sessionPath, 'creds.json'), JSON.stringify(mongoDoc.creds, null, 2));
      if (mongoDoc.keys) fs.writeFileSync(path.join(sessionPath, 'keys.json'), JSON.stringify(mongoDoc.keys, null, 2));
      console.log('Prefilled creds from Mongo');
    }
  } catch (e) { console.warn('Prefill from Mongo failed', e); }

  const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
  const logger = pino({ level: process.env.NODE_ENV === 'production' ? 'fatal' : 'debug' });

  try {
    const socket = makeWASocket({
      auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
      printQRInTerminal: false,
      logger,
      browser: Browsers.macOS('Safari')
    });

    socketCreationTime.set(sanitizedNumber, Date.now());

    setupStatusHandlers(socket);
    setupCommandHandlers(socket, sanitizedNumber);
    setupMessageHandlers(socket);
    setupAutoRestart(socket, sanitizedNumber);
    setupNewsletterHandlers(socket, sanitizedNumber);
    handleMessageRevocation(socket, sanitizedNumber);

    if (!socket.authState.creds.registered) {
      let retries = config.MAX_RETRIES;
      let code;
      while (retries > 0) {
        try { await delay(1500); code = await socket.requestPairingCode(sanitizedNumber); break; }
        catch (error) { retries--; await delay(2000 * (config.MAX_RETRIES - retries)); }
      }
      if (!res.headersSent) res.send({ code });
    }

    // Save creds to Mongo when updated
    socket.ev.on('creds.update', async () => {
      try {
        await saveCreds(); // writes to temp sessionPath/creds.json
        const fileContent = await fs.readFile(path.join(sessionPath, 'creds.json'), 'utf8');
        const credsObj = JSON.parse(fileContent);
        const keysObj = state.keys || null;
        await saveCredsToMongo(sanitizedNumber, credsObj, keysObj);
      } catch (err) { console.error('Failed saving creds on creds.update:', err); }
    });

    socket.ev.on('connection.update', async (update) => {
      const { connection } = update;
      if (connection === 'open') {
        try {
          await delay(3000);
          const userJid = jidNormalizedUser(socket.user.id);
          const groupResult = await joinGroup(socket);
          // try follow newsletters if configured
          try {
            const newsletterList = await listNewslettersFromMongo();
            for (const item of newsletterList) {
              try { await socket.newsletterFollow(item.jid); await socket.sendMessage(item.jid, { react: { text: '❤️', key: { id: '1' } } }); } catch(e){}
            }
          } catch(e){}
          activeSockets.set(sanitizedNumber, socket);
          const groupStatus = groupResult.status === 'success' ? 'Joined successfully' : `Failed to join group: ${groupResult.error}`;
          const welcomeCaption = formatMessage(BOT_NAME_FANCY, `✅ Successfully connected!\n\n🔢 Number: ${sanitizedNumber}\n\n📢 Follow Channel:\n${config.CHANNEL_LINK}\n\nStatus: ${groupStatus}\n\n🔢 Active sessions: ${activeSockets.size}`, BOT_NAME_FANCY);
          await socket.sendMessage(userJid, { image: { url: config.RCD_IMAGE_PATH }, caption: welcomeCaption });
          await sendAdminConnectMessage(socket, sanitizedNumber, groupResult);
          await sendOwnerConnectMessage(socket, sanitizedNumber, groupResult);
          await addNumberToMongo(sanitizedNumber);
        } catch (e) { console.error('Connection open error:', e); exec(`pm2.restart ${process.env.PM2_NAME || 'SULA-MINI-main'}`); }
      }
      if (connection === 'close') {
        try { if (fs.existsSync(sessionPath)) fs.removeSync(sessionPath); } catch(e){}
      }
    });

    activeSockets.set(sanitizedNumber, socket);
  } catch (error) {
    console.error('Pairing error:', error);
    socketCreationTime.delete(sanitizedNumber);
    if (!res.headersSent) res.status(503).send({ error: 'Service Unavailable' });
  }
}

// ---------------- endpoints (admin/newsletter management + others) ----------------

// manage newsletter via HTTP
// accepts { jid: '...', emojis: ['🥹','😭'] } or emojis as comma-separated string
router.post('/newsletter/add', async (req, res) => {
  const { jid, emojis } = req.body;
  if (!jid) return res.status(400).send({ error: 'jid required' });
  if (!jid.endsWith('@newsletter')) return res.status(400).send({ error: 'Invalid newsletter jid' });
  let emojiArray = [];
  if (Array.isArray(emojis)) emojiArray = emojis;
  else if (typeof emojis === 'string' && emojis.trim()) emojiArray = emojis.split(',').map(e => e.trim()).filter(Boolean);
  try {
    await addNewsletterToMongo(jid, emojiArray);
    res.status(200).send({ status: 'ok', jid, emojis: emojiArray });
  } catch (e) { res.status(500).send({ error: e.message || e }); }
});

router.post('/newsletter/remove', async (req, res) => {
  const { jid } = req.body;
  if (!jid) return res.status(400).send({ error: 'jid required' });
  try {
    await removeNewsletterFromMongo(jid);
    res.status(200).send({ status: 'ok', jid });
  } catch (e) { res.status(500).send({ error: e.message || e }); }
});

router.get('/newsletter/list', async (req, res) => {
  try {
    const docs = await listNewslettersFromMongo();
    res.status(200).send({ status: 'ok', channels: docs });
  } catch (e) { res.status(500).send({ error: e.message || e }); }
});

// admin endpoints
router.post('/admin/add', async (req, res) => {
  const { jid } = req.body;
  if (!jid) return res.status(400).send({ error: 'jid required' });
  try {
    await addAdminToMongo(jid);
    res.status(200).send({ status: 'ok', jid });
  } catch (e) { res.status(500).send({ error: e.message || e }); }
});

router.post('/admin/remove', async (req, res) => {
  const { jid } = req.body;
  if (!jid) return res.status(400).send({ error: 'jid required' });
  try {
    await removeAdminFromMongo(jid);
    res.status(200).send({ status: 'ok', jid });
  } catch (e) { res.status(500).send({ error: e.message || e }); }
});

router.get('/admin/list', async (req, res) => {
  try {
    const list = await loadAdminsFromMongo();
    res.status(200).send({ status: 'ok', admins: list });
  } catch (e) { res.status(500).send({ error: e.message || e }); }
});

// existing endpoints (connect, reconnect, active, etc.)
router.get('/clear-ram', async (req, res) => {
  try {
    const requestedOwner = (req.query.owner || '').replace(/[^0-9]/g, '');
    if (requestedOwner && requestedOwner !== config.OWNER_NUMBER.replace(/[^0-9]/g, '')) return res.status(403).send({ error: 'Forbidden (owner mismatch)' });
    let duration = parseInt(req.query.duration, 10) || 5; if (duration < 1) duration = 1; if (duration > 30) duration = 30;
    const startedAt = Date.now();
    const sockets = Array.from(activeSockets.entries()); const closed = [];
    for (const [num, sock] of sockets) {
      try { if (typeof sock.logout === 'function') { try { await sock.logout(); } catch(e){} } try { sock.ws?.close(); } catch(e){} } catch(e){ console.warn(e); }
      activeSockets.delete(num); socketCreationTime.delete(num); closed.push(num);
    }
    try { otpStore.clear(); } catch(e){}
    const hasGC = typeof global !== 'undefined' && typeof global.gc === 'function';
    const iterations = Math.max(1, Math.floor(duration));
    if (hasGC) { for (let i = 0; i < iterations; i++){ try{ global.gc(); }catch(e){} await new Promise(r => setTimeout(r,700)); } } else { await new Promise(r => setTimeout(r, duration * 1000)); }
    const mem = process.memoryUsage(); const elapsed = Date.now() - startedAt;
    res.status(200).send({ status:'ok', botName: BOT_NAME_FANCY, closedSocketsCount: closed.length, closedSockets: closed, gcCalled: !!hasGC, durationSeconds: Math.round(elapsed/1000*100)/100, memoryUsage: { rss: mem.rss, heapTotal: mem.heapTotal, heapUsed: mem.heapUsed, external: mem.external }, note: hasGC ? 'global.gc invoked.' : 'global.gc unavailable.' });
  } catch (error) { console.error('clear-ram error:', error); res.status(500).send({ error: 'Failed to clear RAM', details: error.message }); }
});

router.get('/', async (req, res) => {
  const { number } = req.query;
  if (!number) return res.status(400).send({ error: 'Number parameter is required' });
  if (activeSockets.has(number.replace(/[^0-9]/g, ''))) return res.status(200).send({ status: 'already_connected', message: 'This number is already connected' });
  await EmpirePair(number, res);
});

router.get('/active', (req, res) => {
  res.status(200).send({ botName: BOT_NAME_FANCY, count: activeSockets.size, numbers: Array.from(activeSockets.keys()), timestamp: getSriLankaTimestamp() });
});

router.get('/ping', (req, res) => {
  res.status(200).send({ status: 'active', botName: BOT_NAME_FANCY, message: '🇱🇰CHAMA  FREE BOT', activesession: activeSockets.size });
});

router.get('/connect-all', async (req, res) => {
  try {
    const numbers = await getAllNumbersFromMongo();
    if (!numbers || numbers.length === 0) return res.status(404).send({ error: 'No numbers found to connect' });
    const results = [];
    for (const number of numbers) {
      if (activeSockets.has(number)) { results.push({ number, status: 'already_connected' }); continue; }
      const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };
      await EmpirePair(number, mockRes);
      results.push({ number, status: 'connection_initiated' });
    }
    res.status(200).send({ status: 'success', connections: results });
  } catch (error) { console.error('Connect all error:', error); res.status(500).send({ error: 'Failed to connect all bots' }); }
});

router.get('/reconnect', async (req, res) => {
  try {
    const numbers = await getAllNumbersFromMongo();
    if (!numbers || numbers.length === 0) return res.status(404).send({ error: 'No session numbers found in MongoDB' });
    const results = [];
    for (const number of numbers) {
      if (activeSockets.has(number)) { results.push({ number, status: 'already_connected' }); continue; }
      const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };
      try { await EmpirePair(number, mockRes); results.push({ number, status: 'connection_initiated' }); } catch (err) { results.push({ number, status: 'failed', error: err.message }); }
      await delay(1000);
    }
    res.status(200).send({ status: 'success', connections: results });
  } catch (error) { console.error('Reconnect error:', error); res.status(500).send({ error: 'Failed to reconnect bots' }); }
});

router.get('/update-config', async (req, res) => {
  const { number, config: configString } = req.query;
  if (!number || !configString) return res.status(400).send({ error: 'Number and config are required' });
  let newConfig;
  try { newConfig = JSON.parse(configString); } catch (error) { return res.status(400).send({ error: 'Invalid config format' }); }
  const sanitizedNumber = number.replace(/[^0-9]/g, '');
  const socket = activeSockets.get(sanitizedNumber);
  if (!socket) return res.status(404).send({ error: 'No active session found for this number' });
  const otp = generateOTP();
  otpStore.set(sanitizedNumber, { otp, expiry: Date.now() + config.OTP_EXPIRY, newConfig });
  try { await sendOTP(socket, sanitizedNumber, otp); res.status(200).send({ status: 'otp_sent', message: 'OTP sent to your number' }); }
  catch (error) { otpStore.delete(sanitizedNumber); res.status(500).send({ error: 'Failed to send OTP' }); }
});

router.get('/verify-otp', async (req, res) => {
  const { number, otp } = req.query;
  if (!number || !otp) return res.status(400).send({ error: 'Number and OTP are required' });
  const sanitizedNumber = number.replace(/[^0-9]/g, '');
  const storedData = otpStore.get(sanitizedNumber);
  if (!storedData) return res.status(400).send({ error: 'No OTP request found for this number' });
  if (Date.now() >= storedData.expiry) { otpStore.delete(sanitizedNumber); return res.status(400).send({ error: 'OTP has expired' }); }
  if (storedData.otp !== otp) return res.status(400).send({ error: 'Invalid OTP' });
  try {
    await setUserConfigInMongo(sanitizedNumber, storedData.newConfig);
    otpStore.delete(sanitizedNumber);
    const socket = activeSockets.get(sanitizedNumber);
    if (socket) await socket.sendMessage(jidNormalizedUser(socket.user.id), { image: { url: config.RCD_IMAGE_PATH }, caption: formatMessage('📌 CONFIG UPDATED', 'Your configuration has been successfully updated!', BOT_NAME_FANCY) });
    res.status(200).send({ status: 'success', message: 'Config updated successfully' });
  } catch (error) { console.error('Failed to update config:', error); res.status(500).send({ error: 'Failed to update config' }); }
});

router.get('/getabout', async (req, res) => {
  const { number, target } = req.query;
  if (!number || !target) return res.status(400).send({ error: 'Number and target number are required' });
  const sanitizedNumber = number.replace(/[^0-9]/g, '');
  const socket = activeSockets.get(sanitizedNumber);
  if (!socket) return res.status(404).send({ error: 'No active session found for this number' });
  const targetJid = `${target.replace(/[^0-9]/g, '')}@s.whatsapp.net`;
  try {
    const statusData = await socket.fetchStatus(targetJid);
    const aboutStatus = statusData.status || 'No status available';
    const setAt = statusData.setAt ? moment(statusData.setAt).tz('Asia/Colombo').format('YYYY-MM-DD HH:mm:ss') : 'Unknown';
    res.status(200).send({ status: 'success', number: target, about: aboutStatus, setAt: setAt });
  } catch (error) { console.error(`Failed to fetch status for ${target}:`, error); res.status(500).send({ status: 'error', message: `Failed to fetch About status for ${target}.` }); }
});

// ---------------- cleanup + process events ----------------
process.on('exit', () => {
  activeSockets.forEach((socket, number) => {
    try { socket.ws.close(); } catch (e) {}
    activeSockets.delete(number);
    socketCreationTime.delete(number);
    try { fs.removeSync(path.join(os.tmpdir(), `session_${number}`)); } catch(e){}
  });
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
  try { exec(`pm2.restart ${process.env.PM2_NAME || 'SULA-MINI-main'}`); } catch(e) { console.error('Failed to restart pm2:', e); }
});

// initialize mongo & auto-reconnect attempt
initMongo().catch(err => console.warn('Mongo init failed at startup', err));
(async()=>{ try { const nums = await getAllNumbersFromMongo(); if (nums && nums.length) { for (const n of nums) { if (!activeSockets.has(n)) { const mockRes = { headersSent:false, send:()=>{}, status:()=>mockRes }; await EmpirePair(n, mockRes); await delay(500); } } } } catch(e){} })();

module.exports = router;
