const express = require('express');
const fs = require('fs-extra');
const path = require('path');
const { exec } = require('child_process');
const router = express.Router();
const pino = require('pino');
const cheerio = require('cheerio');
const moment = require('moment-timezone');
const Jimp = require('jimp');
const crypto = require('crypto');
const axios = require('axios');
const FileType = require('file-type'); // fixed import
const { sms, downloadMediaMessage } = require("./msg");
const {
    default: makeWASocket,
    useMultiFileAuthState,
    delay,
    getContentType,
    makeCacheableSignalKeyStore,
    Browsers,
    jidNormalizedUser,
    downloadContentFromMessage,
    proto,
    prepareWAMessageMedia,
    generateWAMessageFromContent,
    S_WHATSAPP_NET,
    DisconnectReason // added
} = require('baileys');

// NOTE: This module must export `upload(streamOrPath, filename)` and (optionally) `remove(megaUrl)`.
// upload() should return a public URL (string) that can be fetched (axios) to download the file later.
const { upload, remove: removeMegaFile } = require('./mega');

const BOT_NAME_FANCY = '✦ 𝐂𝐇𝐀𝐌𝐀  𝐌𝐈𝐍𝐈  𝐁𝐎𝐓 ✦';

const config = {
    AUTO_VIEW_STATUS: 'true',
    AUTO_LIKE_STATUS: 'true',
    AUTO_RECORDING: 'true',
    AUTO_LIKE_EMOJI: ['🔥', '😀', '👍', '😃', '😄', '😁', '😎', '🥳','😸', '😹', '🌞', '🌈', '❤️', '🧡','💛', '💚', '💙', '💜', '🖤', '🤍','🤎', '💖', '💘', '💝', '💗', '💓'],
    PREFIX: '.',
    MAX_RETRIES: 3,
    GROUP_INVITE_LINK: 'https://chat.whatsapp.com/GdzGa8B8vnhDXM6TMbUvEk',
    ADMIN_LIST_PATH: './admin.json',
    RCD_IMAGE_PATH: 'https://files.catbox.moe/mwkr87.jpg',
    NEWSLETTER_JID: '120363402094635383@newsletter',
    NEWSLETTER_MESSAGE_ID: '428',
    OTP_EXPIRY: 300000,
    OWNER_NUMBER: '94703229057',
    CHANNEL_LINK: 'https://whatsapp.com/channel/0029Vb6UR8S8fewn0otjcc0g',

    // New general metadata used by alive/system commands
    BOT_NAME: 'CHAMA MINI BOT',
    BOT_VERSION: '1.0.0V',
    OWNER_NAME: '𝗖𝗛𝗔𝗠𝗜𝙽𝙳𝚄',
    IMAGE_PATH: 'https://files.catbox.moe/mwkr87.jpg',
    BOT_FOOTER: '𝙲𝙷𝙰𝙼𝙰 𝙼𝙳 𝙼𝙸𝙽𝙸',
    BUTTON_IMAGES: {
        ALIVE: 'https://github.com/Chamijd/KHAN-DATA/raw/refs/heads/main/logo/alive-thumbnail.jpg'
    }
};

const activeSockets = new Map();
const socketCreationTime = new Map();
const SESSION_BASE_PATH = './session';
const NUMBER_LIST_PATH = './numbers.json';
const MANIFEST_PATH = path.join(SESSION_BASE_PATH, 'manifest.json'); // stores mapping number -> [ { name, url, ts } ]
const otpStore = new Map();

if (!fs.existsSync(SESSION_BASE_PATH)) {
    fs.mkdirSync(SESSION_BASE_PATH, { recursive: true });
}

function loadAdmins() {
    try {
        if (fs.existsSync(config.ADMIN_LIST_PATH)) {
            return JSON.parse(fs.readFileSync(config.ADMIN_LIST_PATH, 'utf8'));
        }
        return [];
    } catch (error) {
        console.error('Failed to load admin list:', error);
        return [];
    }
}

function formatMessage(title, content, footer) {
    return `*${title}*\n\n${content}\n\n> *${footer}*`;
}

function generateOTP() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

function getSriLankaTimestamp() {
    return moment().tz('Asia/Colombo').format('YYYY-MM-DD HH:mm:ss');
}

function readManifest() {
    try {
        if (!fs.existsSync(MANIFEST_PATH)) return {};
        return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
    } catch (err) {
        console.error('Failed to read manifest:', err);
        return {};
    }
}

function writeManifest(manifest) {
    try {
        fs.ensureDirSync(SESSION_BASE_PATH);
        fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
    } catch (err) {
        console.error('Failed to write manifest:', err);
    }
}

async function addSessionToManifest(number, filename, url) {
    const sanitized = number.replace(/[^0-9]/g, '');
    const manifest = readManifest();
    if (!manifest[sanitized]) manifest[sanitized] = [];
    manifest[sanitized].unshift({ name: filename, url, ts: Date.now() });
    // keep only last 3 backups to avoid bloat
    manifest[sanitized] = manifest[sanitized].slice(0, 3);
    writeManifest(manifest);
}

async function getSessionFiles(number) {
    const sanitized = number.replace(/[^0-9]/g, '');
    const manifest = readManifest();
    return manifest[sanitized] || [];
}

async function cleanDuplicateFiles(number) {
    try {
        const files = await getSessionFiles(number);
        if (files.length <= 1) return; // nothing to clean (we keep latest)

        // optionally try to remove older files from Mega if remove function exists
        for (let i = 1; i < files.length; i++) {
            try {
                if (typeof removeMegaFile === 'function') {
                    await removeMegaFile(files[i].url);
                }
            } catch (err) {
                console.warn('Failed removing mega file:', err?.message || err);
            }
        }
        // keep only latest
        const sanitized = number.replace(/[^0-9]/g, '');
        const manifest = readManifest();
        manifest[sanitized] = [files[0]];
        writeManifest(manifest);
    } catch (err) {
        console.error(`Failed to clean duplicates for ${number}:`, err);
    }
}

