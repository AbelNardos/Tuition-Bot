process.env.TZ = 'Africa/Addis_Ababa';
require('dotenv').config();

const express = require('express');
const { Bot, InlineKeyboard, Keyboard, InputFile, webhookCallback } = require('grammy');
const cors = require('cors');

// --- MODULAR IMPORTS WITH FULL ALIGNMENT ---
const { 
  pool, initDB, getGlobalTerm, isStaff, getUserLang, setUserLang,
  getPendingDepartment, setPendingDepartment, clearPendingDepartment,
  getStaffPendingModuleDept, setStaffPendingModuleDept, clearStaffPendingModuleDept,
  getOrCreateDepartmentTopic, getOrCreateModulesVaultTopic,
  escapeHtml, formatDeptForDashboard, pushToGoogleSheet
} = require('./database');
const { generateApprovalPDF } = require('./pdf');
const { 
  STRINGS, REJECTION_REASONS, getDepartmentKeyboard, getStaffKeyboard, getStudentKeyboard,
  getTransferKeyboard, getRejectionReasonKeyboard
} = require('./ui');

const app = express();
app.use(express.json());
app.use(cors());

const PORT = process.env.PORT || 10000;
const bot = new Bot(process.env.BOT_TOKEN);
const API_SECRET_KEY = process.env.API_SECRET_KEY || 'RG_ADMIN_SECURE_KEY_2026';
const APPROVED_THREAD_ID = process.env.APPROVED_THREAD_ID ? Number(process.env.APPROVED_THREAD_ID) : null;

const activeUploads = new Set(); 

process.on('unhandledRejection', (r) => console.error('[Unhandled Rejection]:', r));
process.on('uncaughtException', (err) => console.error('[Uncaught Exception]:', err.message));
bot.catch((err) => console.error(`[Grammy Error]:`, err.error));

async function buildStudentMenu(userId, lang, forceStatus = null) {
  const currentSeason = await getGlobalTerm();
  let status = forceStatus;
  let userSeason = 0;
  if (!status) {
    const res = await pool.query("SELECT status, global_season FROM tickets WHERE user_id = $1 AND status != 'WIPED' ORDER BY updated_at DESC LIMIT 1", [userId]);
    if (res.rows.length > 0) {
      status = res.rows[0].status;
      userSeason = res.rows[0].global_season || 1;
    }
  } else if (status === 'WIPED') {
     userSeason = 0; 
  } else {
     userSeason = currentSeason; 
  }
  return getStudentKeyboard(status, userSeason, currentSeason, lang);
}

async function dropStudentMenu(userId, text, kb) {
  try {
    const res = await pool.query('SELECT last_menu_msg_id FROM user_settings WHERE user_id = $1', [userId]);
    if (res.rows[0]?.last_menu_msg_id) {
      try { await bot.api.deleteMessage(userId, Number(res.rows[0].last_menu_msg_id)); } catch (e) {}
    }
    const sent = await bot.api.sendMessage(userId, text, { parse_mode: 'HTML', reply_markup: kb });
    await pool.query('UPDATE user_settings SET last_menu_msg_id = $1 WHERE user_id = $2', [sent.message_id, userId]);
    return sent;
  } catch (e) { console.error("[Drop Menu Error]:", e.message); }
}

const requireApiKey = (req, res, next) => {
  const key = req.headers['x-api-key'];
  if (!key || key !== API_SECRET_KEY) return res.status(403).json({ error: 'Access Denied: Missing or Invalid API Key' });
  next();
};

app.use('/api', (req, res, next) => {
  if (req.path === '/export' || req.path === '/export-audit' || req.path.startsWith('/certificate') || req.path.startsWith('/cron/')) {
    if (req.query.key !== API_SECRET_KEY) return res.status(403).send('Access Denied');
    return next();
  }
  requireApiKey(req, res, next);
});

// --- COMMANDS ---
bot.use(async (ctx, next) => {
  if (ctx.message && ctx.message.text && ctx.match) {
    const botUsername = ctx.me?.username;
    if (botUsername && typeof ctx.match === 'string') {
      let trimmed = ctx.match.trim();
      if (trimmed.toLowerCase().startsWith(`@${botUsername.toLowerCase()}`)) {
        ctx.match = trimmed.substring(botUsername.length + 1).trim();
      }
    }
  }
  await next();
});

