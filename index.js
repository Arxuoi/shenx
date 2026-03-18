const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason,
    fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');
const axios = require('axios');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const config = require('./config');

// Simpan history chat per user
const chatHistory = new Map();

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    const { version } = await fetchLatestBaileysVersion();
    
    const sock = makeWASocket({
        version,
        printQRInTerminal: true,  // QR mode (paling stabil)
        auth: state,
        browser: ['Ubuntu', 'Chrome', '20.0.04'],
    });

    // Save credentials
    sock.ev.on('creds.update', saveCreds);

    // Handle connection
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            console.log('\n📱 SCAN QR CODE DI ATAS DENGAN WHATSAPP ANDA\n');
        }
        
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('❌ Koneksi terputus, reconnecting...');
            if (shouldReconnect) {
                connectToWhatsApp();
            }
        } else if (connection === 'open') {
            console.log('✅ BOT BERHASIL TERHUBUNG!');
            console.log('🤖 Siap menerima pesan...\n');
        }
    });

    // Handle pesan masuk
    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        
        if (msg.key.fromMe || !msg.message) return;
        
        const sender = msg.key.remoteJid;
        const messageText = msg.message?.conversation || 
                           msg.message?.extendedTextMessage?.text || '';
        
        console.log(`[${new Date().toLocaleTimeString()}] ${sender}: ${messageText}`);

        if (messageText.startsWith(config.PREFIX)) {
            await handleCommand(sock, sender, messageText);
        } else {
            await handleAIChat(sock, sender, messageText);
        }
    });
}

// ==================== HANDLE COMMAND ====================
async function handleCommand(sock, sender, text) {
    const args = text.slice(config.PREFIX.length).trim().split(' ');
    const command = args.shift().toLowerCase();
    const query = args.join(' ');

    switch(command) {
        case 'help':
        case 'menu':
            const menu = `
🤖 *NAZE AI BOT*

*Perintah:*
${config.PREFIX}help - Menu bantuan
${config.PREFIX}ai <pertanyaan> - Chat dengan AI
${config.PREFIX}clear - Hapus history chat
${config.PREFIX}owner - Hubungi owner

*Cara Pakai:*
Kirim pesan apa saja untuk chat langsung dengan AI!
            `;
            await sock.sendMessage(sender, { text: menu });
            break;

        case 'ai':
            if (!query) {
                await sock.sendMessage(sender, { text: '❌ Contoh: ' + config.PREFIX + 'ai apa itu javascript?' });
                return;
            }
            await sock.sendMessage(sender, { text: '⏳ Sedang memproses...' });
            const aiResponse = await callNazeAPI(query, sender);
            await sock.sendMessage(sender, { text: aiResponse });
            break;

        case 'clear':
            chatHistory.delete(sender);
            await sock.sendMessage(sender, { text: '✅ History chat berhasil dihapus!' });
            break;

        case 'owner':
            await sock.sendMessage(sender, { text: `👤 Owner: wa.me/${config.OWNER}` });
            break;

        default:
            await sock.sendMessage(sender, { text: '❌ Command tidak dikenal. Ketik ' + config.PREFIX + 'help' });
    }
}

// ==================== HANDLE AI CHAT ====================
async function handleAIChat(sock, sender, text) {
    try {
        await sock.sendPresenceUpdate('composing', sender);
        const response = await callNazeAPI(text, sender);
        await sock.sendPresenceUpdate('paused', sender);
        await sock.sendMessage(sender, { text: response });
    } catch (error) {
        console.error('Error:', error);
        await sock.sendMessage(sender, { text: '❌ Terjadi kesalahan, coba lagi nanti.' });
    }
}

// ==================== CALL NAZE API ====================
async function callNazeAPI(prompt, userId) {
    try {
        let messages = chatHistory.get(userId) || [];
        messages.push({ role: 'user', content: prompt });
        
        if (messages.length > 10) messages = messages.slice(-10);

        const params = new URLSearchParams({
            messages: JSON.stringify(messages),
            prompt: prompt,
            apikey: config.NAZE_API.apiKey
        });

        const url = `${config.NAZE_API.baseUrl}?${params.toString()}`;
        
        const response = await axios.get(url, {
            timeout: 60000,
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });

        let aiResponse = '';
        
        if (typeof response.data === 'string') {
            aiResponse = response.data;
        } else if (response.data.result) {
            aiResponse = response.data.result;
        } else if (response.data.data) {
            aiResponse = response.data.data;
        } else if (response.data.message) {
            aiResponse = response.data.message;
        } else {
            aiResponse = JSON.stringify(response.data);
        }

        messages.push({ role: 'assistant', content: aiResponse });
        chatHistory.set(userId, messages);

        return aiResponse;

    } catch (error) {
        console.error('API Error:', error.message);
        return '❌ Gagal menghubungi AI.';
    }
}

// ==================== START BOT ====================
console.log('🚀 Starting Naze AI Bot...');
console.log('📱 Tunggu QR Code...\n');

connectToWhatsApp();
