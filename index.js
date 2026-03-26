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
    { command: '/start', description: 'Mulai / Cari Pasangan (Find Partner)' },
    { command: '/search', description: 'Lewati obrolan & cari baru (Skip)' },
    { command: '/next', description: 'Lewati obrolan & cari baru (Skip)' },
    { command: '/search_pria', description: 'Cari Pria / Find Male (Premium)' },
    { command: '/search_wanita', description: 'Cari Wanita / Find Female (Premium)' },
    { command: '/stop', description: 'Hentikan obrolan (Stop chatting)' },
    { command: '/settings', description: 'Pengaturan Bahasa (Language)' },
    { command: '/refer', description: 'Dapatkan Premium (Get Premium)' },
    { command: '/stats', description: 'Statistik Bot (Bot Stats)' },
    { command: '/help', description: 'Bantuan (Help)' },
    { command: '/ripport', description: 'Laporkan pelanggaran (Report)' }
]);

// ==========================================
// INISIALISASI DATABASE & MIGRASI
// ==========================================
const db = new sqlite3.Database('./bot.db');
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY, state TEXT DEFAULT 'idle', partner_id INTEGER, 
        warnings INTEGER DEFAULT 0, ban_until INTEGER DEFAULT 0, referrals INTEGER DEFAULT 0, premium_until INTEGER DEFAULT 0,
        gender TEXT DEFAULT NULL, age TEXT DEFAULT NULL, lang TEXT DEFAULT 'id'
    )`);
    db.run(`ALTER TABLE users ADD COLUMN gender TEXT`, () => {});
    db.run(`ALTER TABLE users ADD COLUMN age TEXT`, () => {});
    db.run(`ALTER TABLE users ADD COLUMN lang TEXT DEFAULT 'id'`, () => {});
    db.run(`CREATE TABLE IF NOT EXISTS messages (message_id INTEGER PRIMARY KEY, sender_id INTEGER)`);
});

const pendingCaptchas = new Map();

const getUser = (id) => new Promise((resolve) => db.get("SELECT * FROM users WHERE id = ?",[id], (err, row) => resolve(row)));
const updateState = (id, state, partner = null) => new Promise((resolve) => db.run(`UPDATE users SET state = ?, partner_id = ? WHERE id = ?`,[state, partner, id], resolve));
const addMessageCache = (msgId, senderId) => db.run("INSERT OR REPLACE INTO messages (message_id, sender_id) VALUES (?, ?)",[msgId, senderId]);
const getSenderFromCache = (msgId) => new Promise((resolve) => db.get("SELECT sender_id FROM messages WHERE message_id = ?", [msgId], (err, row) => resolve(row ? row.sender_id : null)));

async function isMemberJoined(userId) {
    try {
        const chatMember = await bot.getChatMember(CHANNEL_IKLAN, userId);
        return['member', 'administrator', 'creator'].includes(chatMember.status);
    } catch (e) { return false; }
}

// ==========================================
// KAMUS BAHASA (BILINGUAL)
// ==========================================
const dict = {
    id: {
        promo: "\n\n<i>Ikuti saluran kami agar kamu tidak mendapatkan text promosi.</i>",
        join_btn: "🚪Joint",
        banned: "❌ Anda sedang diblokir dari bot hingga:\n{date}",
        stats: "📊 <b>Statistik Penggunaan Bot</b>\n\n👥 Total Pengguna: <b>{total} User</b>\n🟢 Sedang Online: <b>{online} User</b>\n\n<i>*Online = Sedang mencari / mengobrol</i>",
        refer_new: "🎉 Kamu mendapatkan refferal baru! Total refferal: {ref}",
        setup_gender: "👩‍❤️‍💋‍👨Mengatur identitas anda sebagai pengguna",
        already_chatting: "⚠️ Kamu sedang mengobrol. Ketik /stop atau /next.",
        skipped_self: "✅Kamu Melewatkan Obrolan Ini.",
        skipped_partner: "❌Pasangan Melewatkan Obrolan Ini.",
        searching: "<i>🔎Sedang Mencari Pasangan...</i>",
        stop_self: "🔴Mencari Pasangan Di Stop",
        stop_partner: "🔴Pasangan Menghentikan Obrolan.",
        not_in_chat: "⚠️ Kamu belum berada di dalam obrolan.\n\nSilakan klik /start untuk mulai mencari pasangan.",
        found: "Obrolan di temukan apa yang ingin anda katakan?🤔\n\n/next — cari pasangan baru\n/stop — stop berpasangan.\n/help — bantuan bot",
        not_found: "❌Pasangan Belum Di Temukan Gunakan /refer Agar Pasangan Cepat Di Temukan Dan Akunmu Menjadi Premium",
        premium_needed: "👑 <b>Fitur Khusus Premium!</b>\nGunakan /refer untuk mengundang teman agar kamu bisa mencari pasangan khusus Pria/Wanita.",
        settings: "⚙️ Pengaturan Akun Kamu\nSilakan pilih bahasa:",
        lang_ok: "✅ Bahasa berhasil diubah ke Indonesia!",
        cap_warn: "⚠️ <b>Sistem Anti-Spam Aktif</b>\nPesan Anda mengandung Tanda Khusus/Tautan. Silakan jawab pertanyaan matematika berikut:\n\n<b>{q}</b>",
        cap_ok: "✅Pesan Berhasil Dikirim.",
        cap_fail: "❌Jawaban Salah Coba Lagi...",
        rep_warn: "⚠️Wajib Reply Pesan User yang ingin di-report.",
        rep_inv: "❌ Pesan ini tidak dapat dilaporkan.",
        rep_ok: "✅ Laporan berhasil dikirim secara rahasia ke Admin.",
        rep_fail: "❌ Gagal mengirim laporan ke Admin.",
        help: `📚 <b>BANTUAN & CARA PENGGUNAAN</b>\n\nBot ini menghubungkan Anda dengan orang asing secara anonim. Identitas Anda 100% aman.\n\n🛠 <b>PERINTAH UTAMA:</b>\n🔹 /start - Mendaftarkan identitas & mencari pasangan.\n🔹 /search atau /next - Lewati obrolan & cari teman baru.\n🔹 /stop - Hentikan obrolan saat ini.\n🔹 /settings - Mengubah Bahasa (Language).\n\n💎 <b>FITUR SUPER PREMIUM:</b>\n🔹 /search_pria - Hanya mencari lawan jenis Pria.\n🔹 /search_wanita - Hanya mencari lawan jenis Wanita.\n<i>(Gunakan /refer untuk mengundang teman dan dapatkan Premium Gratis!)</i>\n\n⚖️ <b>SISTEM LAPORAN:</b>\n🔹 /ripport - Balas (Reply) chat yang melanggar/mengganggu, ketik /ripport. Admin akan menindak tegas pelanggar.`
    },
    en: {
        promo: "\n\n<i>Follow our channel to remove this promo text.</i>",
        join_btn: "🚪Join",
        banned: "❌ You are banned from the bot until:\n{date}",
        stats: "📊 <b>Bot Usage Statistics</b>\n\n👥 Total Users: <b>{total} Users</b>\n🟢 Online: <b>{online} Users</b>\n\n<i>*Online = Searching / Chatting</i>",
        refer_new: "🎉 You got a new referral! Total referrals: {ref}",
        setup_gender: "👩‍❤️‍💋‍👨Set up your identity to start",
        already_chatting: "⚠️ You are chatting. Type /stop or /next.",
        skipped_self: "✅You skipped this chat.",
        skipped_partner: "❌Partner skipped this chat.",
        searching: "<i>🔎Searching for a partner...</i>",
        stop_self: "🔴Search Stopped",
        stop_partner: "🔴Partner stopped the chat.",
        not_in_chat: "⚠️ You are not in a chat.\n\nClick /start to find a partner.",
        found: "Chat found! What do you want to say?🤔\n\n/next — find new partner\n/stop — stop chatting.\n/help — help & info",
        not_found: "❌Partner not found. Use /refer to find partners faster and get Premium!",
        premium_needed: "👑 <b>Premium Feature!</b>\nUse /refer to invite friends and get Premium to search specifically for Males or Females.",
        settings: "⚙️ Your Account Settings\nPlease select a language:",
        lang_ok: "✅ Language successfully changed to English!",
        cap_warn: "⚠️ <b>Anti-Spam Active</b>\nMessage contains links/special chars. Answer this math question:\n\n<b>{q}</b>",
        cap_ok: "✅Message sent successfully.",
        cap_fail: "❌Wrong answer, try again...",
        rep_warn: "⚠️You must reply to the user's message to report.",
        rep_inv: "❌ This message cannot be reported.",
        rep_ok: "✅ Report sent securely to Admin.",
        rep_fail: "❌ Failed to send report.",
        help: `📚 <b>HELP & HOW TO USE</b>\n\nThis bot connects you with strangers anonymously. Your identity is 100% safe.\n\n🛠 <b>MAIN COMMANDS:</b>\n🔹 /start - Set identity & find a partner.\n🔹 /search or /next - Skip chat & find someone new.\n🔹 /stop - Stop current chat.\n🔹 /settings - Change Language.\n\n💎 <b>SUPER PREMIUM FEATURES:</b>\n🔹 /search_pria - Search for Males only.\n🔹 /search_wanita - Search for Females only.\n<i>(Use /refer to invite friends and unlock Premium for Free!)</i>\n\n⚖️ <b>REPORT SYSTEM:</b>\n🔹 /ripport - Reply to an abusive message and type /ripport. Admins will permanently ban the offender.`
    }
};

function t(lang, key, vars = {}) {
    let text = dict[lang] && dict[lang][key] ? dict[lang][key] : dict['id'][key];
    if (!text) return "";
    for (const[k, v] of Object.entries(vars)) text = text.replace(new RegExp(`{${k}}`, 'g'), v);
    return text;
}

async function sendBotMessage(userId, lang, textMsg, customKeyboard = null) {
    let isMember = await isMemberJoined(userId);
    let promoText = isMember ? "" : t(lang, 'promo');
    
    let inline_keyboard = customKeyboard ? [...customKeyboard] :[];
    if (!isMember) inline_keyboard.push([{ text: t(lang, 'join_btn'), url: CHANNEL_LINK, style: "success" }]);

    let opts = { parse_mode: 'HTML', reply_markup: inline_keyboard.length > 0 ? { inline_keyboard } : undefined };
    return bot.sendMessage(userId, textMsg + promoText, opts).catch(()=>{});
}

function generateCaptcha() {
    const type = Math.random() > 0.5 ? 2 : 3; 
    const result = Math.floor(Math.random() * 10) + 1; 
    let question = type === 2 ? `${result + Math.floor(Math.random()*10)+1} - ${Math.floor(Math.random()*10)+1} = ?` 
                              : `${(result - Math.floor(Math.random()*result)) + Math.floor(Math.random()*10)+1} - ${Math.floor(Math.random()*10)+1} + ${Math.floor(Math.random()*result)} = ?`;
    return { question, result: result.toString() };
}

async function findPartner(userId, myGender, myLang, targetGender = null) {
    db.all("SELECT * FROM users WHERE state LIKE 'searching%' AND id != ? LIMIT 50", [userId], async (err, rows) => {
        let partner = rows.find(row => {
            let theirTarget = row.state === 'searching_Pria' ? 'Pria' : (row.state === 'searching_Wanita' ? 'Wanita' : null);
            let matchesMyTarget = !targetGender || row.gender === targetGender;
            let matchesTheirTarget = !theirTarget || myGender === theirTarget;
            return matchesMyTarget && matchesTheirTarget;
        });

        if (partner) {
            await updateState(userId, 'chatting', partner.id);
            await updateState(partner.id, 'chatting', userId);
            sendBotMessage(userId, myLang, t(myLang, 'found'));
            sendBotMessage(partner.id, partner.lang, t(partner.lang, 'found'));
        } else {
            sendBotMessage(userId, myLang, t(myLang, 'not_found'));
        }
    });
}

async function startSearch(user, targetGender = null) {
    let searchState = targetGender ? `searching_${targetGender}` : 'searching';
    await updateState(user.id, searchState);
    await sendBotMessage(user.id, user.lang, t(user.lang, 'searching'));
    findPartner(user.id, user.gender, user.lang, targetGender);
}

// ==========================================
// EVENT LISTENER PESAN MASUK
// ==========================================
bot.on('message', async (msg) => {
    if (msg.chat.type !== 'private') return; // ANTI GRUP SPAM

    const chatId = msg.chat.id;
    const text = msg.text || '';

    let user = await getUser(chatId);
    let isNewUser = false;
    
    if (!user) {
        db.run("INSERT INTO users (id) VALUES (?)",[chatId]);
        user = { id: chatId, state: 'idle', warnings: 0, ban_until: 0, referrals: 0, premium_until: 0, gender: null, age: null, lang: 'id' };
        isNewUser = true;
        bot.sendMessage(LOGS_GROUP, `🚀 <b>PENGGUNA BARU</b>\nID: <code>${chatId}</code> baru saja memulai bot!`, { parse_mode: 'HTML' }).catch(()=>{});
    }
    const L = user.lang;

    if (user.ban_until > Date.now()) return sendBotMessage(chatId, L, t(L, 'banned', {date: new Date(user.ban_until).toLocaleString('id-ID')}));

    if (text === '/settings') {
        return sendBotMessage(chatId, L, t(L, 'settings'), [[
            { text: "🇮🇩 Indonesia", callback_data: "lang_id", style: "primary" },
            { text: "🇬🇧 English", callback_data: "lang_en", style: "danger" }
        ]]);
    }

    if (text === '/stats') {
        db.get("SELECT COUNT(*) AS total FROM users", (err, rowTotal) => {
            db.get("SELECT COUNT(*) AS online FROM users WHERE state != 'idle'", (err, rowOnline) => {
                sendBotMessage(chatId, L, t(L, 'stats', {total: rowTotal?.total||0, online: rowOnline?.online||0}));
            });
        });
        return;
    }

    if (text === '/help') return sendBotMessage(chatId, L, t(L, 'help'));

    if (text.startsWith('/start')) {
        let refId = text.split(' ')[1];
        if (refId && refId != chatId && isNewUser) {
            let referrer = await getUser(refId);
            if (referrer) {
                let newRef = referrer.referrals + 1;
                let addDays = (newRef === 1) ? 1 : (newRef === 7) ? 7 : (newRef === 30) ? 30 : (newRef >= 400) ? 365 : 0;
                if (addDays > 0) {
                    let premUntil = (referrer.premium_until > Date.now() ? referrer.premium_until : Date.now()) + (addDays * 24 * 60 * 60 * 1000);
                    db.run("UPDATE users SET referrals = ?, premium_until = ? WHERE id = ?",[newRef, premUntil, refId]);
                } else {
                    db.run("UPDATE users SET referrals = ? WHERE id = ?",[newRef, refId]);
                }
                sendBotMessage(refId, referrer.lang, t(referrer.lang, 'refer_new', {ref: newRef}));
            }
        }

        if (!user.gender || !user.age) {
            return bot.sendMessage(chatId, t(L, 'setup_gender'), {
                reply_markup: { inline_keyboard: [[{ text: "Jenis Kelamin / Gender", callback_data: "set_gender", style: "primary" }]] }
            }).catch(()=>{});
        }
        if (user.state === 'chatting') return sendBotMessage(chatId, L, t(L, 'already_chatting'));
        return startSearch(user);
    }

    if (text === '/next' || text === '/search' || text === '/search_pria' || text === '/search_wanita') {
        const isPremium = user.premium_until > Date.now();
        let targetGender = null;
        
        if (text === '/search_pria') targetGender = 'Pria';
        if (text === '/search_wanita') targetGender = 'Wanita';

        if (targetGender && !isPremium) return sendBotMessage(chatId, L, t(L, 'premium_needed'));

        if (user.state === 'chatting' && user.partner_id) {
            let partner = await getUser(user.partner_id);
            sendBotMessage(user.partner_id, partner.lang, t(partner.lang, 'skipped_partner'));
            await updateState(user.partner_id, 'idle');
        }
        await sendBotMessage(chatId, L, t(L, 'skipped_self'));
        bot.sendChatAction(chatId, 'typing').catch(()=>{}); 
        return startSearch(user, targetGender);
    }

    if (text === '/stop') {
        if (user.state === 'chatting' && user.partner_id) {
            let partner = await getUser(user.partner_id);
            sendBotMessage(user.partner_id, partner.lang, t(partner.lang, 'stop_partner'));
            await updateState(user.partner_id, 'idle');
        }
        await updateState(chatId, 'idle');
        return sendBotMessage(chatId, L, t(L, 'stop_self'));
    }

    if (text === '/refer') {
        const botInfo = await bot.getMe();
        const refLink = `https://t.me/${botInfo.username}?start=${chatId}`;
        const isPremium = user.premium_until > Date.now();
        const sisaHari = isPremium ? Math.ceil((user.premium_until - Date.now()) / (1000 * 60 * 60 * 24)) : 0;
        let refs = user.referrals;
        let currentLvl = refs >= 400 ? 400 : refs >= 30 ? 30 : refs >= 7 ? 7 : refs >= 1 ? 1 : 0;
        let target = refs >= 400 ? "Max" : refs >= 30 ? 400 - refs : refs >= 7 ? 30 - refs : refs >= 1 ? 7 - refs : 1 - refs;
        let nextLvl = refs >= 400 ? "Max" : refs >= 30 ? 400 : refs >= 7 ? 30 : refs >= 1 ? 7 : 1;

        let langText = L === 'id' ? `🌟 <b>KEGUNAAN REFERRAL (PREMIUM):</b>\nBebas mengirim tanda baca (@, ., !) dan Tautan tanpa Captcha. Bisa mencari pasangan khusus Pria / Wanita (Gender Search).\n\n🏆 <b>ATURAN:</b> 1 Ref = 1 Hari | 7 Ref = 7 Hari | 30 Ref = 30 Hari | 400 Ref = 1 Tahun.\n\n📊 Total Referral: <b>${refs}</b>\nKekurangan: <b>${target !== "Max" ? `Butuh ${target} ref untuk level ${nextLvl}` : 'Level Maksimal'}</b>\n⏳ Premium: ${isPremium ? `Aktif ✅ (${sisaHari} Hari)` : 'Tidak Aktif ❌'}\n\n🔗 <b>LINK UNDANGAN:</b>\n<code>${refLink}</code>` 
        : `🌟 <b>PREMIUM BENEFITS:</b>\nSend links & symbols without Captcha. Unlock Gender Search (Male/Female).\n\n🏆 <b>RULES:</b> 1 Ref = 1 Day | 7 Ref = 7 Days | 30 Ref = 30 Days | 400 Ref = 1 Year.\n\n📊 Total Referrals: <b>${refs}</b>\nNeeded: <b>${target !== "Max" ? `Need ${target} ref for level ${nextLvl}` : 'Max Level'}</b>\n⏳ Premium: ${isPremium ? `Active ✅ (${sisaHari} Days)` : 'Inactive ❌'}\n\n🔗 <b>INVITE LINK:</b>\n<code>${refLink}</code>`;
        
        return sendBotMessage(chatId, L, langText);
    }

    if (text === '/ripport') {
        if (!msg.reply_to_message) return sendBotMessage(chatId, L, t(L, 'rep_warn'));
        const suspectId = await getSenderFromCache(msg.reply_to_message.message_id);
        if (!suspectId) return sendBotMessage(chatId, L, t(L, 'rep_inv'));

        bot.sendMessage(OWNER_ID, `⚠️ <b>LAPORAN PENGGUNA</b>\nPelapor: <code>${chatId}</code>\nTersangka: <code>${suspectId}</code>\nPesan: ${msg.reply_to_message.text || "Media/Stiker"}`, {
            parse_mode: 'HTML', reply_markup: { inline_keyboard: [[ { text: "✅ Acc", callback_data: `acc_${suspectId}`, style: "success" }, { text: "❌ Reject", callback_data: `rej_${suspectId}`, style: "danger" } ]] }
        }).then(() => sendBotMessage(chatId, L, t(L, 'rep_ok')))
          .catch(() => {
            bot.sendMessage(LOGS_GROUP, `⚠️ <b>ERROR:</b> Gagal kirim /ripport ke PM Owner. Pastikan Owner sudah /start di bot!`).catch(()=>{});
            sendBotMessage(chatId, L, t(L, 'rep_fail'));
        });
        return;
    }

    if (user.state === 'chatting' && user.partner_id) {
        const isPremium = user.premium_until > Date.now();
        const spamRegex = /[@.,!]|https?:\/\/|t\.me|\.com|\.id|\.net|\.org/i;
        
        if (!isPremium && text && spamRegex.test(text)) {
            const captcha = generateCaptcha();
            const opts = { parse_mode: 'HTML', reply_markup: { inline_keyboard:[[ { text: "1", callback_data: "cpt_1", style: "primary" }, { text: "2", callback_data: "cpt_2", style: "primary" }, { text: "3", callback_data: "cpt_3", style: "primary" }, { text: "4", callback_data: "cpt_4", style: "primary" }, { text: "5", callback_data: "cpt_5", style: "primary" } ],[ { text: "6", callback_data: "cpt_6", style: "primary" }, { text: "7", callback_data: "cpt_7", style: "primary" }, { text: "8", callback_data: "cpt_8", style: "primary" }, { text: "9", callback_data: "cpt_9", style: "primary" }, { text: "10", callback_data: "cpt_10", style: "primary" } ]
            ]}};
            let sentCaptcha = await bot.sendMessage(chatId, t(L, 'cap_warn', {q: captcha.question}), opts);
            pendingCaptchas.set(sentCaptcha.message_id, { correctAnswer: captcha.result, partnerId: user.partner_id, senderId: chatId, text: text });
            setTimeout(() => pendingCaptchas.delete(sentCaptcha.message_id), 300000);
            return; 
        }
        
        try {
            if (text) bot.sendChatAction(user.partner_id, 'typing').catch(()=>{});
            else if (msg.photo) bot.sendChatAction(user.partner_id, 'upload_photo').catch(()=>{});
            else if (msg.voice) bot.sendChatAction(user.partner_id, 'record_voice').catch(()=>{});

            let sentMsg = text ? await bot.sendMessage(user.partner_id, text) : await bot.copyMessage(user.partner_id, chatId, msg.message_id);
            addMessageCache(sentMsg.message_id, chatId);
        } catch (e) {
            await updateState(chatId, 'idle');
            sendBotMessage(chatId, L, t(L, 'stop_partner'));
        }
    } else if (!text.startsWith('/')) {
        return sendBotMessage(chatId, L, t(L, 'not_in_chat'));
    }
});

