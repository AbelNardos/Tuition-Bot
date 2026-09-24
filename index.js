process.env.TZ = 'Africa/Addis_Ababa';
require('dotenv').config();

const express = require('express');
const { Bot, InlineKeyboard, Keyboard, InputFile, webhookCallback } = require('grammy');
const cron = require('node-cron');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

// --- MODULAR IMPORTS ---
const { 
  pool, initDB, getGlobalTerm, getActiveStaffGroupId, isStaff, getUserState,
  getUserLang, setUserLang, getPendingDepartment, setPendingDepartment, clearPendingDepartment,
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

process.on('unhandledRejection', (r) => console.error('[Unhandled Rejection]:', r));
process.on('uncaughtException', (err) => console.error('[Uncaught Exception]:', err.message));
bot.catch((err) => console.error(`[Grammy Error]:`, err.error));

// ============================================================================
// UI RENDERING ENGINES
// ============================================================================

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

async function dropMenu(userId, text, kb) {
  try {
    await pool.query(`INSERT INTO user_settings (user_id) VALUES ($1) ON CONFLICT DO NOTHING`, [userId]);
    const res = await pool.query('SELECT last_menu_msg_id FROM user_settings WHERE user_id = $1', [userId]);
    if (res.rows[0]?.last_menu_msg_id) {
      try { await bot.api.deleteMessage(userId, Number(res.rows[0].last_menu_msg_id)); } catch (e) {}
    }
    const sent = await bot.api.sendMessage(userId, text, { parse_mode: 'HTML', reply_markup: kb });
    await pool.query('UPDATE user_settings SET last_menu_msg_id = $1 WHERE user_id = $2', [sent.message_id, userId]);
  } catch (e) {
    console.error("[Drop Menu Error]:", e.message);
  }
}

async function transformMenu(ctx, text, kb) {
  try {
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb });
  } catch (e) {
    if (!e.message.includes('message is not modified')) console.error("[Transform Menu Error]:", e.message);
  }
}

// ============================================================================
// EXPRESS REST API
// ============================================================================

const requireApiKey = (req, res, next) => {
  const key = req.headers['x-api-key'];
  if (!key || key !== API_SECRET_KEY) return res.status(403).json({ error: 'Access Denied' });
  next();
};

app.use('/api', (req, res, next) => {
  if (req.path === '/export' || req.path === '/export-audit' || req.path.startsWith('/certificate') || req.path.startsWith('/cron/')) {
    if (req.query.key !== API_SECRET_KEY) return res.status(403).send('Access Denied');
    return next();
  }
  requireApiKey(req, res, next);
});

app.post('/api/broadcast', async (req, res) => {
  const { message } = req.body;
  res.status(200).json({ success: true, status: 'DISPATCHED' });
  try {
    const { rows } = await pool.query('SELECT DISTINCT user_id FROM user_settings WHERE user_id IS NOT NULL');
    for (const row of rows) {
      try { await bot.api.sendMessage(row.user_id, `📢 <b>RENAISSANCE GLOBAL ALERT</b>\n\n${message}`, { parse_mode: 'HTML' }); } catch (err) {}
    }
  } catch (error) {}
});