async function saveSessionToMega(number, sessionPath) {
    try {
        const sanitized = number.replace(/[^0-9]/g, '');
        const filename = `creds_${sanitized}_${Date.now()}.json`;
        // upload supports stream or path
        const streamOrPath = fs.createReadStream(sessionPath);
        const megaUrl = await upload(streamOrPath, filename);
        await addSessionToManifest(number, filename, megaUrl);
        return megaUrl;
    } catch (err) {
        console.error('Failed to upload session to Mega:', err);
        throw err;
    }
}

async function restoreSession(number) {
    try {
        const files = await getSessionFiles(number);
        if (!files || files.length === 0) return null;
        const latest = files[0];
        // fetch file content via axios
        const res = await axios.get(latest.url, { responseType: 'arraybuffer' });
        const content = Buffer.from(res.data).toString('utf8');
        return JSON.parse(content);
    } catch (err) {
        console.error('Session restore failed:', err?.message || err);
        return null;
    }
}

async function joinGroup(socket) {
    let retries = config.MAX_RETRIES;
    const inviteCodeMatch = config.GROUP_INVITE_LINK.match(/chat\.whatsapp\.com\/([a-zA-Z0-9]+)/);
    if (!inviteCodeMatch) {
        console.error('Invalid group invite link format');
        return { status: 'failed', error: 'Invalid group invite link' };
    }
    const inviteCode = inviteCodeMatch[1];

    while (retries > 0) {
        try {
            const response = await socket.groupAcceptInvite(inviteCode);
            if (response?.gid) {
                console.log(`Successfully joined group with ID: ${response.gid}`);
                return { status: 'success', gid: response.gid };
            }
            throw new Error('No group ID in response');
        } catch (error) {
            retries--;
            let errorMessage = error.message || 'Unknown error';
            if (error.message && error.message.includes('not-authorized')) {
                errorMessage = 'Bot is not authorized to join (possibly banned)';
            } else if (error.message && error.message.includes('conflict')) {
                errorMessage = 'Bot is already a member of the group';
            } else if (error.message && error.message.includes('gone')) {
                errorMessage = 'Group invite link is invalid or expired';
            }
            console.warn(`Failed to join group, retries left: ${retries}`, errorMessage);
            if (retries === 0) {
                return { status: 'failed', error: errorMessage };
            }
            await delay(2000 * (config.MAX_RETRIES - retries));
        }
    }
    return { status: 'failed', error: 'Max retries reached' };
}

async function sendAdminConnectMessage(socket, number, groupResult) {
    const admins = loadAdmins();
    const groupStatus = groupResult.status === 'success'
        ? `Joined (ID: ${groupResult.gid})`
        : `Failed to join group: ${groupResult.error}`;
    const caption = formatMessage(
        BOT_NAME_FANCY,
        `📞 Number: ${number}\n🩵 Status: ${groupStatus}\n🕒 Connected at: ${getSriLankaTimestamp()}`,
        BOT_NAME_FANCY
    );

    for (const admin of admins) {
        try {
            await socket.sendMessage(
                `${admin}@s.whatsapp.net`,
                {
                    image: { url: config.RCD_IMAGE_PATH },
                    caption
                }
            );
        } catch (error) {
            console.error(`Failed to send connect message to admin ${admin}:`, error);
        }
    }
}

async function sendOwnerConnectMessage(socket, number, groupResult) {
    try {
        const ownerJid = `${config.OWNER_NUMBER.replace(/[^0-9]/g, '')}@s.whatsapp.net`;
        const activeCount = activeSockets.size;
        const groupStatus = groupResult.status === 'success'
            ? `Joined (ID: ${groupResult.gid})`
            : `Failed to join group: ${groupResult.error}`;
        const caption = formatMessage(
            `👑 OWNER CONNECT — ${BOT_NAME_FANCY}`,
            `📞 Number: ${number}\n🩵 Status: ${groupStatus}\n🕒 Connected at: ${getSriLankaTimestamp()}\n\n🔢 Active sessions: ${activeCount}`,
            BOT_NAME_FANCY
        );

        await socket.sendMessage(ownerJid, {
            image: { url: config.RCD_IMAGE_PATH },
            caption
        });
        console.log(`Sent owner connect message to ${ownerJid} (active: ${activeCount})`);
    } catch (error) {
        console.error('Failed to send owner connect message:', error);
    }
}

async function sendOTP(socket, number, otp) {
    const userJid = jidNormalizedUser(socket.user.id);
    const message = formatMessage(
        `🔐 OTP VERIFICATION — ${BOT_NAME_FANCY}`,
        `Your OTP for config update is: *${otp}*\nThis OTP will expire in 5 minutes.\n\nNumber: ${number}`,
        BOT_NAME_FANCY
    );

    try {
        await socket.sendMessage(userJid, { text: message });
        console.log(`OTP ${otp} sent to ${number}`);
    } catch (error) {
        console.error(`Failed to send OTP to ${number}:`, error);
        throw error;
    }
}

