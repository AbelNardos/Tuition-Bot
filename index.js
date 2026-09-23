process.env.TZ = 'Africa/Addis_Ababa';
require('dotenv').config();

const express = require('express');
const { Bot, InlineKeyboard, Keyboard, InputFile, webhookCallback } = require('grammy');
const cron = require('node-cron');
const cors = require('cors');

// --- MODULAR IMPORTS ---
const { 
  pool, initDB, getGlobalTerm, isStaff, getUserLang, setUserLang,
  getPendingDepartment, setPendingDepartment, clearPendingDepartment,
  getStaffPendingModuleDept, setStaffPendingModuleDept, clearStaffPendingModuleDept,
  getOrCreateDepartmentTopic, getOrCreateModulesVaultTopic,
  escapeHtml, formatDeptForDashboard, generateSummaryText, pushToGoogleSheet
} = require('./database');
const { generateApprovalPDF } = require('./pdf');
const { 
  STRINGS, REJECTION_REASONS, getDepartmentKeyboard, getStaffKeyboard, getStudentKeyboard,
  getModuleDepartmentKeyboard, getDeleteModuleDepartmentKeyboard, getApprovedRosterKeyboard,
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
const processedMediaGroups = new Set(); 

process.on('unhandledRejection', (r) => console.error('[Unhandled Rejection]:', r));
process.on('uncaughtException', (err) => console.error('[Uncaught Exception]:', err.message));
bot.catch((err) => console.error(`[Grammy Error]:`, err.error));

// --- HELPER FOR MENU BUILD ---
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

bot.command('deadline', async (ctx) => {
  if (!(await isStaff(ctx))) return;
  const unapprovedUsers = await pool.query(`SELECT DISTINCT u.user_id, u.language FROM user_settings u LEFT JOIN tickets t ON u.user_id = t.user_id AND t.status = 'APPROVED' WHERE t.user_id IS NULL`);
  let sent = 0;
  for (const row of unapprovedUsers.rows) {
    const lang = row.language || 'en';
    const msg = lang === 'am' ? `🚨 <b>የመጨረሻ ማሳሰቢያ: የክፍያ ጊዜው ሊያበቃ ነው</b>` : `🚨 <b>CRITICAL DEADLINE WARNING</b>`;
    try {
      const kb = new InlineKeyboard().text(lang === 'am' ? "📤 ደረሰኝ አስገባ" : "📤 TRANSMIT RECEIPT", "start_resubmit");
      await bot.api.sendMessage(row.user_id, msg, { parse_mode: 'HTML', reply_markup: kb });
      sent++;
    } catch (e) {}
  }
  await ctx.reply(`✅ <b>DEADLINE BROADCAST COMPLETE</b>: <code>${sent}</code> users.`, { parse_mode: 'HTML' });
});

bot.command('start', async (ctx) => {
  if (ctx.match && typeof ctx.match === 'string' && ctx.match.startsWith('verify_')) {
    const verifyId = ctx.match.replace('verify_', '').trim();
    if (isNaN(Number(verifyId)) || verifyId === '') return ctx.reply("⚠️ <b>SYSTEM ERROR:</b> Invalid QR Code format.", { parse_mode: 'HTML' });
    const check = await pool.query("SELECT department, status, academic_year, academic_semester, updated_at FROM tickets WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 1", [verifyId]);
    if (check.rows.length === 0) return ctx.reply(`⚠️ <b>SYSTEM ERROR:</b> No record found.`, { parse_mode: 'HTML' });
    const rec = check.rows[0];
    if (rec.status === 'APPROVED') {
      return ctx.reply(`✅ <b>VALID CLEARANCE</b>\nUID: <code>${escapeHtml(verifyId)}</code>`, { parse_mode: 'HTML' });
    } else {
      return ctx.reply(`🚨 <b>VOID / INVALID</b>`, { parse_mode: 'HTML' });
    }
  }
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
  if (isNaN(targetUid)) return ctx.reply("⚠️ <b>ERROR:</b> Invalid UID.", { message_thread_id: topicId, parse_mode: 'HTML' });

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

bot.command('module', async (ctx) => {
  if (!(await isStaff(ctx))) return;
  const staffGroupId = await getActiveStaffGroupId();
  if (!staffGroupId) return ctx.reply("⚠️ Execute /bind first.", { parse_mode: 'HTML' });
  const doc = ctx.message.document || ctx.message.reply_to_message?.document;
  if (!doc) return ctx.reply("⚠️ Attach PDF via <code>/module Dept | Title</code>", { parse_mode: 'HTML' });
  const parts = (ctx.message.caption || ctx.message.text || '').replace(/^\/(module|uploadmodule)/, '').trim().split('|').map(s => s.trim());
  if (parts.length < 2) return ctx.reply("⚠️ Syntax: <code>Dept | Title</code>", { parse_mode: 'HTML' });
  const [dept, title] = parts;
  const vaultTopicId = await getOrCreateModulesVaultTopic(ctx, staffGroupId);
  const vaultMsg = await ctx.api.sendDocument(staffGroupId, doc.file_id, { message_thread_id: vaultTopicId, caption: `📚 ${escapeHtml(dept)} - ${escapeHtml(title)}`, parse_mode: 'HTML' });
  const insRes = await pool.query("INSERT INTO department_modules (department, title, file_id, file_name) VALUES ($1, $2, $3, $4) RETURNING id", [dept, title, vaultMsg.document.file_id, doc.file_name || `${title}.pdf`]);
  const notifyKb = new InlineKeyboard().text("📢 BROADCAST", `notify_mod_${insRes.rows[0].id}`).row().text("dismiss", "dismiss_mod_notify");
  await ctx.reply(`✅ Stashed in vault. Broadcast?`, { parse_mode: 'HTML', reply_markup: notifyKb });
});

// --- MESSAGES & CALLBACKS ---
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
    const staffGroupId = await getActiveStaffGroupId();
    if (!staffGroupId) return;
    const dbTopicId = await getOrCreateDepartmentTopic(ctx, chosenDeptTagged, staffGroupId);
    const forwardRes = await ctx.api.copyMessage(staffGroupId, ctx.chat.id, ctx.message.message_id, { message_thread_id: dbTopicId });
    const actionKb = new InlineKeyboard().text("✅ APPROVE", `app_${userId}_${dbTopicId}`).row().text("❌ REJECT", `rej_${userId}_${dbTopicId}`).row().text("🔄 OVERRIDE", `trans_${userId}_${dbTopicId}`);
    const sentTicketMsg = await ctx.api.sendMessage(staffGroupId, `🧾 New submission from <code>${userId}</code> (${escapeHtml(chosenDeptTagged)})`, { message_thread_id: dbTopicId, parse_mode: 'HTML', reply_markup: actionKb });
    await clearPendingDepartment(userId);
    await pool.query(`INSERT INTO tickets (user_id, username, receipt_file_id, topic_id, message_id, ticket_msg_id, department, status, academic_year, academic_semester, global_season) VALUES ($1, $2, $3, $4, $5, $6, $7, 'PENDING', $8, $9, $10)`, [userId, ctx.from.username || 'Unknown', fileId, dbTopicId, forwardRes.message_id, sentTicketMsg.message_id, chosenDeptTagged, pRes.rows[0].pending_year || 1, pRes.rows[0].pending_semester || 1, await getGlobalTerm()]);
    await dropStudentMenu(userId, STRINGS[lang].receiptReceived, await buildStudentMenu(userId, lang, 'PENDING'));
  } finally { activeUploads.delete(userId); }
});

