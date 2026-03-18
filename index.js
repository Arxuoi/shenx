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

const chatHistory = new Map();

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    const { version } = await fetchLatestBaileysVersion();
    
    const sock = makeWASocket({
        version,
        auth: state,
        browser: ['Ubuntu', 'Chrome', '20.0.04'],
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            console.log('\n📱 SCAN QR CODE DI BAWAH INI:\n');
            qrcode.generate(qr, { small: true });
        }
        
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('❌ Koneksi terputus, reconnecting...');
            if (shouldReconnect) connectToWhatsApp();
        } else if (connection === 'open') {
            console.log('✅ BOT BERHASIL TERHUBUNG!');
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (msg.key.fromMe || !msg.message) return;
        
        const sender = msg.key.remoteJid;
        const messageText = msg.message?.conversation || 
                           msg.message?.extendedTextMessage?.text || '';
        
        console.log(`[${new Date().toLocaleTimeString()}] ${sender}: ${messageText}`);

        if (messageText.startsWith(config.PREFIX)) {
            await handleCommand(sock, sender, messageText, msg);
        } else {
            await handleAIChat(sock, sender, messageText);
        }
    });
}

// ==================== HANDLE COMMAND ====================
async function handleCommand(sock, sender, text, msg) {
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
${config.PREFIX}tiktok <url> - Download video TikTok
${config.PREFIX}brat <text> - Brat Generator
${config.PREFIX}clear - Hapus history chat
${config.PREFIX}owner - Hubungi owner

*Cara Pakai:*
Kirim pesan apa saja untuk chat langsung dengan AI!
            `;
            await sock.sendMessage(sender, { text: menu });
            break;

        case 'ai':
            if (!query) {
                await sock.sendMessage(sender, { text: '❌ Contoh: ' + config.PREFIX + 'ai halo' });
                return;
            }
            await sock.sendMessage(sender, { text: '⏳ Sedang memproses...' });
            const aiResponse = await callNazeAPI(query, sender);
            await sock.sendMessage(sender, { text: aiResponse });
            break;

        case 'tiktok':
        case 'tt':
            if (!query) {
                await sock.sendMessage(sender, { text: '❌ Contoh: ' + config.PREFIX + 'tiktok https://vt.tiktok.com/xxxxx' });
                return;
            }
            await downloadTikTok(sock, sender, query);
            break;

        case 'brat':
            if (!query) {
                await sock.sendMessage(sender, { text: '❌ Contoh: ' + config.PREFIX + 'brat hello world' });
                return;
            }
            await bratGenerator(sock, sender, query);
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
        await sock.sendMessage(sender, { text: '❌ Error, coba lagi.' });
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
            query: prompt,
            apikey: config.NAZE_API.apiKey
        });

        const url = `${config.NAZE_API.baseUrl}?${params.toString()}`;
        const response = await axios.get(url, { timeout: 60000 });
        
        let aiResponse = '';
        
        if (response.data.success && response.data.result) {
            aiResponse = response.data.result.message || 'No response';
        } else if (typeof response.data === 'string') {
            aiResponse = response.data;
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

// ==================== DOWNLOAD TIKTOK ====================
async function downloadTikTok(sock, sender, url) {
    try {
        await sock.sendMessage(sender, { text: '⏳ Mengambil video TikTok...' });
        
        const apiUrl = `https://api.naze.biz.id/download/tiktok?url=${encodeURIComponent(url)}&apikey=${config.NAZE_API.apiKey}`;
        
        const response = await axios.get(apiUrl, { timeout: 60000 });
        
        if (!response.data.status || !response.data.result) {
            await sock.sendMessage(sender, { text: '❌ Gagal mengambil video. Cek URL dan coba lagi.' });
            return;
        }
        
        const result = response.data.result;
        
        // Kirim info
        await sock.sendMessage(sender, { 
            text: `✅ *TikTok Downloader*\n\n👤 Author: ${result.author || 'Unknown'}\n📝 Title: ${result.title || 'No title'}` 
        });
        
        // Kirim video (no watermark)
        if (result.video) {
            await sock.sendMessage(sender, {
                video: { url: result.video },
                caption: '🎥 Video (No WM)'
            });
        }
        
        // Kirim audio kalau ada
        if (result.audio) {
            await sock.sendMessage(sender, {
                audio: { url: result.audio },
                mimetype: 'audio/mpeg'
            });
        }
        
    } catch (error) {
        console.error('TikTok Error:', error.message);
        await sock.sendMessage(sender, { text: '❌ Error: ' + error.message });
    }
}

// ==================== BRAT GENERATOR ====================
async function bratGenerator(sock, sender, text) {
    try {
        await sock.sendMessage(sender, { text: '⏳ Membuat gambar brat...' });
        
        const apiUrl = `https://api.naze.biz.id/create/brat?text=${encodeURIComponent(text)}&apikey=${config.NAZE_API.apiKey}`;
        
        const response = await axios.get(apiUrl, { 
            timeout: 30000,
            responseType: 'arraybuffer'
        });
        
        // Simpan sementara
        const path = `/tmp/brat_${Date.now()}.png`;
        fs.writeFileSync(path, response.data);
        
        // Kirim gambar
        await sock.sendMessage(sender, {
            image: { url: path },
            caption: `✅ *Brat Generator*\n\nText: "${text}"`
        });
        
        // Hapus file temp
        fs.unlinkSync(path);
        
    } catch (error) {
        console.error('Brat Error:', error.message);
        await sock.sendMessage(sender, { text: '❌ Gagal membuat gambar brat' });
    }
}

console.log('🚀 Starting Naze AI Bot...');
console.log('📱 Tunggu QR Code...\n');

connectToWhatsApp();
            