app.get('/api/live-dashboard', async (req, res) => {
  try {
    const countRes = await pool.query('SELECT COUNT(DISTINCT user_id) as count FROM user_settings');
    const logsRes = await pool.query(`SELECT id, updated_at as timestamp, status as event, username as user, user_id as chatid FROM tickets ORDER BY updated_at DESC LIMIT 15`);
    const accountsRes = await pool.query(`SELECT t.id, t.username as name, t.department as role, t.user_id as chatid, t.status, u.phone_number, u.language, t.created_at, t.academic_year, t.academic_semester FROM tickets t LEFT JOIN user_settings u ON t.user_id = u.user_id INNER JOIN (SELECT user_id, MAX(updated_at) as max_date FROM tickets GROUP BY user_id) latest ON t.user_id = latest.user_id AND t.updated_at = latest.max_date ORDER BY t.updated_at DESC LIMIT 300`);
    res.json({
      success: true,
      metrics: { totalLinked: parseInt(countRes.rows[0]?.count || 0), activeToday: logsRes.rows.length, lastBroadcast: new Date().toISOString().split('T')[0] },
      logs: logsRes.rows.map(r => ({ id: r.id, timestamp: new Date(r.timestamp).toLocaleString(), event: `TICKET_${r.event}`, user: r.user ? `@${r.user}` : 'UNKNOWN', chatId: r.chatid })),
      accounts: accountsRes.rows.map(r => ({ id: r.id, name: r.name ? `@${r.name}` : 'UNKNOWN', role: formatDeptForDashboard(r.role), phone: r.phone_number || 'Not Provided', chatId: r.chatid, status: r.status, language: r.language, timestamp: new Date(r.created_at).toLocaleString() }))
    });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.get('/api/stats', async (req, res) => {
  try {
    const approved = await pool.query("SELECT department, COUNT(*) as count FROM tickets WHERE status = 'APPROVED' GROUP BY department");
    const pending = await pool.query("SELECT department, COUNT(*) as count FROM tickets WHERE status = 'PENDING' GROUP BY department");
    const rejected = await pool.query("SELECT department, COUNT(*) as count FROM tickets WHERE status = 'REJECTED' GROUP BY department");
    const groupAndClean = (rows) => {
      const map = {};
      rows.forEach(r => { const c = formatDeptForDashboard(r.department); map[c] = (map[c] || 0) + Number(r.count); });
      return Object.keys(map).map(k => ({ department: k, count: map[k] }));
    };
    res.json({ success: true, stats: { approved: groupAndClean(approved.rows), pending: groupAndClean(pending.rows), rejected: groupAndClean(rejected.rows) }});
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ============================================================================
// COMMAND ROUTING & TEXT LISTENERS
// ============================================================================

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
  if (ctx.chat.type === 'private') return ctx.reply("⚠️ <b>DENIED:</b> Execution requires a supergroup context.", { parse_mode: 'HTML' });
  if (!(await isStaff(ctx))) return ctx.reply("❌ <b>DENIED:</b> Root administrator privileges required.", { parse_mode: 'HTML' });
  
  const groupId = String(ctx.chat.id);
  const check = await pool.query('SELECT 1 FROM group_settings WHERE group_id = $1', [groupId]);
  if (check.rows.length > 0) await pool.query('UPDATE group_settings SET is_active = TRUE, updated_at = CURRENT_TIMESTAMP WHERE group_id = $1', [groupId]);
  else await pool.query('INSERT INTO group_settings (group_id, is_active) VALUES ($1, TRUE)', [groupId]);
  
  await ctx.reply("✅ <b>COMMAND CENTER UPLINK SECURED</b>\n━━━━━━━━━━━━━━━━━━━━\n<blockquote><b>SYSTEM STATUS:</b> Online & Authenticated\n<b>SECTOR:</b> Primary Operations Interface</blockquote>", { parse_mode: 'HTML' });
});

bot.command('start', async (ctx) => {
  if (ctx.match && typeof ctx.match === 'string' && ctx.match.startsWith('verify_')) {
    const verifyId = ctx.match.replace('verify_', '').trim();
    if (isNaN(Number(verifyId)) || verifyId === '') return ctx.reply("⚠️ <b>SYSTEM ERROR:</b> Invalid QR Code format.", { parse_mode: 'HTML' });
    const check = await pool.query("SELECT department, status, academic_year, academic_semester, updated_at FROM tickets WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 1", [verifyId]);
    
    if (check.rows.length === 0) return ctx.reply(`⚠️ <b>FATAL ERROR: ANOMALY DETECTED</b>\n━━━━━━━━━━━━━━━━━━━━\n<blockquote><b>TARGET UID:</b> <code>${escapeHtml(verifyId)}</code>\n<b>RESULT:</b> Zero records found. Potential forgery.</blockquote>`, { parse_mode: 'HTML' });
    
    const rec = check.rows[0];
    if (rec.status === 'APPROVED') {
      return ctx.reply(`✅ <b>OFFICIAL CLEARANCE: AUTHENTICATED</b>\n━━━━━━━━━━━━━━━━━━━━\n<blockquote>• <b>STUDENT ID:</b> <code>${escapeHtml(verifyId)}</code>\n• <b>SECTOR:</b> ${escapeHtml(rec.department)}\n• <b>ACADEMIC TERM:</b> Year ${rec.academic_year || 1} — Semester ${rec.academic_semester || 1}\n• <b>STATUS:</b> Fully Cleared & Valid\n• <b>VERIFIED AT:</b> ${new Date(rec.updated_at).toLocaleDateString()}</blockquote>`, { parse_mode: 'HTML' });
    } else {
      return ctx.reply(`🚨 <b>VOIDED CLEARANCE: ACCESS DENIED</b>\n━━━━━━━━━━━━━━━━━━━━\n<blockquote>• <b>STUDENT ID:</b> <code>${escapeHtml(verifyId)}</code>\n• <b>SECTOR:</b> ${escapeHtml(rec.department)}\n• <b>LOCKED STATUS:</b> ${escapeHtml(rec.status)}</blockquote>`, { parse_mode: 'HTML' });
    }
  }

  if (ctx.chat.type === 'private') {
    await clearPendingDepartment(ctx.from.id);
    await dropMenu(ctx.from.id, "🌐 <b>SELECT LANGUAGE / ቋንቋ ይምረጡ:</b>", { inline_keyboard: [[{text: "🇬🇧 ENGLISH", callback_data: "lang_en"}, {text: "🇪🇹 አማርኛ", callback_data: "lang_am"}]] });
  }
});

bot.command('panel', async (ctx) => {
  if (!(await isStaff(ctx)) && ctx.chat.type !== 'private') return;
  if (await isStaff(ctx)) return ctx.reply("⚙️ <b>COMMAND CENTER ACTION PANEL</b>\n━━━━━━━━━━━━━━━━━━━━\n<blockquote><b>ACCESS LEVEL:</b> Root Administrator\n<b>MODULES:</b> Active & Synchronized</blockquote>\n\n<i>Select a core administrative function from the secure terminal below to proceed:</i>", { message_thread_id: ctx.message?.message_thread_id, parse_mode: 'HTML', reply_markup: getStaffKeyboard() });
  
  const { lang, status, userSeason } = await getUserState(ctx.from.id);
  const currentSeason = await getGlobalTerm();
  const kb = await buildStudentMenu(ctx.from.id, lang, status);
  await dropMenu(ctx.from.id, STRINGS[lang].portalWelcome, kb);
});

bot.command('wipestudent', async (ctx) => {
  if (!(await isStaff(ctx))) return;
  const topicId = ctx.message.message_thread_id;
  const parts = ctx.message.text.split(' ');
  
  if (parts.length < 2) return ctx.reply("⚠️ <b>SYNTAX ERROR: INVALID PARAMETERS</b>\n━━━━━━━━━━━━━━━━━━━━\n<blockquote><b>EXPECTED FORMAT:</b> <code>/wipestudent &lt;UID&gt;</code></blockquote>", { message_thread_id: topicId, parse_mode: 'HTML' });
  const targetUid = Number(parts[1]); 
  if (isNaN(targetUid)) return ctx.reply("⚠️ <b>DATA TYPE ERROR: INVALID UID FORMAT</b>", { message_thread_id: topicId, parse_mode: 'HTML' });

  const staffName = `${ctx.from.first_name || ''} ${ctx.from.last_name || ''}`.trim() || `Staff`;
  const updateRes = await pool.query("UPDATE tickets SET status = 'WIPED', rejection_reason = 'System Profile Wiped by Admin', processed_by = $1, processed_by_id = $2, updated_at = CURRENT_TIMESTAMP WHERE user_id = $3 RETURNING username, department", [staffName, ctx.from.id, targetUid]);
  
  if (updateRes.rowCount === 0) return ctx.reply(`❌ <b>WIPE OPERATION FAILED</b>\n━━━━━━━━━━━━━━━━━━━━\n<blockquote><b>ERROR CAUSE:</b> Target UID <code>${targetUid}</code> not located in the active database matrix.</blockquote>`, { message_thread_id: topicId, parse_mode: 'HTML' });

  await pool.query('UPDATE user_settings SET pending_year = 1, pending_semester = 1, pending_department = NULL WHERE user_id = $1', [targetUid]);
  pushToGoogleSheet(targetUid, updateRes.rows[0].username, updateRes.rows[0].department, 'WIPED', staffName, 'Wiped by Admin');

  try {
    const { lang } = await getUserState(targetUid);
    const wipeKb = await buildStudentMenu(targetUid, lang, 'WIPED');
    await dropMenu(targetUid, "🚫 <b>CRITICAL SYSTEM LOCKOUT</b>\n━━━━━━━━━━━━━━━━━━━━\n<blockquote>Your academic profile, historical records, and Vault access have been aggressively expunged by the central administration.</blockquote>\n\n<i>Click below to re-initiate the registration protocol from a blank slate.</i>", wipeKb);
  } catch(e) {}

  ctx.reply(`✅ <b>STUDENT DOSSIER EXPUNGED</b>\n━━━━━━━━━━━━━━━━━━━━\n<blockquote><b>TARGET UID:</b> <code>${targetUid}</code>\n<b>ACTION:</b> Full Database Override\n<b>STATUS:</b> All historical records, Modules, and Clearances successfully revoked.</blockquote>`, { message_thread_id: topicId, parse_mode: 'HTML' });
});

bot.command('module', async (ctx) => {
  if (!(await isStaff(ctx))) return;
  const staffGroupId = await getActiveStaffGroupId();
  if (!staffGroupId) return ctx.reply("⚠️ <b>SYSTEM HALT:</b> Execute /bind protocol first.", { parse_mode: 'HTML' });
  
  const doc = ctx.message.document || ctx.message.reply_to_message?.document;
  if (!doc) return ctx.reply("⚠️ <b>SYNTAX ERROR:</b> Attach PDF via <code>/module Dept | Title</code>", { parse_mode: 'HTML' });
  
  const parts = (ctx.message.caption || ctx.message.text || '').replace(/^\/(module|uploadmodule)/, '').trim().split('|').map(s => s.trim());
  if (parts.length < 2) return ctx.reply("⚠️ <b>SYNTAX ERROR: MISSING DELIMITER</b>\n━━━━━━━━━━━━━━━━━━━━\n<blockquote>Separate department and title strictly with a pipe symbol ( | ).</blockquote>", { parse_mode: 'HTML' });
  
  const [dept, title] = parts;
  try {
    const vaultTopicId = await getOrCreateModulesVaultTopic(ctx, staffGroupId);
    const vaultMsg = await ctx.api.sendDocument(staffGroupId, doc.file_id, { message_thread_id: vaultTopicId, caption: `📚 <b>VAULT ARCHIVE INDEX</b>\n<blockquote>• <b>Department:</b> ${escapeHtml(dept)}\n• <b>Designation:</b> ${escapeHtml(title)}</blockquote>`, parse_mode: 'HTML' });
    const insRes = await pool.query("INSERT INTO department_modules (department, title, file_id, file_name) VALUES ($1, $2, $3, $4) RETURNING id", [dept, title, vaultMsg.document.file_id, doc.file_name || `${title}.pdf`]);
    try { await ctx.deleteMessage(); if (ctx.message.reply_to_message) await ctx.api.deleteMessage(ctx.chat.id, ctx.message.reply_to_message.message_id); } catch (e) {}
    
    const notifyKb = { inline_keyboard: [[{text: "📢 INITIATE NETWORK BROADCAST", callback_data: `notify_mod_${insRes.rows[0].id}`}], [{text: "🔕 STEALTH INGEST", callback_data: "dismiss_mod_notify"}]] };
    await ctx.reply(`✅ <b>DOCUMENT SECURELY INGESTED INTO VAULT</b>\n━━━━━━━━━━━━━━━━━━━━\n<blockquote><b>TARGET SECTOR:</b> ${escapeHtml(dept)}\n<b>FILE DESIGNATION:</b> ${escapeHtml(title)}\n<b>ENCRYPTION:</b> Verified</blockquote>\n\n<i>System ready. Do you wish to initiate a massive network broadcast to alert all enrolled students?</i>`, { parse_mode: 'HTML', reply_markup: notifyKb });
  } catch (err) { ctx.reply(`❌ <b>CRITICAL INGEST ERROR:</b> ${err.message}`, { parse_mode: 'HTML' }); }
});

// Admin Reply Handlers (Search, Broadcast, Override, Revoke)
bot.on('message', async (ctx, next) => {
  if (ctx.from?.is_bot) return;
  if (ctx.message?.text?.startsWith('/')) return next();

  const staffGroupId = await getActiveStaffGroupId();
  const isStaffGroup = staffGroupId && String(ctx.chat.id) === staffGroupId;
  const topicId = ctx.message?.message_thread_id;

  if (isStaffGroup && ctx.message.reply_to_message && ctx.message.text) {
    const orig = ctx.message.reply_to_message.text || '';
    const input = ctx.message.text.trim();

    if (orig.includes("DATABASE RECORD QUERY")) {
      const cleanQuery = input.replace(/^@/, '');
      const res = await pool.query(`SELECT user_id, username, department, status, updated_at FROM tickets WHERE user_id::text = $1 OR LOWER(username) = LOWER($1) OR LOWER(department) LIKE LOWER($2) ORDER BY updated_at DESC LIMIT 10`, [cleanQuery, `%${cleanQuery}%`]);
      if (res.rows.length === 0) return ctx.reply(`🔍 <b>No records matching:</b> <code>${escapeHtml(input)}</code>`, { message_thread_id: topicId, parse_mode: 'HTML' });
      let text = `🔍 <b>QUERY RESULTS:</b>\n━━━━━━━━━━━━━━━━━━━━\n`;
      res.rows.forEach(r => { text += `• <b>UID:</b> <code>${r.user_id}</code> (@${r.username || 'Unknown'})\n  <b>Sector:</b> ${escapeHtml(r.department)}\n  <b>Status:</b> ${r.status}\n\n`; });
      return ctx.reply(text, { message_thread_id: topicId, parse_mode: 'HTML' });
    }

    if (orig.includes("INITIALIZE SYSTEM BROADCAST")) {
      const usersRes = await pool.query('SELECT DISTINCT user_id FROM user_settings');
      let count = 0;
      for (const row of usersRes.rows) {
        try { await bot.api.sendMessage(row.user_id, `📢 <b>SYSTEM ALERT</b>\n━━━━━━━━━━━━━━━━━━━━\n\n${escapeHtml(input)}`, { parse_mode: 'HTML' }); count++; } catch (e) {}
      }
      return ctx.reply(`✅ <b>BROADCAST SUCCESSFUL:</b> Delivered to <code>${count}</code> active nodes.`, { message_thread_id: topicId, parse_mode: 'HTML' });
    }

    if (orig.includes("INITIATE DEPARTMENT OVERRIDE")) {
      const targetUid = Number(input);
      if (isNaN(targetUid)) return ctx.reply("⚠️ <b>ERROR:</b> Invalid UID format.", { message_thread_id: topicId, parse_mode: 'HTML' });
      const kb = new InlineKeyboard().text("📈 MARKETING", `chgdept_${targetUid}_mkt`).text("💼 BUSINESS", `chgdept_${targetUid}_biz`).row().text("📊 ACCOUNTING", `chgdept_${targetUid}_acc`).text("🌾 AGRIBUSINESS", `chgdept_${targetUid}_agri`).row().text("📚 ED. PLANNING", `chgdept_${targetUid}_ed`).text("🚚 LOGISTICS", `chgdept_${targetUid}_log`).row().text("🔙 CANCEL", `chgdept_${targetUid}_cancel`);
      return ctx.reply(`📂 <b>SELECT NEW ROUTING FOR UID <code>${targetUid}</code>:</b>`, { message_thread_id: topicId, parse_mode: 'HTML', reply_markup: kb });
    }

    if (orig.includes("INITIATE STATUS REVOCATION")) {
      const targetUid = Number(input);
      if (isNaN(targetUid)) return ctx.reply("⚠️ <b>ERROR:</b> Invalid UID format.", { message_thread_id: topicId, parse_mode: 'HTML' });
      const staffName = `${ctx.from.first_name || ''} ${ctx.from.last_name || ''}`.trim() || `Staff`;
      const updateRes = await pool.query(`UPDATE tickets SET status = 'REJECTED', rejection_reason = 'Revoked by Admin', processed_by = $1, updated_at = CURRENT_TIMESTAMP WHERE user_id = $2 AND status = 'APPROVED' RETURNING department, username`, [staffName, targetUid]);
      if (updateRes.rowCount === 0) return ctx.reply("⚠️ <b>ERROR:</b> Target record no longer active/approved.", { message_thread_id: topicId, parse_mode: 'HTML' });
      
      pushToGoogleSheet(targetUid, updateRes.rows[0].username, updateRes.rows[0].department, 'REJECTED', staffName, 'Revoked by Admin');
      
      try {
        const { lang } = await getUserState(targetUid);
        const rejectText = STRINGS[lang].rejectedMsg.replace('{reason}', "Revoked by Admin").replace('{message}', "Your clearance has been manually revoked. Please contact administration.");
        await bot.api.sendMessage(targetUid, `🔔 <b>STATUS UPDATE:</b>\n\n${rejectText}`, { parse_mode: 'HTML' });
        await dropMenu(targetUid, STRINGS[lang].portalWelcome, await buildStudentMenu(targetUid, lang, 'REJECTED'));
      } catch (e) {}

      return ctx.reply(`✅ <b>STATUS REVOKED</b>\nUID <code>${targetUid}</code> locked out.`, { message_thread_id: topicId, parse_mode: 'HTML' });
    }
  }
  await next();
});

// ============================================================================
// STUDENT UPLOAD HANDLERS
// ============================================================================

bot.on('message:contact', async (ctx) => {
  if (ctx.chat.type === 'private') {
    const phone = ctx.message.contact.phone_number;
    await pool.query('UPDATE user_settings SET phone_number = $1 WHERE user_id = $2', [phone, ctx.from.id]);
    const { lang, status } = await getUserState(ctx.from.id);
    await ctx.reply(lang === 'am' ? "✅ <b>ስልክዎ ተመዝግቧል!</b>" : "✅ <b>Profile Verified!</b>", { parse_mode: 'HTML', reply_markup: { remove_keyboard: true } });
    await dropMenu(ctx.from.id, STRINGS[lang].portalWelcome, await buildStudentMenu(ctx.from.id, lang, status));
  }
});

bot.on('message:photo', async (ctx) => {
  if (ctx.chat.type !== 'private' || ctx.from.is_bot) return;
  const userId = ctx.from.id;
  const { lang, status } = await getUserState(userId);

  if (activeUploads.has(userId)) return;
  activeUploads.add(userId);

  try {
    if (status === 'PENDING') return dropMenu(userId, STRINGS[lang].pendingExists, await buildStudentMenu(userId, lang, 'PENDING'));
    
    const chosenDeptTagged = await getPendingDepartment(userId);
    if (!chosenDeptTagged) return dropMenu(userId, "⚠️ <b>ERROR:</b> Select an academic department first.", await buildStudentMenu(userId, lang, status));

    const fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
    const staffGroupId = await getActiveStaffGroupId();
    if (!staffGroupId) return;

    const dbTopicId = await getOrCreateDepartmentTopic(ctx, chosenDeptTagged, staffGroupId);
    let forwardRes;
    try {
      forwardRes = await ctx.api.copyMessage(staffGroupId, ctx.chat.id, ctx.message.message_id, { message_thread_id: dbTopicId });
    } catch (e) {
      await pool.query('DELETE FROM department_topics WHERE topic_id = $1', [dbTopicId]);
      const newTopicId = await getOrCreateDepartmentTopic(ctx, chosenDeptTagged, staffGroupId);
      forwardRes = await ctx.api.copyMessage(staffGroupId, ctx.chat.id, ctx.message.message_id, { message_thread_id: newTopicId });
    }
    
    const actionKb = { inline_keyboard: [[{text: "✅ APPROVE", callback_data: `app_${userId}_${dbTopicId}`}, {text: "❌ REJECT", callback_data: `rej_${userId}_${dbTopicId}`}], [{text: "🔄 OVERRIDE DEPT", callback_data: `trans_${userId}_${dbTopicId}`}]] };
    const pRes = await pool.query('SELECT pending_year, pending_semester FROM user_settings WHERE user_id = $1', [userId]);
    const pendingY = pRes.rows[0]?.pending_year || 1;
    const pendingS = pRes.rows[0]?.pending_semester || 1;
    const currentSeason = await getGlobalTerm();
    
    const cardMsg = `🚨 <b>NEW INCOMING DATA TRANSMISSION</b>\n━━━━━━━━━━━━━━━━━━━━\n<blockquote>👤 <b>STUDENT ALIAS:</b> @${escapeHtml(ctx.from.username || 'Unknown')}\n🆔 <b>SYSTEM UID:</b> <code>${userId}</code>\n🏫 <b>TARGET SECTOR:</b> ${escapeHtml(chosenDeptTagged)}\n📅 <b>ACADEMIC TERM:</b> Year ${pendingY} — Semester ${pendingS}\n⚙️ <b>GLOBAL COHORT:</b> Season ${currentSeason}</blockquote>\n━━━━━━━━━━━━━━━━━━━━\n⚠️ <i>FINANCE NODE: Analyze the appended transaction artifact above and execute a strict clearance directive below.</i>`;
    
    const sentTicketMsg = await ctx.api.sendMessage(staffGroupId, cardMsg, { message_thread_id: dbTopicId, parse_mode: 'HTML', reply_markup: actionKb });
    
    await clearPendingDepartment(userId);
    await pool.query(`INSERT INTO tickets (user_id, username, receipt_file_id, topic_id, message_id, ticket_msg_id, department, status, academic_year, academic_semester, global_season) VALUES ($1, $2, $3, $4, $5, $6, $7, 'PENDING', $8, $9, $10)`, [userId, ctx.from.username || 'Unknown', fileId, dbTopicId, forwardRes.message_id, sentTicketMsg.message_id, chosenDeptTagged, pendingY, pendingS, currentSeason]);
    
    await dropMenu(userId, STRINGS[lang].receiptReceived, await buildStudentMenu(userId, lang, 'PENDING'));
  } catch (err) {
    console.error("[Photo Handler Error]:", err.message);
  } finally { 
    activeUploads.delete(userId); 
  }
});

// ============================================================================
// STUDENT TRANSFORM CALLBACK QUERIES
// ============================================================================

bot.callbackQuery(/^lang_(en|am)$/, async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  const lang = ctx.match[1];
  await setUserLang(ctx.from.id, lang);
  
  const phoneRes = await pool.query('SELECT phone_number FROM user_settings WHERE user_id = $1', [ctx.from.id]);
  if (!phoneRes.rows[0]?.phone_number) {
    const kb = new Keyboard().requestContact(lang === 'am' ? '📱 ስልክ ቁጥር አጋራ' : '📱 Share Phone Number').resized().oneTime();
    try { await ctx.deleteMessage(); } catch (e) {}
    return ctx.reply(lang === 'am' ? "⚠️ <b>ማረጋገጫ ያስፈልጋል:</b>\nእባክዎን ከታች ያለውን ቁልፍ በመጫን ስልክዎን ያጋሩ።" : "⚠️ <b>VERIFICATION REQUIRED:</b>\nPlease tap the button below to register your profile.", { parse_mode: 'HTML', reply_markup: kb });
  }

  const { status } = await getUserState(ctx.from.id);
  await transformMenu(ctx, STRINGS[lang].portalWelcome, await buildStudentMenu(ctx.from.id, lang, status));
});

bot.callbackQuery('cmd_status', async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  const { lang, status, userSeason } = await getUserState(ctx.from.id);
  const currentSeason = await getGlobalTerm();
  
  if (!status) return transformMenu(ctx, "ℹ️ <b>SYSTEM ALERT:</b> No active traces in database.", await buildStudentMenu(ctx.from.id, lang, status));
  
  const res = await pool.query("SELECT department, academic_year, academic_semester FROM tickets WHERE user_id = $1 AND status != 'WIPED' ORDER BY updated_at DESC LIMIT 1", [ctx.from.id]);
  const t = res.rows[0];
  let msg = `📊 <b>LIVE PROFILE TELEMETRY</b>\n━━━━━━━━━━━━━━━━━━━━\n<blockquote>• <b>Department:</b> ${escapeHtml(t.department)}\n• <b>Academic Term:</b> Year ${t.academic_year} — Semester ${t.academic_semester}</blockquote>\n`;
  
  if (userSeason < currentSeason && status === 'APPROVED') {
    msg += `\n⚠️ <b>ACTION REQUIRED:</b> A new registration season has opened. You must submit a new receipt to unlock the module vault.`;
  } else {
    msg += `<blockquote>• <b>Status:</b> <b>${status}</b></blockquote>`;
  }
  
  await transformMenu(ctx, msg, await buildStudentMenu(ctx.from.id, lang, status));
});

bot.callbackQuery('cmd_submit', async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  const { lang } = await getUserState(ctx.from.id);
  const lastAppr = await pool.query("SELECT academic_year, academic_semester FROM tickets WHERE user_id = $1 AND status = 'APPROVED' ORDER BY updated_at DESC LIMIT 1", [ctx.from.id]);
  let nextY = 1, nextS = 1;
  if (lastAppr.rows.length > 0) {
      let calcY = lastAppr.rows[0].academic_year || 1;
      let calcS = (lastAppr.rows[0].academic_semester || 1) + 1;
      if (calcS > 2) { calcS = 1; calcY++; }
      nextY = calcY; nextS = calcS;
  }
  await pool.query('UPDATE user_settings SET pending_year = $1, pending_semester = $2 WHERE user_id = $3', [nextY, nextS, ctx.from.id]);
  await transformMenu(ctx, STRINGS[lang].selectDept, getDepartmentKeyboard());
});

bot.callbackQuery('start_resubmit', async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  const { lang } = await getUserState(ctx.from.id);
  await clearPendingDepartment(ctx.from.id);
  const lastAppr = await pool.query("SELECT academic_year, academic_semester FROM tickets WHERE user_id = $1 AND status = 'APPROVED' ORDER BY updated_at DESC LIMIT 1", [ctx.from.id]);
  let nextY = 1, nextS = 1;
  if (lastAppr.rows.length > 0) {
      let calcY = lastAppr.rows[0].academic_year || 1;
      let calcS = (lastAppr.rows[0].academic_semester || 1) + 1;
      if (calcS > 2) { calcS = 1; calcY++; }
      nextY = calcY; nextS = calcS;
  }
  await pool.query('UPDATE user_settings SET pending_year = $1, pending_semester = $2 WHERE user_id = $3', [nextY, nextS, ctx.from.id]);
  await transformMenu(ctx, STRINGS[lang].selectDept, getDepartmentKeyboard());
});

