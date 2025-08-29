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




                // ALIVE COMMAND WITH BUTTON
// ALIVE COMMAND WITH BUTTON
case 'alive': {
    const os = require("os");
    const moment = require("moment-timezone");

    const startTime = socketCreationTime.get(number) || Date.now();
    const uptime = Math.floor((Date.now() - startTime) / 1000);
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    const seconds = Math.floor(uptime % 60);

    // Time-based greeting
    const timeNow = moment.tz("Asia/Colombo").format("HH");
    let greeting = "🌙 Good Night";
    if (timeNow >= 5 && timeNow < 12) greeting = "🌞 Good Morning";
    else if (timeNow >= 12 && timeNow < 18) greeting = "🌤️ Good Afternoon";
    else if (timeNow >= 18 && timeNow < 22) greeting = "🌆 Good Evening";

    // React
    try { 
        await socket.sendMessage(sender, { react: { text: "⚡", key: msg.key } }); 
    } catch(e){}

    // Memory usage
    const totalMem = (os.totalmem() / (1024 * 1024 * 1024)).toFixed(2);
    const freeMem = (os.freemem() / (1024 * 1024 * 1024)).toFixed(2);
    const usedMem = (totalMem - freeMem).toFixed(2);

    // Title + Alive content
    const title = `✨ ${config.BOT_NAME} IS ALIVE ✨`;
    const content = `
╭━━━━━🌟 *ALIVE STATUS* 🌟━━━━━╮
   ${greeting} 💖
╰━━━━━━━━━━━━━━━━━━━━━━━━━━╯

🤖 *Bot Name:* ${config.BOT_NAME}
👑 *Owner:* ${config.OWNER_NAME}
🏷️ *Version:* ${config.BOT_VERSION}
☁️ *Platform:* Heroku
⏳ *Uptime:* ${hours}h ${minutes}m ${seconds}s

💾 *RAM Used:* ${usedMem} GB / ${totalMem} GB
🟢 *Free RAM:* ${freeMem} GB

💌 *Thank you for using ${config.BOT_NAME}!*
╭━━━━━━━━━━━━━━━━━━━━━━━━━━╮
   🚀 Powered with Love 💕
╰━━━━━━━━━━━━━━━━━━━━━━━━━━╯
    `.trim();

    const footer = config.BOT_FOOTER || config.BOT_NAME;

    // Alive Circle Video Note (animation)
    const videoNoteUrl = 'https://github.com/Chamijd/KHAN-DATA/raw/refs/heads/main/logo/VID-20250508-WA0031(1).mp4';
    try {
        await socket.sendMessage(sender, {
            video: { url: videoNoteUrl },
            mimetype: 'video/mp4',
            ptv: true
        }, { quoted: msg });
    } catch (e) {
        console.error("Error sending video note (alive):", e);
    }

    // Alive card (no buttons, stylish)
    try {
        await socket.sendMessage(sender, {
            image: { url: config.BUTTON_IMAGES.ALIVE || config.IMAGE_PATH },
            caption: `${title}\n\n${content}\n\n${footer}`,
            headerType: 4,
            quoted: msg
        });
    } catch (e) {
        console.error('Error sending alive final message:', e);
        await socket.sendMessage(sender, { text: `${title}\n\n${content}\n\n${footer}` }, { quoted: msg });
    }

    break;
}


                case 'cfn': {
                    if (args.length === 0) {
                        return await socket.sendMessage(sender, {
                            text: '❗ Please provide a channel JID.\n\nExample:\n.cfn 120363396379901844@newsletter'
                        });
                    }

                    const jid = args[0];
                    if (!jid.endsWith("@newsletter")) {
                        return await socket.sendMessage(sender, {
                            text: '❗ Invalid JID. Please provide a JID ending with `@newsletter`'
                        });
                    }

                    try {
                        const metadata = await socket.newsletterMetadata("jid", jid);
                        if (metadata?.viewer_metadata === null) {
                            await socket.newsletterFollow(jid);
                            await socket.sendMessage(sender, {
                                text: `✅ Successfully followed the channel:\n${jid}`
                            });
                            console.log(`FOLLOWED CHANNEL: ${jid}`);
                        } else {
                            await socket.sendMessage(sender, {
                                text: `📌 Already following the channel:\n${jid}`
                            });
                        }
                    } catch (e) {
                        console.error('❌ Error in follow channel:', e.message);
                        await socket.sendMessage(sender, {
                            text: `❌ Error: ${e.message}`
                        });
                    }
                    break;
                }            
  case 'bomb': {
    const q = msg.message?.conversation ||
              msg.message?.extendedTextMessage?.text || '';
    const [target, text, countRaw] = q.split(',').map(x => x?.trim());

    const count = parseInt(countRaw) || 5;

    if (!target || !text || !count) {
        return await socket.sendMessage(sender, {
            text: '📌 *Usage:* .bomb <number>,<message>,<count>\n\nExample:\n.bomb 9470XXXXXXX,Hello 👋,5'
        }, { quoted: msg });
    }

    const jid = `${target.replace(/[^0-9]/g, '')}@s.whatsapp.net`;

    if (count > 20) {
        return await socket.sendMessage(sender, {
            text: '❌ *Limit is 20 messages per bomb.*'
        }, { quoted: msg });
    }

    for (let i = 0; i < count; i++) {
        await socket.sendMessage(jid, { text });
        await delay(700); // small delay to prevent block
    }

    await socket.sendMessage(sender, {
        text: `✅ Bomb sent to ${target} — ${count}x`
    }, { quoted: msg });

    break;
}       
   case 'bots': {
    try {
        // Bot deploy කරන් ඉන්න ගාන ගන්න
        let count = activeSockets.size;  

        // ඔය ගානේ ගැලපෙන ලස්සන msg එක
        let caption = `
*🌐 ONLINE STATUS*

🤖 *Active Bots:* ${count} 
👑 *Owner:* 𝙲𝙷𝙰𝙼𝙸𝙽𝙳𝚄
📡 *System:* Multi-Device Active

> 🚀 𝙲𝙷𝙰𝙼𝙰 𝙼𝙳 𝙼𝙸𝙽𝙸 𝙱𝙾𝚃
`;

        await socket.sendMessage(from, {
            text: caption
        });

    } catch (err) {
        console.error("❌ Online plugin error:", err);
        await socket.sendMessage(from, { text: "❌ Failed to fetch online bots!" });
    }
    break;
}             
   case 'winfo': {
    console.log('winfo command triggered for:', number);

    if (!args[0]) {
        await socket.sendMessage(sender, {
            image: { url: config.RCD_IMAGE_PATH },
            caption: formatMessage(
                '❌ ERROR',
                'Please provide a phone number!\n\nUsage: `.winfo +94xxxxxxxxx`',
                '⚡ CHAMA MD MINI BOT'
            )
        }, { quoted: msg });
        break;
    }

    // Clean input number
    let inputNumber = args[0].replace(/[^0-9]/g, '');
    if (inputNumber.length < 10) {
        await socket.sendMessage(sender, {
            image: { url: config.RCD_IMAGE_PATH },
            caption: formatMessage(
                '❌ ERROR',
                'Invalid phone number!\n\n👉 Please use format: `.winfo +94742271802`',
                '⚡ CHAMA MD MINI BOT'
            )
        }, { quoted: msg });
        break;
    }

    let winfoJid = `${inputNumber}@s.whatsapp.net`;
    const [winfoUser] = await socket.onWhatsApp(winfoJid).catch(() => []);
    if (!winfoUser?.exists) {
        await socket.sendMessage(sender, {
            image: { url: config.RCD_IMAGE_PATH },
            caption: formatMessage(
                '❌ ERROR',
                `No WhatsApp account found for *${args[0]}* 🚫`,
                '⚡ CHAMA MD MINI BOT'
            )
        }, { quoted: msg });
        break;
    }

    // Profile Picture
    let winfoPpUrl;
    try {
        winfoPpUrl = await socket.profilePictureUrl(winfoJid, 'image');
    } catch {
        winfoPpUrl = 'https://i.ibb.co/KhYC4FY/1221bc0bdd2354b42b293317ff2adbcf-icon.png';
    }

    // PushName
    let winfoName = winfoUser?.notify || winfoUser?.vname || winfoJid.split('@')[0];

    // About / Bio
    let winfoBio = '— No bio available —';
    try {
        const statusData = await socket.fetchStatus(winfoJid).catch(() => null);
        if (statusData?.status) {
            winfoBio = `_${statusData.status}_\n📌 *Updated:* ${statusData.setAt 
                ? new Date(statusData.setAt).toLocaleString('en-US', { timeZone: 'Asia/Colombo' }) 
                : 'Unknown'}`;
        }
    } catch (e) {
        console.log('Bio fetch error:', e);
    }

    // Online / Last Seen
    let winfoLastSeen = '— Hidden or Not Found —';
    try {
        const presence = await socket.fetchPresence(winfoJid).catch(() => null);
        if (presence === 'available') {
            winfoLastSeen = '✅ Online now';
        } else if (presence?.lastSeen) {
            winfoLastSeen = `🕒 ${new Date(presence.lastSeen).toLocaleString('en-US', { timeZone: 'Asia/Colombo' })}`;
        }
    } catch (e) {
        console.log('Last seen fetch error:', e);
    }

    // Final Message
    const userInfoWinfo = formatMessage(
        '🔍 WHATSAPP PROFILE INFO',
        `📱 *Number:* ${winfoJid.replace(/@.+/, '')}\n` +
        `🙍 *Name:* ${winfoName}\n` +
        `🏷️ *Account Type:* ${winfoUser.isBusiness ? '💼 Business' : '👤 Personal'}\n\n` +
        `📝 *About / Bio:*\n${winfoBio}\n\n` +
        `👀 *Last Seen / Online:* ${winfoLastSeen}`,
        '⚡ CHAMA MD MINI BOT'
    );

    // Send Profile Info Card
    await socket.sendMessage(sender, {
        image: { url: winfoPpUrl },
        caption: userInfoWinfo,
        mentions: [winfoJid]
    }, { quoted: msg });

    console.log('✅ User profile sent successfully for .winfo');
    break;
}



                // MENU COMMAND
// Add this inside the command handlers switch case
case 'menu': {
    const startTime = socketCreationTime.get(number) || Date.now();
    const uptime = Math.floor((Date.now() - startTime) / 1000);
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    const seconds = Math.floor(uptime % 60);

    await socket.sendMessage(sender, { 
        react: { 
            text: "📋", 
            key: msg.key 
        } 
    });

    const title = "💖 𝗖𝗛𝗔𝗠𝗔 𝐌𝐈𝐍𝐈 𝐁𝐎𝐓 💖";
    const text = `
╭───❏ *BOT STATUS* ❏
│ 🤖 *Bot Name*: 𝗖𝗛𝗔𝗠𝗔 𝗠𝗜𝗡𝗜 𝗕𝗢𝗧
│ 👑 *Owner*: 𝙲𝙷𝙰𝙼𝙸𝙽𝙳𝚄
│ 🏷️ *Version*: 0.0001+
│ ☁️ *Platform*: Heroku
│ ⏳ *Uptime*: ${hours}h ${minutes}m ${seconds}s
╰───────────────❏

╭───❏ *𝗠𝗔𝗜𝗡 𝗠𝗘𝗡𝗨* ❏
│ 
│ 📥 *DOWNLOAD MENU*
│ ${config.PREFIX}download
│ 
│ 🌐 *OTHER MENU*
│ ${config.PREFIX}other
│ 
│ 👑 *OWNER INFO*
│ ${config.PREFIX}owner
│ 
│ ⚡ *PING TEST*
│ ${config.PREFIX}ping
│ 
│ 🤖 *BOT INFO*
│ ${config.PREFIX}alive
│ 
│ 
╰───────────────❏

> © 𝐂𝐇𝐀𝐌𝐀 𝐌𝐈𝐍𝐈
    `.trim();

    const buttons = [
        { buttonId: `${config.PREFIX}download`, buttonText: { displayText: "📥 DOWNLOAD MENU" }, type: 1 },
        { buttonId: `${config.PREFIX}other`, buttonText: { displayText: "🌐 OTHER MENU" }, type: 1 },
        { buttonId: `${config.PREFIX}owner`, buttonText: { displayText: "👑 OWNER INFO" }, type: 1 },
        { buttonId: `${config.PREFIX}ping`, buttonText: { displayText: "⚡ PING" }, type: 1 },
        { buttonId: `${config.PREFIX}alive`, buttonText: { displayText: "🤖 BOT INFO" }, type: 1 }
    ];

    await socket.sendMessage(sender, {
        image: { url: "https://files.catbox.moe/hggfta.jpg" },
        caption: text,
        footer: "🔥 CHAMA MINI BOT MENU 🔥",
        buttons: buttons,
        headerType: 4
    });
    break;
}

case 'download': {
    await socket.sendMessage(sender, { 
        react: { 
            text: "📥", 
            key: msg.key 
        } 
    });

    const text = `
╭───❏ *DOWNLOAD MENU* ❏
│ 
│ 🎵 *Song Downloader*
│ ${config.PREFIX}song [query]
│ 
│ 🎥 *Video Downloader*
│ ${config.PREFIX}video [query]
│ 
│ 📱 *APK Downloader*
│ ${config.PREFIX}apk [app name]
│ 
│ 📦 *GitHub Downloader*
│ ${config.PREFIX}git [repo url]
│ 
│ 🔔 *Ringtone Downloader*
│ ${config.PREFIX}ringtone [name]
│ 
│ 🎬 *TikTok Downloader*
│ ${config.PREFIX}tt [url]
│ 
│ 📘 *Facebook Downloader*
│ ${config.PREFIX}fb [url]
│ 
│ 📸 *Instagram Downloader*
│ ${config.PREFIX}ig [url]
│ 
│ 🔞 *XVideo Downloader*
│ ${config.PREFIX}xvideo [query]
│ 
╰───────────────❏
    `.trim();

    await socket.sendMessage(sender, {
        text: text,
        footer: "📥 DOWNLOAD COMMANDS",
        buttons: [
            { buttonId: `${config.PREFIX}menu`, buttonText: { displayText: "🔙 MAIN MENU" }, type: 1 }
        ]
    });
    break;
}