bot.command('bind', async (ctx) => {
  if (ctx.chat.type === 'private') return ctx.reply("⚠️ <b>DENIED:</b> Execution requires a supergroup context with topics enabled.", { parse_mode: 'HTML' });
  if (!(await isStaff(ctx))) return ctx.reply("❌ <b>DENIED:</b> Root administrator privileges required.", { parse_mode: 'HTML' });
  const groupId = String(ctx.chat.id);
  const check = await pool.query('SELECT 1 FROM group_settings WHERE group_id = $1', [groupId]);
  if (check.rows.length > 0) await pool.query('UPDATE group_settings SET is_active = TRUE, updated_at = CURRENT_TIMESTAMP WHERE group_id = $1', [groupId]);
  else await pool.query('INSERT INTO group_settings (group_id, is_active) VALUES ($1, TRUE)', [groupId]);
  await ctx.reply("✅ <b>COMMAND CENTER SECURED</b>", { parse_mode: 'HTML' });
});

bot.command('start', async (ctx) => {
  if (ctx.chat.type === 'private') {
    await clearPendingDepartment(ctx.from.id);
    await dropStudentMenu(ctx.from.id, "🌐 <b>SELECT LANGUAGE / ቋንቋ ይምረጡ:</b>", { inline_keyboard: [[{text: "🇬🇧 ENGLISH", callback_data: "lang_en"}, {text: "🇪🇹 አማርኛ", callback_data: "lang_am"}]] });
  }
});

bot.command('panel', async (ctx) => {
  const authorized = await isStaff(ctx);
  if (!authorized && ctx.chat.type !== 'private') return;
  if (authorized) return ctx.reply("⚙️ <b>COMMAND CENTER ACTION PANEL</b>", { message_thread_id: ctx.message?.message_thread_id, parse_mode: 'HTML', reply_markup: getStaffKeyboard() });
  const lang = await getUserLang(ctx.from.id);
  await dropStudentMenu(ctx.from.id, STRINGS[lang].portalWelcome, await buildStudentMenu(ctx.from.id, lang));
});

bot.command('wipestudent', async (ctx) => {
  if (!(await isStaff(ctx))) return;
  const topicId = ctx.message.message_thread_id;
  const parts = ctx.message.text.split(' ');
  if (parts.length < 2) return ctx.reply("⚠️ <b>SYNTAX ERROR:</b> <code>/wipestudent &lt;UID&gt;</code>", { message_thread_id: topicId, parse_mode: 'HTML' });
  const targetUid = Number(parts);
  if (isNaN(targetUid)) return ctx.reply("⚠️ <b>ERROR:</b> Invalid UID format.", { message_thread_id: topicId, parse_mode: 'HTML' });

  const staffName = `${ctx.from.first_name || ''} ${ctx.from.last_name || ''}`.trim() || `Staff`;
  const updateRes = await pool.query("UPDATE tickets SET status = 'WIPED', rejection_reason = 'System Profile Wiped by Admin', processed_by = $1, processed_by_id = $2, updated_at = CURRENT_TIMESTAMP WHERE user_id = $3 RETURNING username, department", [staffName, ctx.from.id, targetUid]);
  
  if (updateRes.rowCount === 0) {
    return ctx.reply(`❌ <b>WIPE FAILED: UID NOT FOUND</b> <code>${targetUid}</code>`, { message_thread_id: topicId, parse_mode: 'HTML' });
  }

  const uname = updateRes.rows[0].username || 'Unknown';
  const dept = updateRes.rows[0].department || 'Unassigned';

  await pool.query('UPDATE user_settings SET pending_year = 1, pending_semester = 1, pending_department = NULL WHERE user_id = $1', [targetUid]);
  pushToGoogleSheet(targetUid, uname, dept, 'WIPED', staffName, 'System Profile Wiped by Admin');

  try {
    const resSettings = await pool.query('SELECT last_menu_msg_id FROM user_settings WHERE user_id = $1', [targetUid]);
    if (resSettings.rows[0]?.last_menu_msg_id) {
        await bot.api.deleteMessage(targetUid, Number(resSettings.rows[0].last_menu_msg_id));
        await pool.query('UPDATE user_settings SET last_menu_msg_id = NULL WHERE user_id = $1', [targetUid]);
    }
    const sLang = await getUserLang(targetUid);
    const wipeKb = await buildStudentMenu(targetUid, sLang, 'WIPED');
    await bot.api.sendMessage(targetUid, "🚫 <b>SYSTEM LOCKOUT</b>\nProfile wiped. Click below to begin fresh.", { parse_mode: 'HTML', reply_markup: wipeKb });
  } catch(e) {}

  ctx.reply(`✅ <b>STUDENT WIPED</b>: <code>${targetUid}</code>`, { message_thread_id: topicId, parse_mode: 'HTML' });
});