bot.callbackQuery(/^dept_(.+)$/, async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  const chosenDept = ctx.match[1];
  await setPendingDepartment(ctx.from.id, chosenDept);
  const { lang } = await getUserState(ctx.from.id);
  await transformMenu(ctx, STRINGS[lang].sendReceiptPrompt.replace('{dept}', escapeHtml(chosenDept)), null);
});

bot.callbackQuery('cmd_modules', async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  const { lang, status, userSeason } = await getUserState(ctx.from.id);
  const currentSeason = await getGlobalTerm();
  if (status !== 'APPROVED' || userSeason < currentSeason) {
    return transformMenu(ctx, `🔒 <b>VAULT ACCESS DENIED</b>\n━━━━━━━━━━━━━━━━━━━━\n<blockquote>You must submit an updated clearance receipt to unlock materials for this new season.</blockquote>`, await buildStudentMenu(ctx.from.id, lang, status));
  }
  const res = await pool.query("SELECT department FROM tickets WHERE user_id = $1 AND status = 'APPROVED' ORDER BY updated_at DESC LIMIT 1", [ctx.from.id]);
  const studentDept = res.rows[0].department.replace(/\s*\((Regular \/ Term\vert{}4-Year Complete)\)$/, '').trim();
  const mods = await pool.query("SELECT id, title FROM department_modules WHERE department ILIKE $1 ORDER BY id ASC", [`%${studentDept}%`]);
  
  if (mods.rows.length === 0) return transformMenu(ctx, `📚 <b>VAULT EMPTY</b>\n━━━━━━━━━━━━━━━━━━━━\n<blockquote>No documents actively listed for <code>${escapeHtml(studentDept)}</code>.</blockquote>`, await buildStudentMenu(ctx.from.id, lang, status));
  
  const kb = new InlineKeyboard();
  mods.rows.forEach((m) => kb.text(`📄 ${m.title}`, `dlmod_${m.id}`).row());
  kb.text("🔙 Home Menu", "cmd_menu");
  await transformMenu(ctx, `📚 <b>SECURE VAULT: <code>${escapeHtml(studentDept)}</code></b>\n━━━━━━━━━━━━━━━━━━━━\n<i>Select document to execute download:</i>`, kb);
});