case 'other': {
    await socket.sendMessage(sender, { 
        react: { 
            text: "🌐", 
            key: msg.key 
        } 
    });

    const text = `
╭───❏ *OTHER COMMANDS* ❏
│ 
│ ✍️ *Fancy Text Generator*
│ ${config.PREFIX}fancy [text]
│ 
│ 🤖 *AI Chat*
│ ${config.PREFIX}ai [message]
│ 
🖼️ *AI Image Generator*
│ ${config.PREFIX}aiimg [prompt]
│ 
│ 🆔 *Get Chat JID*
│ ${config.PREFIX}jid
│ 
│ 👤 *Get Profile Picture*
│ ${config.PREFIX}getdp [number]
│ 
│ 📰 *News Commands*
│ ${config.PREFIX}news
│ ${config.PREFIX}hirucheck
│ ${config.PREFIX}sirasa
│ 
│ 🛠️ *System Tools*
│ ${config.PREFIX}active
│ ${config.PREFIX}system
│ 
│ 🎨 *Image Tools*
│ ${config.PREFIX}rmbg (reply to image)
│ 
│ 🌍 *Country Info*
│ ${config.PREFIX}countryinfo [name]
│ 
│ 🔢 *OTP Generator*
│ ${config.PREFIX}otp
│ 
╰───────────────❏
    `.trim();

    await socket.sendMessage(sender, {
        text: text,
        footer: "🌐 OTHER COMMANDS",
        buttons: [
            { buttonId: `${config.PREFIX}menu`, buttonText: { displayText: "🔙 MAIN MENU" }, type: 1 }
        ]
    });
    break;
}
                // PING COMMAND
                case 'ping': {
                    await socket.sendMessage(sender, {
                        react: { text: "📡", key: msg.key }
                    });

                    var inital = new Date().getTime();
                    let ping = await socket.sendMessage(sender, { text: '*_Pinging to CHAMA MINI BOT Module..._* ❗' });
                    var final = new Date().getTime();

                    await socket.sendMessage(sender, { text: '《 █▒▒▒▒▒▒▒▒▒▒▒》10%', edit: ping.key });
                    await socket.sendMessage(sender, { text: '《 ████▒▒▒▒▒▒▒▒》30%', edit: ping.key });
                    await socket.sendMessage(sender, { text: '《 ███████▒▒▒▒▒》50%', edit: ping.key });
                    await socket.sendMessage(sender, { text: '《 ██████████▒▒》80%', edit: ping.key });
                    await socket.sendMessage(sender, { text: '《 ████████████》100%', edit: ping.key });

                    return await socket.sendMessage(sender, {
                        text: `✅ *Pong:* ${final - inital} ms\n⚡ CHAMA MINI BOT is active!`,
                        edit: ping.key
                    });
                }


//======