bot.on('message:photo', async (ctx) => {
  if (ctx.chat.type !== 'private' || ctx.from.is_bot) return;
  const userId = ctx.from.id;
  const lang = await getUserLang(userId);
  if (activeUploads.has(userId)) return;
  activeUploads.add(userId);
  try {
    const activeCheck = await pool.query("SELECT 1 FROM tickets WHERE user_id = $1 AND status = 'PENDING' LIMIT 1", [userId]);
    if (activeCheck.rows.length > 0) return dropStudentMenu(userId, STRINGS[lang].pendingExists, await buildStudentMenu(userId, lang, 'PENDING'));
    const pRes = await pool.query('SELECT pending_department, pending_year, pending_semester FROM user_settings WHERE user_id = $1', [userId]);
    const chosenDeptTagged = pRes.rows[0]?.pending_department;
    if (!chosenDeptTagged) return dropStudentMenu(userId, "⚠️ Select department first.", await buildStudentMenu(userId, lang));
    const fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
    const staffGroup = await (async () => { const r = await pool.query('SELECT group_id FROM group_settings WHERE is_active = TRUE LIMIT 1'); return r.rows[0]?.group_id || process.env.STAFF_GROUP_ID; })();
    if (!staffGroup) return;
    const dbTopicId = await getOrCreateDepartmentTopic(ctx, chosenDeptTagged, staffGroup);
    const forwardRes = await ctx.api.copyMessage(staffGroup, ctx.chat.id, ctx.message.message_id, { message_thread_id: dbTopicId });
    const actionKb = new InlineKeyboard().text("✅ APPROVE", `app:${userId}:${dbTopicId}`).row().text("❌ REJECT", `rej:${userId}:${dbTopicId}`);
    const sentTicketMsg = await ctx.api.sendMessage(staffGroup, `🧾 New submission from <code>${userId}</code> (${escapeHtml(chosenDeptTagged)})`, { message_thread_id: dbTopicId, parse_mode: 'HTML', reply_markup: actionKb });
    await clearPendingDepartment(userId);
    await pool.query(`INSERT INTO tickets (user_id, username, receipt_file_id, topic_id, message_id, ticket_msg_id, department, status, academic_year, academic_semester, global_season) VALUES ($1, $2, $3, $4, $5, $6, $7, 'PENDING', $8, $9, $10)`, [userId, ctx.from.username || 'Unknown', fileId, dbTopicId, forwardRes.message_id, sentTicketMsg.message_id, chosenDeptTagged, pRes.rows[0].pending_year || 1, pRes.rows[0].pending_semester || 1, await getGlobalTerm()]);
    await dropStudentMenu(userId, STRINGS[lang].receiptReceived, await buildStudentMenu(userId, lang, 'PENDING'));
  } finally { activeUploads.delete(userId); }
});

// --- SAFE DETERMINISTIC CALLBACK PARSING VIA .split(':') ---
bot.callbackQuery(/^lang:(en|am)$/, async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  const lang = ctx.callbackQuery.data.split(':');
  await setUserLang(ctx.from.id, lang);
  await dropStudentMenu(ctx.from.id, STRINGS[lang].portalWelcome, await buildStudentMenu(ctx.from.id, lang));
});

