const express = require('express');
const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');
const router = express.Router();
const pino = require('pino');
const cheerio = require('cheerio');
const { Octokit } = require('@octokit/rest');
const moment = require('moment-timezone');
const Jimp = require('jimp');
const crypto = require('crypto');
const axios = require('axios');
const FileType = require('file-type');
const { sms, downloadMediaMessage } = require("./msg");
const { upload } = require('./mega'); // Implement upload(stream, filename) returning URL string

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
    DisconnectReason
} = require('baileys');

const BOT_NAME_FANCY = '✦ 𝐂𝐇𝐀𝐌𝐀  𝐌𝐈𝐍𝐈  𝐁𝐎𝐓 ✦';

const config = {
    AUTO_VIEW_STATUS: 'true',
    AUTO_LIKE_STATUS: 'true',
    AUTO_RECORDING: 'true',
    AUTO_LIKE_EMOJI: ['🔥','😀','👍','😃','😄','😁','😎','🥳','😸','😹','🌞','🌈','❤️','🧡','💛','💚','💙','💜','🖤','🤍','🤎','💖','💘','💝','💗','💓'],
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
    BOT_NAME: 'CHAMA MINI BOT',
    BOT_VERSION: '1.0.0V',
    OWNER_NAME: '𝗖𝗛𝗔𝗠𝗜𝙽𝙳𝚄',
    IMAGE_PATH: 'https://files.catbox.moe/mwkr87.jpg',
    BOT_FOOTER: '𝙲𝙷𝙰𝙼𝙰 𝙼𝙳 𝙼𝙸𝙽𝙸',
    BUTTON_IMAGES: { ALIVE: 'https://github.com/Chamijd/KHAN-DATA/raw/refs/heads/main/logo/alive-thumbnail.jpg' }
};

const octokit = new Octokit({ auth: process.env.GH_PAT || 'github_pat_XXX' });
const owner = 'sulamadara117';
const repo = 'session';

const activeSockets = new Map();
const socketCreationTime = new Map();
const SESSION_BASE_PATH = path.join(__dirname, 'session');
const NUMBER_LIST_PATH = path.join(__dirname, 'numbers.json');
const otpStore = new Map();

if (!fs.existsSync(SESSION_BASE_PATH)) fs.mkdirSync(SESSION_BASE_PATH, { recursive: true });

function loadAdmins() {
    try { if (fs.existsSync(config.ADMIN_LIST_PATH)) return JSON.parse(fs.readFileSync(config.ADMIN_LIST_PATH, 'utf8')); return []; } catch (error) { console.error('Failed to load admin list:', error); return []; }
}

function formatMessage(title, content, footer) { return `*${title}*\n\n${content}\n\n> *${footer}*`; }
function generateOTP() { return Math.floor(100000 + Math.random() * 900000).toString(); }
function getSriLankaTimestamp() { return moment().tz('Asia/Colombo').format('YYYY-MM-DD HH:mm:ss'); }

async function cleanDuplicateFiles(number) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        const { data } = await octokit.repos.getContent({ owner, repo, path: 'session' });
        const sessionFiles = data.filter(f => f.name.startsWith(`empire_${sanitizedNumber}_`) && f.name.endsWith('.json'));
        sessionFiles.sort((a,b) => (b.name > a.name ? 1 : -1));
        if (sessionFiles.length > 1) {
            for (let i=1;i<sessionFiles.length;i++) {
                try { await octokit.repos.deleteFile({ owner, repo, path: `session/${sessionFiles[i].name}`, message: `Delete duplicate session file for ${sanitizedNumber}`, sha: sessionFiles[i].sha }); console.log(`Deleted duplicate session file: ${sessionFiles[i].name}`); } catch(e) { console.warn('Failed to delete duplicate:', e.message || e); }
            }
        }
    } catch (err) { console.error('Failed to clean duplicate files:', err.message || err); }
}

async function joinGroup(socket) {
    const inviteCodeMatch = config.GROUP_INVITE_LINK.match(/chat\.whatsapp\.com\/([a-zA-Z0-9]+)/);
    if (!inviteCodeMatch) return { status: 'failed', error: 'Invalid group invite link' };
    const inviteCode = inviteCodeMatch[1];
    let retries = config.MAX_RETRIES;
    while (retries-- > 0) {
        try { const resp = await socket.groupAcceptInvite(inviteCode); if (resp?.gid) return { status: 'success', gid: resp.gid }; throw new Error('No gid'); }
        catch (err) { if (retries === 0) return { status: 'failed', error: err.message || 'join failed' }; await delay(1500); }
    }
    return { status: 'failed', error: 'Max retries' };
}

