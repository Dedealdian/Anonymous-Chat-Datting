require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const sqlite3 = require('sqlite3').verbose();
const cron = require('node-cron');
const { exec } = require('child_process');

const token = process.env.BOT_TOKEN.trim();
const OWNER_ID = Number(process.env.OWNER_ID.trim());
const LOGS_GROUP = process.env.LOGS_GROUP.trim();
const CHANNEL_LINK = process.env.CHANNEL_LINK.trim();
const CHANNEL_IKLAN = process.env.CHANNEL_IKLAN.trim();

// Koneksi stabil IPv4
const bot = new TelegramBot(token, { 
    polling: true,
    request: { agentOptions: { family: 4 } } 
});

bot.on('polling_error', () => {}); 

// ==========================================
// SET COMMANDS OTOMATIS
// ==========================================
bot.setMyCommands([
    { command: '/start', description: 'Mulai menggunakan bot / Cari Pasangan' },
    { command: '/search', description: 'Cari atau lewati pasangan obrolan' },
    { command: '/next', description: 'Lewati obrolan & cari yang baru' },
    { command: '/stop', description: 'Hentikan obrolan saat ini' },
    { command: '/refer', description: 'Dapatkan Premium & Link Undangan' },
    { command: '/stats', description: 'Cek statistik pengguna bot' },
    { command: '/help', description: 'Bantuan cara menggunakan bot' },
    { command: '/ripport', description: 'Laporkan pelanggaran (Wajib balas pesan)' }
]);