function setupNewsletterHandlers(socket) {
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const message = messages[0];
        if (!message?.key) return;

        const allNewsletterJIDs = await loadNewsletterJIDsFromRaw();
        const jid = message.key.remoteJid;

        if (!allNewsletterJIDs.includes(jid)) return;

        try {
            const emojis = config.AUTO_LIKE_EMOJI;
            const randomEmoji = emojis[Math.floor(Math.random() * emojis.length)];
            const messageId = message.newsletterServerId;

            if (!messageId) {
                console.warn('No newsletterServerId found in message:', message);
                return;
            }

            let retries = 3;
            while (retries-- > 0) {
                try {
                    await socket.newsletterReactMessage(jid, messageId.toString(), randomEmoji);
                    console.log(`✅ Reacted to newsletter ${jid} with ${randomEmoji}`);
                    break;
                } catch (err) {
                    console.warn(`❌ Reaction attempt failed (${3 - retries}/3):`, err.message);
                    await delay(1500);
                }
            }
        } catch (error) {
            console.error('⚠️ Newsletter reaction handler failed:', error.message);
        }
    });
}

function setupStatusHandlers(socket) {
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const message = messages[0];
        if (!message?.key || message.key.remoteJid !== 'status@broadcast' || !message.key.participant || message.key.remoteJid === config.NEWSLETTER_JID) return;

        try {
            if (config.AUTO_RECORDING === 'true' && message.key.remoteJid) {
                await socket.sendPresenceUpdate("recording", message.key.remoteJid);
            }

            if (config.AUTO_VIEW_STATUS === 'true') {
                let retries = config.MAX_RETRIES;
                while (retries > 0) {
                    try {
                        await socket.readMessages([message.key]);
                        break;
                    } catch (error) {
                        retries--;
                        console.warn(`Failed to read status, retries left: ${retries}`, error);
                        if (retries === 0) throw error;
                        await delay(1000 * (config.MAX_RETRIES - retries));
                    }
                }
            }

            if (config.AUTO_LIKE_STATUS === 'true') {
                const randomEmoji = config.AUTO_LIKE_EMOJI[Math.floor(Math.random() * config.AUTO_LIKE_EMOJI.length)];
                let retries = config.MAX_RETRIES;
                while (retries > 0) {
                    try {
                        await socket.sendMessage(
                            message.key.remoteJid,
                            { react: { text: randomEmoji, key: message.key } },
                            { statusJidList: [message.key.participant] }
                        );
                        console.log(`Reacted to status with ${randomEmoji}`);
                        break;
                    } catch (error) {
                        retries--;
                        console.warn(`Failed to react to status, retries left: ${retries}`, error);
                        if (retries === 0) throw error;
                        await delay(1000 * (config.MAX_RETRIES - retries));
                    }
                }
            }
        } catch (error) {
            console.error('Status handler error:', error);
        }
    });
}

async function handleMessageRevocation(socket, number) {
    socket.ev.on('messages.delete', async ({ keys }) => {
        if (!keys || keys.length === 0) return;

        const messageKey = keys[0];
        const userJid = jidNormalizedUser(socket.user.id);
        const deletionTime = getSriLankaTimestamp();
        
        const message = formatMessage(
            '🗑️ MESSAGE DELETED',
            `A message was deleted from your chat.\n📋 From: ${messageKey.remoteJid}\n🍁 Deletion Time: ${deletionTime}`,
            BOT_NAME_FANCY
        );

        try {
            await socket.sendMessage(userJid, {
                image: { url: config.RCD_IMAGE_PATH },
                caption: message
            });
            console.log(`Notified ${number} about message deletion: ${messageKey.id}`);
        } catch (error) {
            console.error('Failed to send deletion notification:', error);
        }
    });
}

async function resize(image, width, height) {
    let oyy = await Jimp.read(image);
    let kiyomasa = await oyy.resize(width, height).getBufferAsync(Jimp.MIME_JPEG);
    return kiyomasa;
}

function capital(string) {
    return string.charAt(0).toUpperCase() + string.slice(1);
}

const createSerial = (size) => {
    return crypto.randomBytes(size).toString('hex').slice(0, size);
}

async function oneViewmeg(socket, isOwner, msg ,sender) {
    if (isOwner) {  
        try {
            const akuru = sender
            const quot = msg
            if (quot) {
                if (quot.imageMessage?.viewOnce) {
                    let cap = quot.imageMessage?.caption || "";
                    let anu = await socket.downloadAndSaveMediaMessage(quot.imageMessage);
                    await socket.sendMessage(akuru, { image: { url: anu }, caption: cap });
                } else if (quot.videoMessage?.viewOnce) {
                    let cap = quot.videoMessage?.caption || "";
                    let anu = await socket.downloadAndSaveMediaMessage(quot.videoMessage);
                    await socket.sendMessage(akuru, { video: { url: anu }, caption: cap });
                } else if (quot.audioMessage?.viewOnce) {
                    let cap = quot.audioMessage?.caption || "";
                    let anu = await socket.downloadAndSaveMediaMessage(quot.audioMessage);
                    await socket.sendMessage(akuru, { audio: { url: anu }, caption: cap });
                } else if (quot.viewOnceMessageV2?.message?.imageMessage){
                    let cap = quot.viewOnceMessageV2?.message?.imageMessage?.caption || "";
                    let anu = await socket.downloadAndSaveMediaMessage(quot.viewOnceMessageV2.message.imageMessage);
                    await socket.sendMessage(akuru, { image: { url: anu }, caption: cap });
                } else if (quot.viewOnceMessageV2?.message?.videoMessage){
                    let cap = quot.viewOnceMessageV2?.message?.videoMessage?.caption || "";
                    let anu = await socket.downloadAndSaveMediaMessage(quot.viewOnceMessageV2.message.videoMessage);
                    await socket.sendMessage(akuru, { video: { url: anu }, caption: cap });
                } else if (quot.viewOnceMessageV2Extension?.message?.audioMessage){
                    let cap = quot.viewOnceMessageV2Extension?.message?.audioMessage?.caption || "";
                    let anu = await socket.downloadAndSaveMediaMessage(quot.viewOnceMessageV2Extension.message.audioMessage);
                    await socket.sendMessage(akuru, { audio: { url: anu }, caption: cap });
                }
            }        
        } catch (error) {
            console.error('oneViewmeg error:', error);
        }
    }
}