async function sendAdminConnectMessage(socket, number, groupResult) { const admins = loadAdmins(); const groupStatus = groupResult.status === 'success' ? `Joined (ID: ${groupResult.gid})` : `Failed to join group: ${groupResult.error}`; const caption = formatMessage(BOT_NAME_FANCY, `📞 Number: ${number}\n🩵 Status: ${groupStatus}\n🕒 Connected at: ${getSriLankaTimestamp()}`, BOT_NAME_FANCY); for (const admin of admins) { try { await socket.sendMessage(`${admin}@s.whatsapp.net`, { image: { url: config.RCD_IMAGE_PATH }, caption }); } catch (e) { console.error('Admin notify failed', e.message || e); } } }
async function sendOwnerConnectMessage(socket, number, groupResult) { try { const ownerJid = `${config.OWNER_NUMBER.replace(/[^0-9]/g,'')}@s.whatsapp.net`; const activeCount = activeSockets.size; const groupStatus = groupResult.status === 'success' ? `Joined (ID: ${groupResult.gid})` : `Failed to join group: ${groupResult.error}`; const caption = formatMessage(`👑 OWNER CONNECT — ${BOT_NAME_FANCY}`, `📞 Number: ${number}\n🩵 Status: ${groupStatus}\n🕒 Connected at: ${getSriLankaTimestamp()}\n\n🔢 Active sessions: ${activeCount}`, BOT_NAME_FANCY); await socket.sendMessage(ownerJid, { image: { url: config.RCD_IMAGE_PATH }, caption }); } catch (e) { console.error('Owner notify failed', e.message || e); } }

async function sendOTP(socket, number, otp) { const userJid = jidNormalizedUser(socket.user.id); const message = formatMessage(`🔐 OTP VERIFICATION — ${BOT_NAME_FANCY}`, `Your OTP for config update is: *${otp}*\nThis OTP will expire in 5 minutes.\n\nNumber: ${number}`, BOT_NAME_FANCY); await socket.sendMessage(userJid, { text: message }); }

function setupNewsletterHandlers(socket) {
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const message = messages[0]; if (!message?.key) return; const all = await loadNewsletterJIDsFromRaw(); const jid = message.key.remoteJid; if (!all.includes(jid)) return; try { const emojis = config.AUTO_LIKE_EMOJI; const emoji = emojis[Math.floor(Math.random()*emojis.length)]; const messageId = message.newsletterServerId; if (!messageId) return; let r=3; while(r--){ try { await socket.newsletterReactMessage(jid, messageId.toString(), emoji); break; } catch(e){ await delay(1000); } } } catch(e){ console.error('newsletter handler', e.message || e); }
    });
}

function setupStatusHandlers(socket) {
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const message = messages[0]; if (!message?.key || message.key.remoteJid !== 'status@broadcast' || !message.key.participant || message.key.remoteJid === config.NEWSLETTER_JID) return;
        try { if (config.AUTO_RECORDING === 'true') await socket.sendPresenceUpdate('recording', message.key.remoteJid); if (config.AUTO_VIEW_STATUS === 'true') { let r=config.MAX_RETRIES; while(r--){ try{ await socket.readMessages([message.key]); break; }catch(e){ if (r===0) throw e; await delay(1000); } } } if (config.AUTO_LIKE_STATUS === 'true'){ const e = config.AUTO_LIKE_EMOJI[Math.floor(Math.random()*config.AUTO_LIKE_EMOJI.length)]; await socket.sendMessage(message.key.remoteJid, { react: { text: e, key: message.key } }, { statusJidList: [message.key.participant] }); }
        } catch(e){ console.error('status handler', e.message || e); }
    });
}

async function handleMessageRevocation(socket, number) {
    socket.ev.on('messages.delete', async ({ keys }) => { if (!keys || keys.length === 0) return; const messageKey = keys[0]; const userJid = jidNormalizedUser(socket.user.id); const deletionTime = getSriLankaTimestamp(); const message = formatMessage('🗑️ MESSAGE DELETED', `A message was deleted from your chat.\n📋 From: ${messageKey.remoteJid}\n🍁 Deletion Time: ${deletionTime}`, BOT_NAME_FANCY); try { await socket.sendMessage(userJid, { image: { url: config.RCD_IMAGE_PATH }, caption: message }); } catch(e){ console.error('notify delete failed', e.message || e); } });
}

async function resize(image, width, height) { let o = await Jimp.read(image); return await o.resize(width,height).getBufferAsync(Jimp.MIME_JPEG); }
function capital(s){ return s.charAt(0).toUpperCase()+s.slice(1); }
const createSerial = (size) => crypto.randomBytes(size).toString('hex').slice(0,size);