// ==========================================
// CALLBACK QUERY (TOMBOL INLINE)
// ==========================================
bot.on('callback_query', async (query) => {
    const data = query.data;
    const queryChatId = query.message.chat.id;
    const msgId = query.message.message_id;
    let user = await getUser(queryChatId);
    let L = user ? user.lang : 'id';

    if (data === 'lang_id' || data === 'lang_en') {
        let newLang = data === 'lang_id' ? 'id' : 'en';
        db.run("UPDATE users SET lang = ? WHERE id = ?",[newLang, queryChatId]);
        return bot.editMessageText(t(newLang, 'lang_ok'), { chat_id: queryChatId, message_id: msgId }).catch(()=>{});
    }

    if (data === 'set_gender') {
        return bot.editMessageText(t(L, 'setup_gender') || "Atur Jenis Kelamin", { chat_id: queryChatId, message_id: msgId, reply_markup: { inline_keyboard: [[ { text: "♂️Pria (Male)", callback_data: "gender_Pria", style: "primary" }, { text: "♀️Wanita (Female)", callback_data: "gender_Wanita", style: "danger" } ]]} }).catch(()=>{});
    }
    if (data.startsWith('gender_')) {
        db.run("UPDATE users SET gender = ? WHERE id = ?", [data.split('_')[1], queryChatId]);
        return bot.editMessageText("Masukan Usia Kamu / Enter Your Age", { chat_id: queryChatId, message_id: msgId, reply_markup: { inline_keyboard: [[ { text: "16", callback_data: "age_16", style: "danger" }, { text: "17", callback_data: "age_17", style: "success" }, { text: "18", callback_data: "age_18", style: "danger" }, { text: "19", callback_data: "age_19", style: "success" } ],[ { text: "20", callback_data: "age_20", style: "success" }, { text: "21", callback_data: "age_21", style: "danger" }, { text: "22", callback_data: "age_22", style: "success" }, { text: "23+", callback_data: "age_23+", style: "danger" } ]] } }).catch(()=>{});
    }
    if (data.startsWith('age_')) {
        db.run("UPDATE users SET age = ? WHERE id = ?",[data.split('_')[1], queryChatId]);
        user.gender = "Saved"; 
        await bot.editMessageText("✅ Identitas berhasil disimpan!", { chat_id: queryChatId, message_id: msgId }).catch(()=>{});
        return startSearch(user);
    }

    if (data.startsWith('cpt_')) {
        const answer = data.split('_')[1];
        const captchaData = pendingCaptchas.get(msgId);
        if (!captchaData) return; 

        if (answer === captchaData.correctAnswer) {
            await bot.editMessageText(t(L, 'cap_ok'), { chat_id: queryChatId, message_id: msgId }).catch(()=>{});
            try {
                bot.sendChatAction(captchaData.partnerId, 'typing').catch(()=>{});
                let sentMsg = await bot.sendMessage(captchaData.partnerId, captchaData.text);
                addMessageCache(sentMsg.message_id, captchaData.senderId);
            } catch (e) {} 
            pendingCaptchas.delete(msgId);
        } else {
            await bot.editMessageText(t(L, 'cap_fail'), { chat_id: queryChatId, message_id: msgId }).catch(()=>{});
            pendingCaptchas.delete(msgId);
        }
        return;
    }

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
                    let suspectPartner = await getUser(suspect.partner_id);
                    sendBotMessage(suspect.partner_id, suspectPartner.lang, t(suspectPartner.lang, 'stop_partner'));
                }
                sendBotMessage(suspectId, suspect.lang, t(suspect.lang, 'banned', {date: new Date(banUntil).toLocaleString('id-ID')}));
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

console.log("Bot Anonim Internasional Berjalan Sempurna...");