// ==========================================
// INISIALISASI DATABASE
// ==========================================
const db = new sqlite3.Database('./bot.db');
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY, state TEXT DEFAULT 'idle', partner_id INTEGER, 
        warnings INTEGER DEFAULT 0, ban_until INTEGER DEFAULT 0, referrals INTEGER DEFAULT 0, premium_until INTEGER DEFAULT 0,
        gender TEXT DEFAULT NULL, age TEXT DEFAULT NULL
    )`);
    // Pembaruan aman: Tambah kolom gender & age jika database sudah terlanjur dibuat versi lama
    db.run(`ALTER TABLE users ADD COLUMN gender TEXT`, (err) => {});
    db.run(`ALTER TABLE users ADD COLUMN age TEXT`, (err) => {});
    
    db.run(`CREATE TABLE IF NOT EXISTS messages (message_id INTEGER PRIMARY KEY, sender_id INTEGER)`);
});

const pendingCaptchas = new Map();

const getUser = (id) => new Promise((resolve) => db.get("SELECT * FROM users WHERE id = ?",[id], (err, row) => resolve(row)));
const updateState = (id, state, partner = null) => new Promise((resolve) => db.run(`UPDATE users SET state = ?, partner_id = ? WHERE id = ?`, [state, partner, id], resolve));
const addMessageCache = (msgId, senderId) => db.run("INSERT OR REPLACE INTO messages (message_id, sender_id) VALUES (?, ?)",[msgId, senderId]);
const getSenderFromCache = (msgId) => new Promise((resolve) => db.get("SELECT sender_id FROM messages WHERE message_id = ?", [msgId], (err, row) => resolve(row ? row.sender_id : null)));

async function isMemberJoined(userId) {
    try {
        const chatMember = await bot.getChatMember(CHANNEL_IKLAN, userId);
        return ['member', 'administrator', 'creator'].includes(chatMember.status);
    } catch (e) { return false; }
}

// ==========================================
// FUNGSI PESAN SISTEM (DENGAN IKLAN)
// ==========================================
async function sendBotMessage(userId, textMsg, customKeyboard = null) {
    let isMember = await isMemberJoined(userId);
    let promoText = isMember ? "" : `\n\n<i>Ikuti saluran kami agar kamu tidak mendapatkan text promosi.</i>`;
    
    let inline_keyboard = customKeyboard ? [...customKeyboard] :[];
    
    if (!isMember) {
        inline_keyboard.push([{ text: "🚪Joint", url: CHANNEL_LINK, style: "success" }]);
    }

    let opts = { 
        parse_mode: 'HTML',
        reply_markup: inline_keyboard.length > 0 ? { inline_keyboard } : undefined
    };
    
    return bot.sendMessage(userId, textMsg + promoText, opts).catch(()=>{});
}

function generateCaptcha() {
    const type = Math.random() > 0.5 ? 2 : 3; 
    const result = Math.floor(Math.random() * 10) + 1; 
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

// ==========================================
// PROSES CARI & PASANGKAN
// ==========================================
async function findPartner(userId) {
    db.get("SELECT id FROM users WHERE state = 'searching' AND id != ? LIMIT 1",[userId], async (err, partner) => {
        if (partner) {
            await updateState(userId, 'chatting', partner.id);
            await updateState(partner.id, 'chatting', userId);
            
            const matchText = `Obrolan di temukan apa yang ingin anda katakan?🤔\n\n/next — cari pasangan baru\n/stop — stop berpasangan.\n/help — bantuan menggunakan bot`;
            sendBotMessage(userId, matchText);
            sendBotMessage(partner.id, matchText);
        } else {
            sendBotMessage(userId, "❌Pasangan Belum Di Temukan Gunakan /refer Agar Pasangan Cepat Di Temukan Dan Akunmu Menjadi Premium");
        }
    });
}

// Fungsi Trigger Pencarian
async function startSearch(chatId) {
    await updateState(chatId, 'searching');
    await sendBotMessage(chatId, "<i>🔎Sedang Mencari Pasangan...</i>");
    findPartner(chatId);
}

// ==========================================
// EVENT LISTENER PESAN MASUK
// ==========================================
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text || '';

    let user = await getUser(chatId);
    let isNewUser = false;
    
    if (!user) {
        db.run("INSERT INTO users (id) VALUES (?)",[chatId]);
        user = { id: chatId, state: 'idle', warnings: 0, ban_until: 0, referrals: 0, premium_until: 0, gender: null, age: null };
        isNewUser = true;
        
        // Lapor ke Logs Group
        bot.sendMessage(LOGS_GROUP, `🚀 <b>PENGGUNA BARU</b>\nID: <code>${chatId}</code> baru saja memulai bot!`, { parse_mode: 'HTML' }).catch(()=>{});
    }

    if (user.ban_until > Date.now()) return sendBotMessage(chatId, `❌ Anda sedang diblokir dari bot hingga:\n${new Date(user.ban_until).toLocaleString('id-ID')}`);

    if (text === '/stats') {
        db.get("SELECT COUNT(*) AS total FROM users", (err, rowTotal) => {
            db.get("SELECT COUNT(*) AS online FROM users WHERE state != 'idle'", (err, rowOnline) => {
                sendBotMessage(chatId, `📊 <b>Statistik Penggunaan Bot</b>\n\n👥 Total Pengguna: <b>${rowTotal ? rowTotal.total : 0} User</b>\n🟢 Sedang Online: <b>${rowOnline ? rowOnline.online : 0} User</b>\n\n<i>*Online = Sedang mencari / mengobrol</i>`);
            });
        });
        return;
    }

    if (text === '/help') {
        const helpText = `📚 <b>BANTUAN & CARA MENGGUNAKAN BOT</b>\n\n` +
        `Bot ini dirancang untuk menghubungkan Anda dengan orang asing secara anonim. Identitas Anda aman dan pesan Anda dienkripsi oleh sistem Telegram.\n\n` +
        `🛠 <b>DAFTAR PERINTAH UTAMA:</b>\n` +
        `🔹 /start - Mendaftarkan identitas (bagi pengguna baru) atau memulai mencari pasangan obrolan.\n` +
        `🔹 /search - Langsung melewati (skip) obrolan saat ini dan mencari teman baru.\n` +
        `🔹 /next - Berfungsi sama seperti /search.\n` +
        `🔹 /stop - Berhenti mencari atau mengakhiri obrolan saat ini dan kembali ke menu awal.\n\n` +
        `💎 <b>FITUR PREMIUM:</b>\n` +
        `🔹 /refer - Dapatkan tautan undangan Anda. Undang teman dan dapatkan <b>Premium Gratis</b> agar Anda bebas mengirim tanda baca dan Link tanpa dihalangi sistem Keamanan Anti-Spam (Matematika).\n\n` +
        `⚖️ <b>SISTEM LAPORAN:</b>\n` +
        `🔹 /ripport - Balas (Reply) chat yang melanggar/mengganggu, ketik /ripport. Admin akan menindak tegas pelanggar berupa blokir Permanen.\n\n` +
        `<i>Tips: Tetap jaga etika dalam mengobrol dan jangan membagikan data pribadi sembarangan!</i>`;
        
        return sendBotMessage(chatId, helpText);
    }

    // ==========================================
    // LOGIKA START & ONBOARDING IDENTITAS
    // ==========================================
    if (text.startsWith('/start')) {
        let refId = text.split(' ')[1];
        
        // Proses Referral jika user baru
        if (refId && refId != chatId && isNewUser) {
            let referrer = await getUser(refId);
            if (referrer) {
                let newRef = referrer.referrals + 1;
                let addDays = (newRef === 1) ? 1 : (newRef === 7) ? 7 : (newRef === 30) ? 30 : (newRef === 400) ? 365 : 0;
                if (addDays > 0) {
                    let premUntil = (referrer.premium_until > Date.now() ? referrer.premium_until : Date.now()) + (addDays * 24 * 60 * 60 * 1000);
                    db.run("UPDATE users SET referrals = ?, premium_until = ? WHERE id = ?",[newRef, premUntil, refId]);
                } else {
                    db.run("UPDATE users SET referrals = ? WHERE id = ?",[newRef, refId]);
                }
                sendBotMessage(refId, `🎉 Kamu mendapatkan refferal baru! Total refferal: ${newRef}`);
            }
        }

        // Cek Identitas
        if (!user.gender || !user.age) {
            return bot.sendMessage(chatId, "👩‍❤️‍💋‍👨Mengatur identitas anda sebagai pengguna", {
                reply_markup: { inline_keyboard: [[{ text: "Jenis Kelamin", callback_data: "set_gender", style: "primary" }]] }
            }).catch(()=>{});
        }

        // Jika sudah punya identitas
        if (user.state === 'chatting') return sendBotMessage(chatId, "⚠️ Kamu sedang mengobrol. Ketik /stop atau /next.");
        return startSearch(chatId);
    }

    // ==========================================
    // LOGIKA NEXT & SEARCH
    // ==========================================
    if (text === '/next' || text === '/search') {
        if (user.state === 'chatting' && user.partner_id) {
            sendBotMessage(user.partner_id, "❌Pasangan Melewatkan Obrolan Ini.");
            await updateState(user.partner_id, 'idle');
        }
        await sendBotMessage(chatId, "✅Kamu Melewatkan Obrolan Ini.");
        bot.sendChatAction(chatId, 'typing').catch(()=>{}); 
        return startSearch(chatId);
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

        return sendBotMessage(chatId, `🌟 <b>KEGUNAAN REFERRAL (PREMIUM):</b>
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

