require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const sqlite3 = require('sqlite3').verbose();
const cron = require('node-cron');
const { exec } = require('child_process');

const token = process.env.BOT_TOKEN;
const OWNER_ID = Number(process.env.OWNER_ID);
const LOGS_GROUP = Number(process.env.LOGS_GROUP);
const CHANNEL_LINK = process.env.CHANNEL_LINK;
const CHANNEL_IKLAN = Number(process.env.CHANNEL_IKLAN);

const bot = new TelegramBot(token, { polling: true });

// Menyimpan sementara pesan user yang tertahan Captcha Matematika
const pendingCaptchas = new Map();

// ==========================================
// OTOMATIS SET COMMAND
// ==========================================
bot.setMyCommands([
    { command: '/start', description: 'Mulai mencari pasangan obrolan' },
    { command: '/search', description: 'Cari pasangan baru' },
    { command: '/next', description: 'Lewati obrolan & cari yang baru' },
    { command: '/stop', description: 'Hentikan pencarian / obrolan saat ini' },
    { command: '/refer', description: 'Dapatkan Premium & Link Undangan' },
    { command: '/stats', description: 'Cek statistik pengguna bot' },
    { command: '/ripport', description: 'Laporkan pelanggaran (Wajib balas pesan)' }
]);

// Inisialisasi DB
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

async function isMemberJoined(userId) {
    try {
        const chatMember = await bot.getChatMember(CHANNEL_IKLAN, userId);
        return ['member', 'administrator', 'creator'].includes(chatMember.status);
    } catch (e) { return false; }
}

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
// FUNGSI GENERATOR SOAL MATEMATIKA (1-10)
// ==========================================
function generateCaptcha() {
    const type = Math.random() > 0.5 ? 2 : 3; // Pilih tipe soal 2 angka / 3 angka
    const result = Math.floor(Math.random() * 10) + 1; // Hasil pasti 1 sampai 10
    let question = "";
    
    if (type === 2) {
        let b = Math.floor(Math.random() * 10) + 1;
        let a = result + b; 
        question = `${a} - ${b} = ?`;
    } else {
        let c = Math.floor(Math.random() * result); 
        let temp = result - c; 
        let b = Math.floor(Math.random() * 10) + 1;
        let a = temp + b;
        question = `${a} - ${b} + ${c} = ?`;
    }
    return { question, result: result.toString() };
}