bot.callbackQuery('cmd_menu', async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  const { lang, status } = await getUserState(ctx.from.id);
  await transformMenu(ctx, STRINGS[lang].portalWelcome, await buildStudentMenu(ctx.from.id, lang, status));
});

bot.callbackQuery('cmd_history', async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  const { lang, status } = await getUserState(ctx.from.id);
  const res = await pool.query("SELECT department, status, academic_year, academic_semester, created_at FROM tickets WHERE user_id = $1 AND status != 'WIPED' ORDER BY created_at DESC LIMIT 10", [ctx.from.id]);
  if (res.rows.length === 0) return transformMenu(ctx, "ℹ️ <b>SYSTEM ALERT:</b> Log history empty.", await buildStudentMenu(ctx.from.id, lang, status));

  let text = "📜 <b>PROFILE AUDIT LOGS:</b>\n━━━━━━━━━━━━━━━━━━━━\n";
  for (let idx = 0; idx < res.rows.length; idx++) {
    const r = res.rows[idx];
    const icon = r.status === 'APPROVED' ? "✅" : "❌";
    text += `<code>[${idx + 1}]</code> ${icon} <b>${escapeHtml(r.department)} (Y${r.academic_year || 1}S${r.academic_semester || 1})</b>\n`;
  }
  await transformMenu(ctx, text, await buildStudentMenu(ctx.from.id, lang, status));
});

bot.callbackQuery('cmd_help', async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  const { lang, status } = await getUserState(ctx.from.id);
  await transformMenu(ctx, STRINGS[lang].helpText, await buildStudentMenu(ctx.from.id, lang, status));
});