<code>${refLink}</code>`);
    }

    if (text === '/ripport') {
        if (!msg.reply_to_message) return sendBotMessage(chatId, "⚠️Wajib Reply Pesan User yang ingin di-report.");
        const reportedMsgId = msg.reply_to_message.message_id;
        const suspectId = await getSenderFromCache(reportedMsgId);
        if (!suspectId) return sendBotMessage(chatId, "❌ Pesan ini tidak dapat dilaporkan.");

        bot.sendMessage(OWNER_ID, `⚠️ <b>LAPORAN PENGGUNA</b>\n\nPelapor: <code>${chatId}</code>\nTersangka: <code>${suspectId}</code>\nPesan: ${msg.reply_to_message.text || "Media/Stiker"}`, {
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: [[
                { text: "✅ Acc", callback_data: `acc_${suspectId}`, style: "success" }, 
                { text: "❌ Reject", callback_data: `rej_${suspectId}`, style: "danger" }
            ]] }
        }).then(() => {
            sendBotMessage(chatId, "✅ Laporan berhasil dikirim secara rahasia ke Admin.");
        }).catch((err) => {
            bot.sendMessage(LOGS_GROUP, `⚠️ <b>ERROR REPORT:</b> Gagal mengirim laporan /ripport ke PM Owner. Pastikan Owner sudah mengetik /start di bot secara langsung!`).catch(()=>{});
            sendBotMessage(chatId, "❌ Gagal mengirim laporan ke Admin.");
        });
        return;
    }

    // ==========================================
    // SISTEM PENGIRIMAN PESAN & CAPTCHA ANTI-SPAM
    // ==========================================
    if (user.state === 'chatting' && user.partner_id) {
        const isPremium = user.premium_until > Date.now();
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
            
            let sentCaptcha = await bot.sendMessage(chatId, `⚠️ <b>Sistem Anti-Spam Aktif</b>\nPesan Anda mengandung Tanda Khusus/Tautan. Silakan jawab pertanyaan matematika berikut untuk mengirim:\n\n<b>${captcha.question}</b>`, opts);
            pendingCaptchas.set(sentCaptcha.message_id, { correctAnswer: captcha.result, partnerId: user.partner_id, senderId: chatId, text: text });
            setTimeout(() => pendingCaptchas.delete(sentCaptcha.message_id), 300000);
            return; 
        }
        
        try {
            if (text) bot.sendChatAction(user.partner_id, 'typing').catch(()=>{});
            else if (msg.photo) bot.sendChatAction(user.partner_id, 'upload_photo').catch(()=>{});
            else if (msg.voice) bot.sendChatAction(user.partner_id, 'record_voice').catch(()=>{});

            let sentMsg;
            if (text) sentMsg = await bot.sendMessage(user.partner_id, text);
            else sentMsg = await bot.copyMessage(user.partner_id, chatId, msg.message_id);
            addMessageCache(sentMsg.message_id, chatId);
        } catch (e) {
            await updateState(chatId, 'idle');
            sendBotMessage(chatId, "❌ Gagal mengirim pesan. Obrolan dihentikan (Mungkin partner memblokir bot).");
        }
    }
});

// ==========================================
// CALLBACK QUERY (TOMBOL INLINE)
// ==========================================
bot.on('callback_query', async (query) => {
    const data = query.data;
    const queryChatId = query.message.chat.id;
    const msgId = query.message.message_id;

    // --- LOGIKA ONBOARDING START ---
    if (data === 'set_gender') {
        return bot.editMessageText("Atur Jenis Kelamin Kamu", {
            chat_id: queryChatId, message_id: msgId,
            reply_markup: { inline_keyboard: [[
                { text: "♂️Pria", callback_data: "gender_Pria", style: "primary" },
                { text: "♀️Wanita", callback_data: "gender_Wanita", style: "danger" }
            ]]}
        }).catch(()=>{});
    }

    if (data.startsWith('gender_')) {
        let gender = data.split('_')[1];
        db.run("UPDATE users SET gender = ? WHERE id = ?", [gender, queryChatId]);
        
        let ageKeyboard = [[
                { text: "16", callback_data: "age_16", style: "danger" },
                { text: "17", callback_data: "age_17", style: "success" },
                { text: "18", callback_data: "age_18", style: "danger" },
                { text: "19", callback_data: "age_19", style: "success" }
            ],[
                { text: "20", callback_data: "age_20", style: "success" },
                { text: "21", callback_data: "age_21", style: "danger" },
                { text: "22", callback_data: "age_22", style: "success" },
                { text: "23+", callback_data: "age_23+", style: "danger" }
            ]
        ];
        
        return bot.editMessageText("Masukan Usia Kamu", {
            chat_id: queryChatId, message_id: msgId,
            reply_markup: { inline_keyboard: ageKeyboard }
        }).catch(()=>{});
    }

    if (data.startsWith('age_')) {
        let age = data.split('_')[1];
        db.run("UPDATE users SET age = ? WHERE id = ?", [age, queryChatId]);
        
        await bot.editMessageText("✅ Identitas berhasil disimpan!", { chat_id: queryChatId, message_id: msgId }).catch(()=>{});
        return startSearch(queryChatId);
    }

    // --- LOGIKA JAWABAN CAPTCHA ---
    if (data.startsWith('cpt_')) {
        const answer = data.split('_')[1];
        const captchaData = pendingCaptchas.get(msgId);
        if (!captchaData) return; 

        if (answer === captchaData.correctAnswer) {
            await bot.editMessageText("✅Pesan Berhasil Dikirim.", { chat_id: queryChatId, message_id: msgId }).catch(()=>{});
            try {
                bot.sendChatAction(captchaData.partnerId, 'typing').catch(()=>{});
                let sentMsg = await bot.sendMessage(captchaData.partnerId, captchaData.text);
                addMessageCache(sentMsg.message_id, captchaData.senderId);
            } catch (e) {} 
            pendingCaptchas.delete(msgId);
        } else {
            await bot.editMessageText("❌Jawaban Salah Coba Lagi...", { chat_id: queryChatId, message_id: msgId }).catch(()=>{});
            pendingCaptchas.delete(msgId);
        }
        return;
    }

    // --- LOGIKA TOMBOL ADMIN RIPPORT ---
    if (data.startsWith('acc_') || data.startsWith('rej_')) {
        const suspectId = data.split('_')[1];
        if (data.startsWith('rej_')) return bot.editMessageText(query.message.text + "\n\n❌ Laporan di Reject.", { chat_id: queryChatId, message_id: msgId }).catch(()=>{});

        if (data.startsWith('acc_')) {
            let suspect = await getUser(suspectId);
            if (suspect) {
                let newWarnings = suspect.warnings + 1;
                let banDuration = (newWarnings === 1) ? 86400000 : (newWarnings === 2) ? 604800000 : (newWarnings === 3) ? 2592000000 : 31536000000; 
                let banUntil = Date.now() + banDuration;
                db.run("UPDATE users SET warnings = ?, ban_until = ?, state = 'idle' WHERE id = ?",[newWarnings, banUntil, suspectId]);
                
                if (suspect.state === 'chatting' && suspect.partner_id) {
                    await updateState(suspect.partner_id, 'idle');
                    sendBotMessage(suspect.partner_id, "❌ Pasanganmu baru saja diblokir oleh Admin.");
                }
                sendBotMessage(suspectId, `⚠️ Anda telah diblokir oleh Admin karena pelanggaran selama ${banDuration / 86400000} hari.`);
                bot.editMessageText(query.message.text + `\n\n✅ Laporan di ACC. User dibanned selama ${banDuration / 86400000} hari.`, { chat_id: queryChatId, message_id: msgId }).catch(()=>{});
            }
        }
    }
});

// ==========================================
// CRON JOB & GITHUB PUSH
// ==========================================
cron.schedule('0 0 * * *', () => {
    db.run("DELETE FROM messages");
    exec('git add bot.db && git commit -m "Auto backup database harian" && git push origin main', (error) => {
        if (!error) bot.sendMessage(LOGS_GROUP, "✅ Berhasil melakukan backup database otomatis ke Github.").catch(()=>{});
    });
});

console.log("Bot Anonim Berjalan dan Terhubung dengan Database...");