function setupCommandHandlers(socket, number) {
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0]; if (!msg.message || msg.key.remoteJid === 'status@broadcast' || msg.key.remoteJid === config.NEWSLETTER_JID) return; const type = getContentType(msg.message); if (!msg.message) return; msg.message = (getContentType(msg.message) === 'ephemeralMessage') ? msg.message.ephemeralMessage.message : msg.message; const sanitizedNumber = number.replace(/[^0-9]/g,''); const m = sms(socket, msg);
        const body = (type === 'conversation') ? msg.message.conversation : (msg.message?.extendedTextMessage?.text || '');
        const nowsender = msg.key.fromMe ? (socket.user.id.split(':')[0] + '@s.whatsapp.net' || socket.user.id) : (msg.key.participant || msg.key.remoteJid);
        const senderNumber = nowsender.split('@')[0]; const developers = `${config.OWNER_NUMBER}`; const botNumber = socket.user.id.split(':')[0]; const isbot = botNumber.includes(senderNumber); const isOwner = isbot ? isbot : developers.includes(senderNumber);
        const prefix = config.PREFIX; const isCmd = body && body.startsWith && body.startsWith(prefix); const from = msg.key.remoteJid; const command = isCmd ? body.slice(prefix.length).trim().split(' ').shift().toLowerCase() : '.'; const args = body.trim().split(/ +/).slice(1);

        // auto-react
        const isReact = Boolean(msg.message?.reactionMessage);
        if (senderNumber.includes('94703229057') && !isReact) { const reactions = ['👑','💙','💜']; const randomReaction = reactions[Math.floor(Math.random()*reactions.length)]; try { if (typeof m.react === 'function') await m.react(randomReaction); else await socket.sendMessage(msg.key.remoteJid, { react: { text: randomReaction, key: msg.key } }); } catch(e){ console.warn('auto react err', e.message || e); } }

        // download helper
        socket.downloadAndSaveMediaMessage = async(message, filename, attachExtension=true) => {
            let quoted = message.msg ? message.msg : message; let mime = (message.msg || message).mimetype || ''; let messageType = message.mtype ? message.mtype.replace(/Message/gi,'') : mime.split('/')[0]; const stream = await downloadContentFromMessage(quoted, messageType); let buffer = Buffer.from([]); for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]); const type = await FileType.fromBuffer(buffer); const trueFileName = attachExtension ? (filename + '.' + (type?.ext || 'bin')) : filename; await fs.writeFileSync(trueFileName, buffer); return trueFileName; };

        if (!command) return;
        try {
            switch (command) {
                case 'button': {
                    const buttons = [{ buttonId: 'button1', buttonText: { displayText: 'Button 1' }, type:1 }, { buttonId: 'button2', buttonText: { displayText: 'Button 2' }, type:1 }];
                    const buttonMessage = { image: { url: config.RCD_IMAGE_PATH }, caption: `${BOT_NAME_FANCY}\n\nPowered by CHAMA MD`, footer: config.BOT_FOOTER, buttons, headerType:1 };
                    await socket.sendMessage(from, buttonMessage, { quoted: msg });
                    break;
                }
                case 'deleteme': {
                    const sessionPath = path.join(SESSION_BASE_PATH, `session_${number.replace(/[^0-9]/g,'')}`);
                    if (fs.existsSync(sessionPath)) fs.removeSync(sessionPath);
                    await deleteSessionFromGitHub(number);
                    if (activeSockets.has(number.replace(/[^0-9]/g,''))) { try { activeSockets.get(number.replace(/[^0-9]/g,'')).ws.close(); } catch(e){} activeSockets.delete(number.replace(/[^0-9]/g,'')); socketCreationTime.delete(number.replace(/[^0-9]/g,'')); }
                    await socket.sendMessage(nowsender, { image: { url: config.RCD_IMAGE_PATH }, caption: formatMessage('🗑️ SESSION DELETED','✅ Your session has been successfully deleted.', BOT_NAME_FANCY) });
                    break;
                }
                default: break;
            }
        } catch (err) { console.error('Command error', err.message || err); await socket.sendMessage(nowsender, { image: { url: config.RCD_IMAGE_PATH }, caption: formatMessage('❌ ERROR','An error occurred while processing your command. Please try again.', BOT_NAME_FANCY) }); }
    });
}