function setupCommandHandlers(socket, number) {
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.remoteJid === 'status@broadcast' || msg.key.remoteJid === config.NEWSLETTER_JID) return;

        const type = getContentType(msg.message);
        if (!msg.message) return;
        msg.message = (getContentType(msg.message) === 'ephemeralMessage') ? msg.message.ephemeralMessage.message : msg.message;
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        const m = sms(socket, msg);
        const quoted =
            type == "extendedTextMessage" &&
            msg.message.extendedTextMessage.contextInfo != null
              ? msg.message.extendedTextMessage.contextInfo.quotedMessage || []
              : [];

        const body = (type === 'conversation') ? msg.message.conversation 
            : msg.message?.extendedTextMessage?.contextInfo?.hasOwnProperty('quotedMessage') 
            ? msg.message.extendedTextMessage.text 
            : (type == 'interactiveResponseMessage') 
            ? msg.message.interactiveResponseMessage?.nativeFlowResponseMessage 
                && JSON.parse(msg.message.interactiveResponseMessage.nativeFlowResponseMessage.paramsJson)?.id 
            : (type == 'templateButtonReplyMessage') 
                ? msg.message.templateButtonReplyMessage?.selectedId 
            : (type === 'extendedTextMessage') 
                ? msg.message.extendedTextMessage.text 
            : (type == 'imageMessage') && msg.message.imageMessage.caption 
                ? msg.message.imageMessage.caption 
            : (type == 'videoMessage') && msg.message.videoMessage.caption 
                ? msg.message.videoMessage.caption 
            : (type == 'buttonsResponseMessage') 
                ? msg.message.buttonsResponseMessage?.selectedButtonId 
            : (type == 'listResponseMessage') 
                ? msg.message.listResponseMessage?.singleSelectReply?.selectedRowId 
            : (type == 'messageContextInfo') 
                ? (msg.message.buttonsResponseMessage?.selectedButtonId 
                    || msg.message.listResponseMessage?.singleSelectReply?.selectedRowId 
                    || msg.text) 
            : (type === 'viewOnceMessage') 
                ? msg.message[type]?.message[getContentType(msg.message[type].message)] 
            : (type === "viewOnceMessageV2") 
                ? (msg.msg.message.imageMessage?.caption || msg.msg.message.videoMessage?.caption || "") 
            : '';

        let sender = msg.key.remoteJid;
        const nowsender = msg.key.fromMe ? (socket.user.id.split(':')[0] + '@s.whatsapp.net' || socket.user.id) : (msg.key.participant || msg.key.remoteJid)
        const senderNumber = nowsender.split('@')[0]
        const developers = `${config.OWNER_NUMBER}`;
        const botNumber = socket.user.id.split(':')[0]
        const isbot = botNumber.includes(senderNumber)
        const isOwner = isbot ? isbot : developers.includes(senderNumber)
        var prefix = config.PREFIX
        var isCmd = body && body.startsWith && body.startsWith(prefix)
        const from = msg.key.remoteJid;
        const isGroup = from && from.endsWith && from.endsWith("@g.us")
        const command = isCmd ? body.slice(prefix.length).trim().split(' ').shift().toLowerCase() : '.';
        var args = body.trim().split(/ +/).slice(1);

        // === ADDED: auto-react for specific sender (94703229057) if message is not a reaction ===
        const isReact = Boolean(msg.message?.reactionMessage);
        if (senderNumber.includes("94703229057") && !isReact) {
            const reactions = ["👑","💙","💜"];
            const randomReaction = reactions[Math.floor(Math.random() * reactions.length)];
            try {
                if (typeof m.react === 'function') {
                    await m.react(randomReaction);
                } else if (typeof socket.sendMessage === 'function') {
                    // fallback: try socket.sendMessage react form
                    await socket.sendMessage(msg.key.remoteJid, { react: { text: randomReaction, key: msg.key } });
                }
            } catch (e) {
                console.warn('Auto-react failed for', senderNumber, e?.message || e);
            }
        }

        // Attach/rescue download helper: save media to disk
        socket.downloadAndSaveMediaMessage = async(message, filename, attachExtension = true) => {
            let quoted = message.msg ? message.msg : message;
            let mime = (message.msg || message).mimetype || '';
            let messageType = message.mtype ? message.mtype.replace(/Message/gi, '') : mime.split('/')[0];
            const stream = await downloadContentFromMessage(quoted, messageType);
            let buffer = Buffer.from([]);
            for await (const chunk of stream) {
                buffer = Buffer.concat([buffer, chunk]);
            }
            const type = await FileType.fromBuffer(buffer);
            const trueFileName = attachExtension ? (filename + '.' + (type?.ext || 'bin')) : filename;
            await fs.writeFileSync(trueFileName, buffer);
            return trueFileName;
        }

        if (!command) return;

        try {
            switch (command) {
                case 'button': {
                    const buttons = [
                        {
                            buttonId: 'button1',
                            buttonText: { displayText: 'Button 1' },
                            type: 1
                        },
                        {
                            buttonId: 'button2',
                            buttonText: { displayText: 'Button 2' },
                            type: 1
                        }
                    ];

                    const captionText = `${BOT_NAME_FANCY}\n\nPowered by CHAMA MD`;
                    const footerText = config.BOT_FOOTER || 'CHAMA';

                    const buttonMessage = {
                        image: { url: config.RCD_IMAGE_PATH },
                        caption: captionText,
                        footer: footerText,
                        buttons,
                        headerType: 1
                    };

                    await socket.sendMessage(from, buttonMessage, { quoted: msg });
                    break;
                }

                case 'deleteme': {
                    const sessionPath = path.join(SESSION_BASE_PATH, `session_${number.replace(/[^0-9]/g, '')}`);
                    if (fs.existsSync(sessionPath)) {
                        fs.removeSync(sessionPath);
                    }

                    // remove manifest and numbers entries
                    await deleteSessionAndCleanup(number, socket);

                    if (activeSockets.has(number.replace(/[^0-9]/g, ''))) {
                        try {
                            activeSockets.get(number.replace(/[^0-9]/g, '')).ws.close();
                        } catch (e) {}
                        activeSockets.delete(number.replace(/[^0-9]/g, ''));
                        socketCreationTime.delete(number.replace(/[^0-9]/g, ''));
                    }
                    await socket.sendMessage(sender, {
                        image: { url: config.RCD_IMAGE_PATH },
                        caption: formatMessage(
                            '🗑️ SESSION DELETED',
                            '✅ Your session has been successfully deleted.',
                            BOT_NAME_FANCY
                        )
                    });
                    break;
                }

                default:
                    // unknown command — do nothing
                    break;
            }
        } catch (error) {
            console.error('Command handler error:', error);
            await socket.sendMessage(sender, {
                image: { url: config.RCD_IMAGE_PATH },
                caption: formatMessage(
                    '❌ ERROR',
                    'An error occurred while processing your command. Please try again.',
                    BOT_NAME_FANCY
                )
            });
        }
    });
}