bot.callbackQuery(/^lang_(en|am)$/, async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  const lang = ctx.match;
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

bot.callbackQuery(/^dept_(.+)$/, async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  await setPendingDepartment(ctx.from.id, ctx.match);
  const lang = await getUserLang(ctx.from.id);
  await dropStudentMenu(ctx.from.id, STRINGS[lang].sendReceiptPrompt.replace('{dept}', escapeHtml(ctx.match)), null);
});

bot.callbackQuery('cmd_download_pdf', async (ctx) => {
  try {
    const lang = await getUserLang(ctx.from.id);
    const res = await pool.query("SELECT department, username, academic_year, academic_semester, status FROM tickets WHERE user_id = $1 AND status = 'APPROVED' ORDER BY updated_at DESC LIMIT 1", [ctx.from.id]);
    if (res.rows.length === 0) return ctx.answerCallbackQuery("⚠️ No valid clearance.");
    const t = res.rows[0];
    await ctx.answerCallbackQuery("Generating PDF...");
    const pdfBuf = await generateApprovalPDF(ctx.from.id, t.username, t.department, 'Finance Office', bot.botInfo?.username, lang, t.academic_academic_year || 1, t.academic_semester || 1);
    await ctx.replyWithDocument(new InputFile(pdfBuf, `Clearance_${ctx.from.id}.pdf`));
  } catch (e) { ctx.answerCallbackQuery("Error generating PDF."); }
});

bot.callbackQuery(/^app_(\d+)_(\d+)$/, async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  const userId = Number(ctx.match);
  const staffName = `${ctx.from.first_name || ''} ${ctx.from.last_name || ''}`.trim() || `Staff`;
  const updateRes = await pool.query("UPDATE tickets SET status = 'APPROVED', processed_by = $1, updated_at = CURRENT_TIMESTAMP WHERE user_id = $2 AND status = 'PENDING' RETURNING department, username", [staffName, userId]);
  if (updateRes.rowCount === 0) return ctx.editMessageText("⚠️ Already finalized.");
  const lang = await getUserLang(userId);
  await ctx.api.sendMessage(userId, STRINGS[lang].approvedMsg).catch(()=>{});
  await dropStudentMenu(userId, STRINGS[lang].portalWelcome, await buildStudentMenu(userId, lang, 'APPROVED'));
  ctx.editMessageText("✅ Approved.");
});

// --- SERVER INIT ---
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