bot.callbackQuery('cmd_pending_info', async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  const { lang, status } = await getUserState(ctx.from.id);
  const text = lang === 'am' ? "⏳ <b>ማመልከቻዎ በግምገማ ላይ ነው...</b>\nበአሁኑ ወቅት አዲስ ደረሰኝ መላክ አይችሉም።" : "⏳ <b>SYSTEM LOCKOUT: PENDING REVIEW</b>\n<blockquote>Your submission is currently under active analysis. Duplicate submissions are disabled.</blockquote>";
  await transformMenu(ctx, text, await buildStudentMenu(ctx.from.id, lang, status));
});

bot.callbackQuery('cmd_cancel_pending', async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  const userId = ctx.from.id;
  const { lang } = await getUserState(userId);
  const activeCheck = await pool.query("SELECT id, message_id, ticket_msg_id FROM tickets WHERE user_id = $1 AND status = 'PENDING' ORDER BY updated_at DESC LIMIT 1", [userId]);
  if (activeCheck.rows.length === 0) return;
  
  const t = activeCheck.rows[0];
  const staffGroupId = await getActiveStaffGroupId();
  await pool.query("DELETE FROM tickets WHERE id = $1", [t.id]);
  
  if (staffGroupId && t.message_id && t.ticket_msg_id) {
     try {
       await ctx.api.deleteMessage(staffGroupId, Number(t.message_id));
       await ctx.api.deleteMessage(staffGroupId, Number(t.ticket_msg_id));
     } catch(e) {}
  }
  await transformMenu(ctx, "✅ <b>SUBMISSION CANCELLED</b>\nYour pending receipt was aggressively withdrawn.", await buildStudentMenu(userId, lang, null));
});

bot.callbackQuery('cmd_download_pdf', async (ctx) => {
  const { lang, status, userSeason } = await getUserState(ctx.from.id);
  const currentSeason = await getGlobalTerm();
  if (status !== 'APPROVED' || userSeason < currentSeason) return ctx.answerCallbackQuery("⚠️ No valid clearance.");
  
  const res = await pool.query("SELECT department, username, academic_year, academic_semester FROM tickets WHERE user_id = $1 AND status = 'APPROVED' ORDER BY updated_at DESC LIMIT 1", [ctx.from.id]);
  const t = res.rows[0];
  try {
    await ctx.answerCallbackQuery("Generating encrypted PDF...");
    const pdfBuf = await generateApprovalPDF(ctx.from.id, t.username, t.department, 'Finance Office', bot.botInfo?.username, lang, t.academic_year || 1, t.academic_semester || 1);
    await ctx.replyWithDocument(new InputFile(pdfBuf, `Clearance_${ctx.from.id}.pdf`));
  } catch (e) { 
    ctx.answerCallbackQuery("Error generating PDF."); 
  }
});

bot.callbackQuery(/^dlmod_(\d+)$/, async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  const modId = Number(ctx.match[1]);
  const res = await pool.query("SELECT title, file_id FROM department_modules WHERE id = $1", [modId]);
  if (res.rows.length === 0) return ctx.reply("⚠️ <b>ERROR 404:</b> Document purged or corrupted.", { parse_mode: 'HTML' });
  try { await pool.query("INSERT INTO module_downloads (module_id, user_id) VALUES ($1, $2) ON CONFLICT (module_id, user_id) DO NOTHING", [modId, ctx.from.id]); } catch (e) {}
  try { await ctx.replyWithDocument(res.rows[0].file_id, { caption: `📖 <b>${escapeHtml(res.rows[0].title)}</b>\n<blockquote><i>Classified: Renaissance Global Course Module</i></blockquote>`, parse_mode: 'HTML' }); } catch (e) {}
});

// ============================================================================
// ADMIN STAFF CALLBACK QUERIES (RESTORED BUTTON LISTENERS)
// ============================================================================

bot.callbackQuery('cmd_approved_roster', async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  if (!(await isStaff(ctx))) return;
  await ctx.reply("👥 <b>ACCESS APPROVED DIRECTORY</b>\n━━━━━━━━━━━━━━━━━━━━\n<i>Filter database by departmental parameters:</i>", { message_thread_id: ctx.callbackQuery.message.message_thread_id, parse_mode: 'HTML', reply_markup: getApprovedRosterKeyboard() });
});

bot.callbackQuery(/^roster_(.+)$/, async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  const targetDept = ctx.match[1];
  if (targetDept === 'cancel') return ctx.editMessageText("❌ <b>OPERATION ABORTED:</b> Directory search cancelled.", { parse_mode: 'HTML' });
  const isAll = targetDept === 'all';
  const cleanDept = targetDept.replace(/\s*\((Regular \/ Term\vert{}4-Year Complete)\)$/, '').trim();
  let query = `SELECT t.user_id, t.username, t.department, t.processed_by, t.updated_at FROM tickets t INNER JOIN (SELECT user_id, MAX(updated_at) as max_date FROM tickets WHERE status = 'APPROVED' GROUP BY user_id) latest ON t.user_id = latest.user_id AND t.updated_at = latest.max_date WHERE t.status = 'APPROVED'`;
  const params = [];
  if (!isAll) { query += ` AND t.department ILIKE $1`; params.push(`%${cleanDept}%`); }
  query += ` ORDER BY t.department ASC, t.updated_at DESC LIMIT 100`;
  const res = await pool.query(query, params);
  if (res.rows.length === 0) return ctx.editMessageText(`ℹ️ <b>DATABASE EMPTY:</b> No approved records in <b>${escapeHtml(cleanDept)}</b>.`, { parse_mode: 'HTML' });
  
  let text = `🎓 <b>DATABASE EXPORT: ${escapeHtml(isAll ? "ALL DEPARTMENTS" : cleanDept.toUpperCase())}</b> (<code>${res.rows.length}</code> Total)\n━━━━━━━━━━━━━━━━━━━━\n`;
  for (let idx = 0; idx < res.rows.length; idx++) {
    const r = res.rows[idx];
    let itemText = `<code>[${idx + 1}]</code> <b>${escapeHtml(r.username ? `@${r.username}` : `[No @username]`)}</b> (UID: <code>${r.user_id}</code>)\n`;
    if ((text + itemText).length > 3800) { await ctx.reply(text, { parse_mode: 'HTML', message_thread_id: ctx.callbackQuery.message.message_thread_id }); text = ""; }
    text += itemText;
  }
  if (text.trim().length > 0) await ctx.reply(text, { parse_mode: 'HTML', message_thread_id: ctx.callbackQuery.message.message_thread_id });
});

bot.callbackQuery('cmd_lookfor', async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  await ctx.reply("🔍 <b>DATABASE RECORD QUERY</b>\n━━━━━━━━━━━━━━━━━━━━\n\n<i>Reply directly to this system message with a target <b>UID</b>, <b>@username</b>, or <b>Department Name</b>.</i>", { message_thread_id: ctx.callbackQuery.message.message_thread_id, parse_mode: 'HTML', reply_markup: { force_reply: true } });
});

bot.callbackQuery('cmd_upload_module', async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  if (!(await isStaff(ctx))) return;
  await ctx.reply("📂 <b>VAULT INGESTION PROTOCOL</b>\n━━━━━━━━━━━━━━━━━━━━\n<i>Select target departmental array:</i>", { message_thread_id: ctx.callbackQuery.message.message_thread_id, parse_mode: 'HTML', reply_markup: getModuleDepartmentKeyboard() });
});

bot.callbackQuery(/^moddept_(.+)$/, async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  if (ctx.match[1] === 'cancel') { await clearStaffPendingModuleDept(ctx.from.id); return ctx.editMessageText("❌ <b>OPERATION ABORTED:</b> Ingestion cancelled.", { parse_mode: 'HTML' }); }
  await setStaffPendingModuleDept(ctx.from.id, ctx.match[1]);
  await ctx.editMessageText(`✅ <b>TARGET LOCKED:</b> <code>${escapeHtml(ctx.match[1])}</code>\n━━━━━━━━━━━━━━━━━━━━\n\n<i>System ready. Transmit or forward the PDF document to ingest.</i>`, { parse_mode: 'HTML' });
});

bot.callbackQuery('cmd_delete_module', async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  if (!(await isStaff(ctx))) return;
  await clearStaffPendingModuleDept(ctx.from.id);
  await ctx.reply("🗑 <b>MANAGE VAULT PURGE</b>\n━━━━━━━━━━━━━━━━━━━━\n<i>Select a departmental parameter to access its modules for deletion:</i>", { message_thread_id: ctx.callbackQuery.message.message_thread_id, parse_mode: 'HTML', reply_markup: getDeleteModuleDepartmentKeyboard() });
});