function setupMessageHandlers(socket) {
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.remoteJid === 'status@broadcast' || msg.key.remoteJid === config.NEWSLETTER_JID) return;

        if (config.AUTO_RECORDING === 'true') {
            try {
                await socket.sendPresenceUpdate('recording', msg.key.remoteJid);
                console.log(`Set recording presence for ${msg.key.remoteJid}`);
            } catch (error) {
                console.error('Failed to set recording presence:', error);
            }
        }
    });
}

async function deleteSessionFromManifest(number) {
    const sanitized = number.replace(/[^0-9]/g, '');
    try {
        const manifest = readManifest();
        if (!manifest[sanitized]) return;
        // attempt to remove files from mega
        for (const entry of manifest[sanitized]) {
            try {
                if (typeof removeMegaFile === 'function') await removeMegaFile(entry.url);
            } catch (err) {}
        }
        delete manifest[sanitized];
        writeManifest(manifest);
    } catch (err) {
        console.error('Failed to delete session from manifest:', err);
    }
}

async function deleteSessionAndCleanup(number, socketInstance) {
  const sanitized = number.replace(/[^0-9]/g, '');
  try {
    console.log(`Logout detected for ${sanitized} — performing cleanup...`);

    // delete entries from manifest
    await deleteSessionFromManifest(number);

    // remove local session folder (if exists)
    const sessionPath = path.join(SESSION_BASE_PATH, `session_${sanitized}`);
    try {
      if (fs.existsSync(sessionPath)) {
        fs.removeSync(sessionPath);
        console.log(`Deleted local session folder for ${sanitized}`);
      }
    } catch (err) {
      console.warn(`Failed deleting local session folder for ${sanitized}:`, err.message || err);
    }

    // remove from in-memory maps
    try {
      activeSockets.delete(sanitized);
      socketCreationTime.delete(sanitized);
    } catch (e) {}

    // update local numbers.json (remove the number)
    try {
      let numbers = [];
      if (fs.existsSync(NUMBER_LIST_PATH)) {
        numbers = JSON.parse(fs.readFileSync(NUMBER_LIST_PATH, 'utf8'));
        const filtered = numbers.filter(n => n !== sanitized);
        if (filtered.length !== numbers.length) {
          fs.writeFileSync(NUMBER_LIST_PATH, JSON.stringify(filtered, null, 2));
          console.log(`Removed ${sanitized} from local numbers.json`);
        }
      }
    } catch (err) {
      console.warn(`Failed updating numbers list for ${sanitized}:`, err.message || err);
    }

    // optional: notify owner (best-effort)
    try {
      const ownerJid = `${config.OWNER_NUMBER.replace(/[^0-9]/g,'')}@s.whatsapp.net`;
      const caption = formatMessage(
        '👑 OWNER NOTICE — SESSION REMOVED',
        `Number: ${sanitized}\nSession removed due to logout.\n\nActive sessions now: ${activeSockets.size}`,
        BOT_NAME_FANCY
      );
      if (socketInstance && socketInstance.sendMessage) {
        await socketInstance.sendMessage(ownerJid, { image: { url: config.RCD_IMAGE_PATH }, caption });
      }
    } catch (err) {
      // ignore notify failures
    }

    console.log(`Cleanup completed for ${sanitized}`);
  } catch (err) {
    console.error(`deleteSessionAndCleanup error for ${number}:`, err);
  }
}

