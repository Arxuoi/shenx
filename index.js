const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore  // Tambah ini
} = require('@whiskeysockets/baileys');
const axios = require('axios');
const readline = require('readline');  // Tambah ini untuk input
const fs = require('fs');
const config = require('./config');

// Setup readline untuk input pairing code
const rl = readline.createInterface({ 
    input: process.stdin, 
    output: process.stdout 
});

const question = (text) => new Promise((resolve) => rl.question(text, resolve));

// Simpan history chat per user
const chatHistory = new Map();

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    const { version } = await fetchLatestBaileysVersion();
    
    // Tanya nomor WhatsApp
    const phoneNumber = await question('📱 Masukkan nomor WhatsApp (628xxxxx): ');
    
    const sock = makeWASocket({
        version,
        printQRInTerminal: false,  // Matikan QR
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, console),
        },
        browser: ['Ubuntu', 'Chrome', '20.0.04'],
        logger: console,
        markOnlineOnConnect: true,
    });

    // Pairing code logic
    if (!sock.authState.creds.registered) {
        console.log('⏳ Requesting pairing code...');
        
        try {
            const code = await sock.requestPairingCode(phoneNumber);
            console.log('\n🔑 PAIRING CODE ANDA:');
            console.log('═══════════════════════');
            console.log('       ' + code);
            console.log('═══════════════════════');
            console.log('Buka WhatsApp → Menu → Perangkat Tertaut → Tautkan Perangkat\n');
        } catch (err) {
            console.error('❌ Gagal request pairing code:', err.message);
            process.exit(1);
        }
    }

    // Save credentials
    sock.ev.on('creds.update', saveCreds);

    // Handle connection
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('❌ Koneksi terputus, reconnecting...');
            if (shouldReconnect) {
                connectToWhatsApp();
            }
        } else if (connection === 'open') {
            console.log('✅ BOT BERHASIL TERHUBUNG!');
            console.log('🤖 Siap menerima pesan...\n');
            rl.close();  // Tutup readline setelah connect
        }
    });

    // Handle pesan masuk (sama seperti sebelumnya)
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

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    const { version } = await fetchLatestBaileysVersion();
    
    // Tanya nomor WhatsApp
    const phoneNumber = await question('📱 Masukkan nomor WhatsApp (628xxxxx): ');
    
    // Bersihkan nomor (hapus spasi, +, -)
    const cleanNumber = phoneNumber.replace(/[^0-9]/g, '');
    
    const sock = makeWASocket({
        version,
        printQRInTerminal: false,  // Matikan QR
        auth: state,  // ✅ FIX: langsung pakai state
        browser: ['Ubuntu', 'Chrome', '20.0.04'],
        logger: console,
        markOnlineOnConnect: true,
    });

    // Pairing code logic - TUNGGU SOCKET READY
    if (!sock.authState.creds.registered) {
        console.log('⏳ Requesting pairing code...');
        
        try {
            // ✅ FIX: Tunggu 2 detik biar socket ready
            await new Promise(resolve => setTimeout(resolve, 2000));
            
            const code = await sock.requestPairingCode(cleanNumber);
            
            console.log('\n🔑 PAIRING CODE ANDA:');
            console.log('═══════════════════════');
            console.log('       ' + code);
            console.log('═══════════════════════');
            console.log('Buka WhatsApp → Menu (3 titik) → Perangkat Tertaut → Tautkan Perangkat');
            console.log('Pilih "Tautkan dengan nomor telepon"\n');
            
        } catch (err) {
            console.error('❌ Gagal request pairing code:', err.message);
            console.log('🔄 Mencoba method QR...');
            // Fallback ke QR kalau pairing gagal
        }
    
    
