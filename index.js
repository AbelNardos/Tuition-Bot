process.env.TZ = 'Africa/Addis_Ababa';
require('dotenv').config();

const express = require('express');
const { Bot, InputFile, webhookCallback } = require('grammy');
const cron = require('node-cron');
const cors = require('cors');

const { pool, initDB, getGlobalTerm, getUserState } = require('./database');
const { STRINGS, getDepartmentKeyboard, getStaffKeyboard, getStudentKeyboard, REJECTION_REASONS } = require('./ui');
const { generateApprovalPDF } = require('./pdf');

const app = express();
app.use(express.json());
app.use(cors());

const PORT = process.env.PORT || 10000;
const bot = new Bot(process.env.BOT_TOKEN);
const STAFF_GROUP_ID = process.env.STAFF_GROUP_ID || '';

process.on('unhandledRejection', (r) => console.error('[Unhandled Rejection]:', r));
process.on('uncaughtException', (err) => console.error('[Uncaught Exception]:', err.message));
bot.catch((err) => console.error(`[Grammy Error]:`, err.error));

// --- UI RATE-LIMIT OPTIMIZER ---
async function sendOrEditMenu(ctx, userId, text, kb) {
  try {
    if (ctx.callbackQuery) {
      await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb });
    } else {
      const res = await pool.query('SELECT last_menu_msg_id FROM user_settings WHERE user_id = $1', [userId]);
      if (res.rows[0]?.last_menu_msg_id) {
        try { await bot.api.deleteMessage(userId, Number(res.rows[0].last_menu_msg_id)); } catch(e) {}
      }
      const sent = await bot.api.sendMessage(userId, text, { parse_mode: 'HTML', reply_markup: kb });
      await pool.query('UPDATE user_settings SET last_menu_msg_id = $1 WHERE user_id = $2', [sent.message_id, userId]);
    }
  } catch (err) { 
    if (!err.message.includes('message is not modified')) console.error('[Menu Error]:', err.message); 
  }
}

// --- CORE BOT COMMANDS ---
bot.command('start', async (ctx) => {
  try {
    await pool.query('UPDATE user_settings SET pending_department = NULL WHERE user_id = $1', [ctx.from.id]);
    await sendOrEditMenu(ctx, ctx.from.id, "🌐 <b>SYSTEM LOCALIZATION:</b>\n<blockquote>Select your preferred language below.</blockquote>", { inline_keyboard: [[{text: "🇬🇧 ENGLISH", callback_data: "lang_en"}, {text: "🇪🇹 አማርኛ", callback_data: "lang_am"}]] });
  } catch(err) { console.error('[Start Error]:', err.message); }
});

bot.command('wipestudent', async (ctx) => {
  if (String(ctx.chat.id) !== STAFF_GROUP_ID) return;
  const parts = ctx.message.text.split(' ');
  if (parts.length < 2) return ctx.reply("⚠️ <b>SYNTAX ERROR:</b> <code>/wipestudent &lt;UID&gt;</code>", { parse_mode: 'HTML' });
  const targetUid = Number(parts[1]);

  try {
    const updateRes = await pool.query("UPDATE tickets SET status = 'WIPED', updated_at = CURRENT_TIMESTAMP WHERE user_id = $1 RETURNING username", [targetUid]);
    if (updateRes.rowCount === 0) return ctx.reply(`❌ <b>WIPE FAILED:</b> UID <code>${targetUid}</code> not found in database.`, { parse_mode: 'HTML' });
    await pool.query('UPDATE user_settings SET pending_department = NULL WHERE user_id = $1', [targetUid]);

    const { lang } = await getUserState(targetUid);
    const wipeKb = getStudentKeyboard('WIPED', 0, 1, lang);
    await sendOrEditMenu(ctx, targetUid, "🚫 <b>SYSTEM LOCKOUT</b>\n━━━━━━━━━━━━━━━━━━━━\nYour academic profile has been securely wiped by administration. All PDFs are void.\n\nClick below to begin fresh.", wipeKb);
    ctx.reply(`✅ <b>STUDENT WIPED</b>: UID <code>${targetUid}</code>.`, { parse_mode: 'HTML' });
  } catch (err) { console.error('[Wipe Error]:', err.message); }
});