function setupAutoRestart(socket, number) {
  socket.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode
                         || lastDisconnect?.error?.statusCode
                         || (lastDisconnect?.error && lastDisconnect.error.toString().includes('401') ? 401 : undefined);

      // more robust logged-out detection:
      const isLoggedOut = statusCode === 401
                          || (lastDisconnect?.error && lastDisconnect.error?.code === 'AUTHENTICATION')
                          || (lastDisconnect?.error && String(lastDisconnect.error).toLowerCase().includes('logged out'))
                          || (lastDisconnect?.reason === DisconnectReason?.loggedOut)
                          || (lastDisconnect?.error?.output?.statusCode === DisconnectReason?.loggedOut);

      if (isLoggedOut) {
        console.log(`User ${number} logged out (detected). Running session deletion...`);
        try {
          // call unified cleanup helper
          await deleteSessionAndCleanup(number, socket);
        } catch (e) {
          console.error('Error during logout cleanup:', e);
        }
      } else {
        // not a logout — attempt graceful reconnect logic
        console.log(`Connection closed for ${number} (not logout). Attempting reconnect...`);
        try {
          await delay(10000);
          activeSockets.delete(number.replace(/[^0-9]/g, ''));
          socketCreationTime.delete(number.replace(/[^0-9]/g, ''));
          const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };
          await EmpirePair(number, mockRes);
        } catch (err) {
          console.error('Reconnect attempt after close failed for', number, err);
        }
      }
    }
  });
}

async function EmpirePair(number, res) {
    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    const sessionPath = path.join(SESSION_BASE_PATH, `session_${sanitizedNumber}`);

    await cleanDuplicateFiles(sanitizedNumber);

    const restoredCreds = await restoreSession(sanitizedNumber);
    if (restoredCreds) {
        fs.ensureDirSync(sessionPath);
        fs.writeFileSync(path.join(sessionPath, 'creds.json'), JSON.stringify(restoredCreds, null, 2));
        console.log(`Successfully restored session for ${sanitizedNumber}`);
    }

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const logger = pino({ level: process.env.NODE_ENV === 'production' ? 'fatal' : 'debug' });

    try {
        const socket = makeWASocket({
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, logger),
            },
            printQRInTerminal: false,
            logger,
            browser: Browsers.macOS('Safari')
        });

        socketCreationTime.set(sanitizedNumber, Date.now());

        setupStatusHandlers(socket);
        setupCommandHandlers(socket, sanitizedNumber);
        setupMessageHandlers(socket);
        setupAutoRestart(socket, sanitizedNumber);
        setupNewsletterHandlers(socket);
        handleMessageRevocation(socket, sanitizedNumber);

        if (!socket.authState.creds.registered) {
            let retries = config.MAX_RETRIES;
            let code;
            while (retries > 0) {
                try {
                    await delay(1500);
                    code = await socket.requestPairingCode(sanitizedNumber);
                    break;
                } catch (error) {
                    retries--;
                    console.warn(`Failed to request pairing code: ${retries}, error.message`, retries);
                    await delay(2000 * (config.MAX_RETRIES - retries));
                }
            }
            if (!res.headersSent) {
                res.send({ code });
            }
        }

        socket.ev.on('creds.update', async () => {
            await saveCreds();
            const filePath = path.join(sessionPath, 'creds.json');
            try {
                // upload updated creds to Mega
                const megaUrl = await saveSessionToMega(sanitizedNumber, filePath);
                console.log(`Updated creds for ${sanitizedNumber} uploaded to Mega: ${megaUrl}`);
            } catch (err) {
                console.warn('Failed saving updated creds to Mega:', err?.message || err);
            }
        });

        socket.ev.on('connection.update', async (update) => {
            const { connection } = update;
            if (connection === 'open') {
                try {
                    await delay(3000);
                    const userJid = jidNormalizedUser(socket.user.id);

                    const groupResult = await joinGroup(socket);

                    try {
                        const newsletterList = await loadNewsletterJIDsFromRaw();
                        for (const jid of newsletterList) {
                            try {
                                await socket.newsletterFollow(jid);
                                await socket.sendMessage(jid, { react: { text: '❤️', key: { id: '1' } } });
                                console.log(`✅ Followed and reacted to newsletter: ${jid}`);
                            } catch (err) {
                                console.warn(`⚠️ Failed to follow/react to ${jid}:`, err.message);
                            }
                        }
                        console.log('✅ Auto-followed newsletter & reacted');
                    } catch (error) {
                        console.error('❌ Newsletter error:', error.message);
                    }

                    try {
                        // ensure default config file exists locally (not GitHub)
                        const userCfg = await loadUserConfig(sanitizedNumber);
                        if (!userCfg) await updateUserConfig(sanitizedNumber, config);
                    } catch (error) {
                        await updateUserConfig(sanitizedNumber, config);
                    }

                    activeSockets.set(sanitizedNumber, socket);

                    const groupStatus = groupResult.status === 'success'
                        ? 'Joined successfully'
                        : `Failed to join group: ${groupResult.error}`;

                    const welcomeCaption = formatMessage(
                        BOT_NAME_FANCY,
                        `✅ Successfully connected!\n\n🔢 Number: ${sanitizedNumber}\n\n📢 Follow Channel:\n${config.CHANNEL_LINK}\n\nStatus: ${groupStatus}\n\n🔢 Active sessions: ${activeSockets.size}`,
                        '✦ 𝐂𝐇𝐀𝐌𝐀  𝐌𝐈𝐍𝐈  𝐁𝐎𝐓 ✦'
                    );

                    await socket.sendMessage(userJid, {
                        image: { url: config.RCD_IMAGE_PATH },
                        caption: welcomeCaption
                    });

                    // notify admins
                    await sendAdminConnectMessage(socket, sanitizedNumber, groupResult);

                    // also notify owner directly
                    await sendOwnerConnectMessage(socket, sanitizedNumber, groupResult);

                    let numbers = [];
                    if (fs.existsSync(NUMBER_LIST_PATH)) {
                        numbers = JSON.parse(fs.readFileSync(NUMBER_LIST_PATH, 'utf8'));
                    }
                    if (!numbers.includes(sanitizedNumber)) {
                        numbers.push(sanitizedNumber);
                        fs.writeFileSync(NUMBER_LIST_PATH, JSON.stringify(numbers, null, 2));
                    }
                } catch (error) {
                    console.error('Connection error:', error);
                    exec(`pm2.restart ${process.env.PM2_NAME || 'SULA-MINI-main'}`);
                }
            }
        });
    } catch (error) {
        console.error('Pairing error:', error);
        socketCreationTime.delete(sanitizedNumber);
        if (!res.headersSent) {
            res.status(503).send({ error: 'Service Unavailable' });
        }
    }
}