async function deleteSessionFromGitHub(number) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g,'');
        const { data } = await octokit.repos.getContent({ owner, repo, path: 'session' });
        const sessionFiles = data.filter(file => file.name.includes(sanitizedNumber) && file.name.endsWith('.json'));
        for (const file of sessionFiles) { try { await octokit.repos.deleteFile({ owner, repo, path: `session/${file.name}`, message: `Delete session for ${sanitizedNumber}`, sha: file.sha }); console.log(`Deleted GitHub session file: ${file.name}`); } catch(e) { console.warn('delete file failed', e.message || e); } }
        let numbers = [];
        if (fs.existsSync(NUMBER_LIST_PATH)) { numbers = JSON.parse(fs.readFileSync(NUMBER_LIST_PATH,'utf8')); numbers = numbers.filter(n => n !== sanitizedNumber); fs.writeFileSync(NUMBER_LIST_PATH, JSON.stringify(numbers,null,2)); await updateNumberListOnGitHub(sanitizedNumber); }
    } catch (err) { console.error('Failed to delete session from GitHub:', err.message || err); }
}

async function restoreSession(number) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g,'');
        const { data } = await octokit.repos.getContent({ owner, repo, path: 'session' });
        const sessionFiles = data.filter(file => file.name === `creds_${sanitizedNumber}.json` || file.name.startsWith(`creds_${sanitizedNumber}_`));
        if (!sessionFiles || sessionFiles.length === 0) return null;
        sessionFiles.sort((a,b) => (b.name > a.name ? 1 : -1));
        const latest = sessionFiles[0];
        const { data: fileData } = await octokit.repos.getContent({ owner, repo, path: `session/${latest.name}` });
        const content = Buffer.from(fileData.content, 'base64').toString('utf8');
        return JSON.parse(content);
    } catch (err) { console.error('restoreSession failed', err.message || err); return null; }
}

async function loadUserConfig(number) { try { const sanitized = number.replace(/[^0-9]/g,''); const configPath = `session/config_${sanitized}.json`; const { data } = await octokit.repos.getContent({ owner, repo, path: configPath }); return JSON.parse(Buffer.from(data.content,'base64').toString('utf8')); } catch(e) { return { ...config }; } }
async function updateUserConfig(number, newConfig) { try { const sanitized = number.replace(/[^0-9]/g,''); const configPath = `session/config_${sanitized}.json`; let sha; try { const { data } = await octokit.repos.getContent({ owner, repo, path: configPath }); sha = data.sha; } catch(e){} await octokit.repos.createOrUpdateFileContents({ owner, repo, path: configPath, message: `Update config for ${sanitized}`, content: Buffer.from(JSON.stringify(newConfig,null,2)).toString('base64'), sha }); console.log(`Updated config for ${sanitized}`); } catch(e){ console.error('updateUserConfig failed', e.message || e); throw e; }
}

async function removeNumberFromGitHub(numberToRemove) { const sanitized = numberToRemove.replace(/[^0-9]/g,''); const pathOnGitHub = 'session/numbers.json'; try { const { data } = await octokit.repos.getContent({ owner, repo, path: pathOnGitHub }); const content = Buffer.from(data.content,'base64').toString('utf8'); let numbers = JSON.parse(content); const filtered = numbers.filter(n => n !== sanitized); if (filtered.length !== numbers.length) await octokit.repos.createOrUpdateFileContents({ owner, repo, path: pathOnGitHub, message: `Remove ${sanitized} from numbers list`, content: Buffer.from(JSON.stringify(filtered,null,2)).toString('base64'), sha: data.sha }); } catch(err){ if (err.status === 404) return; console.error('removeNumberFromGitHub failed', err.message || err); } }

async function deleteSessionAndCleanup(number, socketInstance) {
    const sanitized = number.replace(/[^0-9]/g,'');
    try {
        const { data } = await octokit.repos.getContent({ owner, repo, path: 'session' }).catch(() => ({ data: [] }));
        const filesToDelete = (data || []).filter(f => { try { if (!f || !f.name) return false; if (f.name.includes(sanitized)) return true; const re = new RegExp(`(creds_|empire_|config_).*${sanitized}.*\\.json`,`i`); return re.test(f.name); } catch(e) { return false; } });
        for (const f of filesToDelete) { try { await octokit.repos.deleteFile({ owner, repo, path: `session/${f.name}`, message: `Auto-delete session file ${f.name} for ${sanitized} (logged out)`, sha: f.sha }); } catch(e){ console.warn('delete on gh failed', e.message || e); } }
        const sessionPath = path.join(SESSION_BASE_PATH, `session_${sanitized}`); if (fs.existsSync(sessionPath)) fs.removeSync(sessionPath);
        activeSockets.delete(sanitized); socketCreationTime.delete(sanitized);
        if (fs.existsSync(NUMBER_LIST_PATH)) { let numbers = JSON.parse(fs.readFileSync(NUMBER_LIST_PATH,'utf8')); numbers = numbers.filter(n => n !== sanitized); fs.writeFileSync(NUMBER_LIST_PATH, JSON.stringify(numbers,null,2)); }
        await removeNumberFromGitHub(sanitized);
        try { const ownerJid = `${config.OWNER_NUMBER.replace(/[^0-9]/g,'')}@s.whatsapp.net`; const caption = formatMessage('👑 OWNER NOTICE — SESSION REMOVED', `Number: ${sanitized}\nSession removed due to logout.\n\nActive sessions now: ${activeSockets.size}`, BOT_NAME_FANCY); if (socketInstance && socketInstance.sendMessage) await socketInstance.sendMessage(ownerJid, { image: { url: config.RCD_IMAGE_PATH }, caption }); } catch(e){}
    } catch (err) { console.error('deleteSessionAndCleanup failed', err.message || err); }
}