bot.command('resetglobal', async (ctx) => {
  if (String(ctx.chat.id) !== STAFF_GROUP_ID) return;
  await pool.query('UPDATE group_settings SET global_season = 1');
  ctx.reply("✅ <b>GLOBAL TERM RESET TO SEASON 1</b>", { parse_mode: 'HTML' });
});

bot.command('advance', async (ctx) => {
  if (String(ctx.chat.id) !== STAFF_GROUP_ID) return;
  const current = await getGlobalTerm();
  await pool.query('UPDATE group_settings SET global_season = $1', [current + 1]);
  ctx.reply(`🔓 <b>NEW SEASON OPEN: Season ${current + 1}</b>\nAll approved students can now transmit a new receipt.`, { parse_mode: 'HTML' });
});

// --- MENU NAVIGATION CALLBACKS ---
bot.callbackQuery(/^lang_(en|am)$/, async (ctx) => {
  try {
    const lang = ctx.match[1];
    await pool.query(`INSERT INTO user_settings (user_id, language, last_menu_msg_id) VALUES ($1, $2, $3) ON CONFLICT (user_id) DO UPDATE SET language = $2, last_menu_msg_id = $3`, [ctx.from.id, lang, ctx.callbackQuery.message.message_id]);
    const { ticket } = await getUserState(ctx.from.id);
    const currentSeason = await getGlobalTerm();
    const kb = getStudentKeyboard(ticket?.status, ticket?.global_season, currentSeason, lang);
    await sendOrEditMenu(ctx, ctx.from.id, STRINGS[lang].portalWelcome, kb);
    await ctx.answerCallbackQuery();
  } catch (err) { console.error('[Lang Set Error]:', err.message); }
});

bot.callbackQuery('cmd_status', async (ctx) => {
  const { lang, ticket } = await getUserState(ctx.from.id);
  const currentSeason = await getGlobalTerm();
  if (!ticket) return sendOrEditMenu(ctx, ctx.from.id, "ℹ️ <b>SYSTEM ALERT:</b> No active traces in database.", getStudentKeyboard(null, 0, currentSeason, lang));
  
  let msg = `📊 <b>LIVE PROFILE TELEMETRY</b>\n━━━━━━━━━━━━━━━━━━━━\n<blockquote>• <b>Department:</b> ${escapeHtml(ticket.department)}\n• <b>Academic Term:</b> Y${ticket.academic_year}S${ticket.academic_semester}</blockquote>\n`;
  if (ticket.global_season < currentSeason && ticket.status !== 'WIPED') {
      msg += `\n⚠️ <b>ACTION REQUIRED:</b> A new registration season has opened. Submit a new receipt to unlock the vault.`;
  } else {
      msg += `<blockquote>• <b>Status:</b> <b>${ticket.status}</b></blockquote>`;
  }
  await sendOrEditMenu(ctx, ctx.from.id, msg, getStudentKeyboard(ticket.status, ticket.global_season, currentSeason, lang));
  await ctx.answerCallbackQuery();
});

bot.callbackQuery('cmd_submit', async (ctx) => {
  const { lang, ticket } = await getUserState(ctx.from.id);
  let nY = 1, nS = 1;
  if (ticket && ticket.status !== 'WIPED') {
      nY = ticket.academic_year; nS = ticket.academic_semester + 1;
      if (nS > 2) { nS = 1; nY++; }
  }
  await pool.query('UPDATE user_settings SET pending_year = $1, pending_semester = $2 WHERE user_id = $3', [nY, nS, ctx.from.id]);
  await sendOrEditMenu(ctx, ctx.from.id, STRINGS[lang].selectDept, getDepartmentKeyboard());
  await ctx.answerCallbackQuery();
});