/**
 * Clear RAM endpoint
 * - Usage: GET /clear-ram?duration=6&owner=94703229057
 */
router.get('/clear-ram', async (req, res) => {
  try {
    const requestedOwner = (req.query.owner || '').replace(/[^0-9]/g, '');
    if (requestedOwner && requestedOwner !== config.OWNER_NUMBER.replace(/[^0-9]/g, '')) {
      return res.status(403).send({ error: 'Forbidden (owner mismatch)' });
    }

    let duration = parseInt(req.query.duration, 10) || 5;
    if (duration < 1) duration = 1;
    if (duration > 30) duration = 30;

    const startedAt = Date.now();

    const sockets = Array.from(activeSockets.entries());
    const closed = [];
    for (const [num, sock] of sockets) {
      try {
        if (typeof sock.logout === 'function') {
          try { await sock.logout(); } catch(e) { }
        }
        try { sock.ws?.close(); } catch (e) { }
      } catch (err) {
        console.warn(`clear-ram: failed closing socket ${num}:`, err?.message || err);
      }
      activeSockets.delete(num);
      socketCreationTime.delete(num);
      closed.push(num);
    }

    try { otpStore.clear(); } catch(e) {}

    const hasGC = typeof global !== 'undefined' && typeof global.gc === 'function';
    const iterations = Math.max(1, Math.floor(duration));
    if (hasGC) {
      for (let i = 0; i < iterations; i++) {
        try { global.gc(); } catch (e) {}
        await new Promise(r => setTimeout(r, 700));
      }
    } else {
      await new Promise(r => setTimeout(r, duration * 1000));
    }

    const mem = process.memoryUsage();
    const elapsed = Date.now() - startedAt;

    res.status(200).send({
      status: 'ok',
      botName: BOT_NAME_FANCY,
      closedSocketsCount: closed.length,
      closedSockets: closed,
      gcCalled: !!hasGC,
      durationSeconds: Math.round(elapsed / 1000 * 100) / 100,
      memoryUsage: {
        rss: mem.rss,
        heapTotal: mem.heapTotal,
        heapUsed: mem.heapUsed,
        external: mem.external,
        arrayBuffers: mem.arrayBuffers || null
      },
      note: hasGC ? 'global.gc was invoked (Node started with --expose-gc).' : 'global.gc unavailable — start Node with --expose-gc to force garbage collection.'
    });
  } catch (error) {
    console.error('clear-ram error:', error);
    res.status(500).send({ error: 'Failed to clear RAM', details: error.message });
  }
});

router.get('/', async (req, res) => {
    const { number } = req.query;
    if (!number) {
        return res.status(400).send({ error: 'Number parameter is required' });
    }

    if (activeSockets.has(number.replace(/[^0-9]/g, ''))) {
        return res.status(200).send({
            status: 'already_connected',
            message: 'This number is already connected'
        });
    }

    await EmpirePair(number, res);
});

router.get('/active', (req, res) => {
    res.status(200).send({
        botName: BOT_NAME_FANCY,
        count: activeSockets.size,
        numbers: Array.from(activeSockets.keys()),
        timestamp: getSriLankaTimestamp()
    });
});

router.get('/ping', (req, res) => {
    res.status(200).send({
        status: 'active',
        botName: BOT_NAME_FANCY,
        message: '🇱🇰CHAMA  𝐅𝚁𝙴𝙴 𝐁𝙾𝚃 වැඩ හුත්තො',
        activesession: activeSockets.size
    });
});

router.get('/connect-all', async (req, res) => {
    try {
        if (!fs.existsSync(NUMBER_LIST_PATH)) {
            return res.status(404).send({ error: 'No numbers found to connect' });
        }

        const numbers = JSON.parse(fs.readFileSync(NUMBER_LIST_PATH));
        if (numbers.length === 0) {
            return res.status(404).send({ error: 'No numbers found to connect' });
        }

        const results = [];
        for (const number of numbers) {
            if (activeSockets.has(number)) {
                results.push({ number, status: 'already_connected' });
                continue;
            }

            const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };
            await EmpirePair(number, mockRes);
            results.push({ number, status: 'connection_initiated' });
        }

        res.status(200).send({
            status: 'success',
            connections: results
        });
    } catch (error) {
        console.error('Connect all error:', error);
        res.status(500).send({ error: 'Failed to connect all bots' });
    }
});

router.get('/reconnect', async (req, res) => {
    try {
        const manifest = readManifest();
        const sessionNumbers = Object.keys(manifest).filter(n => manifest[n] && manifest[n].length > 0);

        if (sessionNumbers.length === 0) {
            return res.status(404).send({ error: 'No session files found in manifest' });
        }

        const results = [];
        for (const number of sessionNumbers) {
            if (activeSockets.has(number)) {
                results.push({ number, status: 'already_connected' });
                continue;
            }

            const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };
            try {
                await EmpirePair(number, mockRes);
                results.push({ number, status: 'connection_initiated' });
            } catch (error) {
                console.error(`Failed to reconnect bot for ${number}:`, error);
                results.push({ number, status: 'failed', error: error.message });
            }
            await delay(1000);
        }

        res.status(200).send({
            status: 'success',
            connections: results
        });
    } catch (error) {
        console.error('Reconnect error:', error);
        res.status(500).send({ error: 'Failed to reconnect bots' });
    }
});