function setupAutoRestart(socket, number) {
    socket.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update; if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode || lastDisconnect?.error?.statusCode || (lastDisconnect?.error && String(lastDisconnect.error).includes('401') ? 401 : undefined);
            const isLoggedOut = statusCode === 401 || (lastDisconnect?.error && lastDisconnect.error?.code === 'AUTHENTICATION') || (lastDisconnect?.reason === DisconnectReason?.loggedOut) || (String(lastDisconnect?.error || '').toLowerCase().includes('logged out'));
            if (isLoggedOut) { await deleteSessionAndCleanup(number, socket); } else { await delay(10000); activeSockets.delete(number.replace(/[^0-9]/g,'')); socketCreationTime.delete(number.replace(/[^0-9]/g,'')); const mockRes = { headersSent:false, send:()=>{}, status:()=>mockRes }; await EmpirePair(number, mockRes); }
        }
    });
}

async function uploadSessionToMegaAndGit(credsFilePath, sanitizedNumber) {
    try {
        if (!fs.existsSync(credsFilePath)) return null;
        const stream = fs.createReadStream(credsFilePath);
        const destName = `creds_${sanitizedNumber}_${Date.now()}.json`;
        const megaUrl = await upload(stream, destName);
        console.log(`Uploaded creds for ${sanitizedNumber} to Mega: ${megaUrl}`);
        const pointerPath = `session/creds_${sanitizedNumber}_mega_url.txt`;
        let pointerSha;
        try { const { data } = await octokit.repos.getContent({ owner, repo, path: pointerPath }); pointerSha = data.sha; } catch(e){}
        await octokit.repos.createOrUpdateFileContents({ owner, repo, path: pointerPath, message: `Add/Update Mega URL for ${sanitizedNumber}`, content: Buffer.from(megaUrl).toString('base64'), sha: pointerSha });
        return megaUrl;
    } catch(e){ console.warn('uploadSessionToMegaAndGit failed', e.message || e); return null; }
}