bot.callbackQuery(/^dept_(.+)$/, async (ctx) => {
  const dept = ctx.match[1];
  await pool.query(`UPDATE user_settings SET pending_department = $1 WHERE user_id = $2`, [dept, ctx.from.id]);
  const { lang } = await getUserState(ctx.from.id);
  await sendOrEditMenu(ctx, ctx.from.id, STRINGS[lang].sendReceiptPrompt.replace('{dept}', escapeHtml(dept)), null);
  await ctx.answerCallbackQuery();
});

// --- IN-MEMORY PDF GENERATION ---
bot.callbackQuery('cmd_download_pdf', async (ctx) => {
  try {
    const { lang, ticket } = await getUserState(ctx.from.id);
    const currentSeason = await getGlobalTerm();
    if (!ticket || ticket.status !== 'APPROVED' || ticket.global_season < currentSeason) {
      return ctx.answerCallbackQuery("⚠️ Error: Clearance missing or revoked for current season.");
    }
    await ctx.answerCallbackQuery("Generating encrypted PDF...");
    const pdfBuffer = await generateApprovalPDF(ctx.from.id, ctx.from.username, ticket.department, 'Finance Team', bot.botInfo?.username, lang, ticket.academic_year, ticket.academic_semester);
    await ctx.replyWithDocument(new InputFile(pdfBuffer, `Clearance_Y${ticket.academic_year}S${ticket.academic_semester}_${ctx.from.id}.pdf`), { caption: STRINGS[lang].approvedMsg, parse_mode: 'HTML' });
  } catch (err) { 
    console.error('[PDF Trigger Error]:', err.message); 
    ctx.answerCallbackQuery("⚠️ PDF Engine Failed.");
  }
});

// --- MEDIA UPLOAD HANDLER ---
bot.on('message:photo', async (ctx) => {
  if (ctx.chat.type !== 'private') return;
  try {
    const { lang, ticket } = await getUserState(ctx.from.id);
    if (ticket?.status === 'PENDING') return ctx.reply(STRINGS[lang].pendingExists);
    
    const pRes = await pool.query('SELECT pending_department, pending_year, pending_semester FROM user_settings WHERE user_id = $1', [ctx.from.id]);
    if (!pRes.rows[0]?.pending_department) return ctx.reply(lang === 'am' ? "⚠️ መጀመሪያ ክፍል ይምረጡ።" : "⚠️ Error: Select department first.");

    const fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
    const currentSeason = await getGlobalTerm();
    
    await pool.query(`INSERT INTO tickets (user_id, username, receipt_file_id, department, status, academic_year, academic_semester, global_season) VALUES ($1, $2, $3, $4, 'PENDING', $5, $6, $7)`, [ctx.from.id, ctx.from.username || 'Unknown', fileId, pRes.rows[0].pending_department, pRes.rows[0].pending_year, pRes.rows[0].pending_semester, currentSeason]);
    await pool.query('UPDATE user_settings SET pending_department = NULL WHERE user_id = $1', [ctx.from.id]);

    const kb = getStudentKeyboard('PENDING', currentSeason, currentSeason, lang);
    await sendOrEditMenu(ctx, ctx.from.id, STRINGS[lang].receiptReceived, kb);
  } catch (err) { console.error('[Upload Error]:', err.message); }
});

// --- EXPRESS SERVER ---
app.use('/webhook', webhookCallback(bot, 'express'));
app.get('/', (req, res) => res.send('Renaissance Bot Active'));

async function main() {
  await initDB();
  try { await bot.init(); } catch (e) { console.error("[Bot Init Warning]:", e.message); }
  const url = process.env.RENDER_EXTERNAL_URL; 
  if (url) { await bot.api.setWebhook(`${url}/webhook`, { drop_pending_updates: true }); }
  app.listen(PORT, () => console.log(`Server live on ${PORT}`));
}
main();