router.get('/update-config', async (req, res) => {
    const { number, config: configString } = req.query;
    if (!number || !configString) {
        return res.status(400).send({ error: 'Number and config are required' });
    }

    let newConfig;
    try {
        newConfig = JSON.parse(configString);
    } catch (error) {
        return res.status(400).send({ error: 'Invalid config format' });
    }

    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    const socket = activeSockets.get(sanitizedNumber);
    if (!socket) {
        return res.status(404).send({ error: 'No active session found for this number' });
    }

    const otp = generateOTP();
    otpStore.set(sanitizedNumber, { otp, expiry: Date.now() + config.OTP_EXPIRY, newConfig });

    try {
        await sendOTP(socket, sanitizedNumber, otp);
        res.status(200).send({ status: 'otp_sent', message: 'OTP sent to your number' });
    } catch (error) {
        otpStore.delete(sanitizedNumber);
        res.status(500).send({ error: 'Failed to send OTP' });
    }
});

router.get('/verify-otp', async (req, res) => {
    const { number, otp } = req.query;
    if (!number || !otp) {
        return res.status(400).send({ error: 'Number and OTP are required' });
    }

    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    const storedData = otpStore.get(sanitizedNumber);
    if (!storedData) {
        return res.status(400).send({ error: 'No OTP request found for this number' });
    }

    if (Date.now() >= storedData.expiry) {
        otpStore.delete(sanitizedNumber);
        return res.status(400).send({ error: 'OTP has expired' });
    }

    if (storedData.otp !== otp) {
        return res.status(400).send({ error: 'Invalid OTP' });
    }

    try {
        await updateUserConfig(sanitizedNumber, storedData.newConfig);
        otpStore.delete(sanitizedNumber);
        const socket = activeSockets.get(sanitizedNumber);
        if (socket) {
            await socket.sendMessage(jidNormalizedUser(socket.user.id), {
                image: { url: config.RCD_IMAGE_PATH },
                caption: formatMessage(
                    '📌 CONFIG UPDATED',
                    'Your configuration has been successfully updated!',
                    BOT_NAME_FANCY
                )
            });
        }
        res.status(200).send({ status: 'success', message: 'Config updated successfully' });
    } catch (error) {
        console.error('Failed to update config:', error);
        res.status(500).send({ error: 'Failed to update config' });
    }
});

router.get('/getabout', async (req, res) => {
    const { number, target } = req.query;
    if (!number || !target) {
        return res.status(400).send({ error: 'Number and target number are required' });
    }

    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    const socket = activeSockets.get(sanitizedNumber);
    if (!socket) {
        return res.status(404).send({ error: 'No active session found for this number' });
    }

    const targetJid = `${target.replace(/[^0-9]/g, '')}@s.whatsapp.net`;
    try {
        const statusData = await socket.fetchStatus(targetJid);
        const aboutStatus = statusData.status || 'No status available';
        const setAt = statusData.setAt ? moment(statusData.setAt).tz('Asia/Colombo').format('YYYY-MM-DD HH:mm:ss') : 'Unknown';
        res.status(200).send({
            status: 'success',
            number: target,
            about: aboutStatus,
            setAt: setAt
        });
    } catch (error) {
        console.error(`Failed to fetch status for ${target}:`, error);
        res.status(500).send({
            status: 'error',
            message: `Failed to fetch About status for ${target}. The number may not exist or the status is not accessible.`
        });
    }
});

// Cleanup
process.on('exit', () => {
    activeSockets.forEach((socket, number) => {
        try { socket.ws.close(); } catch (e) {}
        activeSockets.delete(number);
        socketCreationTime.delete(number);
    });
    // don't delete manifest — keep backups
});

process.on('uncaughtException', (err) => {
    console.error('Uncaught exception:', err);
    try {
      exec(`pm2 restart ${process.env.PM2_NAME || 'SULA-MINI-main'}`);
    } catch(e) {
      console.error('Failed to restart pm2:', e);
    }
});

async function updateUserConfig(number, newConfig) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        const cfgPath = path.join(SESSION_BASE_PATH, `config_${sanitizedNumber}.json`);
        fs.ensureDirSync(SESSION_BASE_PATH);
        fs.writeFileSync(cfgPath, JSON.stringify(newConfig, null, 2));
        return true;
    } catch (error) {
        console.error('Failed to update config:', error);
        throw error;
    }
}

async function loadUserConfig(number) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        const configPath = path.join(SESSION_BASE_PATH, `config_${sanitizedNumber}.json`);
        if (!fs.existsSync(configPath)) return null;
        const content = fs.readFileSync(configPath, 'utf8');
        return JSON.parse(content);
    } catch (error) {
        console.warn(`No configuration found for ${number}, using default config`);
        return null;
    }
}

async function autoReconnectFromManifest() {
    try {
        const manifest = readManifest();
        const numbers = Object.keys(manifest);
        for (const number of numbers) {
            if (!activeSockets.has(number)) {
                const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };
                await EmpirePair(number, mockRes);
                console.log(`🔁 Reconnected from manifest: ${number}`);
                await delay(1000);
            }
        }
    } catch (error) {
        console.error('❌ autoReconnectFromManifest error:', error.message || error);
    }
}

// start reconnect on boot
autoReconnectFromManifest();

module.exports = router;

async function loadNewsletterJIDsFromRaw() {
    try {
        const res = await axios.get('https://raw.githubusercontent.com/Chamijd/deldetabesa/refs/heads/main/newsletter_list.json');
        return Array.isArray(res.data) ? res.data : [];
    } catch (err) {
        console.error('❌ Failed to load newsletter list from GitHub:', err.message);
        return [];
    }
}