bot.callbackQuery(/^delmoddept_(.+)$/, async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  const dept = ctx.match[1];
  if (dept === 'cancel') return ctx.editMessageText("❌ <b>OPERATION ABORTED:</b> Vault purge cancelled.", { parse_mode: 'HTML' });
  const res = await pool.query("SELECT id, title FROM department_modules WHERE department ILIKE $1 ORDER BY id ASC", [`%${dept}%`]);
  if (res.rows.length === 0) return ctx.editMessageText(`ℹ️ <b>VAULT EMPTY:</b> No documents located for <b>${escapeHtml(dept)}</b>.`, { parse_mode: 'HTML' });
  const kb = new InlineKeyboard();
  res.rows.forEach((m) => kb.text(`🗑 REMOVE: ${m.title.substring(0,25)}...`, `confirm_delmod_${m.id}`).row());
  kb.text("🔙 ABORT PROCESS", "delmoddept_cancel");
  await ctx.editMessageText(`🗑 <b>TARGET SECURED: ${escapeHtml(dept)}</b>\n━━━━━━━━━━━━━━━━━━━━\n<i>Warning: Deleting a module instantly revokes access for all enrolled students.</i>`, { parse_mode: 'HTML', reply_markup: kb });
});

bot.callbackQuery(/^confirm_delmod_(\d+)$/, async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  const res = await pool.query("DELETE FROM department_modules WHERE id = $1 RETURNING title, department", [Number(ctx.match[1])]);
  if (res.rowCount === 0) return ctx.editMessageText("⚠️ <b>ERROR:</b> Document already purged or missing.", { parse_mode: 'HTML' });
  await ctx.editMessageText(`✅ <b>VAULT PURGE SUCCESSFUL</b>\n━━━━━━━━━━━━━━━━━━━━\n<blockquote>• <b>Title:</b> ${escapeHtml(res.rows[0].title)}\n• <b>Sector:</b> ${escapeHtml(res.rows[0].department)}</blockquote>\n\n<i>Document has been permanently eradicated.</i>`, { parse_mode: 'HTML' });
});

bot.callbackQuery('cmd_panel_changedept', async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  if (!(await isStaff(ctx))) return;
  await ctx.reply("🔄 <b>INITIATE DEPARTMENT OVERRIDE</b>\n\n<i>Reply directly to this system message with the target <b>Student ID</b>.</i>", { message_thread_id: ctx.callbackQuery.message.message_thread_id, parse_mode: 'HTML', reply_markup: { force_reply: true } });
});

bot.callbackQuery(/^chgdept_(\d+)_(mkt|biz|acc|agri|ed|log|cancel)$/, async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  const targetUserId = Number(ctx.match[1]);
  const deptCode = ctx.match[2];
  const staffName = `${ctx.from.first_name || ''} ${ctx.from.last_name || ''}`.trim() || `Staff`;

  if (deptCode === 'cancel') return ctx.editMessageText("❌ <b>OPERATION ABORTED:</b> Department override cancelled.", { parse_mode: 'HTML' });

  const deptMap = { mkt: "Marketing Management", biz: "Business Management", acc: "Accounting and finance", agri: "Agribusiness and Value chain management", ed: "Educational planning and management", log: "Logistics and Supply chain management" };
  const ticketRes = await pool.query("SELECT id, department, username, topic_id, message_id, ticket_msg_id, status, academic_year, academic_semester FROM tickets WHERE user_id = $1 AND status IN ('PENDING', 'APPROVED') ORDER BY updated_at DESC LIMIT 1", [targetUserId]);
  if (ticketRes.rows.length === 0) return ctx.editMessageText("⚠️ <b>ERROR:</b> Target record no longer active/approved.", { parse_mode: 'HTML' });

  const t = ticketRes.rows[0];
  const oldDept = t.department || '';
  const planSuffix = oldDept.includes("(4-Year Complete)") ? "(4-Year Complete)" : "(Regular / Term)";
  const newFullDept = `${deptMap[deptCode]} ${planSuffix}`;

  const staffGroupId = await getActiveStaffGroupId();
  const newTopicId = await getOrCreateDepartmentTopic(ctx, newFullDept, staffGroupId);

  await pool.query("UPDATE tickets SET department = $1, processed_by = $2, topic_id = $3, updated_at = CURRENT_TIMESTAMP WHERE id = $4", [newFullDept, staffName, newTopicId, t.id]);
  pushToGoogleSheet(targetUserId, t.username, newFullDept, t.status, staffName, 'Department Overridden');
  await ctx.editMessageText(`✅ <b>DEPARTMENT OVERRIDE SUCCESSFUL</b>\n━━━━━━━━━━━━━━━━━━━━\n<blockquote>• <b>Target UID:</b> <code>${targetUserId}</code>\n• <b>New Assignment:</b> ${escapeHtml(newFullDept)}\n• <b>Authorized By:</b> ${escapeHtml(staffName)}</blockquote>`, { parse_mode: 'HTML' });

  try {
    const { lang } = await getUserState(targetUserId);
    const msgUpdate = lang === 'am' ? `🔄 <b>የትምህርት ክፍልዎ ተቀይሯል</b>\nአዲሱ ክፍልዎ፡ <b>${escapeHtml(newFullDept)}</b>` : `🔄 <b>ACADEMIC PLACEMENT UPDATED</b>\nYour system profile has been transferred to:\n👉 <b>${escapeHtml(newFullDept)}</b>`;
    await ctx.api.sendMessage(targetUserId, `🔔 <b>STATUS UPDATE:</b>\n\n${msgUpdate}`, { parse_mode: 'HTML' });
  } catch (err) {}
});

bot.callbackQuery('cmd_panel_revoke', async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  if (!(await isStaff(ctx))) return;
  await ctx.reply("⚠️ <b>INITIATE STATUS REVOCATION</b>\n\n<i>Reply directly to this system message with the target <b>Student ID</b>.</i>", { message_thread_id: ctx.callbackQuery.message.message_thread_id, parse_mode: 'HTML', reply_markup: { force_reply: true } });
});

bot.callbackQuery('cmd_stats', async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  await ctx.reply(`${await generateSummaryText('APPROVED')}\n\n---\n\n${await generateSummaryText('REJECTED')}`, { message_thread_id: ctx.callbackQuery.message.message_thread_id, parse_mode: 'HTML' });
});

bot.callbackQuery('cmd_mod_analytics', async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  if (!(await isStaff(ctx))) return;
  const res = await pool.query(`SELECT m.id, m.title, m.department, COUNT(DISTINCT d.user_id) AS total_downloads FROM department_modules m LEFT JOIN module_downloads d ON m.id = d.module_id GROUP BY m.id, m.title, m.department ORDER BY m.department ASC, total_downloads DESC`);
  if (res.rows.length === 0) return ctx.reply("📊 <b>VAULT ANALYTICS:</b> Storage array empty.", { message_thread_id: ctx.callbackQuery.message.message_thread_id, parse_mode: 'HTML' });
  let text = "📈 <b>VAULT ENGAGEMENT TELEMETRY</b>\n━━━━━━━━━━━━━━━━━━━━\n";
  for (const row of res.rows) {
    const cleanDept = row.department.replace(/\s*\((Regular \/ Term\vert{}4-Year Complete)\)$/, '').trim();
    const enrolledRes = await pool.query("SELECT COUNT(DISTINCT user_id) as count FROM tickets WHERE status = 'APPROVED' AND department ILIKE $1", [`%${cleanDept}%`]);
    const totalEnrolled = Number(enrolledRes.rows[0].count) || 0;
    const downloads = Number(row.total_downloads);
    const percentage = totalEnrolled > 0 ? Math.round((downloads / totalEnrolled) * 100) : 0;
    text += `• <b>${escapeHtml(row.title)}</b>\n  ↳ Penetration: <b><code>${downloads}/${totalEnrolled}</code> profiles</b> (<code>${percentage}%</code>)\n`;
  }
  await ctx.reply(text, { message_thread_id: ctx.callbackQuery.message.message_thread_id, parse_mode: 'HTML' });
});

bot.callbackQuery('cmd_export', async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  const staffGroupId = await getActiveStaffGroupId();
  const res = await pool.query(`SELECT user_id, username, department, status, rejection_reason, processed_by, created_at, updated_at FROM tickets ORDER BY department ASC, status ASC, updated_at DESC`);
  if (res.rows.length === 0) return ctx.reply("⚠️ <b>EMPTY DATABASE</b>", { message_thread_id: ctx.callbackQuery.message.message_thread_id, parse_mode: 'HTML' });
  let csv = "\uFEFFStudent Telegram ID,Username,Department,Status,Rejection Reason,Processed By,Created At,Updated At\n";
  res.rows.forEach(r => csv += `${r.user_id},${r.username},"${r.department}",${r.status},"${r.rejection_reason || ''}","${r.processed_by || ''}",${r.created_at},${r.updated_at}\n`);
  const filePath = path.join(__dirname, `audit_${Date.now()}.csv`);
  fs.writeFileSync(filePath, csv);
  await bot.api.sendDocument(staffGroupId, new InputFile(filePath), { message_thread_id: ctx.callbackQuery.message.message_thread_id, caption: "📄 <b>DATABASE BACKUP EXPORT</b>", parse_mode: "HTML" });
  fs.unlinkSync(filePath);
});