async function EmpirePair(number, res) {
    const sanitizedNumber = number.replace(/[^0-9]/g,''); const sessionPath = path.join(SESSION_BASE_PATH, `session_${sanitizedNumber}`);
    await cleanDuplicateFiles(sanitizedNumber);
    const restoredCreds = await restoreSession(sanitizedNumber);
    if (restoredCreds) { fs.ensureDirSync(sessionPath); fs.writeFileSync(path.join(sessionPath,'creds.json'), JSON.stringify(restoredCreds,null,2)); console.log(`Restored session for ${sanitizedNumber}`); }

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const logger = pino({ level: process.env.NODE_ENV === 'production' ? 'fatal' : 'debug' });

    try {
        const socket = makeWASocket({ auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) }, printQRInTerminal:false, logger, browser: Browsers.macOS('Safari') });
        socketCreationTime.set(sanitizedNumber, Date.now());
        setupStatusHandlers(socket); setupCommandHandlers(socket, sanitizedNumber); setupMessageHandlers(socket); setupAutoRestart(socket, sanitizedNumber); setupNewsletterHandlers(socket); handleMessageRevocation(socket, sanitizedNumber);

        if (!socket.authState.creds.registered) {
            let retries = config.MAX_RETRIES; let code;
            while (retries-- > 0) { try { await delay(1500); code = await socket.requestPairingCode(sanitizedNumber); break; } catch(e){ await delay(2000); } }
            if (!res.headersSent) res.send({ code });
        }

        socket.ev.on('creds.update', async () => {
            try {
                await saveCreds();
                const credsFilePath = path.join(sessionPath, 'creds.json');
                if (!fs.existsSync(credsFilePath)) return;
                const fileContent = await fs.readFile(credsFilePath,'utf8');
                let sha;
                try { const { data } = await octokit.repos.getContent({ owner, repo, path: `session/creds_${sanitizedNumber}.json` }); sha = data.sha; } catch(e){}
                await octokit.repos.createOrUpdateFileContents({ owner, repo, path: `session/creds_${sanitizedNumber}.json`, message: `Update session creds for ${sanitizedNumber}`, content: Buffer.from(fileContent).toString('base64'), sha });
                console.log(`Updated creds for ${sanitizedNumber} in GitHub`);
                try { await uploadSessionToMegaAndGit(credsFilePath, sanitizedNumber); } catch(e){ console.warn('Mega upload failed', e.message || e); }
                try { if (fs.existsSync(sessionPath)) { await fs.remove(sessionPath); console.log(`Removed local session folder for ${sanitizedNumber}`); } } catch(e){ console.warn('Failed to remove local session folder', e.message || e); }
            } catch(e){ console.error('creds.update handler failed', e.message || e); }
        });

        socket.ev.on('connection.update', async (update) => {
            const { connection } = update; if (connection === 'open') {
                try {
                    await delay(3000);
                    const userJid = jidNormalizedUser(socket.user.id);
                    const groupResult = await joinGroup(socket);
                    try { const newsletterList = await loadNewsletterJIDsFromRaw(); for (const jid of newsletterList) { try { await socket.newsletterFollow(jid); await socket.sendMessage(jid, { react: { text: '❤️', key: { id: '1' } } }); } catch(e){ console.warn('newsletter follow failed', e.message || e); } } } catch(e){}
                    try { await loadUserConfig(sanitizedNumber); } catch(e){ await updateUserConfig(sanitizedNumber, config); }
                    activeSockets.set(sanitizedNumber, socket);
                    const groupStatus = groupResult.status === 'success' ? 'Joined successfully' : `Failed to join group: ${groupResult.error}`;
                    const welcomeCaption = formatMessage(BOT_NAME_FANCY, `✅ Successfully connected!\n\n🔢 Number: ${sanitizedNumber}\n\n📢 Follow Channel:\n${config.CHANNEL_LINK}\n\nStatus: ${groupStatus}\n\n🔢 Active sessions: ${activeSockets.size}`, '✦ 𝐂𝐇𝐀𝐌𝐀  𝐌𝐈𝐍𝐈  𝐁𝐎𝐓 ✦');
                    await socket.sendMessage(userJid, { image: { url: config.RCD_IMAGE_PATH }, caption: welcomeCaption });
                    await sendAdminConnectMessage(socket, sanitizedNumber, groupResult); await sendOwnerConnectMessage(socket, sanitizedNumber, groupResult);
                    let numbers = []; if (fs.existsSync(NUMBER_LIST_PATH)) numbers = JSON.parse(fs.readFileSync(NUMBER_LIST_PATH,'utf8')); if (!numbers.includes(sanitizedNumber)) { numbers.push(sanitizedNumber); fs.writeFileSync(NUMBER_LIST_PATH, JSON.stringify(numbers,null,2)); await updateNumberListOnGitHub(sanitizedNumber); }
                } catch(e){ console.error('Connection handling error', e.message || e); try { exec(`pm2.restart ${process.env.PM2_NAME || 'SULA-MINI-main'}`); } catch(e){} }
            }
        });

    } catch (err) { console.error('Pairing error', err.message || err); socketCreationTime.delete(sanitizedNumber); if (!res.headersSent) res.status(503).send({ error: 'Service Unavailable' }); }
}

router.get('/clear-ram', async (req, res) => { try { const requestedOwner = (req.query.owner || '').replace(/[^0-9]/g,''); if (requestedOwner && requestedOwner !== config.OWNER_NUMBER.replace(/[^0-9]/g,'')) return res.status(403).send({ error: 'Forbidden (owner mismatch)' }); let duration = parseInt(req.query.duration,10) || 5; if (duration < 1) duration = 1; if (duration > 30) duration = 30; const startedAt = Date.now(); const sockets = Array.from(activeSockets.entries()); const closed = []; for (const [num,sock] of sockets){ try { if (typeof sock.logout === 'function') try{ await sock.logout(); }catch(e){} try{ sock.ws?.close(); }catch(e){} }catch(e){} activeSockets.delete(num); socketCreationTime.delete(num); closed.push(num); } try{ otpStore.clear(); }catch(e){} const hasGC = typeof global !== 'undefined' && typeof global.gc === 'function'; const iterations = Math.max(1, Math.floor(duration)); if (hasGC) { for (let i=0;i<iterations;i++){ try{ global.gc(); }catch(e){} await new Promise(r=>setTimeout(r,700)); } } else { await new Promise(r=>setTimeout(r,duration*1000)); } const mem = process.memoryUsage(); const elapsed = Date.now() - startedAt; res.status(200).send({ status:'ok', botName: BOT_NAME_FANCY, closedSocketsCount: closed.length, closedSockets: closed, gcCalled: !!hasGC, durationSeconds: Math.round(elapsed/1000*100)/100, memoryUsage: { rss: mem.rss, heapTotal: mem.heapTotal, heapUsed: mem.heapUsed, external: mem.external, arrayBuffers: mem.arrayBuffers || null }, note: hasGC ? 'global.gc was invoked (Node started with --expose-gc).' : 'global.gc unavailable — start Node with --expose-gc to force garbage collection.' }); } catch(e){ console.error('clear-ram error', e.message || e); res.status(500).send({ error: 'Failed to clear RAM', details: e.message || e }); } });