async function findPartner(userId) {
    db.get("SELECT id FROM users WHERE state = 'searching' AND id != ? LIMIT 1", [userId], async (err, partner) => {
        if (partner) {
            await updateState(userId, 'chatting', partner.id);
            await updateState(partner.id, 'chatting', userId);
            sendBotMessage(userId, "🎉 Pasangan ditemukan! Silakan mulai mengobrol.");
            sendBotMessage(partner.id, "🎉 Pasangan ditemukan! Silakan mulai mengobrol.");
        } else {
            sendBotMessage(userId, "❌Pasangan Belum Di Temukan Gunakan /refer Agar Pasangan Cepat Di Temukan Dan Akunmu Menjadi Premium");
        }
    });
}

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

    if (text === '/stats') {
        db.get("SELECT COUNT(*) AS total FROM users", (err, rowTotal) => {
            db.get("SELECT COUNT(*) AS online FROM users WHERE state != 'idle'", (err, rowOnline) => {
                let statsMsg = `📊 <b>Statistik Penggunaan Bot</b>\n\n👥 Total Pengguna: <b>${rowTotal ? rowTotal.total : 0} User</b>\n🟢 Sedang Online: <b>${rowOnline ? rowOnline.online : 0} User</b>\n\n<i>*Online = Sedang mencari / mengobrol</i>`;
                sendBotMessage(chatId, statsMsg);
            });
        });
        return;
    }

    if (text.startsWith('/start') || text.startsWith('/search')) {
        let refId = text.split(' ')[1];
        if (refId && refId != chatId && isNewUser) {
            let referrer = await getUser(refId);
            if (referrer) {
                let newRef = referrer.referrals + 1;
                let addDays = (newRef >= 400) ? 365 : (newRef >= 30) ? 30 : (newRef >= 7) ? 7 : 1;
                let premUntil = addDays > 0 ? Date.now() + (addDays * 24 * 60 * 60 * 1000) : referrer.premium_until;
                db.run("UPDATE users SET referrals = ?, premium_until = ? WHERE id = ?", [newRef, premUntil, refId]);
                sendBotMessage(refId, `🎉 Kamu mendapatkan refferal baru! Total refferal: ${newRef}`);
            }
        }
        if (user.state === 'chatting') return sendBotMessage(chatId, "⚠️ Kamu sedang mengobrol. Ketik /stop atau /next.");
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
        const sisaHari = isPremium ? Math.ceil((user.premium_until - Date.now()) / (1000 * 60 * 60 * 24)) : 0;
        
        let refs = user.referrals;
        let currentLvl = 0, levelDays = 0, target = 1, nextLvl = 1;
        
        if (refs >= 400) { currentLvl = 400; levelDays = 365; target = "Max"; }
        else if (refs >= 30) { currentLvl = 30; levelDays = 30; nextLvl = 400; target = 400 - refs; }
        else if (refs >= 7) { currentLvl = 7; levelDays = 7; nextLvl = 30; target = 30 - refs; }
        else if (refs >= 1) { currentLvl = 1; levelDays = 1; nextLvl = 7; target = 7 - refs; }
        else { currentLvl = 0; levelDays = 0; nextLvl = 1; target = 1 - refs; }

        const statMsg = `🌟 <b>KEGUNAAN REFERRAL (PREMIUM):</b>
Akun Premium bebas mengirim tanda baca (@, ., ,, !) serta tautan (link) tanpa harus melewati Verifikasi Keamanan Anti-Spam (Captcha Matematika).

🏆 <b>ATURAN & BONUS:</b>
• 1 Referral = Premium 1 Hari
• 7 Referral = Premium 7 Hari
• 30 Referral = Premium 30 Hari
• 400 Referral = Premium 1 Tahun

📊 <b>STATUS KAMU SAAT INI:</b>
Total Referral: <b>${refs}</b>
Pencapaian: <b>${currentLvl > 0 ? `Level ${currentLvl} (Bonus Premium ${levelDays} Hari)` : 'Belum ada level'}</b>
Kekurangan: <b>${target !== "Max" ? `Butuh ${target} referral lagi untuk level ${nextLvl}` : 'Level Maksimal'}</b>

⏳ <b>STATUS PREMIUM:</b> ${isPremium ? `Aktif ✅ (Sisa ${sisaHari} Hari)` : 'Tidak Aktif ❌'}

🔗 <b>TAUTAN UNDANGAN KAMU:</b>
<i>(Klik teks link di bawah untuk otomatis menyalin)</i>

<code>${refLink}</code>`;
        
        return sendBotMessage(chatId, statMsg);
    }

    if (text === '/ripport') {
        if (!msg.reply_to_message) return sendBotMessage(chatId, "⚠️Wajib Reply Pesan User yang ingin di-report.");
        const reportedMsgId = msg.reply_to_message.message_id;
        const suspectId = await getSenderFromCache(reportedMsgId);
        if (!suspectId) return sendBotMessage(chatId, "❌ Pesan ini tidak dapat dilaporkan.");

        bot.sendMessage(LOGS_GROUP, `⚠️ <b>LAPORAN PENGGUNA</b>\n\nPelapor: <code>${chatId}</code>\nTersangka: <code>${suspectId}</code>\nPesan: ${msg.reply_to_message.text || "Media/Stiker"}`, {
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: [[{ text: "✅ Acc", callback_data: `acc_${suspectId}` }, { text: "❌ Reject", callback_data: `rej_${suspectId}` }]] }
        });
        return sendBotMessage(chatId, "✅ Laporan berhasil dikirim ke Admin.");
    }

    // ==========================================
    // SISTEM PENGIRIMAN PESAN & VERIFIKASI (CAPTCHA)
    // ==========================================
    if (user.state === 'chatting' && user.partner_id) {
        const isPremium = user.premium_until > Date.now();
        
        // Regex untuk mendeteksi tanda baca khusus, link, dan .com/.id dsb
        const spamRegex = /[@.,!]|https?:\/\/|t\.me|\.com|\.id|\.net|\.org/i;
        
        if (!isPremium && text && spamRegex.test(text)) {
            const captcha = generateCaptcha();
            const opts = {
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard:[[ { text: "1", callback_data: "cpt_1", style: "primary" }, { text: "2", callback_data: "cpt_2", style: "primary" }, { text: "3", callback_data: "cpt_3", style: "primary" }, { text: "4", callback_data: "cpt_4", style: "primary" }, { text: "5", callback_data: "cpt_5", style: "primary" } ],[ { text: "6", callback_data: "cpt_6", style: "primary" }, { text: "7", callback_data: "cpt_7", style: "primary" }, { text: "8", callback_data: "cpt_8", style: "primary" }, { text: "9", callback_data: "cpt_9", style: "primary" }, { text: "10", callback_data: "cpt_10", style: "primary" } ]
                    ]
                }
            };
            
            // Kirim pesan Captcha dan jangan teruskan pesan ke partner dulu
            let sentCaptcha = await bot.sendMessage(chatId, `⚠️ <b>Sistem Anti-Spam Aktif</b>\nPesan Anda mengandung Tanda Khusus/Tautan. Silakan jawab pertanyaan matematika berikut untuk mengirim:\n\n<b>${captcha.question}</b>`, opts);
            
            // Simpan data pesan di memori agar bisa diteruskan jika jawaban benar
            pendingCaptchas.set(sentCaptcha.message_id, {
                correctAnswer: captcha.result,
                partnerId: user.partner_id,
                senderId: chatId,
                text: text
            });

            // Otomatis hapus sesi captcha jika 5 menit tidak dijawab
            setTimeout(() => { pendingCaptchas.delete(sentCaptcha.message_id); }, 300000);
            return; 
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
// CALLBACK QUERY (TOMBOL CAPTCHA & ADMIN)
// ==========================================
bot.on('callback_query', async (query) => {
    const data = query.data;
    const queryChatId = query.message.chat.id;
    const msgId = query.message.message_id;

    // ----- LOGIKA JAWABAN CAPTCHA -----
    if (data.startsWith('cpt_')) {
        const answer = data.split('_')[1];
        const captchaData = pendingCaptchas.get(msgId);
        
        if (!captchaData) return; // Abaikan jika user spam klik tombol yang sudah kadaluarsa

        if (answer === captchaData.correctAnswer) {
            // Jawaban Benar
            await bot.editMessageText("✅Pesan Berhasil Dikirim.", { chat_id: queryChatId, message_id: msgId });
            
            // Lanjutkan mengirim pesan yang sempat ditahan
            try {
                bot.sendChatAction(captchaData.partnerId, 'typing');
                let sentMsg = await bot.sendMessage(captchaData.partnerId, captchaData.text);
                addMessageCache(sentMsg.message_id, captchaData.senderId);
            } catch (e) {} 
            
            pendingCaptchas.delete(msgId);
        } else {
            // Jawaban Salah
            await bot.editMessageText("❌Jawaban Salah Coba Lagi...", { chat_id: queryChatId, message_id: msgId });
            pendingCaptchas.delete(msgId);
        }
        return;
    }

    // ----- LOGIKA ADMIN LOGS -----
    if (data.startsWith('acc_') || data.startsWith('rej_')) {
        const suspectId = data.split('_')[1];
        if (data.startsWith('rej_')) return bot.editMessageText(query.message.text + "\n\n❌ Laporan di Reject.", { chat_id: queryChatId, message_id: msgId });

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
                bot.editMessageText(query.message.text + `\n\n✅ Laporan di ACC. User dibanned selama ${banDuration / 86400000} hari.`, { chat_id: queryChatId, message_id: msgId });
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