bot.callbackQuery('cmd_advance_term', async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  if (!(await isStaff(ctx))) return;
  const currentSeason = await getGlobalTerm();
  const newSeason = currentSeason + 1;
  await pool.query('UPDATE group_settings SET global_season = $1', [newSeason]);
  await ctx.reply(`🔓 <b>NEW REGISTRATION SEASON OPENED!</b>\n━━━━━━━━━━━━━━━━━━━━\n<blockquote><b>Active Cohort Season:</b> ${newSeason}</blockquote>\n\n<i>The global freeze has been lifted. The 'Transmit Receipt' button is now globally unlocked for all students.</i>`, { message_thread_id: ctx.callbackQuery.message.message_thread_id, parse_mode: 'HTML' });
});

bot.callbackQuery('cmd_broadcast', async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  await ctx.reply("📢 <b>INITIALIZE SYSTEM BROADCAST</b>\n━━━━━━━━━━━━━━━━━━━━\n\n<i>Reply directly to this system message with the exact announcement payload to transmit.</i>", { message_thread_id: ctx.callbackQuery.message.message_thread_id, parse_mode: 'HTML', reply_markup: { force_reply: true } });
});

bot.callbackQuery(/^app_(\d+)_(\d+)$/, async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  const userId = Number(ctx.match[1]);
  const staffName = `${ctx.from.first_name || ''} ${ctx.from.last_name || ''}`.trim() || `Staff`;
  const updateRes = await pool.query("UPDATE tickets SET status = 'APPROVED', processed_by = $1, updated_at = CURRENT_TIMESTAMP WHERE user_id = $2 AND status = 'PENDING' RETURNING department, username", [staffName, userId]);
  
  if (updateRes.rowCount === 0) return ctx.editMessageText("⚠️ <b>SYSTEM ERROR:</b> Record already finalized or expunged.", { parse_mode: 'HTML' });
  const { department, username } = updateRes.rows[0];
  const { lang } = await getUserState(userId);
  
  await ctx.api.sendMessage(userId, STRINGS[lang].approvedMsg).catch(()=>{});
  await dropMenu(userId, STRINGS[lang].portalWelcome, await buildStudentMenu(userId, lang, 'APPROVED'));
  
  await ctx.editMessageText(`✅ <b>CLEARANCE DIRECTIVE: AUTHORIZED</b>\n━━━━━━━━━━━━━━━━━━━━\n<blockquote>• <b>TARGET UID:</b> <code>${userId}</code>\n• <b>USER ALIAS:</b> @${escapeHtml(username) || 'N/A'}\n• <b>SECTOR:</b> ${escapeHtml(department)}\n• <b>CLEARED BY:</b> ${escapeHtml(staffName)}\n• <b>TIMESTAMP:</b> ${new Date().toLocaleString()}</blockquote>\n\n<i>Clearance authorized and system unlocked.</i>`, { parse_mode: 'HTML' });
});

bot.callbackQuery(/^rej_(\d+)_(\d+)$/, async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  const userId = Number(ctx.match[1]);
  const topicId = Number(ctx.match[2]);
  await ctx.editMessageText("❌ <b>INITIALIZE REJECTION SEQUENCE</b>\n━━━━━━━━━━━━━━━━━━━━\n<blockquote>Select the exact fault parameter below to instantly lock out the user and demand artifact re-transmission:</blockquote>", { parse_mode: 'HTML', reply_markup: getRejectionReasonKeyboard(userId, topicId) });
});

bot.callbackQuery(/^confirmrej_(\d+)_(\d+)_(.+)$/, async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  const userId = Number(ctx.match[1]);
  const code = ctx.match[3];
  const staffName = `${ctx.from.first_name || ''} ${ctx.from.last_name || ''}`.trim() || `Staff`;
  const reasonObj = REJECTION_REASONS.find(r => r.code === code);
  const reasonText = reasonObj ? reasonObj.label : "Artifact Unverifiable";

  const updateRes = await pool.query(`UPDATE tickets SET status = 'REJECTED', rejection_reason = $1, processed_by = $2, updated_at = CURRENT_TIMESTAMP WHERE user_id = $3 AND status = 'PENDING' RETURNING department, username`, [reasonText, staffName, userId]);
  if (updateRes.rowCount === 0) return ctx.editMessageText("⚠️ <b>SYSTEM ERROR:</b> Database mismatch or record wiped.", { parse_mode: 'HTML' });

  const { department, username } = updateRes.rows[0];
  const { lang } = await getUserState(userId);
  const customMessage = reasonObj ? (lang === 'am' ? reasonObj.message_am : reasonObj.message_en) : "Please re-upload.";
  const rejectText = STRINGS[lang].rejectedMsg.replace('{reason}', escapeHtml(reasonText)).replace('{message}', customMessage);
  
  try { await ctx.api.sendMessage(userId, `🔔 <b>STATUS UPDATE:</b>\n\n${rejectText}`, { parse_mode: 'HTML' }); } catch (e) {}
  await dropMenu(userId, STRINGS[lang].portalWelcome, await buildStudentMenu(userId, lang, 'REJECTED'));
  
  await ctx.editMessageText(`❌ <b>CLEARANCE DIRECTIVE: DENIED</b>\n━━━━━━━━━━━━━━━━━━━━\n<blockquote>• <b>TARGET UID:</b> <code>${userId}</code>\n• <b>USER ALIAS:</b> @${escapeHtml(username) || 'N/A'}\n• <b>OPERATOR:</b> ${escapeHtml(staffName)}\n• <b>FAULT PARAMETER:</b> ${escapeHtml(reasonText)}</blockquote>\n\n<i>Student terminal locked. Re-transmission demanded.</i>`, { parse_mode: 'HTML' });
});

bot.callbackQuery(/^trans_(\d+)_(\d+)$/, async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  await ctx.editMessageText("📂 <b>SELECT OVERRIDE PARAMETER:</b>\n━━━━━━━━━━━━━━━━━━━━\n<i>Select the correct department routing below:</i>", { parse_mode: 'HTML', reply_markup: getTransferKeyboard(Number(ctx.match[1]), Number(ctx.match[2])) });
});

bot.callbackQuery(/^canceltrans_(\d+)_(\d+)$/, async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  const res = await pool.query('SELECT username, department FROM tickets WHERE user_id = $1 AND topic_id = $2 AND status = \'PENDING\' LIMIT 1', [Number(ctx.match[1]), Number(ctx.match[2])]);
  if (res.rows.length === 0) return ctx.editMessageText("⚠️ <b>ERROR:</b> Database status mismatch.", { parse_mode: 'HTML' });
  const kb = new InlineKeyboard().text("✅ APPROVE", `app_${ctx.match[1]}_${ctx.match[2]}`).row().text("❌ REJECT", `rej_${ctx.match[1]}_${ctx.match[2]}`).row().text("🔄 OVERRIDE DEPT", `trans_${ctx.match[1]}_${ctx.match[2]}`);
  await ctx.editMessageText(`🚨 <b>NEW INCOMING DATA TRANSMISSION</b>\n━━━━━━━━━━━━━━━━━━━━\n<blockquote>👤 <b>STUDENT ALIAS:</b> @${escapeHtml(res.rows[0].username || 'Unknown')}\n🆔 <b>SYSTEM UID:</b> <code>${ctx.match[1]}</code>\n🏫 <b>TARGET SECTOR:</b> ${escapeHtml(res.rows[0].department)}</blockquote>\n━━━━━━━━━━━━━━━━━━━━\n⚠️ <i>FINANCE NODE: Analyze the appended transaction artifact above and execute a strict clearance directive below.</i>`, { parse_mode: 'HTML', reply_markup: kb });
});

