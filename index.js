require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const sqlite3 = require('sqlite3').verbose();
const cron = require('node-cron');
const { exec } = require('child_process');

// Mengambil Data dari .env
const token = process.env.BOT_TOKEN;
const OWNER_ID = Number(process.env.OWNER_ID);
const LOGS_GROUP = Number(process.env.LOGS_GROUP);
const CHANNEL_LINK = process.env.CHANNEL_LINK;
const CHANNEL_IKLAN = Number(process.env.CHANNEL_IKLAN);

const bot = new TelegramBot(token, { polling: true });

// ==========================================
// OTOMATIS SET COMMAND DI MENU TELEGRAM
// ==========================================
bot.setMyCommands([
    { command: '/start', description: 'Mulai mencari pasangan obrolan' },
    { command: '/search', description: 'Cari pasangan baru' },
    { command: '/next', description: 'Lewati obrolan & cari yang baru' },
    { command: '/stop', description: 'Hentikan pencarian / obrolan saat ini' },
    { command: '/refer', description: 'Dapatkan link undangan (Fitur Premium)' },
    { command: '/stats', description: 'Cek statistik pengguna bot' },
    { command: '/ripport', description: 'Laporkan pelanggaran (Wajib balas pesan)' }
]).then(() => console.log("✅ Menu Commands terpasang!")).catch(console.error);