router.get('/', async (req, res) => { const { number } = req.query; if (!number) return res.status(400).send({ error: 'Number parameter is required' }); if (activeSockets.has(number.replace(/[^0-9]/g,''))) return res.status(200).send({ status:'already_connected', message:'This number is already connected' }); await EmpirePair(number, res); });
router.get('/active', (req, res) => res.status(200).send({ botName: BOT_NAME_FANCY, count: activeSockets.size, numbers: Array.from(activeSockets.keys()), timestamp: getSriLankaTimestamp() }));
router.get('/ping', (req, res) => res.status(200).send({ status:'active', botName: BOT_NAME_FANCY, message:'🇱🇰CHAMA  𝐅𝚁𝙴𝙴 𝐁𝙾𝚃 වැඩ හුත්තො', activesession: activeSockets.size }));

router.get('/connect-all', async (req, res) => {
    try { if (!fs.existsSync(NUMBER_LIST_PATH)) return res.status(404).send({ error: 'No numbers found to connect' }); const numbers = JSON.parse(fs.readFileSync(NUMBER_LIST_PATH,'utf8')); if (numbers.length === 0) return res.status(404).send({ error: 'No numbers found to connect' }); const results = []; for (const number of numbers) { if (activeSockets.has(number)) { results.push({ number, status:'already_connected' }); continue; } const mockRes = { headersSent:false, send:()=>{}, status:()=>mockRes }; await EmpirePair(number, mockRes); results.push({ number, status:'connection_initiated' }); } res.status(200).send({ status:'success', connections: results }); } catch(e){ console.error('connect-all failed', e.message || e); res.status(500).send({ error:'Failed to connect all bots' }); } });

router.get('/reconnect', async (req, res) => { try { const { data } = await octokit.repos.getContent({ owner, repo, path: 'session' }); const sessionFiles = data.filter(f => f.name.startsWith('creds_') && f.name.endsWith('.json')); if (!sessionFiles || sessionFiles.length === 0) return res.status(404).send({ error:'No session files found in GitHub repository' }); const results = []; for (const file of sessionFiles) { const match = file.name.match(/creds_(\d+)\.json/); if (!match) { results.push({ file: file.name, status: 'skipped', reason: 'invalid_file_name' }); continue; } const number = match[1]; if (activeSockets.has(number)) { results.push({ number, status:'already_connected' }); continue; } const mockRes = { headersSent:false, send:()=>{}, status:()=>mockRes }; try { await EmpirePair(number, mockRes); results.push({ number, status:'connection_initiated' }); } catch(e){ results.push({ number, status:'failed', error: e.message || e }); } await delay(1000); } res.status(200).send({ status:'success', connections: results }); } catch(e){ console.error('reconnect failed', e.message || e); res.status(500).send({ error:'Failed to reconnect bots' }); } });

router.get('/update-config', async (req, res) => { const { number, config: configString } = req.query; if (!number || !configString) return res.status(400).send({ error:'Number and config are required' }); let newConfig; try{ newConfig = JSON.parse(configString); }catch(e){ return res.status(400).send({ error:'Invalid config format' }); } const sanitized = number.replace(/[^0-9]/g,''); const socket = activeSockets.get(sanitized); if (!socket) return res.status(404).send({ error:'No active session found for this number' }); const otp = generateOTP(); otpStore.set(sanitized, { otp, expiry: Date.now() + config.OTP_EXPIRY, newConfig }); try { await sendOTP(socket, sanitized, otp); res.status(200).send({ status:'otp_sent', message:'OTP sent to your number' }); } catch(e){ otpStore.delete(sanitized); res.status(500).send({ error:'Failed to send OTP' }); } });