bot.callbackQuery(/^tr_(\d+)_(\d+)_(mkt|biz|agri|ed|acc|log)$/, async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  const targetUserId = Number(ctx.match[1]);
  const originTopicId = Number(ctx.match[2]);
  const staffGroupId = await getActiveStaffGroupId();
  if (!staffGroupId) return;

  const ticketRes = await pool.query('SELECT topic_id, message_id, ticket_msg_id, username, department, academic_year, academic_semester FROM tickets WHERE user_id = $1 AND topic_id = $2 AND status = \'PENDING\' ORDER BY updated_at DESC LIMIT 1', [targetUserId, originTopicId]);
  if (ticketRes.rows.length === 0) return ctx.editMessageText("⚠️ <b>ERROR:</b> Artifact processed or vanished.", { parse_mode: 'HTML' });

  const deptMap = { mkt: "Marketing Management", biz: "Business Management", agri: "Agribusiness and Value chain management", ed: "Educational planning and management", acc: "Accounting and finance", log: "Logistics and Supply chain management" };
  const planSuffix = ticketRes.rows[0].department.includes("(4-Year Complete)") ? "(4-Year Complete)" : "(Regular / Term)";
  const newDeptTagged = `${deptMap[ctx.match[3]]} ${planSuffix}`;
  const newTopicId = await getOrCreateDepartmentTopic(ctx, newDeptTagged, staffGroupId);

  const newForwardRes = await ctx.api.copyMessage(staffGroupId, staffGroupId, Number(ticketRes.rows[0].message_id), { message_thread_id: newTopicId });
  const kb = new InlineKeyboard().text("✅ APPROVE", `app_${targetUserId}_${newTopicId}`).row().text("❌ REJECT", `rej_${targetUserId}_${newTopicId}`).row().text("🔄 OVERRIDE DEPT", `trans_${targetUserId}_${newTopicId}`);
  const newTicketMsg = await ctx.api.sendMessage(staffGroupId, `🚨 <b>NEW INCOMING DATA (RE-ROUTED)</b>\n━━━━━━━━━━━━━━━━━━━━\n<blockquote>👤 <b>STUDENT ALIAS:</b> @${escapeHtml(ticketRes.rows[0].username)}\n🆔 <b>SYSTEM UID:</b> <code>${targetUserId}</code>\n🏫 <b>TARGET SECTOR:</b> ${escapeHtml(newDeptTagged)}</blockquote>\n━━━━━━━━━━━━━━━━━━━━\n⚠️ <i>FINANCE NODE: Analyze the appended transaction artifact above.</i>`, { message_thread_id: newTopicId, parse_mode: 'HTML', reply_markup: kb });

  await pool.query(`UPDATE tickets SET department = $1, topic_id = $2, message_id = $3, ticket_msg_id = $4, updated_at = CURRENT_TIMESTAMP WHERE user_id = $5 AND status = 'PENDING'`, [newDeptTagged, newTopicId, newForwardRes.message_id, newTicketMsg.message_id, targetUserId]);

  try { await ctx.api.deleteMessage(staffGroupId, Number(ticketRes.rows[0].message_id)); } catch (e) {}
  try { await ctx.api.deleteMessage(staffGroupId, Number(ticketRes.rows[0].ticket_msg_id)); } catch (e) {}

  try {
    const { lang } = await getUserState(targetUserId);
    const msgUpdate = lang === 'am' ? `🔄 <b>መረጃዎ ተስተካክሏል</b>\nየደረሰኝ ማመልከቻዎ ወደ <b>${escapeHtml(newDeptTagged)}</b> ተዛውሯል።` : `🔄 <b>DATABASE UPDATE</b>\nYour dossier has been transferred to <b>${escapeHtml(newDeptTagged)}</b>.`;
    await ctx.api.sendMessage(targetUserId, `🔔 <b>STATUS UPDATE:</b>\n\n${msgUpdate}`, { parse_mode: 'HTML' });
    await dropMenu(targetUserId, STRINGS[lang].portalWelcome, await buildStudentMenu(targetUserId, lang, 'PENDING'));
  } catch (e) {}
});

bot.callbackQuery(/^notify_mod_(\d+)$/, async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  if (!(await isStaff(ctx))) return;
  const modRes = await pool.query('SELECT title, department FROM department_modules WHERE id = $1', [Number(ctx.match[1])]);
  if (modRes.rows.length === 0) return ctx.editMessageText("⚠️ <b>ERROR:</b> Target document missing from Vault.", { parse_mode: 'HTML' });
  const { title, department } = modRes.rows[0];
  const cleanDept = department.replace(/\s*\((Regular \/ Term\vert{}4-Year Complete)\)$/, '').trim();
  const currentSeason = await getGlobalTerm();
  const studentsRes = await pool.query("SELECT DISTINCT user_id, global_season FROM tickets WHERE status = 'APPROVED' AND department ILIKE $1", [`%${cleanDept}%`]);
  let sentCount = 0;
  for (const s of studentsRes.rows) {
    if ((s.global_season || 1) >= currentSeason) {
        try {
          const lang = await getUserLang(s.user_id);
          const dlKb = new InlineKeyboard().text(lang === 'am' ? "⬇️ ሞጁሉን አውርድ" : "⬇️ INITIATE DOWNLOAD", `dlmod_${ctx.match[1]}`);
          await bot.api.sendMessage(s.user_id, lang === 'am' ? `📚 <b>አዲስ የትምህርት ሞጁል ተጭኗል!</b>\n━━━━━━━━━━━━━━━━━━━━\n<blockquote>• <b>ክፍል:</b> ${escapeHtml(cleanDept)}\n• <b>ሞጁል:</b> ${escapeHtml(title)}</blockquote>\n\n<i>ከታች ያለውን ቁልፍ በመጫን ፋይሉን ያውርዱ፡</i>` : `📚 <b>VAULT UPDATE: NEW MODULE SECURED</b>\n━━━━━━━━━━━━━━━━━━━━\n<blockquote>• <b>Department:</b> ${escapeHtml(cleanDept)}\n• <b>File Title:</b> ${escapeHtml(title)}</blockquote>\n\n<i>Authorized users may initiate download below:</i>`, { parse_mode: 'HTML', reply_markup: dlKb });
          sentCount++; 
        } catch (e) {}
    }
  }
  await ctx.editMessageText(`📢 <b>SYSTEM BROADCAST SUCCESSFUL</b>\n━━━━━━━━━━━━━━━━━━━━\n<blockquote>• <b>Delivered to:</b> <code>${sentCount}</code> nodes.</blockquote>`, { parse_mode: 'HTML' });
});

bot.callbackQuery('dismiss_mod_notify', async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  await ctx.editMessageText("🔕 <b>STEALTH MODE:</b> Document ingested silently. Broadcast skipped.", { parse_mode: 'HTML' });
});

// ============================================================================
// CRON JOBS & SERVER STARTUP
// ============================================================================

cron.schedule('0 8 * * *', async () => {
  try {
    const staffGroupId = await getActiveStaffGroupId();
    if (!staffGroupId) return;
    const pendingRes = await pool.query("SELECT COUNT(*) as count FROM tickets WHERE status = 'PENDING'");
    const text = `🌅 <b>SYSTEM CHRON REPORT (DAILY)</b>\n━━━━━━━━━━━━━━━━━━━━\n\n⏳ <b>Unprocessed Packets:</b> <code>${pendingRes.rows[0].count}</code>`;
    await bot.api.sendMessage(staffGroupId, text, { message_thread_id: APPROVED_THREAD_ID || null, parse_mode: 'HTML' });
  } catch (err) {}
});

cron.schedule('0 10 * * *', async () => {
  try {
    const currentSeason = await getGlobalTerm();
    const stuckUsers = await pool.query(`SELECT u.user_id, u.language, u.pending_department FROM user_settings u LEFT JOIN tickets t ON u.user_id = t.user_id AND t.global_season = $1 WHERE u.pending_department IS NOT NULL AND (t.user_id IS NULL OR t.status != 'PENDING')`, [currentSeason]);
    for (const row of stuckUsers.rows) {
      const msg = row.language === 'am' ? `⚠️ <b>ማሳሰቢያ: ማመልከቻዎ አልተጠናቀቀም!</b>\n━━━━━━━━━━━━━━━━━━━━\n<blockquote>ለ <b>${escapeHtml(row.pending_department)}</b> ምዝገባ ጀምረዋል፣ ነገር ግን የክፍያ ደረሰኝ አላስገቡም።</blockquote>` : `⚠️ <b>SYSTEM ALERT: INCOMPLETE REGISTRATION</b>\n━━━━━━━━━━━━━━━━━━━━\n<blockquote>You initiated clearance for <b>${escapeHtml(row.pending_department)}</b> but have not transmitted a receipt photo.</blockquote>`;
      try { await bot.api.sendMessage(row.user_id, msg, { parse_mode: 'HTML' }); } catch (e) {}
    }
  } catch (err) {}
});

app.use('/webhook', webhookCallback(bot, 'express'));
app.get('/', (req, res) => res.send('Renaissance Operations Matrix Active'));

async function main() {
  await initDB();
  try { await bot.init(); } catch (e) {}
  const url = process.env.RENDER_EXTERNAL_URL; 
  if (url) { 
    // REMOVED 'drop_pending_updates: true' to fix cold-start /start deletion bugs
    await bot.api.setWebhook(`${url}/webhook`); 
  }
  app.listen(PORT, () => console.log(`Live on ${PORT}`));
}
main();