// Inisialisasi Database SQLite3
const db = new sqlite3.Database('./bot.db');

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY, state TEXT DEFAULT 'idle', partner_id INTEGER, 
        warnings INTEGER DEFAULT 0, ban_until INTEGER DEFAULT 0, referrals INTEGER DEFAULT 0, premium_until INTEGER DEFAULT 0
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS messages (message_id INTEGER PRIMARY KEY, sender_id INTEGER)`);
});

const getUser = (id) => new Promise((resolve) => db.get("SELECT * FROM users WHERE id = ?", [id], (err, row) => resolve(row)));
const updateState = (id, state, partner = null) => new Promise((resolve) => db.run(`UPDATE users SET state = ?, partner_id = ? WHERE id = ?`, [state, partner, id], resolve));
const addMessageCache = (msgId, senderId) => db.run("INSERT OR REPLACE INTO messages (message_id, sender_id) VALUES (?, ?)",[msgId, senderId]);
const getSenderFromCache = (msgId) => new Promise((resolve) => db.get("SELECT sender_id FROM messages WHERE message_id = ?", [msgId], (err, row) => resolve(row ? row.sender_id : null)));

// Cek status member channel (Bot Wajib Jadi Admin)
async function isMemberJoined(userId) {
    try {
        const chatMember = await bot.getChatMember(CHANNEL_IKLAN, userId);
        return ['member', 'administrator', 'creator'].includes(chatMember.status);
    } catch (e) {
        return false;
    }
}

// ==========================================
// FUNGSI PESAN BOT (DENGAN IKLAN)
// ==========================================
async function sendBotMessage(userId, textMsg) {
    let isMember = await isMemberJoined(userId);
    let promoText = isMember ? "" : `\n\n<i>Ikuti saluran kami agar kamu tidak mendapatkan text promosi.</i>`;
    let opts = { parse_mode: 'HTML' };
    
    if (!isMember) {
        opts.reply_markup = { inline_keyboard: [[{ text: "🚪Joint", url: CHANNEL_LINK, style: "success" }]] };
    }
    return bot.sendMessage(userId, textMsg + promoText, opts);
}

// ==========================================
// FITUR CARI PASANGAN
// ==========================================
async function findPartner(userId) {
    db.get("SELECT id FROM users WHERE state = 'searching' AND id != ? LIMIT 1", [userId], async (err, partner) => {
        if (partner) {
            // Jika ketemu, pasangkan keduanya
            await updateState(userId, 'chatting', partner.id);
            await updateState(partner.id, 'chatting', userId);
            sendBotMessage(userId, "🎉 Pasangan ditemukan! Silakan mulai mengobrol.");
            sendBotMessage(partner.id, "🎉 Pasangan ditemukan! Silakan mulai mengobrol.");
        } else {
            // Jika kosong/belum ada pasangan yang standby
            sendBotMessage(userId, "❌Pasangan Belum Di Temukan Gunakan /refer Agar Pasangan Cepat Di Temukan Dan Akunmu Menjadi Premium");
        }
    });
}

// ==========================================
// LISTENER PESAN UTAMA
// ==========================================
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text || '';

    let user = await getUser(chatId);
    let isNewUser = false;
    
    if (!user) {
        db.run("INSERT INTO users (id) VALUES (?)", [chatId]);
        user = { id: chatId, state: 'idle', warnings: 0, ban_until: 0, referrals: 0, premium_until: 0 };
        isNewUser = true;
    }

    if (user.ban_until > Date.now()) {
        let date = new Date(user.ban_until).toLocaleString('id-ID');
        return sendBotMessage(chatId, `❌ Anda sedang diblokir dari bot hingga:\n${date}`);
    }

    // COMMANDS
    if (text === '/stats') {
        db.get("SELECT COUNT(*) AS total FROM users", (err, rowTotal) => {
            db.get("SELECT COUNT(*) AS online FROM users WHERE state != 'idle'", (err, rowOnline) => {
                let totalUsers = rowTotal ? rowTotal.total : 0;
                let onlineUsers = rowOnline ? rowOnline.online : 0;
                
                let statsMsg = `📊 <b>Statistik Penggunaan Bot</b>\n\n👥 Total Pengguna: <b>${totalUsers} User</b>\n🟢 Sedang Online: <b>${onlineUsers} User</b>\n\n<i>*Online = Sedang mencari atau mengobrol</i>`;
                sendBotMessage(chatId, statsMsg);
            });
        });
        return;
    }

    if (text.startsWith('/start') || text.startsWith('/search')) {
        let refId = text.split(' ')[1];
        
        // Anti Curang Referral (Hanya user baru yang dihitung)
        if (refId && refId != chatId && isNewUser) {
            let referrer = await getUser(refId);
            if (referrer) {
                let newRef = referrer.referrals + 1;
                let addDays = 0;
                if (newRef === 1) addDays = 1;
                else if (newRef === 7) addDays = 7;
                else if (newRef === 30) addDays = 30;
                else if (newRef >= 400) addDays = 365;
                
                let premUntil = addDays > 0 ? Date.now() + (addDays * 24 * 60 * 60 * 1000) : referrer.premium_until;
                db.run("UPDATE users SET referrals = ?, premium_until = ? WHERE id = ?", [newRef, premUntil, refId]);
                sendBotMessage(refId, `🎉 Kamu mendapatkan refferal baru! Total refferal: ${newRef}`);
            }
        }

        if (user.state === 'chatting') {
            return sendBotMessage(chatId, "⚠️ Kamu sedang mengobrol. Ketik /stop atau /next terlebih dahulu.");
        }

        await updateState(chatId, 'searching');
        sendBotMessage(chatId, "🔎Sedang Mencari Pasangan...");
        findPartner(chatId);
        return;
    }

    if (text === '/next') {
        if (user.state === 'chatting' && user.partner_id) {
            sendBotMessage(user.partner_id, "❌User Baru Saja Klik /next");
            await updateState(user.partner_id, 'idle');
        }
        await sendBotMessage(chatId, "✅Kamu Melewatkan Obrolan Ini.");
        bot.sendChatAction(chatId, 'typing'); 
        await sendBotMessage(chatId, "🔎Mencari Obrolan Baru...");
        await updateState(chatId, 'searching');
        findPartner(chatId);
        return;
    }

    if (text === '/stop') {
        if (user.state === 'chatting' && user.partner_id) {
            sendBotMessage(user.partner_id, "🔴Pasangan Menghentikan Obrolan.");
            await updateState(user.partner_id, 'idle');
        }
        await updateState(chatId, 'idle');
        return sendBotMessage(chatId, "🔴Mencari Pasangan Di Stop");
    }

    if (text === '/refer') {
        const botInfo = await bot.getMe();
        const refLink = `https://t.me/${botInfo.username}?start=${chatId}`;
        const isPremium = user.premium_until > Date.now();
        // Menggunakan <code> agar link bisa diklik 1x langsung tersalin otomatis
        const stat = `<b>Tautan Undangan Kamu:</b>\n<i>(Klik teks link di bawah untuk otomatis menyalin)</i>\n\n<code>${refLink}</code>\n\nTotal Refferal: ${user.referrals}\nStatus Premium: ${isPremium ? 'Aktif ✅' : 'Tidak Aktif ❌'}`;
        return sendBotMessage(chatId, stat);
    }

    if (text === '/ripport') {
        if (!msg.reply_to_message) return sendBotMessage(chatId, "⚠️Wajib Reply Pesan User yang ingin di-report.");
        const reportedMsgId = msg.reply_to_message.message_id;
        const suspectId = await getSenderFromCache(reportedMsgId);
        if (!suspectId) return sendBotMessage(chatId, "❌ Pesan ini tidak dapat dilaporkan.");

        bot.sendMessage(LOGS_GROUP, `⚠️ <b>LAPORAN PENGGUNA</b>\n\nPelapor: <code>${chatId}</code>\nTersangka: <code>${suspectId}</code>\nPesan: ${msg.reply_to_message.text || "Media/Stiker"}`, {
            parse_mode: 'HTML',
            reply_markup: {
                inline_keyboard: [[{ text: "✅ Acc", callback_data: `acc_${suspectId}` }, { text: "❌ Reject", callback_data: `rej_${suspectId}` }]]
            }
        });
        return sendBotMessage(chatId, "✅ Laporan berhasil dikirim ke Admin.");
    }

    // ==========================================
    // SISTEM PENGIRIMAN PESAN ANTAR USER
    // ==========================================
    if (user.state === 'chatting' && user.partner_id) {
        const isPremium = user.premium_until > Date.now();
        
        if (!isPremium && text && /[@\.,!]/.test(text)) {
            return sendBotMessage(chatId, "❌ Anda bukan pengguna premium. Tidak dapat mengirim simbol larangan (@, ., ,, !) untuk menghindari encoding ID/Username.");
        }
        
        try {
            if (text) bot.sendChatAction(user.partner_id, 'typing');
            else if (msg.photo) bot.sendChatAction(user.partner_id, 'upload_photo');
            else if (msg.voice) bot.sendChatAction(user.partner_id, 'record_voice');

            let sentMsg;
            if (text) sentMsg = await bot.sendMessage(user.partner_id, text);
            else sentMsg = await bot.copyMessage(user.partner_id, chatId, msg.message_id);
            addMessageCache(sentMsg.message_id, chatId);
        } catch (e) {
            await updateState(chatId, 'idle');
            sendBotMessage(chatId, "❌ Gagal mengirim pesan. Obrolan dihentikan (Mungkin partner telah memblokir bot).");
        }
    }
});

