const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason,
    fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');
const axios = require('axios');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const FormData = require('form-data');
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
🤖 *SHENX*

*Perintah:*
${config.PREFIX}help - Menu bantuan
${config.PREFIX}ai <pertanyaan> - Chat dengan AI
${config.PREFIX}tiktok <url> - Download video (All in One)
${config.PREFIX}hd - HD Remini (kirim/reply foto)
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
        case 'download':
            if (!query) {
                await sock.sendMessage(sender, { text: '❌ Contoh: ' + config.PREFIX + 'tiktok https://vt.tiktok.com/xxxxx' });
                return;
            }
            await downloadAIO(sock, sender, query);
            break;

        case 'hd':
        case 'remini':
            await hdRemini(sock, sender, msg);
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

// ==================== DOWNLOAD ALL IN ONE ====================
async function downloadAIO(sock, sender, url) {
    try {
        // ✅ FIX: Bersihkan URL TikTok (hapus parameter tambahan)
        let cleanUrl = url;
        
        if (url.includes('tiktok.com')) {
            // Ambil hanya bagian utama URL
            const match = url.match(/(https:\/\/(?:www\.)?tiktok\.com\/@[\w.]+\/video\/\d+)/);
            if (match) {
                cleanUrl = match[1];
            } else {
                // Untuk URL short (vt.tiktok.com)
                const shortMatch = url.match(/(https:\/\/vt\.tiktok\.com\/\w+)/);
                if (shortMatch) {
                    cleanUrl = shortMatch[1];
                }
            }
        }
        
        console.log('🌐 Clean URL:', cleanUrl);
        
        await sock.sendMessage(sender, { text: '⏳ Mengambil media...' });
        
        const apiUrl = `https://api.naze.biz.id/download/aio3?url=${encodeURIComponent(cleanUrl)}&apikey=${config.NAZE_API.apiKey}`;
        
        const response = await axios.get(apiUrl, { timeout: 60000 });
        
        console.log('📥 Response:', response.data);
        
        if (!response.data.status || !response.data.result) {
            await sock.sendMessage(sender, { text: '❌ Gagal: ' + (response.data.message || 'Unknown error') });
            return;
        }
        
        const result = response.data.result;
        
        await sock.sendMessage(sender, { 
            text: `✅ *Download Berhasil*\n\n📱 Platform: ${result.platform || 'Unknown'}\n👤 Author: ${result.author || 'Unknown'}` 
        });
        
        if (result.video) {
            await sock.sendMessage(sender, {
                video: { url: result.video },
                caption: '🎥 Video'
            });
        } else if (result.audio) {
            await sock.sendMessage(sender, {
                audio: { url: result.audio },
                mimetype: 'audio/mpeg'
            });
        }
        
    } catch (error) {
        console.error('Download Error:', error.message);
        console.error('Response:', error.response?.data);
        await sock.sendMessage(sender, { text: '❌ Error: ' + error.message });
    }
}


// ==================== HD REMINI ====================
async function hdRemini(sock, sender, msg) {
    try {
        const imageMessage = msg.message?.imageMessage || 
                            msg.message?.extendedTextMessage?.contextInfo?.quotedMessage?.imageMessage;
        
        if (!imageMessage) {
            await sock.sendMessage(sender, { text: '❌ Kirim foto dengan caption *.hd*' });
            return;
        }
        
        await sock.sendMessage(sender, { text: '⏳ Mengunduh foto...' });
        
        const stream = await sock.downloadContentFromMessage(imageMessage, 'image');
        let buffer = Buffer.from([]);
        
        for await (const chunk of stream) {
            buffer = Buffer.concat([buffer, chunk]);
        }
        
        await sock.sendMessage(sender, { text: '⏳ Upload ke server...' });
        
        // ✅ FIX: Upload dengan benar
        const form = new FormData();
        form.append('file', buffer, { filename: 'image.jpg', contentType: 'image/jpeg' });
        
        const uploadRes = await axios.post(
            `https://api.naze.biz.id/upload/v3?apikey=${config.NAZE_API.apiKey}`, 
            form, 
            {
                headers: form.getHeaders(),
                timeout: 60000
            }
        );
        
        console.log('📤 Upload response:', uploadRes.data);
        
        const imageUrl = uploadRes.data.result?.url || uploadRes.data.url || uploadRes.data;
        
        if (!imageUrl || !imageUrl.startsWith('http')) {
            await sock.sendMessage(sender, { text: '❌ Gagal upload: ' + JSON.stringify(uploadRes.data) });
            return;
        }
        
        console.log('📤 Uploaded:', imageUrl);
        
        await sock.sendMessage(sender, { text: '⏳ Proses HD...' });
        
        const apiUrl = `https://api.naze.biz.id/tools/hd?set=4&url=${encodeURIComponent(imageUrl)}&apikey=${config.NAZE_API.apiKey}`;
        
        const response = await axios.get(apiUrl, { timeout: 120000 });
        
        console.log('📥 HD response:', response.data);
        
        if (!response.data.status || !response.data.result) {
            await sock.sendMessage(sender, { text: '❌ Gagal HD: ' + JSON.stringify(response.data) });
            return;
        }
        
        await sock.sendMessage(sender, {
            image: { url: response.data.result },
            caption: '✅ *HD Berhasil!*'
        });
        
    } catch (error) {
        console.error('HD Error:', error.message);
        console.error('Response:', error.response?.data);
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
        
        const path = `./brat_${Date.now()}.png`;
        fs.writeFileSync(path, response.data);
        
        await sock.sendMessage(sender, {
            image: { url: path },
            caption: `✅ *Brat Generator*\n\nText: "${text}"`
        });
        
        fs.unlinkSync(path);
        
    } catch (error) {
        console.error('Brat Error:', error.message);
        await sock.sendMessage(sender, { text: '❌ Gagal membuat gambar brat' });
    }
}

console.log('🚀 Starting Naze AI Bot...');
console.log('📱 Tunggu QR Code...\n');

connectToWhatsApp();
        