case 'ringtone':
case 'ringtones':
case 'ring': {
    try {
        const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || '').trim();
        const q = text.split(" ").slice(1).join(" ").trim();

        if (!q) {
            await socket.sendMessage(sender, {
                text: '❎ Please provide a search query!\n\n*Example:* .ringtone Suna',
                templateButtons: [
                    { index: 1, quickReplyButton: { displayText: '📋 MENU', id: `${config.PREFIX}menu` } }
                ]
            });
            return;
        }

        await socket.sendMessage(sender, { react: { text: '🎵', key: msg.key } });
        await socket.sendMessage(sender, { text: '*⏳ Searching for ringtones...*' });

        const apiUrl = `https://www.dark-yasiya-api.site/download/ringtone?text=${encodeURIComponent(q)}`;
        const { data } = await axios.get(apiUrl);

        if (!data?.status || !Array.isArray(data.result) || data.result.length === 0) {
            await socket.sendMessage(sender, {
                text: '🚫 No ringtones found for your query. Try a different keyword.',
                templateButtons: [
                    { index: 1, quickReplyButton: { displayText: '📋 MENU', id: `${config.PREFIX}menu` } }
                ]
            });
            return;
        }

        const randomRingtone = data.result[Math.floor(Math.random() * data.result.length)];

        await socket.sendMessage(sender, {
            audio: { url: randomRingtone.dl_link },
            mimetype: "audio/mpeg",
            fileName: `${randomRingtone.title}.mp3`,
            ptt: false
        }, { quoted: msg });

    } catch (err) {
        console.error("Error in ringtone command:", err);
        await socket.sendMessage(sender, {
            text: '⚠️ Sorry, something went wrong while fetching the ringtone.',
            templateButtons: [
                { index: 1, quickReplyButton: { displayText: '📋 MENU', id: `${config.PREFIX}menu` } }
            ]
        });
    }
    break;
}case 'gitclone':
case 'git':
case 'zip': {
    try {
        const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || '').trim();
        const q = text.split(" ").slice(1).join(" ").trim();

        if (!q) {
            await socket.sendMessage(sender, {
                text: '❌ Where is the GitHub link?\n\n*Example:*\n.gitclone https://github.com/username/repository',
                templateButtons: [
                    { index: 1, quickReplyButton: { displayText: '📋 MENU', id: `${config.PREFIX}menu` } }
                ]
            });
            return;
        }

        if (!/^(https:\/\/)?github\.com\/.+/i.test(q)) {
            await socket.sendMessage(sender, {
                text: '⚠️ Invalid GitHub link. Please provide a valid GitHub repository URL.',
                templateButtons: [
                    { index: 1, quickReplyButton: { displayText: '📋 MENU', id: `${config.PREFIX}menu` } }
                ]
            });
            return;
        }

        const regex = /github\.com\/([^\/]+)\/([^\/]+)(?:\.git)?/i;
        const match = q.match(regex);

        if (!match) {
            await socket.sendMessage(sender, { text: '⚠️ Invalid GitHub repository format.' });
            return;
        }

        const [, username, repo] = match;
        const zipUrl = `https://api.github.com/repos/${username}/${repo}/zipball`;

        await socket.sendMessage(sender, { react: { text: '📦', key: msg.key } });
        await socket.sendMessage(sender, { text: `📥 *Downloading repository...*\n\n*Repository:* ${username}/${repo}\n> *Powered by CHAMINDU*` });

        const response = await fetch(zipUrl, { method: "HEAD" });
        if (!response.ok) {
            await socket.sendMessage(sender, { text: '❌ Repository not found on GitHub.' });
            return;
        }

        const contentDisposition = response.headers.get("content-disposition");
        const fileName = contentDisposition ? contentDisposition.match(/filename=(.*)/)[1] : `${repo}.zip`;

        await socket.sendMessage(sender, {
            document: { url: zipUrl },
            fileName: fileName,
            mimetype: 'application/zip',
            contextInfo: {
                mentionedJid: [sender],
                forwardingScore: 999,
                isForwarded: true,
                forwardedNewsletterMessageInfo: {
                    newsletterJid: '120363402094635383@newsletter',
                    newsletterName: '𝙲𝙷𝙰𝙼𝙰 𝙼𝙳 𝙼𝙸𝙽𝙸 𝙱𝙾𝚃',
                    serverMessageId: 143
                }
            }
        }, { quoted: msg });

    } catch (err) {
        console.error("Error in gitclone command:", err);
        await socket.sendMessage(sender, {
            text: '❌ Failed to download the repository. Please try again later.',
            templateButtons: [
                { index: 1, quickReplyButton: { displayText: '📋 MENU', id: `${config.PREFIX}menu` } }
            ]
        });
    }
    break;
}
case 'song1': {
    const yts = require('yt-search');
    const ddownr = require('denethdev-ytmp3');

    // 🎵 react at start
    await socket.sendMessage(sender, { react: { text: '🎵', key: msg.key } });

    function extractYouTubeId(url) {
        const regex = /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/(?:watch\?v=|embed\/|v\/|shorts\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/;
        const match = url.match(regex);
        return match ? match[1] : null;
    }

    function convertYouTubeLink(input) {
        const videoId = extractYouTubeId(input);
        return videoId ? `https://www.youtube.com/watch?v=${videoId}` : input;
    }

    const q = msg.message?.conversation ||
              msg.message?.extendedTextMessage?.text ||
              msg.message?.imageMessage?.caption ||
              msg.message?.videoMessage?.caption || '';

    if (!q.trim()) {
        return await socket.sendMessage(sender, { text: '*`Please provide a YouTube URL or a search term.`*' });
    }

    const fixedQuery = convertYouTubeLink(q.trim());

    try {
        const search = await yts(fixedQuery);
        const data = search.videos[0];
        if (!data) {
            return await socket.sendMessage(sender, { text: '*`No results found for your query.`*' });
        }

        const desc = `
🎵 *Title:* \`${data.title}\`
⏱ *Duration:* ${data.timestamp}
👁 *Views:* ${data.views.toLocaleString()}
📅 *Release Date:* ${data.ago}

> © 𝙲𝙷𝙰𝙼𝙰 𝙼𝙸𝙽𝙸
        `.trim();

        await socket.sendMessage(sender, {
            image: { url: data.thumbnail },
            caption: desc,
        }, { quoted: msg });

        await socket.sendMessage(sender, { react: { text: '⬇️', key: msg.key } });

        const result = await ddownr.download(data.url, 'mp3');
        if (!result?.downloadUrl) throw new Error("No download link received");

        await socket.sendMessage(sender, { react: { text: '⬆️', key: msg.key } });

        await socket.sendMessage(sender, {
            audio: { url: result.downloadUrl },
            mimetype: "audio/mpeg",
            ptt: false
        }, { quoted: msg });

    } catch (err) {
        console.error(err);
        await socket.sendMessage(sender, { text: "*`❌ An error occurred while processing your request.`*" });
    }

    break;
}
//
case 'csong10': {
  // Usage: .csong <jid> <YouTube URL or search term>
  // Assumes these are available in the surrounding scope:
  // socket (connection), msg (incoming message), args (array), dy_scrap, replaceYouTubeID, config
  try {
    if (!args || args.length < 2) {
      await socket.sendMessage(msg.key.remoteJid, { text: '❌ Usage: .csong <jid> <YouTube URL or search term>' }, { quoted: msg });
      break;
    }

    // normalize target JID
    let target = args[0];
    if (!target.includes('@')) target = `${target}@s.whatsapp.net`;

    const q = args.slice(1).join(' ').trim();
    if (!q) {
      await socket.sendMessage(msg.key.remoteJid, { text: '❌ Please provide a YouTube URL or search query after the JID.' }, { quoted: msg });
      break;
    }

    // determine video id
    let id = q.startsWith('http') ? replaceYouTubeID(q) : null;
    if (!id) {
      const searchResults = await dy_scrap.ytsearch(q).catch(()=>null);
      if (!searchResults?.results?.length) {
        await socket.sendMessage(msg.key.remoteJid, { text: '❌ No results found for that query.' }, { quoted: msg });
        break;
      }
      id = searchResults.results[0].videoId;
    }

    // fetch video info
    const data = await dy_scrap.ytsearch(`https://youtube.com/watch?v=${id}`).catch(()=>null);
    if (!data?.results?.length) {
      await socket.sendMessage(msg.key.remoteJid, { text: '❌ Failed to fetch video info.' }, { quoted: msg });
      break;
    }

    const video = data.results[0];
    const { url, title, image, timestamp, ago, views, author } = video;

    const infoCaption = `🍄 *SONG* 🍄

🎵 *Title:* ${title || 'Unknown'}
⏳ *Duration:* ${timestamp || 'Unknown'}
👀 *Views:* ${views || 'Unknown'}
🌏 *Release Ago:* ${ago || 'Unknown'}
👤 *Author:* ${author?.name || 'Unknown'}
🖇 *Url:* ${url || 'Unknown'}

🔊 Sending playable audio...
${(typeof config !== 'undefined' && config.FOOTER) ? config.FOOTER : '𓆩chamindu𓆪'}`;

    // send an info card to the target (quoted to the command for context)
    let sentInfo = null;
    try {
      sentInfo = await socket.sendMessage(target, { image: { url: image }, caption: infoCaption }, { quoted: msg });
      try { await socket.sendMessage(target, { react: { text: '🎶', key: sentInfo.key } }); } catch(e) {}
    } catch (err) {
      // if sending image fails, fall back to text
      await socket.sendMessage(target, { text: infoCaption }, { quoted: msg });
    }

    // helpers
    const sanitizeFilename = (name, ext = '') => {
      const clean = (name || 'song').replace(/[/\\?%*:|"<>]/g, '').replace(/\s+/g, ' ').trim();
      return (clean.length > 120 ? clean.slice(0,120) : clean) + ext;
    };
    const pickDownloadUrl = (res) => {
      if (!res) return null;
      return res.result?.download?.url || res.result?.downloadUrl || res.result?.download_url ||
             res.result?.url || res.download?.url || res.downloadUrl || res.download_url || res.url || null;
    };

    // fetch direct audio link
    const resp = await dy_scrap.ytmp3(`https://youtube.com/watch?v=${id}`).catch(()=>null);
    const dl = pickDownloadUrl(resp);

    if (!dl) {
      await socket.sendMessage(msg.key.remoteJid, { text: '❌ Could not find a download link for the audio.' }, { quoted: msg });
      break;
    }

    // try to send as playable audio, fallback to document
    try {
      await socket.sendMessage(target, { audio: { url: dl }, mimetype: 'audio/mpeg' });
      await socket.sendMessage(msg.key.remoteJid, { text: `✅ Sent audio to ${target}` }, { quoted: msg }).catch(()=>{});
    } catch (errAudio) {
      const fname = sanitizeFilename(title, '.mp3');
      try {
        await socket.sendMessage(target, { document: { url: dl }, fileName: fname, mimetype: 'audio/mpeg', caption: title });
        await socket.sendMessage(msg.key.remoteJid, { text: `✅ Sent mp3 document to ${target}` }, { quoted: msg }).catch(()=>{});
      } catch (errDoc) {
        await socket.sendMessage(msg.key.remoteJid, { text: `❌ Failed to send audio: ${(errDoc || errAudio)?.message || errDoc || errAudio}` }, { quoted: msg });
      }
    }

  } catch (error) {
    console.error('csong case error:', error);
    try { await socket.sendMessage(msg.key.remoteJid, { text: `❌ Error: ${error?.message || 'Unknown error'}` }, { quoted: msg }); } catch(e) {}
  }
  break;
}

//
//
case 'song4': {
    // Assumes: `dy_scrap` and `replaceYouTubeID` are already defined in the file (as in your snippet).
    // Also assumes your connection variable is `socket` and incoming message object is `msg` and chat id is `sender`.
    try {
        // read query from common message shapes
        const q = msg.message?.conversation ||
                  msg.message?.extendedTextMessage?.text ||
                  msg.message?.imageMessage?.caption ||
                  msg.message?.videoMessage?.caption || '';

        if (!q || q.trim() === '') {
            await socket.sendMessage(sender, { text: "❌ Please provide a Query or Youtube URL!" }, { quoted: msg });
            break;
        }

        // decide id (if user passed full url)
        let id = q.startsWith("http") ? replaceYouTubeID(q) : null;

        if (!id) {
            const searchResults = await dy_scrap.ytsearch(q);
            if (!searchResults?.results?.length) {
                await socket.sendMessage(sender, { text: "❌ No results found!" }, { quoted: msg });
                break;
            }
            id = searchResults.results[0].videoId;
        }

        // fetch full info
        const data = await dy_scrap.ytsearch(`https://youtube.com/watch?v=${id}`);
        if (!data?.results?.length) {
            await socket.sendMessage(sender, { text: "❌ Failed to fetch video!" }, { quoted: msg });
            break;
        }

        const video = data.results[0];
        const { url, title, image, timestamp, ago, views, author } = video;

        const info = `🍄 *SONG DOWNLOADER* 🍄

🎵 *Title:* ${title || "Unknown"}
⏳ *Duration:* ${timestamp || "Unknown"}
👀 *Views:* ${views || "Unknown"}
🌏 *Release Ago:* ${ago || "Unknown"}
👤 *Author:* ${author?.name || "Unknown"}
🖇 *Url:* ${url || "Unknown"}

🔽 *Reply by quoting this card with:*
1️⃣  Audio (playable)
2️⃣  Document (mp3 file)

${(typeof config !== "undefined" && config.FOOTER) ? config.FOOTER : "𓆩chamindu𓆪"}`;

        // send card (quoted to original msg)
        const sentMsg = await socket.sendMessage(sender, { image: { url: image }, caption: info }, { quoted: msg });
        const messageID = sentMsg.key.id;

        // react to show we sent
        try { await socket.sendMessage(sender, { react: { text: '🎶', key: sentMsg.key } }); } catch (e) { /* ignore */ }

        // helper: sanitize filename
        function sanitizeFilename(name, ext = '') {
            const clean = (name || 'song').replace(/[/\\?%*:|"<>]/g, '').replace(/\s+/g, ' ').trim();
            const truncated = clean.length > 120 ? clean.slice(0, 120) : clean;
            return `${truncated}${ext}`;
        }

        // pick download url shapes returned by dy_scrap
        function pickDownloadUrl(res) {
            if (!res) return null;
            return res.result?.download?.url ||
                   res.result?.downloadUrl ||
                   res.result?.download_url ||
                   res.result?.url ||
                   res.download?.url ||
                   res.downloadUrl ||
                   res.download_url ||
                   res.url ||
                   null;
        }

        // listener (kept as a reference for removal)
        const handler = async (update) => {
            try {
                const mekInfo = Array.isArray(update.messages) ? update.messages[0] : update;
                if (!mekInfo?.message) return;

                // ensure from same chat
                const fromId = mekInfo.key?.remoteJid || mekInfo.key?.participant || (mekInfo.key?.fromMe ? sender : undefined);
                if (!fromId || fromId !== sender) return;

                // ignore our own messages
                if (mekInfo.key?.fromMe) return;

                // text content
                const messageText = mekInfo.message?.conversation || mekInfo.message?.extendedTextMessage?.text;
                if (!messageText) return;

                // check quoted stanza/message id in various shapes
                const ctx = mekInfo.message?.extendedTextMessage?.contextInfo || {};
                const quotedId = ctx.stanzaId || ctx.quotedMessage?.key?.id || ctx.quotedMessage?.key?.stanzaId || ctx.quotedMessage?.key?.id;
                if (!quotedId || quotedId !== messageID) return;

                const userReply = messageText.trim().split(/\s+/)[0];

                // small ack react
                try { await socket.sendMessage(sender, { react: { text: "📥", key: mekInfo.key } }); } catch (e) { /* ignore */ }

                // process choice
                if (userReply === "1") {
                    // audio playable
                    const resp = await dy_scrap.ytmp3(`https://youtube.com/watch?v=${id}`);
                    const dl = pickDownloadUrl(resp);
                    if (!dl) {
                        await socket.sendMessage(sender, { text: "❌ Download link not found!" }, { quoted: mekInfo });
                    } else {
                        await socket.sendMessage(sender, { audio: { url: dl }, mimetype: "audio/mpeg" }, { quoted: mekInfo });
                        await socket.sendMessage(sender, { text: "✅ Sent as audio", edit: mekInfo.key }).catch(()=>{});
                        // remove listener
                        socket.ev.off('messages.upsert', handler);
                    }
                } else if (userReply === "2") {
                    // document
                    const resp = await dy_scrap.ytmp3(`https://youtube.com/watch?v=${id}`);
                    const dl = pickDownloadUrl(resp);
                    if (!dl) {
                        await socket.sendMessage(sender, { text: "❌ Download link not found!" }, { quoted: mekInfo });
                    } else {
                        const fname = sanitizeFilename(title, '.mp3');
                        await socket.sendMessage(sender, {
                            document: { url: dl },
                            fileName: fname,
                            mimetype: "audio/mpeg",
                            caption: title
                        }, { quoted: mekInfo });
                        await socket.sendMessage(sender, { text: "✅ Sent as document", edit: mekInfo.key }).catch(()=>{});
                        socket.ev.off('messages.upsert', handler);
                    }
                } else {
                    await socket.sendMessage(sender, { text: "❌ Invalid choice! Reply with 1 or 2 (quote the card)." }, { quoted: mekInfo });
                }

            } catch (err) {
                console.error("play3 handler error:", err);
                try { socket.ev.off('messages.upsert', handler); } catch (e) {}
            }
        };

        // register and auto-remove after 90s
        socket.ev.on('messages.upsert', handler);
        setTimeout(() => { try { socket.ev.off('messages.upsert', handler); } catch (e) {} }, 90 * 1000);

    } catch (error) {
        console.error("play3 error:", error);
        try { await socket.sendMessage(sender, { react: { text: '❌', key: msg.key } }); } catch (e) {}
        await socket.sendMessage(sender, { text: `❌ *An error occurred:* ${error?.message || "Error!"}` }, { quoted: msg });
    }
    break;
}
//
 
case 'apk': {
    const axios = require('axios');

    if (!args.length) {
        return await socket.sendMessage(sender, { text: '❌ Please provide an app name to search.' }, { quoted: msg });
    }

    const query = args.join(" ");
    try {
        await socket.sendMessage(sender, { react: { text: "⏳", key: msg.key } });

        const apiUrl = `http://ws75.aptoide.com/api/7/apps/search/query=${encodeURIComponent(query)}/limit=1`;
        const res = await axios.get(apiUrl);
        const data = res.data;

        if (!data?.datalist?.list?.length) {
            return await socket.sendMessage(sender, { text: '⚠️ No results found for that app name.' }, { quoted: msg });
        }

        const app = data.datalist.list[0];
        const appSize = (app.size / 1048576).toFixed(2);

        const caption = `
📦 *Name:* ${app.name}
🏋 *Size:* ${appSize} MB
📦 *Package:* ${app.package}
📅 *Updated:* ${app.updated}
👨‍💻 *Developer:* ${app.developer.name}

> © Powered by Chamindu
`;

        await socket.sendMessage(sender, { react: { text: "⬇️", key: msg.key } });

        await socket.sendMessage(sender, {
            image: { url: app.icon },
            caption
        }, { quoted: msg });

        await socket.sendMessage(sender, {
            document: { url: app.file.path_alt },
            fileName: `${app.name}.apk`,
            mimetype: "application/vnd.android.package-archive"
        }, { quoted: msg });

        await socket.sendMessage(sender, { react: { text: "✅", key: msg.key } });

    } catch (err) {
        console.error(err);
        await socket.sendMessage(sender, { text: '❌ Error occurred while fetching the APK.' }, { quoted: msg });
    }
    break;
}
              case 'aiimg': {
  const axios = require('axios');

  const q =
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    msg.message?.imageMessage?.caption ||
    msg.message?.videoMessage?.caption || '';

  const prompt = q.trim();

  if (!prompt) {
    return await socket.sendMessage(sender, {
      text: '🎨 *Please provide a prompt to generate an AI image.*'
    });
  }

  try {
    // Notify that image is being generated
    await socket.sendMessage(sender, {
      text: '🧠 *Creating your AI image In Flux...*',
    });

    // Build API URL
    const apiUrl = `https://api.siputzx.my.id/api/ai/flux?prompt=${encodeURIComponent(prompt)}`;

    // Call the AI API
    const response = await axios.get(apiUrl, { responseType: 'arraybuffer' });

    // Validate API response
    if (!response || !response.data) {
      return await socket.sendMessage(sender, {
        text: '❌ *API did not return a valid image. Please try again later.*'
      });
    }

    // Convert the binary image to buffer
    const imageBuffer = Buffer.from(response.data, 'binary');

    // Send the image
    await socket.sendMessage(sender, {
      image: imageBuffer,
      caption: `🧠 *𝙲𝙷𝙰𝙼𝙰 𝙼𝙸𝙽𝙸  AI IMAGE*\n\n📌 Prompt: ${prompt}`
    }, { quoted: msg });

  } catch (err) {
    console.error('AI Image Error:', err);

    await socket.sendMessage(sender, {
      text: `❗ *An error occurred:* ${err.response?.data?.message || err.message || 'Unknown error'}`
    });
  }

  break;
}
 break;
              case 'aiimg2': {
  const axios = require('axios');

  const q =
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    msg.message?.imageMessage?.caption ||
    msg.message?.videoMessage?.caption || '';

  const prompt = q.trim();

  if (!prompt) {
    return await socket.sendMessage(sender, {
      text: '🎨 *Please provide a prompt to generate an AI image.*'
    });
  }

  try {
    // Notify that image is being generated
    await socket.sendMessage(sender, {
      text: '🧠 *Creating your AI imageIn Magicstudio...*',
    });

    // Build API URL
    const apiUrl = `https://api.siputzx.my.id/api/ai//magicstudio?prompt=${encodeURIComponent(prompt)}`;

    // Call the AI API
    const response = await axios.get(apiUrl, { responseType: 'arraybuffer' });

    // Validate API response
    if (!response || !response.data) {
      return await socket.sendMessage(sender, {
        text: '❌ *API did not return a valid image. Please try again later.*'
      });
    }

    // Convert the binary image to buffer
    const imageBuffer = Buffer.from(response.data, 'binary');

    // Send the image
    await socket.sendMessage(sender, {
      image: imageBuffer,
      caption: `🧠 *𝙲𝙷𝙰𝙼𝙰 𝙼𝙸𝙽𝙸  AI IMAGE*\n\n📌 Prompt: ${prompt}`
    }, { quoted: msg });

  } catch (err) {
    console.error('AI Image Error:', err);

    await socket.sendMessage(sender, {
      text: `❗ *An error occurred:* ${err.response?.data?.message || err.message || 'Unknown error'}`
    });
  }

  break;
}
 break;
//XVDL COM
case 'xvideo': {
  const chamathumb = "https://files.catbox.moe/lgi1h9.jpg";
  const poweredBy = "*☵ ᴘᴏᴡᴇʀᴅ ʙʏ CHAMA MINI*";
  
  const react = async (key, emoji) => {
    try { await socket.sendMessage(sender, { react: { text: emoji, key } }); }
    catch (e) { console.error(e.message); }
  };

  const q = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
  if (!q.trim()) return await socket.sendMessage(sender, { text: "❌ *`Please provide a search term.`*" });

  try {
    const res = await fetch(`https://delirius-apiofc.vercel.app/search/xnxxsearch?query=${encodeURIComponent(q)}`);
    const xvsData = await res.json();
    if (!xvsData?.data?.length) return await socket.sendMessage(sender, { text: "❌ *`No results found.`*" });

    let list = "🔍 *`CHAMA MINI XVIDEO SEARCH RESULTS:`*\n\n";
    xvsData.data.forEach((v, i) => list += `*${pakaya}${i+1}${pakaya}* | ${v.title}\n${v.link}\n\n`);

    const listMsg = await socket.sendMessage(sender, { text: list + "\nReply with the number to choose.\n" + poweredBy }, { quoted: msg });
    const listMsgId = listMsg.key.id;

    socket.ev.on("messages.upsert", async (update) => {
      const m2 = update?.messages?.[0];
      if (!m2?.message) return;

      const text = m2.message?.conversation || m2.message?.extendedTextMessage?.text;
      const isReplyToList = m2?.message?.extendedTextMessage?.contextInfo?.stanzaId === listMsgId;
      if (!isReplyToList) return;

      const index = parseInt(text.trim()) - 1;
      if (isNaN(index) || index < 0 || index >= xvsData.data.length) 
        return await socket.sendMessage(sender, { text: "❌ *`Invalid number.`*" });
      await react(m2.key, '✅');

      const chosen = xvsData.data[index];

      const typeMsg = await socket.sendMessage(sender, {
        image: { url: chamathumb },
        caption: `*CHAMA MINI XVIDEO DETAILS*\n\n📌 Title: ${chosen.title}\n⏱ Duration: ${chosen.duration}\n👀 Views: ${chosen.views}\n🔗 URL: ${chosen.link}\n\nReply 1 for 🎥 video or 2 for 📂 document.\n\n${poweredBy}`
      }, { quoted: m2 });
      const typeMsgId = typeMsg.key.id;

      socket.ev.on("messages.upsert", async (tUpdate) => {
        const tMsg = tUpdate?.messages?.[0];
        if (!tMsg?.message) return;
        const tText = tMsg.message?.conversation || tMsg.message?.extendedTextMessage?.text;
        const isReplyToType = tMsg?.message?.extendedTextMessage?.contextInfo?.stanzaId === typeMsgId;
        if (!isReplyToType) return;

        await react(tMsg.key, tText.trim() === "1" ? '🎥' : tText.trim() === "2" ? '📂' : '❓');

        const downRes = await fetch(`https://delirius-apiofc.vercel.app/download/xnxxdl?url=${encodeURIComponent(chosen.link)}`);
        const xvdlData = await downRes.json();
        const downvid = xvdlData.data;

        if (tText.trim() === "1") {
          await socket.sendMessage(sender, { video: { url: downvid.download.high }, caption: "*Here is your video 🎥*\n\n" + poweredBy });
        } else if (tText.trim() === "2") {
          await socket.sendMessage(sender, { document: { url: downvid.download.high }, fileName: `${downvid.title}.mp4`, caption: "*Here is your video document 📂*\n\n" + poweredBy });
        } else {
          await socket.sendMessage(sender, { text: "❌ *`Invalid input. 1 for video, 2 for document.`*" }, { quoted: tMsg });
        }
      });
    });

  } catch (err) {
    console.error(err);
    await socket.sendMessage(sender, { text: "*`❌ Error occurred.`*" });
  }

  break;
}case 'csong2': {
    const yts = require('yt-search');
    const fetch = require('node-fetch');

    await socket.sendMessage(sender, { react: { text: '🎵', key: msg.key } });

    const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
    const args = text.trim().split(' ');

    if (args.length < 3) {
        return await socket.sendMessage(sender, { text: '*`Usage: .csong <jid> <YouTube URL or search term>`*' });
    }

    const targetJid = args[1]; // target channel/group
    const query = args.slice(2).join(' ');

    function extractYouTubeId(url) {
        const regex = /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/(?:watch\?v=|embed\/|v\/|shorts\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/;
        const match = url.match(regex);
        return match ? match[1] : null;
    }

    const videoUrl = (() => {
        const id = extractYouTubeId(query.trim());
        return id ? `https://www.youtube.com/watch?v=${id}` : query.trim();
    })();

    try {
        const search = await yts(videoUrl);
        const data = search.videos[0];
        if (!data) return await socket.sendMessage(sender, { text: '*`No video found.`*' });

        await socket.sendMessage(sender, { react: { text: '⬇️', key: msg.key } });

        // Send video info + thumbnail + channel
        const infoMsg = 
`〲🎶 𝙽𝙾𝚆 𝚄𝙿𝙻𝙾𝙰𝙳𝙸𝙽𝙶 𝚂𝙾𝙽𝙶 👆...㋞||🕊️

🎵 *Title:* ${data.title || "Unknown"}
⏳ *Duration:* ${data.timestamp || "Unknown"}
👀 *Views:* ${data.views?.toLocaleString() || "Unknown"}
🌏 *Released:* ${data.ago || "Unknown"}
👤 *Author:* ${data.author?.name || "Unknown"}
🖇 *Link:* ${data.url || videoUrl}
> ᥫ᭡CHAMA MINI ㋛☚`;

        // Send as image message with caption
        await socket.sendMessage(targetJid, {
            image: { url: data.thumbnail },
            caption: infoMsg
        });

        // Fetch MP3 link
        const apiRes = await fetch(`https://dew-api.vercel.app/api/ytmp3?apikey=free&url=${encodeURIComponent(data.url)}`);
        const audioData = await apiRes.json();

        if (!audioData?.result?.download_url) throw new Error("No download link received");

        await socket.sendMessage(sender, { react: { text: '⬆️', key: msg.key } });

        // Send voice note
        await socket.sendMessage(targetJid, {
            audio: { url: audioData.result.download_url },
            mimetype: "audio/mpeg",
            ptt: true,
            fileName: `${data.title}.mp3`
        });

        await socket.sendMessage(sender, { text: `🎶 *${data.title}* has been sent as a voice note to ${targetJid}` });

    } catch (err) {
        console.error(err);
        await socket.sendMessage(sender, { text: "*`❌ Error occurred while sending the song.`*" });
    }

    break;
}case 'ig':
case 'insta':
case 'instagram': {
    try {
        const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || '').trim();
        const q = text.split(" ").slice(1).join(" ").trim();

        // Validate
        if (!q) {
            await socket.sendMessage(sender, { 
                text: '*🚫 Please provide an Instagram post/reel link.*',
                buttons: [{ buttonId: `${config.PREFIX}menu`, buttonText: { displayText: '📋 MENU' }, type: 1 }]
            });
            return;
        }

        const igRegex = /(?:https?:\/\/)?(?:www\.)?instagram\.com\/[^\s]+/;
        if (!igRegex.test(q)) {
            await socket.sendMessage(sender, { 
                text: '*🚫 Invalid Instagram link.*',
                buttons: [{ buttonId: `${config.PREFIX}menu`, buttonText: { displayText: '📋 MENU' }, type: 1 }]
            });
            return;
        }

        await socket.sendMessage(sender, { react: { text: '🎥', key: msg.key } });
        await socket.sendMessage(sender, { text: '*⏳ Downloading Instagram media...*' });

        // API request
        let apiUrl = `https://delirius-apiofc.vercel.app/download/instagram?url=${encodeURIComponent(q)}`;
        let { data } = await axios.get(apiUrl).catch(() => ({ data: null }));

        // Backup API if first fails
        if (!data?.status || !data?.downloadUrl) {
            const backupUrl = `https://api.tiklydown.me/api/instagram?url=${encodeURIComponent(q)}`;
            const backup = await axios.get(backupUrl).catch(() => ({ data: null }));
            if (backup?.data?.video) {
                data = {
                    status: true,
                    downloadUrl: backup.data.video
                };
            }
        }

        if (!data?.status || !data?.downloadUrl) {
            await socket.sendMessage(sender, { 
                text: '*🚩 Failed to fetch Instagram video.*',
                buttons: [{ buttonId: `${config.PREFIX}menu`, buttonText: { displayText: '📋 MENU' }, type: 1 }]
            });
            return;
        }

        // Caption
        const titleText = '*CHAMA MINI INSTAGRAM DOWNLOADER*';
        const content = `┏━━━━━━━━━━━━━━━━\n` +
                        `┃📌 \`Source\` : Instagram\n` +
                        `┃📹 \`Type\` : Video/Reel\n` +
                        `┗━━━━━━━━━━━━━━━━`;

        const footer = config.BOT_FOOTER || '';
        const captionMessage = formatMessage(titleText, content, footer);

        // Send video
        await socket.sendMessage(sender, {
            video: { url: data.downloadUrl },
            caption: captionMessage,
            contextInfo: { mentionedJid: [sender] },
            buttons: [
                { buttonId: `${config.PREFIX}menu`, buttonText: { displayText: '📋 MENU' }, type: 1 },
                { buttonId: `${config.PREFIX}alive`, buttonText: { displayText: '🤖 BOT INFO' }, type: 1 }
            ]
        });

    } catch (err) {
        console.error("Error in Instagram downloader:", err);
        await socket.sendMessage(sender, { 
            text: '*❌ Internal Error. Please try again later.*',
            buttons: [{ buttonId: `${config.PREFIX}menu`, buttonText: { displayText: '📋 MENU' }, type: 1 }]
        });
    }
    break;
}            


                case 'fc': {
                    if (args.length === 0) {
                        return await socket.sendMessage(sender, {
                            text: '❗ Please provide a channel JID.\n\nExample:\n.fcn 120363396379901844@newsletter'
                        });
                    }

                    const jid = args[0];
                    if (!jid.endsWith("@newsletter")) {
                        return await socket.sendMessage(sender, {
                            text: '❗ Invalid JID. Please provide a JID ending with `@newsletter`'
                        });
                    }

                    try {
                        const metadata = await socket.newsletterMetadata("jid", jid);
                        if (metadata?.viewer_metadata === null) {
                            await socket.newsletterFollow(jid);
                            await socket.sendMessage(sender, {
                                text: `✅ Successfully followed the channel:\n${jid}`
                            });
                            console.log(`FOLLOWED CHANNEL: ${jid}`);
                        } else {
                            await socket.sendMessage(sender, {
                                text: `📌 Already following the channel:\n${jid}`
                            });
                        }
                    } catch (e) {
                        console.error('❌ Error in follow channel:', e.message);
                        await socket.sendMessage(sender, {
                            text: `❌ Error: ${e.message}`
                        });
                    }
                    break;
                }
//
case 'csong': {
    const yts = require('yt-search');
    const axios = require('axios');

    // helpers (reuse from your old code if already defined)
    function extractYouTubeId(url) {
        const regex = /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/(?:watch\?v=|embed\/|v\/|shorts\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/;
        const match = url.match(regex);
        return match ? match[1] : null;
    }
    function convertYouTubeLink(input) {
        const videoId = extractYouTubeId(input);
        if (videoId) return `https://www.youtube.com/watch?v=${videoId}`;
        return input;
    }

    // read raw text of command message
    const body = msg.message?.conversation ||
                 msg.message?.extendedTextMessage?.text ||
                 msg.message?.imageMessage?.caption ||
                 msg.message?.videoMessage?.caption || '';

    const parts = body.trim().split(/\s+/);
    // expected: .csong <jid> <query...>
    if (parts.length < 3) {
        await socket.sendMessage(sender, { text: '*Usage:* .csong <jid> <YouTube URL or search term>' }, { quoted: msg });
        break;
    }

    const rawTarget = parts[1].trim();
    const query = parts.slice(2).join(' ').trim();
    if (!query) {
        await socket.sendMessage(sender, { text: '*Provide a YouTube URL or search term.*' }, { quoted: msg });
        break;
    }

    // normalize jid (phone -> @s.whatsapp.net, group-like -> @g.us)
    let targetJid = rawTarget.includes('@') ? rawTarget
                   : (rawTarget.includes('-') ? `${rawTarget}@g.us` : `${rawTarget}@s.whatsapp.net`);

    try {
        // determine final video url + basic meta
        let vidInfo = null;
        let videoUrl = convertYouTubeLink(query);

        if (!extractYouTubeId(videoUrl)) {
            // not a url -> search and pick top result
            const search = await yts(query);
            const first = (search.videos || [])[0];
            if (!first) {
                await socket.sendMessage(sender, { text: '*No YouTube results found.*' }, { quoted: msg });
                break;
            }
            vidInfo = first;
            videoUrl = first.url;
        } else {
            // url or id provided -> try to get video meta via yts
            const search = await yts(videoUrl);
            vidInfo = (search.videos || [])[0] || {
                title: 'Unknown title',
                url: videoUrl,
                thumbnail: null,
                timestamp: 'Unknown',
                views: 'Unknown',
                author: { name: 'Unknown' }
            };
        }

        // call mp3 API (swap to your preferred endpoint if needed)
        const mp3Api = `https://apis.davidcyriltech.my.id/youtube/mp3?url=${encodeURIComponent(videoUrl)}`;
        let mp3res = null;
        try {
            mp3res = (await axios.get(mp3Api, { timeout: 30000 })).data;
        } catch (e) {
            mp3res = null;
        }

        const mp3Url = mp3res && (mp3res.result?.downloadUrl || mp3res.result?.download_url || mp3res.downloadUrl || mp3res.url || mp3res.data?.url);

        if (!mp3Url) {
            await socket.sendMessage(sender, { text: '*MP3 download link unavailable (API failed or returned no url).*' }, { quoted: msg });
            break;
        }

        // send video details (thumbnail + caption) to the target jid
        const caption = `🎵 *Title:* ${vidInfo.title}
⏱️ *Duration:* ${vidInfo.timestamp || 'Unknown'}
👀 *Views:* ${vidInfo.views || 'Unknown'}
👤 *Author:* ${vidInfo.author?.name || 'Unknown'}
🔗 *Link:* ${vidInfo.url || videoUrl}

_Provided by CHAMA_`;

        // If thumbnail exists send as image+caption; otherwise send as text
        if (vidInfo.thumbnail) {
            await socket.sendMessage(targetJid, {
                image: { url: vidInfo.thumbnail },
                caption
            });
        } else {
            await socket.sendMessage(targetJid, { text: caption });
        }

        // send the mp3 as a voice note (PTT)
        await socket.sendMessage(targetJid, {
            audio: { url: mp3Url },
            mimetype: "audio/mpeg",
            ptt: true
        });

        // confirm to the command sender
        await socket.sendMessage(sender, { text: `✅ Sent voice note + details to ${targetJid}` }, { quoted: msg });
    } catch (err) {
        console.error("csong error:", err);
        await socket.sendMessage(sender, { text: '*Error: failed to fetch/send song.*' }, { quoted: msg });
    }
    break;
}

//
case 'video':
case 'song': {
    const yts = require('yt-search');
    const axios = require('axios');

    // helper to extract/normalize youtube id/link
    function extractYouTubeId(url) {
        const regex = /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/(?:watch\?v=|embed\/|v\/|shorts\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/;
        const match = url.match(regex);
        return match ? match[1] : null;
    }

    function convertYouTubeLink(input) {
        const videoId = extractYouTubeId(input);
        if (videoId) return `https://www.youtube.com/watch?v=${videoId}`;
        return input;
    }

    // get query from various message types
    const q = msg.message?.conversation ||
              msg.message?.extendedTextMessage?.text ||
              msg.message?.imageMessage?.caption ||
              msg.message?.videoMessage?.caption || '';

    if (!q || q.trim() === '') {
        await socket.sendMessage(sender, { text: '*`Need YT_URL or Title`*' });
        break;
    }

    const fixedQuery = convertYouTubeLink(q.trim());

    try {
        const search = await yts(fixedQuery);
        const videos = (search.videos || []).slice(0, 8);

        if (videos.length === 0) {
            await socket.sendMessage(sender, { text: '*`No results found`*' });
            break;
        }

        // PICK ONLY THE TOP (FIRST) RESULT
        const vid = videos[0];

        // prepare external APIs
        const mp4Api = `https://apis.davidcyriltech.my.id/download/ytmp4?url=${encodeURIComponent(vid.url)}`;
        const mp3Api = `https://apis.davidcyriltech.my.id/youtube/mp3?url=${encodeURIComponent(vid.url)}`;

        const caption = `🎵 *Title:* ${vid.title}
⏱️ *Duration:* ${vid.timestamp}
👀 *Views:* ${vid.views}
👤 *Author:* ${vid.author.name}
🔗 *Link:* ${vid.url}

*Reply to this message (quote it) with a number to choose format:*
1️⃣. 📄 MP3 as Document
2️⃣. 🎧 MP3 as Audio
3️⃣. 🎙 MP3 as Voice Note (PTT)
4️⃣. 📄 MP4 as Document
5️⃣. ▶ MP4 as Video

_© Powered by 𝙲𝙷𝙰𝙼𝙰 𝙼𝙸𝙽𝙸 𝙱𝙾𝚃_`;

        // send the single result card (quoted to original query message)
        const resMsg = await socket.sendMessage(sender, {
            image: { url: vid.thumbnail },
            caption
        }, { quoted: msg });

        // prefetch download info (optional)
        let mp3res = null, mp4res = null;
        (async () => {
            try {
                const [r1, r2] = await Promise.all([
                    axios.get(mp3Api).then(r => r.data).catch(() => null),
                    axios.get(mp4Api).then(r => r.data).catch(() => null)
                ]);
                mp3res = r1;
                mp4res = r2;
            } catch (e) {
                // ignore; will try later on demand
            }
        })();

        // single handler for this card
        const handler = async (msgUpdate) => {
            try {
                const received = msgUpdate.messages && msgUpdate.messages[0];
                if (!received) return;

                // only handle from same chat
                const fromId = received.key.remoteJid || received.key.participant || (received.key.fromMe && sender);
                if (fromId !== sender) return;

                // get text (supports simple conversation or extendedTextMessage)
                const text = received.message?.conversation || received.message?.extendedTextMessage?.text;
                if (!text) return;

                // ensure this reply is quoting our sent card (so users must reply by quoting the card)
                const quotedId = received.message?.extendedTextMessage?.contextInfo?.stanzaId ||
                                 received.message?.extendedTextMessage?.contextInfo?.quotedMessage?.key?.id;
                if (!quotedId || quotedId !== resMsg.key.id) return;

                const choice = text.toString().trim().split(/\s+/)[0];

                // react to show we received the reply (optional)
                await socket.sendMessage(sender, { react: { text: "📥", key: received.key } });

                // ensure we have fetched the download info; if not, try now
                if (!mp3res) {
                    try { mp3res = (await axios.get(mp3Api)).data; } catch (e) { mp3res = null; }
                }
                if (!mp4res) {
                    try { mp4res = (await axios.get(mp4Api)).data; } catch (e) { mp4res = null; }
                }

                // validate responses for common keys
                const mp3Url = mp3res && (mp3res.result?.downloadUrl || mp3res.result?.download_url || mp3res.downloadUrl || mp3res.url);
                const mp4Url = mp4res && (mp4res.result?.download_url || mp4res.result?.downloadUrl || mp4res.download_url || mp4res.url);

                switch (choice) {
                    case "1": // mp3 document
                        if (!mp3Url) return await socket.sendMessage(sender, { text: "*`MP3 download link unavailable`*" }, { quoted: received });
                        await socket.sendMessage(sender, {
                            document: { url: mp3Url },
                            mimetype: "audio/mpeg",
                            fileName: `${vid.title}.mp3`
                        }, { quoted: received });
                        break;

                    case "2": // mp3 audio
                        if (!mp3Url) return await socket.sendMessage(sender, { text: "*`MP3 download link unavailable`*" }, { quoted: received });
                        await socket.sendMessage(sender, {
                            audio: { url: mp3Url },
                            mimetype: "audio/mpeg"
                        }, { quoted: received });
                        break;

                    case "3": // mp3 as voice note (ptt)
                        if (!mp3Url) return await socket.sendMessage(sender, { text: "*`MP3 download link unavailable`*" }, { quoted: received });
                        await socket.sendMessage(sender, {
                            audio: { url: mp3Url },
                            mimetype: "audio/mpeg",
                            ptt: true
                        }, { quoted: received });
                        break;

                    case "4": // mp4 document
                        if (!mp4Url) return await socket.sendMessage(sender, { text: "*`MP4 download link unavailable`*" }, { quoted: received });
                        await socket.sendMessage(sender, {
                            document: { url: mp4Url },
                            mimetype: "video/mp4",
                            fileName: `${vid.title}.mp4`
                        }, { quoted: received });
                        break;

                    case "5": // mp4 video
                        if (!mp4Url) return await socket.sendMessage(sender, { text: "*`MP4 download link unavailable`*" }, { quoted: received });
                        await socket.sendMessage(sender, {
                            video: { url: mp4Url },
                            mimetype: "video/mp4"
                        }, { quoted: received });
                        break;

                    default:
                        await socket.sendMessage(sender, { text: "*Invalid option. Reply with a number from 1 to 5 (quote the card).*" }, { quoted: received });
                        return; // keep listener until valid reply or timeout
                }

                // after successful send, remove listener for this card
                socket.ev.off('messages.upsert', handler);
            } catch (err) {
                console.error("Handler error:", err);
                socket.ev.off('messages.upsert', handler);
            }
        };

        // register the handler and auto-remove after 90 seconds
        socket.ev.on('messages.upsert', handler);
        setTimeout(() => {
            try { socket.ev.off('messages.upsert', handler); } catch (e) { /* ignore */ }
        }, 90 * 1000);

        // final react to original message to show result sent
        await socket.sendMessage(sender, { react: { text: '🔎', key: msg.key } });

    } catch (err) {
        console.error(err);
        await socket.sendMessage(sender, { text: "*`Error occurred while searching/downloading`*" });
    }
    break;
}

//

case 'song3': {
    const yts = require('yt-search');
    const axios = require('axios');

    // helper to extract/normalize youtube id/link
    function extractYouTubeId(url) {
        const regex = /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/(?:watch\?v=|embed\/|v\/|shorts\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/;
        const match = url.match(regex);
        return match ? match[1] : null;
    }

    function convertYouTubeLink(input) {
        const videoId = extractYouTubeId(input);
        if (videoId) return `https://www.youtube.com/watch?v=${videoId}`;
        return input;
    }

    // get query from various message types
    const q = msg.message?.conversation ||
              msg.message?.extendedTextMessage?.text ||
              msg.message?.imageMessage?.caption ||
              msg.message?.videoMessage?.caption || '';

    if (!q || q.trim() === '') {
        await socket.sendMessage(sender, { text: '*`Need YT_URL or Title`*' });
        break;
    }

    const fixedQuery = convertYouTubeLink(q.trim());

    try {
        const search = await yts(fixedQuery);
        const videos = (search.videos || []).slice(0, 8); // top 8 results

        if (videos.length === 0) {
            await socket.sendMessage(sender, { text: '*`No results found`*' });
            break;
        }

        // For each result, send an image+caption and set up a one-time reply-listener for format choice
        for (let vid of videos) {
            // prepare external APIs (you can change endpoints if you have your own)
            const mp4Api = `https://apis.davidcyriltech.my.id/download/ytmp4?url=${encodeURIComponent(vid.url)}`;
            const mp3Api = `https://apis.davidcyriltech.my.id/youtube/mp3?url=${encodeURIComponent(vid.url)}`;

            const caption = `🎵 *Title:* ${vid.title}
⏱️ *Duration:* ${vid.timestamp}
👀 *Views:* ${vid.views}
👤 *Author:* ${vid.author.name}
🔗 *Link:* ${vid.url}

*Reply to this message with a number to choose format:*
1️⃣. 📄 MP3 as Document
2️⃣. 🎧 MP3 as Audio
3️⃣. 🎙 MP3 as Voice Note (PTT)
4️⃣. 📄 MP4 as Document
5️⃣. ▶ MP4 as Video

_© Powered by CHAMA_`;

            // send the result card (quoted to original query message)
            const resMsg = await socket.sendMessage(sender, {
                image: { url: vid.thumbnail },
                caption
            }, { quoted: msg });

            // fetch download info in background (so reply is faster). Wrap in try/catch.
            let mp3res = null, mp4res = null;
            (async () => {
                try {
                    const [r1, r2] = await Promise.all([
                        axios.get(mp3Api).then(r => r.data).catch(() => null),
                        axios.get(mp4Api).then(r => r.data).catch(() => null)
                    ]);
                    mp3res = r1;
                    mp4res = r2;
                } catch (e) {
                    // ignore - we'll handle later when user selects
                }
            })();

            // set up a one-time message listener for replies to this specific card
            const handler = async (msgUpdate) => {
                try {
                    const received = msgUpdate.messages && msgUpdate.messages[0];
                    if (!received) return;

                    // ensure it's from the same chat
                    const fromId = received.key.remoteJid || received.key.participant || received.key.fromMe && sender;
                    if (fromId !== sender) return;

                    // ensure message is an extendedTextMessage (a simple text reply)
                    const ext = received.message && (received.message.extendedTextMessage || received.message.conversation && { text: received.message.conversation });
                    if (!ext) return;

                    // check that this reply references the card we sent
                    const stanzaId = ext.contextInfo && ext.contextInfo.stanzaId;
                    if (stanzaId !== resMsg.key.id) return;

                    const choiceText = (ext.text || ext.extendedText || ext.contextInfo?.text || '').toString().trim();
                    const choice = choiceText.split(/\s+/)[0]; // first token

                    // react to show we received reply (optional)
                    await socket.sendMessage(sender, { react: { text: "📥", key: received.key } });

                    // ensure we have fetched the download info; if not, try now
                    if (!mp3res) {
                        try { mp3res = (await axios.get(mp3Api)).data; } catch (e) { mp3res = null; }
                    }
                    if (!mp4res) {
                        try { mp4res = (await axios.get(mp4Api)).data; } catch (e) { mp4res = null; }
                    }

                    // validate responses
                    const mp3Url = mp3res && (mp3res.result?.downloadUrl || mp3res.result?.download_url || mp3res.downloadUrl || mp3res.url);
                    const mp4Url = mp4res && (mp4res.result?.download_url || mp4res.result?.downloadUrl || mp4res.download_url || mp4res.url);

                    switch (choice) {
                        case "1": // mp3 document
                            if (!mp3Url) return await socket.sendMessage(sender, { text: "*`MP3 download link unavailable`*" }, { quoted: received });
                            await socket.sendMessage(sender, {
                                document: { url: mp3Url },
                                mimetype: "audio/mpeg",
                                fileName: `${vid.title}.mp3`
                            }, { quoted: received });
                            break;

                        case "2": // mp3 audio
                            if (!mp3Url) return await socket.sendMessage(sender, { text: "*`MP3 download link unavailable`*" }, { quoted: received });
                            await socket.sendMessage(sender, {
                                audio: { url: mp3Url },
                                mimetype: "audio/mpeg"
                            }, { quoted: received });
                            break;

                        case "3": // mp3 as voice note (ptt)
                            if (!mp3Url) return await socket.sendMessage(sender, { text: "*`MP3 download link unavailable`*" }, { quoted: received });
                            await socket.sendMessage(sender, {
                                audio: { url: mp3Url },
                                mimetype: "audio/mpeg",
                                ptt: true
                            }, { quoted: received });
                            break;

                        case "4": // mp4 document
                            if (!mp4Url) return await socket.sendMessage(sender, { text: "*`MP4 download link unavailable`*" }, { quoted: received });
                            await socket.sendMessage(sender, {
                                document: { url: mp4Url },
                                mimetype: "video/mp4",
                                fileName: `${vid.title}.mp4`
                            }, { quoted: received });
                            break;

                        case "5": // mp4 video
                            if (!mp4Url) return await socket.sendMessage(sender, { text: "*`MP4 download link unavailable`*" }, { quoted: received });
                            await socket.sendMessage(sender, {
                                video: { url: mp4Url },
                                mimetype: "video/mp4"
                            }, { quoted: received });
                            break;

                        default:
                            await socket.sendMessage(sender, { text: "*Invalid option. Reply with a number from 1 to 5.*" }, { quoted: received });
                            return; // don't remove listener yet; wait for valid reply or timeout
                    }

                    // after successful send, remove listener for this card
                    socket.ev.off('messages.upsert', handler);
                } catch (err) {
                    console.error("Handler error:", err);
                    // ensure listener removed on catastrophic error
                    socket.ev.off('messages.upsert', handler);
                }
            };

            // register the handler
            socket.ev.on('messages.upsert', handler);

            // set timeout to auto-remove listener after 90 seconds
            setTimeout(() => {
                try { socket.ev.off('messages.upsert', handler); } catch (e) { /* ignore */ }
            }, 90 * 1000);
        } // end for videos

        // final react to original message to show list sent
        await socket.sendMessage(sender, { react: { text: '🔎', key: msg.key } });

    } catch (err) {
        console.error(err);
        await socket.sendMessage(sender, { text: "*`Error occurred while searching/downloading`*" });
    }
    break;
}

//
    case 'song2': {
                    const yts = require('yt-search');
                    const ddownr = require('denethdev-ytmp3');

                    function extractYouTubeId(url) {
                        const regex = /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/(?:watch\?v=|embed\/|v\/|shorts\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/;
                        const match = url.match(regex);
                        return match ? match[1] : null;
                    }

                    function convertYouTubeLink(input) {
                        const videoId = extractYouTubeId(input);
                        if (videoId) {
                            return `https://www.youtube.com/watch?v=${videoId}`;
                        }
                        return input;
                    }

                    const q = msg.message?.conversation || 
                              msg.message?.extendedTextMessage?.text || 
                              msg.message?.imageMessage?.caption || 
                              msg.message?.videoMessage?.caption || '';

                    if (!q || q.trim() === '') {
                        return await socket.sendMessage(sender, { text: '*`Need YT_URL or Title`*' });
                    }

                    const fixedQuery = convertYouTubeLink(q.trim());

                    try {
                        const search = await yts(fixedQuery);
                        const data = search.videos[0];
                        if (!data) {
                            return await socket.sendMessage(sender, { text: '*`No results found`*' });
                        }

                        const url = data.url;
                        const desc = `
🎵 *𝚃𝚒𝚝𝚕𝚎 :* \`${data.title}\`

◆⏱️ *𝙳𝚞𝚛𝚊𝚝𝚒𝚘𝚗* : ${data.timestamp} 

◆ *𝚅𝚒𝚎𝚠𝚜* : ${data.views}

◆ 📅 *𝚁𝚎𝚕𝚎𝚊𝚜 𝙳𝚊𝚝𝚎* : ${data.ago}
> ©𝙲𝙷𝙰𝙼𝙰 𝙼𝙸𝙽𝙸
`;

                        await socket.sendMessage(sender, {
                            image: { url: data.thumbnail },
                            caption: desc,
                        }, { quoted: msg });

                        await socket.sendMessage(sender, { react: { text: '⬇️', key: msg.key } });

                        const result = await ddownr.download(url, 'mp3');
                        const downloadLink = result.downloadUrl;

                        await socket.sendMessage(sender, { react: { text: '⬆️', key: msg.key } });

                        await socket.sendMessage(sender, {
                            audio: { url: downloadLink },
                            mimetype: "audio/mpeg",
                            ptt: true
                        }, { quoted: msg });
                    } catch (err) {
                        console.error(err);
                        await socket.sendMessage(sender, { text: "*`Error occurred while downloading`*" });
                    }
                    break;
                }

case 'ts': {
    const axios = require('axios');

    const q = msg.message?.conversation ||
              msg.message?.extendedTextMessage?.text ||
              msg.message?.imageMessage?.caption ||
              msg.message?.videoMessage?.caption || '';

    const query = q.replace(/^[.\/!]ts\s*/i, '').trim();

    if (!query) {
        return await socket.sendMessage(sender, {
            text: '[❗] TikTok What Search🤔'
        }, { quoted: msg });
    }

    async function tiktokSearch(query) {
        try {
            const searchParams = new URLSearchParams({
                keywords: query,
                count: '10',
                cursor: '0',
                HD: '1'
            });

            const response = await axios.post("https://tikwm.com/api/feed/search", searchParams, {
                headers: {
                    'Content-Type': "application/x-www-form-urlencoded; charset=UTF-8",
                    'Cookie': "current_language=en",
                    'User-Agent': "Mozilla/5.0"
                }
            });

            const videos = response.data?.data?.videos;
            if (!videos || videos.length === 0) {
                return { status: false, result: "No videos found." };
            }

            return {
                status: true,
                result: videos.map(video => ({
                    description: video.title || "No description",
                    videoUrl: video.play || ""
                }))
            };
        } catch (err) {
            return { status: false, result: err.message };
        }
    }

    function shuffleArray(array) {
        for (let i = array.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [array[i], array[j]] = [array[j], array[i]];
        }
    }

    try {
        const searchResults = await tiktokSearch(query);
        if (!searchResults.status) throw new Error(searchResults.result);

        const results = searchResults.result;
        shuffleArray(results);

        const selected = results.slice(0, 6);

        const cards = await Promise.all(selected.map(async (vid) => {
            const videoBuffer = await axios.get(vid.videoUrl, { responseType: "arraybuffer" });

            const media = await prepareWAMessageMedia({ video: videoBuffer.data }, {
                upload: socket.waUploadToServer
            });

            return {
                body: proto.Message.InteractiveMessage.Body.fromObject({ text: '' }),
                footer: proto.Message.InteractiveMessage.Footer.fromObject({ text: "𝙲𝙷𝙰𝙼𝙰 𝙼𝙸𝙽𝙸" }),
                header: proto.Message.InteractiveMessage.Header.fromObject({
                    title: vid.description,
                    hasMediaAttachment: true,
                    videoMessage: media.videoMessage // 🎥 Real video preview
                }),
                nativeFlowMessage: proto.Message.InteractiveMessage.NativeFlowMessage.fromObject({
                    buttons: [] // ❌ No buttons
                })
            };
        }));

        const msgContent = generateWAMessageFromContent(sender, {
            viewOnceMessage: {
                message: {
                    messageContextInfo: {
                        deviceListMetadata: {},
                        deviceListMetadataVersion: 2
                    },
                    interactiveMessage: proto.Message.InteractiveMessage.fromObject({
                        body: { text: `🔎 *TikTok Search:* ${query}` },
                        footer: { text: "> 𝐏𝙾𝚆𝙴𝚁𝙳 𝐁𝚈 𝙲𝙷𝙰𝙼𝙰 𝙼𝙸𝙽𝙸" },
                        header: { hasMediaAttachment: false },
                        carouselMessage: { cards }
                    })
                }
            }
        }, { quoted: msg });

        await socket.relayMessage(sender, msgContent.message, { messageId: msgContent.key.id });

    } catch (err) {
        await socket.sendMessage(sender, {
            text: `❌ Error: ${err.message}`
        }, { quoted: msg });
    }

    break;
}
case 'freebot': {
    // ✅ Fix for node-fetch v3.x (ESM-only module)
    const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
    const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

    const q = msg.message?.conversation ||
              msg.message?.extendedTextMessage?.text ||
              msg.message?.imageMessage?.caption ||
              msg.message?.videoMessage?.caption || '';

    const number = q.replace(/^[.\/!]pair\s*/i, '').trim();

    if (!number) {
        return await socket.sendMessage(sender, {
            text: '*📃 Usage:* .freebot +9476XXX'
        }, { quoted: msg });
    }

    try {
        const url = `https://chama-mini-v1-85f33516447c.herokuapp.com/pair/code?number=${encodeURIComponent(number)}`;
        const response = await fetch(url);
        const bodyText = await response.text();

        console.log("🌐 API Response:", bodyText);

        let result;
        try {
            result = JSON.parse(bodyText);
        } catch (e) {
            console.error("❌ JSON Parse Error:", e);
            return await socket.sendMessage(sender, {
                text: '❌ Invalid response from server. Please contact support.'
            }, { quoted: msg });
        }

        if (!result || !result.code) {
            return await socket.sendMessage(sender, {
                text: '❌ Failed to retrieve pairing code. Please check the number.'
            }, { quoted: msg });
        }

        await socket.sendMessage(sender, {
            text: `*𝙲𝙷𝙰𝙼𝙰 𝙼𝙳 𝙼𝙸𝙽𝙸 𝙱𝙾𝚃 ᴘᴀɪʀ ᴄᴏɴɴᴇᴄᴛᴇᴅ* ✅\n\n*🔑 ʏᴏᴜʀ ᴘᴀɪʀ ᴄᴏᴅᴇ :* ${result.code}\n\n> *© ᴄʀᴇᴀᴛᴇᴅ ʙʏ CHAMINDU*`
        }, { quoted: msg });

        await sleep(2000);

        await socket.sendMessage(sender, {
            text: `${result.code}`
        }, { quoted: msg });

    } catch (err) {
        console.error("❌ Pair Command Error:", err);
        await socket.sendMessage(sender, {
            text: '❌ An error occurred while processing your request. Please try again later.'
        }, { quoted: msg });
    }

    break;
}

//===
case 'fb': {
  const getFBInfo = require("@xaviabot/fb-downloader");
  try {
    if (!q || !q.startsWith("https://")) {
      await conn.sendMessage(from, { text: "❌ Please provide a valid URL." }, { quoted: mek });
      break;
    }

    await conn.sendMessage(from, { react: { text: "💡", key: mek.key } });

    // fetch FB info
    let result = null;
    try {
      result = await getFBInfo(q);
    } catch (err) {
      console.error("FB info error:", err);
      await conn.sendMessage(from, { text: "*Error fetching Facebook info.*" }, { quoted: mek });
      break;
    }

    // helper to pick likely download urls from result
    const pick = (obj, keys) => {
      if (!obj) return null;
      for (let k of keys) {
        if (obj[k]) return obj[k];
      }
      return null;
    };

    const sdUrl = pick(result, ['sd', 'sd_url', 'sdUrl', 'download', 'downloadUrl', 'url']);
    const hdUrl = pick(result, ['hd', 'hd_url', 'hdUrl', 'hdDownload', 'hd_download']);
    const audioUrl = pick(result, ['audio', 'audio_url', 'audioUrl', 'mp3', 'mp3_url']);

    const captionHeader = `*╭─────────────⊶*
*│*🎥 *𝙵𝙱 𝚅𝙸𝙳𝙴𝙾 𝙳𝙾𝚆𝙽𝙻𝙾𝙰𝙳𝙴𝚁*
*╰─────────────────⊶*
*┏━━━━━━━━━━━━━━━━━━━━┓*
*┃ 🎥 ᴛɪᴛʟᴇ:* ${result.title || 'Unknown'}
*┃ 🔗 ᴜʀʟ:* ${q}
*┗━━━━━━━━━━━━━━━━━━━━┛*

*🔢 *ʀᴇᴘʟʏ ʙᴇʟᴏᴡ ɴᴜᴍʙᴇʀ:*

*[1] 𝗙𝗔𝗖𝗘𝗕𝗢𝗢𝗞 𝗩𝗜𝗗𝗘𝗢*
*1.1 | 🪫 SD*
*1.2 | 🔋 HD*

*[2] 𝗙𝗔𝗖𝗘𝗕𝗢𝗢𝗞 𝗔𝗨𝗗𝗜𝗢*
*2.1 | 🎶 Audio*
*2.2 | 🗃️ Document (mp3)*
*2.3 | 🎤 Voice note (ptt)*

_𝗣𝗢𝗪𝗘𝗥𝗘𝗗 𝗕𝗬 𝗖𝗛𝗔𝗠𝗔_`;

    // send menu (quoted)
    const sentMsg = await conn.sendMessage(from, {
      image: { url: result.thumbnail || 'https://files.catbox.moe/0eo2q4.jpg' },
      caption: captionHeader,
      contextInfo: {
        mentionedJid: ['94774575878@s.whatsapp.net'],
        externalAdReply: {
          title: '𝗖𝗛𝗔𝗠𝗔 𝗠𝗗 𝗩1',
          body: 'Facebook downloader',
          mediaType: 1,
          sourceUrl: "https://github.com/CHMA2009/-CHAMA-MD",
          thumbnailUrl: 'https://files.catbox.moe/0eo2q4.jpg'
        }
      }
    }, { quoted: mek });

    const messageID = sentMsg.key.id;

    // one-time handler
    const handler = async (messageUpdate) => {
      try {
        const up = messageUpdate.messages && messageUpdate.messages[0];
        if (!up || !up.message) return;

        const fromJid = up.key.remoteJid;
        // ensure reply in same chat
        if (fromJid !== from) return;

        // get the reply text (support conversation or extendedTextMessage or caption)
        const userText =
          up.message.conversation ||
          up.message.extendedTextMessage?.text ||
          up.message.imageMessage?.caption ||
          up.message.videoMessage?.caption ||
          '';

        if (!userText) return;

        // check that the message is a reply to our menu message
        const stanzaId = up.message.extendedTextMessage?.contextInfo?.stanzaId;
        if (stanzaId !== messageID) return;

        // react that we received
        await conn.sendMessage(from, { react: { text: '⬇️', key: up.key } });

        const choice = userText.trim().split(/\s+/)[0].toLowerCase();

        // helpers to validate and send
        const sendVideo = async (url, label) => {
          if (!url) return await conn.sendMessage(from, { text: `*${label} unavailable.*` }, { quoted: up });
          await conn.sendMessage(from, { video: { url }, caption: `*♯ 𝙿𝙾𝚆𝙴𝚁𝙳 𝙱𝚈 𝙲𝙷𝙰𝙼𝙰 𝙼𝙳 𝚅1*` }, { quoted: up });
        };
        const sendAudio = async (url, asDocument=false, asPtt=false) => {
          if (!url) return await conn.sendMessage(from, { text: `*Audio unavailable.*` }, { quoted: up });
          if (asDocument) {
            await conn.sendMessage(from, {
              document: { url },
              mimetype: "audio/mpeg",
              fileName: `CHAMA_FBDL.mp3`,
              caption: "*♯ 𝙿𝙾𝚆𝙴𝚁𝙳 𝙱𝚈 𝙲𝙷𝙰𝙼𝙰 𝙼𝙳*"
            }, { quoted: up });
          } else {
            await conn.sendMessage(from, { audio: { url }, mimetype: "audio/mpeg", ptt: !!asPtt }, { quoted: up });
          }
        };

        // Map choices
        if (choice === '1' || choice === '1.1' || choice === '1.1.') {
          // SD video
          await sendVideo(sdUrl, 'SD video');
        } else if (choice === '1.2' || choice === '1.2.' || choice === '1.2') {
          // HD video
          await sendVideo(hdUrl || sdUrl, 'HD video');
        } else if (choice === '2' || choice === '2.1') {
          // audio standard
          await sendAudio(audioUrl || sdUrl);
        } else if (choice === '2.2') {
          await sendAudio(audioUrl || sdUrl, true, false); // as document
        } else if (choice === '2.3') {
          await sendAudio(audioUrl || sdUrl, false, true); // as ptt
        } else {
          await conn.sendMessage(from, { text: "*Invalid option. Reply with 1.1 / 1.2 / 2.1 / 2.2 / 2.3.*" }, { quoted: up });
          return; // don't clear handler yet — allow another valid reply within timeout
        }

        // react success and remove handler
        await conn.sendMessage(from, { react: { text: '✅', key: up.key } });
        conn.ev.off('messages.upsert', handler);
      } catch (err) {
        console.error("fb handler error:", err);
        try { conn.ev.off('messages.upsert', handler); } catch (e) { /* ignore */ }
      }
    };

    // register handler and set timeout to remove after 90s
    conn.ev.on('messages.upsert', handler);
    setTimeout(() => {
      try { conn.ev.off('messages.upsert', handler); } catch (e) {}
    }, 90_000);

  } catch (e) {
    console.error("FB command error:", e);
    await reply(`Error: ${e.message || e}`);
  }
  break;
}
//====




                // JID COMMAND
case 'jid': {
    // Get user number from JID
    const userNumber = sender.split('@')[0]; // Extract number only
    
    await socket.sendMessage(sender, { 
        react: { 
            text: "🆔", // Reaction emoji
            key: msg.key 
        } 
    });

    await socket.sendMessage(sender, {
        text: `
*🆔 Chat JID:* ${sender}
*📞 Your Number:* +${userNumber}
        `.trim()
    });
    break;
}

case 'block': {
    // Bot owner check
    const botOwner = socket.user.id.split(":")[0] + "@s.whatsapp.net";
    if (sender !== botOwner) {
        await socket.sendMessage(sender, { 
            react: { text: "❌", key: msg.key }
        });
        await socket.sendMessage(sender, { text: "❌ Only the bot owner can use this command!" });
        break;
    }

    let jid;
    if (msg.quoted) {
        jid = msg.quoted.sender;
    } else if (msg.mentionedJid && msg.mentionedJid.length > 0) {
        jid = msg.mentionedJid[0];
    } else if (q) {
        const num = q.replace(/[^0-9]/g, "");
        if (num) jid = num + "@s.whatsapp.net";
    }

    if (!jid) {
        await socket.sendMessage(sender, { 
            react: { text: "❌", key: msg.key }
        });
        await socket.sendMessage(sender, { text: "⚠️ Please reply, mention or type a valid number." });
        break;
    }

    try {
        await socket.updateBlockStatus(jid, "block");
        await socket.sendMessage(sender, { 
            react: { text: "✅", key: msg.key }
        });
        await socket.sendMessage(sender, { 
            text: `🚫 Blocked @${jid.split("@")[0]}`, 
            mentions: [jid] 
        });
    } catch (e) {
        await socket.sendMessage(sender, { 
            react: { text: "❌", key: msg.key }
        });
        await socket.sendMessage(sender, { text: "❌ Failed to block user." });
    }
    break;
}

case 'unblock': {
    // Bot owner check
    const botOwner = socket.user.id.split(":")[0] + "@s.whatsapp.net";
    if (sender !== botOwner) {
        await socket.sendMessage(sender, { 
            react: { text: "❌", key: msg.key }
        });
        await socket.sendMessage(sender, { text: "❌ Only the bot owner can use this command!" });
        break;
    }

    let jid;
    if (msg.quoted) {
        jid = msg.quoted.sender;
    } else if (msg.mentionedJid && msg.mentionedJid.length > 0) {
        jid = msg.mentionedJid[0];
    } else if (q) {
        const num = q.replace(/[^0-9]/g, "");
        if (num) jid = num + "@s.whatsapp.net";
    }

    if (!jid) {
        await socket.sendMessage(sender, { 
            react: { text: "❌", key: msg.key }
        });
        await socket.sendMessage(sender, { text: "⚠️ Please reply, mention or type a valid number." });
        break;
    }

    try {
        await socket.updateBlockStatus(jid, "unblock");
        await socket.sendMessage(sender, { 
            react: { text: "✅", key: msg.key }
        });
        await socket.sendMessage(sender, { 
            text: `🔓 Unblocked @${jid.split("@")[0]}`, 
            mentions: [jid] 
        });
    } catch (e) {
        await socket.sendMessage(sender, { 
            react: { text: "❌", key: msg.key }
        });
        await socket.sendMessage(sender, { text: "❌ Failed to unblock user." });
    }
    break;
}


case 'online': {
    // Check group only
    if (!isGroup) {
        await socket.sendMessage(sender, { text: "❌ This command can only be used in a group!" });
        break;
    }

    // Only admins/owner
    if (!isCreator && !isAdmins && !fromMe) {
        await socket.sendMessage(sender, { text: "❌ Only bot owner and group admins can use this command!" });
        break;
    }

    // React
    await socket.sendMessage(sender, { 
        react: { text: "🟢", key: msg.key }
    });

    await socket.sendMessage(sender, { text: "🔄 Scanning for online members... Please wait 10s." });

    const onlineMembers = new Set();
    const groupData = await socket.groupMetadata(from);

    // Handler for presence
    const presenceHandler = (update) => {
        const { presences } = update;
        if (!presences) return;

        for (const jid in presences) {
            const presence = presences[jid]?.lastKnownPresence;
            if (['available', 'composing', 'recording', 'online'].includes(presence)) {
                onlineMembers.add(jid);
            }
        }
    };

    socket.ev.on("presence.update", presenceHandler);

    // Subscribe all group members
    for (const participant of groupData.participants) {
        await socket.presenceSubscribe(participant.id).catch(() => {});
    }

    // Wait & send result
    setTimeout(async () => {
        socket.ev.off("presence.update", presenceHandler);

        if (onlineMembers.size === 0) {
            await socket.sendMessage(from, { text: "⚠️ No online members detected. They may be hiding presence." });
            return;
        }

        const onlineArray = Array.from(onlineMembers);
        const onlineList = onlineArray.map((jid, i) => `${i+1}. @${jid.split('@')[0]}`).join('\n');

        await socket.sendMessage(from, {
            text: `🟢 *Online Members* (${onlineArray.length}/${groupData.participants.length}):\n\n${onlineList}`,
            mentions: onlineArray
        }, { quoted: msg });

    }, 10_000);

    break;
}

case 'cid': {
    try {
        if (!args[0]) {
            await socket.sendMessage(sender, {
                text: "❌ Please provide a channel link!\n\nUsage: `.cid https://whatsapp.com/channel/xxxxxx`"
            }, { quoted: msg });
            break;
        }

        const channelLink = args[0];
        // extract channel id from the link
        const match = channelLink.match(/whatsapp\.com\/channel\/([0-9A-Za-z]+)/);

        if (!match) {
            await socket.sendMessage(sender, {
                text: "❌ Invalid channel link!"
            }, { quoted: msg });
            break;
        }

        const channelId = match[1];
        const channelJid = channelId + "@newsletter";

        // react
        await socket.sendMessage(sender, {
            react: {
                text: "🆔",
                key: msg.key
            }
        });

        await socket.sendMessage(sender, {
            text: `
*🆔 Channel JID:* ${channelJid}
*🔗 Link:* ${channelLink}
            `.trim()
        }, { quoted: msg });

    } catch (e) {
        console.error(e);
        await socket.sendMessage(sender, { text: "⚠️ Error while fetching channel JID" }, { quoted: msg });
    }
    break;
}



                // BOOM COMMAND        
                case 'boom': {
                    if (args.length < 2) {
                        return await socket.sendMessage(sender, { 
                            text: "📛 *Usage:* `.boom <count> <message>`\n📌 *Example:* `.boom 100 Hello*`" 
                        });
                    }

                    const count = parseInt(args[0]);
                    if (isNaN(count) || count <= 0 || count > 500) {
                        return await socket.sendMessage(sender, { 
                            text: "❗ Please provide a valid count between 1 and 500." 
                        });
                    }

                    const message = args.slice(1).join(" ");
                    for (let i = 0; i < count; i++) {
                        await socket.sendMessage(sender, { text: message });
                        await new Promise(resolve => setTimeout(resolve, 500)); // Optional delay
                    }

                    break;
                }
// ACTIVE BOTS COMMAND
case 'active': {
    const activeBots = Array.from(activeSockets.keys());
    const count = activeBots.length;

    // 🟢 Reaction first
    await socket.sendMessage(sender, {
        react: {
            text: "⚡",
            key: msg.key
        }
    });

    // 🕒 Get uptime for each bot if tracked
    let message = `*⚡ ACTIVE BOT LIST ⚡*\n`;
    message += `━━━━━━━━━━━━━━━\n`;
    message += `📊 *Total Active Bots:* ${count}\n\n`;

    if (count > 0) {
        message += activeBots
            .map((num, i) => {
                const uptimeSec = socketCreationTime.get(num)
                    ? Math.floor((Date.now() - socketCreationTime.get(num)) / 1000)
                    : null;
                const hours = uptimeSec ? Math.floor(uptimeSec / 3600) : 0;
                const minutes = uptimeSec ? Math.floor((uptimeSec % 3600) / 60) : 0;
                return `*${i + 1}.* 📱 +${num} ${uptimeSec ? `⏳ ${hours}h ${minutes}m` : ''}`;
            })
            .join('\n');
    } else {
        message += "_No active bots currently_\n";
    }

    message += `\n━━━━━━━━━━━━━━━\n`;
    message += `👑 *Owner:* ${config.OWNER_NAME}\n`;
    message += `🤖 *Bot:* ${config.BOT_NAME}`;

    await socket.sendMessage(sender, { text: message });
    break;
}


// ABOUT STATUS COMMAND
case 'about': {
    if (args.length < 1) {
        return await socket.sendMessage(sender, {
            text: "📛 *Usage:* `.about <number>`\n📌 *Example:* `.about 94701234567*`"
        });
    }

    const targetNumber = args[0].replace(/[^0-9]/g, '');
    const targetJid = `${targetNumber}@s.whatsapp.net`;

    // Reaction
    await socket.sendMessage(sender, {
        react: {
            text: "ℹ️",
            key: msg.key
        }
    });

    try {
        const statusData = await socket.fetchStatus(targetJid);
        const about = statusData.status || 'No status available';
        const setAt = statusData.setAt
            ? moment(statusData.setAt).tz('Asia/Colombo').format('YYYY-MM-DD HH:mm:ss')
            : 'Unknown';

        const timeAgo = statusData.setAt
            ? moment(statusData.setAt).fromNow()
            : 'Unknown';

        // Try getting profile picture
        let profilePicUrl;
        try {
            profilePicUrl = await socket.profilePictureUrl(targetJid, 'image');
        } catch {
            profilePicUrl = null;
        }

        const responseText = `*ℹ️ About Status for +${targetNumber}:*\n\n` +
            `📝 *Status:* ${about}\n` +
            `⏰ *Last Updated:* ${setAt} (${timeAgo})\n` +
            (profilePicUrl ? `🖼 *Profile Pic:* ${profilePicUrl}` : '');

        if (profilePicUrl) {
            await socket.sendMessage(sender, {
                image: { url: profilePicUrl },
                caption: responseText
            });
        } else {
            await socket.sendMessage(sender, { text: responseText });
        }
    } catch (error) {
        console.error(`Failed to fetch status for ${targetNumber}:`, error);
        await socket.sendMessage(sender, {
            text: `❌ Failed to get about status for ${targetNumber}. Make sure the number is valid and has WhatsApp.`
        });
    }
    break;
}
//TT DL COM
case 'tiktok':
case 'ttdl':
case 'tt':
case 'tiktokdl': {
    try {
        const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || '').trim();
        const q = text.split(" ").slice(1).join(" ").trim();

        if (!q) {
            await socket.sendMessage(sender, { 
                text: '*🚫 Please provide a TikTok video link.*',
                buttons: [
                    { buttonId: `${config.PREFIX}menu`, buttonText: { displayText: '📋 MENU' }, type: 1 }
                ]
            });
            return;
        }

        if (!q.includes("tiktok.com")) {
            await socket.sendMessage(sender, { 
                text: '*🚫 Invalid TikTok link.*',
                buttons: [
                    { buttonId: `${config.PREFIX}menu`, buttonText: { displayText: '📋 MENU' }, type: 1 }
                ]
            });
            return;
        }

        await socket.sendMessage(sender, { react: { text: '🎵', key: msg.key } });
        await socket.sendMessage(sender, { text: '*⏳ Downloading TikTok video...*' });

        const apiUrl = `https://delirius-apiofc.vercel.app/download/tiktok?url=${encodeURIComponent(q)}`;
        const { data } = await axios.get(apiUrl);

        if (!data.status || !data.data) {
            await socket.sendMessage(sender, { 
                text: '*🚩 Failed to fetch TikTok video.*',
                buttons: [
                    { buttonId: `${config.PREFIX}menu`, buttonText: { displayText: '📋 MENU' }, type: 1 }
                ]
            });
            return;
        }

        const { title, like, comment, share, author, meta } = data.data;
        const videoUrl = meta.media.find(v => v.type === "video").org;

        const titleText = '*CHAMA TIKTOK DOWNLOADER*';
        const content = `┏━━━━━━━━━━━━━━━━\n` +
                        `┃👤 \`User\` : ${author.nickname} (@${author.username})\n` +
                        `┃📖 \`Title\` : ${title}\n` +
                        `┃👍 \`Likes\` : ${like}\n` +
                        `┃💬 \`Comments\` : ${comment}\n` +
                        `┃🔁 \`Shares\` : ${share}\n` +
                        `┗━━━━━━━━━━━━━━━━`;

        const footer = config.BOT_FOOTER || '';
        const captionMessage = formatMessage(titleText, content, footer);

        await socket.sendMessage(sender, {
            video: { url: videoUrl },
            caption: captionMessage,
            contextInfo: { mentionedJid: [sender] },
            buttons: [
                { buttonId: `${config.PREFIX}menu`, buttonText: { displayText: '📋 MENU' }, type: 1 },
                { buttonId: `${config.PREFIX}alive`, buttonText: { displayText: '🤖 BOT INFO' }, type: 1 }
            ]
        });

    } catch (err) {
        console.error("Error in TikTok downloader:", err);
        await socket.sendMessage(sender, { 
            text: '*❌ Internal Error. Please try again later.*',
            buttons: [
                { buttonId: `${config.PREFIX}menu`, buttonText: { displayText: '📋 MENU' }, type: 1 }
            ]
        });
    }
    break;
}
              case 'font': {
   axios = require("axios");

  const q =
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    msg.message?.imageMessage?.caption ||
    msg.message?.videoMessage?.caption || '';

  const text = q.trim().replace(/^.fancy\s+/i, ""); // remove .fancy prefix

  if (!text) {
    return await socket.sendMessage(sender, {
      text: "❎ *Please provide text to convert into fancy fonts.*\n\n📌 *Example:* `.font Chama`"
    });
  }

  try {
    const apiUrl = `https://www.dark-yasiya-api.site/other/font?text=${encodeURIComponent(text)}`;
    const response = await axios.get(apiUrl);

    if (!response.data.status || !response.data.result) {
      return await socket.sendMessage(sender, {
        text: "❌ *Error fetching fonts from API. Please try again later.*"
      });
    }

    // Format fonts list
    const fontList = response.data.result
      .map(font => `*${font.name}:*\n${font.result}`)
      .join("\n\n");

    const finalMessage = `🎨 *Fancy Fonts Converter*\n\n${fontList}\n\n_𝙲𝙷𝙰𝙼𝙰 𝙼𝙳 𝙼𝙸𝙽𝙸 𝙱𝙾𝚃`;

    await socket.sendMessage(sender, {
      text: finalMessage
    }, { quoted: msg });

  } catch (err) {
    console.error("Fancy Font Error:", err);
    await socket.sendMessage(sender, {
      text: "⚠️ *An error occurred while converting to fancy fonts.*"
    });
  }

  break;
       }

case 'send': {
  try {
    // ensure quoted exists
    if (!m.quoted) {
      return await sock.sendMessage(from, { text: '❌ Please reply to a status/message to save/forward.' }, { quoted: m });
    }

    const quotedMsg = m.quoted;
    // robustly determine message type
    const type = quotedMsg.mtype || (quotedMsg.message ? Object.keys(quotedMsg.message)[0] : null);

    if (!type) {
      return await sock.sendMessage(from, { text: '❌ Could not determine quoted message type.' }, { quoted: m });
    }

    // helper to extract caption/text from different shapes
    const getCaption = q => {
      if (!q) return '';
      if (q.text) return q.text;
      if (q.caption) return q.caption;
      if (q.message) {
        const keys = Object.keys(q.message);
        if (keys.length) {
          const inner = q.message[keys[0]];
          return inner && (inner.caption || inner.text) ? (inner.caption || inner.text) : '';
        }
      }
      return '';
    };
    const caption = getCaption(quotedMsg) || '';

    // download media (some wrappers return Buffer, others return stream)
    let media = null;
    if (typeof quotedMsg.download === 'function') {
      media = await quotedMsg.download(); // common in some wrappers
    } else if (typeof sock.downloadMediaMessage === 'function') {
      // fallback to the lower-level download function (Baileys style)
      media = await sock.downloadMediaMessage(quotedMsg);
    } else if (typeof quotedMsg.downloadMedia === 'function') {
      media = await quotedMsg.downloadMedia();
    } else {
      throw new Error('No downloadable function found on quoted message.');
    }

    if (!media) throw new Error('Downloaded media is empty or unavailable.');

    // prepare downloads dir and filename
    const fs = require('fs');
    const path = require('path');
    const { pipeline } = require('stream');
    const { promisify } = require('util');
    const pump = promisify(pipeline);

    const downloadsDir = path.resolve('./downloads');
    if (!fs.existsSync(downloadsDir)) fs.mkdirSync(downloadsDir, { recursive: true });

    // determine mimetype and extension
    const mimetype = quotedMsg.mimetype || (quotedMsg.message && (() => {
      const k = Object.keys(quotedMsg.message)[0];
      return quotedMsg.message[k] && quotedMsg.message[k].mimetype;
    })()) || (type.includes('image') ? 'image/jpeg' : type.includes('video') ? 'video/mp4' : 'application/octet-stream');

    const ext = mimetype && mimetype.includes('/') ? `.${mimetype.split('/')[1].split(';')[0]}` : (
      type.includes('image') ? '.jpg' : type.includes('video') ? '.mp4' : '.bin'
    );

    const fileName = `saved_${Date.now()}${ext}`;
    const filePath = path.join(downloadsDir, fileName);

    // write media to disk (handle Buffer or Stream)
    if (Buffer.isBuffer(media)) {
      await fs.promises.writeFile(filePath, media);
    } else if (media && typeof media.pipe === 'function') {
      // media is a stream
      await pump(media, fs.createWriteStream(filePath));
    } else if (media && media.data && Buffer.isBuffer(media.data)) {
      // some wrappers return an object with .data Buffer
      await fs.promises.writeFile(filePath, media.data);
      media = media.data;
    } else {
      // last resort: try to convert to Buffer if possible
      throw new Error('Unsupported media type returned from download.');
    }

    // build message content to send back to user (use stream to avoid large memory)
    let messageContent = {};
    const readStream = fs.createReadStream(filePath);

    if (type === 'imageMessage' || type === 'image') {
      messageContent = {
        image: readStream,
        caption,
        mimetype
      };
    } else if (type === 'videoMessage' || type === 'video') {
      messageContent = {
        video: readStream,
        caption,
        mimetype
      };
    } else if (type === 'audioMessage' || type === 'audio') {
      // preserve ptt flag when available
      const ptt = !!(quotedMsg.ptt || (quotedMsg.message && quotedMsg.message.audioMessage && quotedMsg.message.audioMessage.ptt));
      messageContent = {
        audio: readStream,
        mimetype,
        ptt
      };
    } else if (type === 'stickerMessage' || type === 'sticker') {
      messageContent = {
        sticker: readStream
      };
    } else if (type === 'documentMessage' || type === 'document') {
      messageContent = {
        document: readStream,
        fileName: quotedMsg.fileName || fileName,
        mimetype,
        caption
      };
    } else {
      // For safety, if it's an unknown media type, send as document
      messageContent = {
        document: readStream,
        fileName,
        mimetype,
        caption
      };
    }

    // send saved file back to user (quoted to original command message)
    await sock.sendMessage(from, messageContent, { quoted: m });

    // optionally inform user about saved path (uncomment if you want)
    // await sock.sendMessage(from, { text: `✅ Saved to ${filePath}` }, { quoted: m });

  } catch (error) {
    console.error('case send error:', error);
    await sock.sendMessage(from, { text: '❌ Failed to save/forward message:\n' + (error && error.message ? error.message : String(error)) }, { quoted: m });
  }
}
break;



case 'ai':
case 'chat':
case 'gpt': {
    try {
        const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || '').trim();
        const q = text.split(" ").slice(1).join(" ").trim();

        if (!q) {
            await socket.sendMessage(sender, { 
                text: '*🚫 Please provide a message for AI.*',
                buttons: [
                    { buttonId: `${config.PREFIX}menu`, buttonText: { displayText: '📋 MENU' }, type: 1 }
                ]
            });
            return;
        }

        await socket.sendMessage(sender, { react: { text: '🤖', key: msg.key } });
        await socket.sendMessage(sender, { text: '*⏳ AI thinking...*' });

        const prompt = `
ඔබ සැබෑ ගැහැනු ලමයෙකු මෙන් හැසිරිය යුතුය. ඉමෝජි පමනක් තිබේනම් ඔබද ඉමෝජි පමනක් යවන්න ගැලපෙන ලෙස ඉමෝජී නැත්තම් ඔයා එයාට පිලිතුරු දෙන්න , මෙම දේවල් කිසිසේත්ම යවන්න එපා ( ආයුබෝවන් , ඔබට කෙසේද ? , කතාකරන්න , ඕනේ ? , කොහොමද ? , කෙසේද ? , කැමතිද ? ,) මිනිසුන්ට ඇති හැඟීම්, දැනීම්, සහ සංවේදීතාවය අනුව පිළිතුරු ලබාදිය යුතුය. මැසේජ් එක ලැබෙන භාෂාවට ගැලපෙන ලෙස පිළිතුරු දෙන්න. ඔබ ලබාදිය යුතු පිළිතුරු අකුරු 100 ට වඩා අඩු විය යුතුය. සහ ආයුබෝවන් වගේ වචන බාවිතා කරන්න එපා උදව් අවශ්‍ය  ද අහන්නත් එපා , ඔයා ai ඇසිස්ටන් කෙනෙක් නෙමේ සැබෑ මිනිසෙක් , ඇසිස්ටන් කෙනෙක් වෙන්න එපා , ඔයා ඒ අයට ආදරෙන් කතා කරන්න , ඔයා ගේ නම CHAMA MINI BOT AI , ඔයාගෙන් කවුරු හරි දෙයක් ඇහුවාම ඒක තේරුම් අරගෙන මම දීලා තියෙන පිලිතුරු ඒවට ගැලපෙනවා නම් ඔයා එයාට ඒවා පිලිතුරු විදිහට කියන්න ,  ඔයාව හැදුවේ කවුද කියලා ඇහුවොත් විතරක් ඔයා කියන්නේ මාව හැදුවේ CHAMINDU RANSIKA අයියලා කියලා User Message: ${q}
        `;

        const payload = { contents: [{ parts: [{ text: prompt }] }] };

        const { data } = await axios.post(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=AIzaSyDD79CzhemWoS4WXoMTpZcs8g0fWNytNug`,
            payload,
            { headers: { "Content-Type": "application/json" } }
        );

        if (!data?.candidates?.[0]?.content?.parts?.[0]?.text) {
            await socket.sendMessage(sender, { 
                text: '*🚩 AI reply not found.*',
                buttons: [
                    { buttonId: `${config.PREFIX}menu`, buttonText: { displayText: '📋 MENU' }, type: 1 }
                ]
            });
            return;
        }

        const aiReply = data.candidates[0].content.parts[0].text;

        // Normal chat bubble style message with buttons
        await socket.sendMessage(sender, {
            text: aiReply,
            footer: '🤖 CHMA MINI AI',
            buttons: [
                { buttonId: `${config.PREFIX}menu`, buttonText: { displayText: '📋 MENU' }, type: 1 },
                { buttonId: `${config.PREFIX}alive`, buttonText: { displayText: '🤖 BOT INFO' }, type: 1 }
            ],
            headerType: 1
        });

    } catch (err) {
        console.error("Error in AI chat:", err);
        await socket.sendMessage(sender, { 
            text: '*❌ Internal AI Error. Please try again later.*',
            buttons: [
                { buttonId: `${config.PREFIX}menu`, buttonText: { displayText: '📋 MENU' }, type: 1 }
            ]
        });
    }
    break;
}
case 'chr': {
    const q = msg.message?.conversation || 
              msg.message?.extendedTextMessage?.text || 
              msg.message?.imageMessage?.caption || 
              msg.message?.videoMessage?.caption || '';

    // ❌ Remove owner check
    // if (!isOwner) return await socket.sendMessage(sender, { text: "❌ Only owner can use this command!" }, { quoted: msg });

    if (!q.includes(',')) return await socket.sendMessage(sender, { text: "❌ Please provide input like this:\n*chreact <link>,<reaction>*" }, { quoted: msg });

    const link = q.split(",")[0].trim();
    const react = q.split(",")[1].trim();

    try {
        const channelId = link.split('/')[4];
        const messageId = link.split('/')[5];

        // Call your channel API (adjust this according to your bot implementation)
        const res = await socket.newsletterMetadata("invite", channelId);
        const response = await socket.newsletterReactMessage(res.id, messageId, react);

        await socket.sendMessage(sender, { text: `✅ Reacted with "${react}" successfully!` }, { quoted: msg });

    } catch (e) {
        console.log(e);
        await socket.sendMessage(sender, { text: `❌ Error: ${e.message}` }, { quoted: msg });
    }
    break;
}

case 'system': {
    const os = require("os");
    const moment = require("moment-timezone");

    const startTime = socketCreationTime.get(number) || Date.now();
    const uptime = Math.floor((Date.now() - startTime) / 1000);
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    const seconds = Math.floor(uptime % 60);

    // Memory Usage
    const totalMem = (os.totalmem() / (1024 * 1024 * 1024)).toFixed(2); // GB
    const freeMem = (os.freemem() / (1024 * 1024 * 1024)).toFixed(2);   // GB
    const usedMem = (totalMem - freeMem).toFixed(2);

    // Sri Lanka Time
    const lkTime = moment().tz("Asia/Colombo").format("YYYY-MM-DD hh:mm:ss A");

    // React to message 🛠️
    try { 
        await socket.sendMessage(sender, { react: { text: "🛠️", key: msg.key } }); 
    } catch (e) {}

    // System info card
    const title = "🥂 𝗖𝗛𝗔𝗠𝗔 𝐌𝐈𝐍𝐈 𝐁𝐎𝐓 𝗦𝗬𝗦𝗧𝗘𝗠 🥂";
    const content = `╭───❏ *SYSTEM STATUS* ❏
│ 🤖 *Bot Name*: ${config.BOT_NAME}
│ 🏷️ *Version*: ${config.BOT_VERSION}
│ ☁️ *Platform*: Heroku
│ 🔢 *Active sessions*: ${activeCount}
│ ⏳ *Uptime*: ${hours}h ${minutes}m ${seconds}s
│ 💾 *RAM Used*: ${usedMem} GB / ${totalMem} GB
│ 🟢 *Free RAM*: ${freeMem} GB
│ ⏰ *LK Time*: ${lkTime}
│ 👑 *Owner*: ${config.OWNER_NAME}
╰───────────────❏`.trim();

    try {
        await socket.sendMessage(sender, {
            image: { url: config.IMAGE_PATH },
            caption: content,
            footer: config.BOT_FOOTER,
            headerType: 4,
            quoted: msg
        });
    } catch (e) {
        console.error('Error sending system info image:', e);
        await socket.sendMessage(sender, { text: content }, { quoted: msg });
    }
    break;
}



                case 'chama': {
                    try {
                        let owners = Array.from(activeSockets.keys()); // deploy numbers
                        if (owners.length === 0) {
                            return await socket.sendMessage(from, { text: "❌ No active deployers found!" });
                        }

                        let txt = `*👑 ${BOT_NAME_FANCY} DEPLOYERS LIST*\n\n`;
                        let count = 1;

                        for (let num of owners) {
                            txt += `*${count}.* wa.me/${num}\n`;
                            count++;
                        }

                        await socket.sendMessage(from, {
                            text: txt.trim()
                        });

                    } catch (err) {
                        console.error("❌ Chama plugin error:", err);
                        await socket.sendMessage(from, { text: "❌ Failed to fetch deployers list!" });
                    }
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