// ==========================================
// CALLBACK ADMIN (ACC/REJECT LOGS)
// ==========================================
bot.on('callback_query', async (query) => {
    const data = query.data;
    const adminChatId = query.message.chat.id;
    const msgId = query.message.message_id;

    if (data.startsWith('acc_') || data.startsWith('rej_')) {
        const suspectId = data.split('_')[1];
        if (data.startsWith('rej_')) return bot.editMessageText(query.message.text + "\n\n❌ Laporan di Reject.", { chat_id: adminChatId, message_id: msgId });

        if (data.startsWith('acc_')) {
            let suspect = await getUser(suspectId);
            if (suspect) {
                let newWarnings = suspect.warnings + 1;
                let banDuration = (newWarnings === 1) ? 86400000 : (newWarnings === 2) ? 604800000 : (newWarnings === 3) ? 2592000000 : 31536000000; 
                let banUntil = Date.now() + banDuration;
                db.run("UPDATE users SET warnings = ?, ban_until = ?, state = 'idle' WHERE id = ?", [newWarnings, banUntil, suspectId]);
                
                if (suspect.state === 'chatting' && suspect.partner_id) {
                    await updateState(suspect.partner_id, 'idle');
                    sendBotMessage(suspect.partner_id, "❌ Pasanganmu baru saja diblokir oleh Admin.");
                }
                sendBotMessage(suspectId, `⚠️ Anda telah diblokir oleh Admin karena pelanggaran selama ${banDuration / 86400000} hari.`);
                bot.editMessageText(query.message.text + `\n\n✅ Laporan di ACC. User dibanned selama ${banDuration / 86400000} hari.`, { chat_id: adminChatId, message_id: msgId });
            }
        }
    }
});

// ==========================================
// CRON JOB: BACKUP DB KE GITHUB (JAM 00:00)
// ==========================================
cron.schedule('0 0 * * *', () => {
    console.log("[CRON] Menjalankan pembersihan cache & backup otomatis...");
    db.run("DELETE FROM messages");
    exec('git add bot.db && git commit -m "Auto backup database harian" && git push origin main', (error, stdout, stderr) => {
        if (error) {
            console.error(`[CRON] Backup Github Gagal: ${error.message}`);
            bot.sendMessage(LOGS_GROUP, "⚠️ Gagal melakukan backup database otomatis ke Github.");
            return;
        }
        console.log(`[CRON] Backup berhasil: ${stdout}`);
        bot.sendMessage(LOGS_GROUP, "✅ Berhasil melakukan backup database otomatis ke Github.");
    });
});

console.log("Bot Anonim Berjalan dan Terhubung dengan Database...");