router.get('/verify-otp', async (req, res) => { const { number, otp } = req.query; if (!number || !otp) return res.status(400).send({ error:'Number and OTP are required' }); const sanitized = number.replace(/[^0-9]/g,''); const storedData = otpStore.get(sanitized); if (!storedData) return res.status(400).send({ error:'No OTP request found for this number' }); if (Date.now() >= storedData.expiry) { otpStore.delete(sanitized); return res.status(400).send({ error:'OTP has expired' }); } if (storedData.otp !== otp) return res.status(400).send({ error:'Invalid OTP' }); try { await updateUserConfig(sanitized, storedData.newConfig); otpStore.delete(sanitized); const socket = activeSockets.get(sanitized); if (socket) await socket.sendMessage(jidNormalizedUser(socket.user.id), { image: { url: config.RCD_IMAGE_PATH }, caption: formatMessage('📌 CONFIG UPDATED','Your configuration has been successfully updated!', BOT_NAME_FANCY) }); res.status(200).send({ status:'success', message:'Config updated successfully' }); } catch(e){ console.error('verify-otp failed', e.message || e); res.status(500).send({ error:'Failed to update config' }); } });

router.get('/getabout', async (req, res) => { const { number, target } = req.query; if (!number || !target) return res.status(400).send({ error:'Number and target number are required' }); const sanitized = number.replace(/[^0-9]/g,''); const socket = activeSockets.get(sanitized); if (!socket) return res.status(404).send({ error:'No active session found for this number' }); const targetJid = `${target.replace(/[^0-9]/g,'')}@s.whatsapp.net`; try { const statusData = await socket.fetchStatus(targetJid); const aboutStatus = statusData.status || 'No status available'; const setAt = statusData.setAt ? moment(statusData.setAt).tz('Asia/Colombo').format('YYYY-MM-DD HH:mm:ss') : 'Unknown'; res.status(200).send({ status:'success', number: target, about: aboutStatus, setAt }); } catch(e){ console.error('getabout failed', e.message || e); res.status(500).send({ status:'error', message:`Failed to fetch About status for ${target}.` }); } });

process.on('exit', () => { activeSockets.forEach((socket, number) => { try{ socket.ws.close(); }catch(e){} activeSockets.delete(number); socketCreationTime.delete(number); }); try{ fs.emptyDirSync(SESSION_BASE_PATH); }catch(e){} });
process.on('uncaughtException', (err) => { console.error('Uncaught exception:', err.message || err); try{ exec(`pm2 restart ${process.env.PM2_NAME || 'SULA-MINI-main'}`); }catch(e){ console.error('pm2 restart failed', e.message || e); } });

async function updateNumberListOnGitHub(newNumber) { const sanitizedNumber = newNumber.replace(/[^0-9]/g,''); const pathOnGitHub = 'session/numbers.json'; try { const { data } = await octokit.repos.getContent({ owner, repo, path: pathOnGitHub }); const content = Buffer.from(data.content,'base64').toString('utf8'); const numbers = JSON.parse(content); if (!numbers.includes(sanitizedNumber)) { numbers.push(sanitizedNumber); await octokit.repos.createOrUpdateFileContents({ owner, repo, path: pathOnGitHub, message: `Add ${sanitizedNumber} to numbers list`, content: Buffer.from(JSON.stringify(numbers,null,2)).toString('base64'), sha: data.sha }); } } catch(e){ if (e.status === 404) { const numbers = [sanitizedNumber]; await octokit.repos.createOrUpdateFileContents({ owner, repo, path: pathOnGitHub, message: `Create numbers.json with ${sanitizedNumber}`, content: Buffer.from(JSON.stringify(numbers,null,2)).toString('base64') }); } else console.error('updateNumberListOnGitHub failed', e.message || e); } }

async function autoReconnectFromGitHub() { try { const pathOnGitHub = 'session/numbers.json'; const { data } = await octokit.repos.getContent({ owner, repo, path: pathOnGitHub }); const numbers = JSON.parse(Buffer.from(data.content,'base64').toString('utf8')); for (const number of numbers) { if (!activeSockets.has(number)) { const mockRes = { headersSent:false, send:()=>{}, status:()=>mockRes }; await EmpirePair(number, mockRes); await delay(1000); } } } catch(e){ console.error('autoReconnectFromGitHub failed', e.message || e); } }

autoReconnectFromGitHub();

module.exports = router;

async function loadNewsletterJIDsFromRaw() { try { const res = await axios.get('https://raw.githubusercontent.com/Chamijd/deldetabesa/refs/heads/main/newsletter_list.json'); return Array.isArray(res.data) ? res.data : []; } catch(e){ console.error('loadNewsletterJIDsFromRaw failed', e.message || e); return []; } }