bot.callbackQuery('cmd_status', async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  const lang = await getUserLang(ctx.from.id);
  const res = await pool.query("SELECT department, status, academic_year, academic_semester FROM tickets WHERE user_id = $1 AND status != 'WIPED' ORDER BY updated_at DESC LIMIT 1", [ctx.from.id]);
  if (res.rows.length === 0) return dropStudentMenu(ctx.from.id, "ℹ️ No traces found.", await buildStudentMenu(ctx.from.id, lang));
  const t = res.rows[0];
  await dropStudentMenu(ctx.from.id, `📊 Status: <b>${t.status}</b> (${t.department})`, await buildStudentMenu(ctx.from.id, lang, t.status));
});

bot.callbackQuery('cmd_submit', async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  const lang = await getUserLang(ctx.from.id);
  await dropStudentMenu(ctx.from.id, STRINGS[lang].selectDept, getDepartmentKeyboard());
});

bot.callbackQuery(/^dept:(.+)$/, async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  const chosenDept = ctx.callbackQuery.data.split(':');
  await setPendingDepartment(ctx.from.id, chosenDept);
  const lang = await getUserLang(ctx.from.id);
  await dropStudentMenu(ctx.from.id, STRINGS[lang].sendReceiptPrompt.replace('{dept}', escapeHtml(chosenDept)), null);
});

bot.callbackQuery('cmd_download_pdf', async (ctx) => {
  try {
    const lang = await getUserLang(ctx.from.id);
    const res = await pool.query("SELECT department, username, academic_year, academic_semester, status FROM tickets WHERE user_id = $1 AND status = 'APPROVED' ORDER BY updated_at DESC LIMIT 1", [ctx.from.id]);
    if (res.rows.length === 0) return ctx.answerCallbackQuery("⚠️ No valid clearance.");
    const t = res.rows[0];
    await ctx.answerCallbackQuery("Generating PDF...");
    const pdfBuf = await generateApprovalPDF(ctx.from.id, t.username, t.department, 'Finance Office', bot.botInfo?.username, lang, t.academic_year || 1, t.academic_semester || 1);
    await ctx.replyWithDocument(new InputFile(pdfBuf, `Clearance_${ctx.from.id}.pdf`));
  } catch (e) { ctx.answerCallbackQuery("Error generating PDF."); }
});

bot.callbackQuery(/^app:(\d+):(\d+)$/, async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  const parts = ctx.callbackQuery.data.split(':');
  const userId = Number(parts);
  const staffName = `${ctx.from.first_name || ''} ${ctx.from.last_name || ''}`.trim() || `Staff`;
  const updateRes = await pool.query("UPDATE tickets SET status = 'APPROVED', processed_by = $1, updated_at = CURRENT_TIMESTAMP WHERE user_id = $2 AND status = 'PENDING' RETURNING department, username", [staffName, userId]);
  if (updateRes.rowCount === 0) return ctx.editMessageText("⚠️ Already finalized.");
  const lang = await getUserLang(userId);
  await ctx.api.sendMessage(userId, STRINGS[lang].approvedMsg).catch(()=>{});
  await dropStudentMenu(userId, STRINGS[lang].portalWelcome, await buildStudentMenu(userId, lang, 'APPROVED'));
  ctx.editMessageText("✅ Approved.");
});

bot.callbackQuery(/^rej:(\d+):(\d+)$/, async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  const parts = ctx.callbackQuery.data.split(':');
  const userId = Number(parts);
  const topicId = Number(parts);
  await ctx.editMessageText("❌ <b>INITIALIZE REJECTION SEQUENCE:</b>", { parse_mode: 'HTML', reply_markup: getRejectionReasonKeyboard(userId, topicId) });
});

app.use('/webhook', webhookCallback(bot, 'express'));
app.get('/', (req, res) => res.send('Active'));

async function main() {
  await initDB();
  try { await bot.init(); } catch (e) {}
  const url = process.env.RENDER_EXTERNAL_URL; 
  if (url) { await bot.api.setWebhook(`${url}/webhook`, { drop_pending_updates: true }); }
  app.listen(PORT, () => console.log(`Live on ${PORT}`));
}
main();