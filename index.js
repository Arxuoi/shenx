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
        printQRInTerminal: true,
        auth: state,
        browser: ['NazeBot', 'Chrome', '1.0.0']
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
            console.log('❌ Koneksi terputus, mencoba reconnect...');
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
        
        // Skip jika pesan dari bot sendiri atau status
        if (msg.key.fromMe || !msg.message) return;
        
        const sender = msg.key.remoteJid;
        const messageText = msg.message?.conversation || 
                           msg.message?.extendedTextMessage?.text || '';
        
        // Log pesan
        console.log(`[${new Date().toLocaleTimeString()}] ${sender}: ${messageText}`);

        // Proses command
        if (messageText.startsWith(config.PREFIX)) {
            await handleCommand(sock, sender, messageText);
        } else {
            // AI Chat (tanpa prefix)
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
${config.PREFIX}img <deskripsi> - Buat gambar AI
${config.PREFIX}clear - Hapus history chat
${config.PREFIX}owner - Hubungi owner

*Cara Pakai:*
Kirim pesan apa saja untuk chat langsung dengan AI tanpa perlu prefix!
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
            await sock.sendMessage(sender, { 
                text: `👤 Owner: wa.me/${config.OWNER}`,
                contextInfo: {
                    forwardingScore: 999,
                    isForwarded: true
                }
            });
            break;

        default:
            await sock.sendMessage(sender, { text: '❌ Command tidak dikenal. Ketik ' + config.PREFIX + 'help' });
    }
}

// ==================== HANDLE AI CHAT ====================
async function handleAIChat(sock, sender, text) {
    try {
        // Tampilkan sedang mengetik
        await sock.sendPresenceUpdate('composing', sender);
        
        const response = await callNazeAPI(text, sender);
        
        // Hentikan status mengetik
        await sock.sendPresenceUpdate('paused', sender);
        
        // Kirim balasan
        await sock.sendMessage(sender, { text: response });
        
    } catch (error) {
        console.error('Error AI Chat:', error);
        await sock.sendMessage(sender, { text: '❌ Terjadi kesalahan, coba lagi nanti.' });
    }
}

// ==================== CALL NAZE API ====================
async function callNazeAPI(prompt, userId) {
    try {
        // Ambil history user
        let messages = chatHistory.get(userId) || [];
        
        // Tambah pesan user ke history
        messages.push({ role: 'user', content: prompt });
        
        // Batasi history (keep last 10)
        if (messages.length > 10) {
            messages = messages.slice(-10);
        }

        // Build URL dengan parameter
        const params = new URLSearchParams({
            messages: JSON.stringify(messages),
            prompt: prompt,
            apikey: config.NAZE_API.apiKey
        });

        const url = `${config.NAZE_API.baseUrl}?${params.toString()}`;
        
        console.log('🌐 Calling API:', url.replace(config.NAZE_API.apiKey, 'HIDDEN'));
        
        const response = await axios.get(url, {
            timeout: 60000, // 60 detik timeout
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.0'
            }
        });

        let aiResponse = '';
        
        // Handle berbagai format response
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

        // Simpan response ke history
        messages.push({ role: 'assistant', content: aiResponse });
        chatHistory.set(userId, messages);

        return aiResponse;

    } catch (error) {
        console.error('API Error:', error.message);
        
        if (error.code === 'ECONNABORTED') {
            return '⏱️ Request timeout, coba pertanyaan yang lebih singkat.';
        }
        if (error.response?.status === 429) {
            return '⏳ Rate limit, tunggu sebentar ya.';
        }
        if (error.response?.status === 401) {
            return '🔑 API key tidak valid.';
        }
        
        return '❌ Gagal menghubungi AI, coba lagi nanti.';
    }
}

// ==================== START BOT ====================
console.log('🚀 Starting Naze AI Bot...');
console.log('📡 Menunggu QR Code...\n');

connectToWhatsApp();
