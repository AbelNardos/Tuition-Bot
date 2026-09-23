process.env.TZ = 'Africa/Addis_Ababa';
require('dotenv').config();

const express = require('express');
const { Bot, InlineKeyboard, Keyboard, InputFile, webhookCallback } = require('grammy');
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const cors = require('cors');

// --- MODULAR IMPORTS ---
const { pool, initDB, getGlobalTerm } = require('./database');
const { generateApprovalPDF } = require('./pdf');
const { STRINGS, REJECTION_REASONS, getDepartmentKeyboard, getStaffKeyboard, getStudentKeyboard, getModuleDepartmentKeyboard, getDeleteModuleDepartmentKeyboard, getApprovedRosterKeyboard, getTransferKeyboard, getRejectionReasonKeyboard } = require('./ui');

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

// ============================================================================
// INTERNAL DB HELPERS & STAFF CHECKS
// ============================================================================

function getTermScore(year, sem) { return (parseInt(year) * 10) + parseInt(sem); }
function escapeHtml(str) { return str ? String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') : ''; }
function formatDeptForDashboard(dept) { let c = String(dept || '').replace(/\s*\((Regular \/ Term|4-Year Complete)\)/ig, '').trim(); return c || 'Unassigned'; }

async function getActiveStaffGroupId() {
  try {
    const res = await pool.query('SELECT group_id FROM group_settings WHERE is_active = TRUE ORDER BY updated_at DESC LIMIT 1');
    if (res.rows.length > 0) return res.rows[0].group_id;
  } catch (err) {}
  return String(process.env.STAFF_GROUP_ID || '').trim();
}

async function isStaff(ctx) {
  try {
    const staffGroupId = await getActiveStaffGroupId();
    if (!staffGroupId) return false;
    const member = await ctx.api.getChatMember(staffGroupId, ctx.from.id);
    return ['creator', 'administrator', 'member'].includes(member.status);
  } catch (err) { return false; }
}

async function getUserLang(userId) {
  try {
    const res = await pool.query('SELECT language FROM user_settings WHERE user_id = $1', [userId]);
    return res.rows[0]?.language || 'en';
  } catch (err) { return 'en'; }
}

async function setUserLang(userId, lang) {
  try { await pool.query(`INSERT INTO user_settings (user_id, language) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET language = $2`, [userId, lang]); } catch (err) {}
}

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

async function getOrCreateDepartmentTopic(ctx, departmentName, targetGroupId) {
  const baseDept = departmentName.replace(/\s*\((Regular \/ Term|4-Year Complete)\)$/, '').trim();
  const cached = await pool.query('SELECT topic_id FROM department_topics WHERE group_id = $1 AND department = $2 LIMIT 1', [targetGroupId, baseDept]);
  if (cached.rows.length > 0) return Number(cached.rows[0].topic_id);
  const newTopic = await ctx.api.createForumTopic(targetGroupId, `📁 [${baseDept}]`);
  const topicId = newTopic.message_thread_id;
  await pool.query('DELETE FROM department_topics WHERE group_id = $1 AND department = $2', [targetGroupId, baseDept]);
  await pool.query('INSERT INTO department_topics (group_id, department, topic_id) VALUES ($1, $2, $3)', [targetGroupId, baseDept, topicId]);
  return topicId;
}

async function getOrCreateModulesVaultTopic(ctx, targetGroupId) {
  const cached = await pool.query('SELECT modules_topic_id FROM group_settings WHERE group_id = $1 LIMIT 1', [targetGroupId]);
  if (cached.rows.length > 0 && cached.rows[0].modules_topic_id) return Number(cached.rows[0].modules_topic_id);
  const newTopic = await ctx.api.createForumTopic(targetGroupId, '📚 [COURSE MODULES VAULT]');
  const topicId = newTopic.message_thread_id;
  await pool.query('UPDATE group_settings SET modules_topic_id = $1 WHERE group_id = $2', [topicId, targetGroupId]);
  return topicId;
}

async function generateSummaryText(statusType) {
  const res = await pool.query(`SELECT department, COUNT(*) as count FROM tickets WHERE status = $1 GROUP BY department ORDER BY department ASC`, [statusType]);
  const icon = statusType === 'APPROVED' ? '✅' : '❌';
  let text = `📊 <b>${icon} ${statusType} RECEIPTS DIRECTORY</b>\n━━━━━━━━━━━━━━━━━━━━\n`;
  if (res.rows.length === 0) return text + `<blockquote><i>No ${statusType.toLowerCase()} records in database.</i></blockquote>`;
  text += `<blockquote>`;
  res.rows.forEach((r) => text += `• <b>${escapeHtml(r.department)}</b>: <code>${r.count}</code> student(s)\n`);
  text += `</blockquote>`;
  return text;
}

async function sendCSVExport(staffGroupId, threadId, captionText) {
  try {
    const res = await pool.query(`SELECT user_id, username, department, status, rejection_reason, processed_by, created_at, updated_at FROM tickets ORDER BY department ASC, status ASC, updated_at DESC`);
    if (res.rows.length === 0) return bot.api.sendMessage(staffGroupId, "⚠️ <b>EMPTY DATABASE:</b> No receipts found to export.", { message_thread_id: threadId, parse_mode: 'HTML' });
    let csv = "Student Telegram ID,Username,Department & Tag,Status,Rejection Reason,Processed By,Created At,Updated At\n";
    res.rows.forEach((r) => {
      const uname = r.username ? `"${r.username.replace(/"/g, '""')}"` : "";
      const reason = r.rejection_reason ? `"${r.rejection_reason.replace(/"/g, '""')}"` : "";
      const staff = r.processed_by ? `"${r.processed_by.replace(/"/g, '""')}"` : "";
      csv += `${r.user_id},${uname},"${r.department}",${r.status},${reason},${staff},${r.created_at},${r.updated_at}\n`;
    });
    const filePath = path.join(__dirname, 'receipts_audit.csv');
    fs.writeFileSync(filePath, csv);
    await bot.api.sendDocument(staffGroupId, new InputFile(filePath, `Receipts_Audit_${new Date().toISOString().split('T')[0]}.csv`), { message_thread_id: threadId, caption: captionText, parse_mode: 'HTML' });
  } catch (err) {
    await bot.api.sendMessage(staffGroupId, `❌ <b>SYSTEM ERROR:</b> ${err.message}`, { message_thread_id: threadId, parse_mode: 'HTML' });
  }
}

async function performSearch(ctx, query, topicId) {
  const cleanQuery = query.replace(/^@/, '');
  const res = await pool.query(`SELECT user_id, username, department, status, rejection_reason, processed_by, created_at, updated_at FROM tickets WHERE user_id::text = $1 OR LOWER(username) = LOWER($1) OR LOWER(department) LIKE LOWER($2) ORDER BY updated_at DESC LIMIT 10`, [cleanQuery, `%${cleanQuery}%`]);
  if (res.rows.length === 0) return ctx.reply(`🔍 <b>DATABASE QUERY FAILED:</b> No records matching <code>${escapeHtml(query)}</code>`, { message_thread_id: topicId, parse_mode: 'HTML' });
  let text = `🔍 <b>QUERY RESULTS:</b> <code>${escapeHtml(query)}</code> (${res.rows.length})\n━━━━━━━━━━━━━━━━━━━━\n\n`;
  res.rows.forEach((r, idx) => {
    let statusEmoji = r.status === 'APPROVED' ? "✅" : (r.status === 'REJECTED' ? "❌" : (r.status === 'WIPED' ? "🧹" : "⏳"));
    const uname = r.username ? `@${r.username}` : "N/A";
    const staff = r.processed_by ? `\n   ↳ <i>Cleared By: ${escapeHtml(r.processed_by)}</i>` : "";
    text += `<code>[${idx + 1}]</code> ${statusEmoji} <b>${escapeHtml(r.department)}</b>\n<blockquote>• <b>ID:</b> <code>${r.user_id}</code> (${escapeHtml(uname)})\n• <b>Status:</b> <b>${r.status}</b>${staff}\n• <b>Timestamp:</b> ${new Date(r.updated_at).toLocaleDateString()}</blockquote>\n\n`;
  });
  await ctx.reply(text, { message_thread_id: topicId, parse_mode: 'HTML' });
}

async function performBroadcast(ctx, topicId, broadcastMsg) {
  if (!broadcastMsg) return ctx.reply("⚠️ <b>ERROR:</b> Broadcast text payload cannot be empty.", { message_thread_id: topicId, parse_mode: 'HTML' });
  const usersRes = await pool.query('SELECT DISTINCT user_id FROM user_settings');
  let successCount = 0;
  await ctx.reply(`📢 <b>INITIATING SYSTEM BROADCAST:</b> Targeting <code>${usersRes.rows.length}</code> students...`, { message_thread_id: topicId, parse_mode: 'HTML' });
  for (const row of usersRes.rows) {
    try { await bot.api.sendMessage(row.user_id, `📢 <b>SYSTEM ANNOUNCEMENT / ማስታወቂያ</b>\n━━━━━━━━━━━━━━━━━━━━\n\n<blockquote>${escapeHtml(broadcastMsg)}</blockquote>`, { parse_mode: 'HTML' }); successCount++; await delay(50); } catch (err) {}
  }
  await ctx.reply(`✅ <b>BROADCAST TRANSMISSION COMPLETE</b>\n━━━━━━━━━━━━━━━━━━━━\n• <b>Delivered to:</b> <code>${successCount}</code> students`, { message_thread_id: topicId, parse_mode: 'HTML' });
}

async function pushToGoogleSheet(userId, username, fullDept, status, staffName, reasonText = '') {
  const webhook = process.env.GOOGLE_SHEETS_WEBHOOK;
  if (!webhook) return;
  try {
    const userRes = await pool.query('SELECT phone_number, language FROM user_settings WHERE user_id = $1', [userId]);
    const phone = userRes.rows[0]?.phone_number || 'N/A';
    const lang = userRes.rows[0]?.language || 'en';
    let planType = 'Regular / Term'; let cleanDept = fullDept || 'Unknown';
    if (cleanDept.includes('(4-Year Complete)')) { planType = '4-Year Complete'; cleanDept = cleanDept.replace(/\s*\((4-Year Complete)\)$/, '').trim(); } 
    else if (cleanDept.includes('(Regular / Term)')) { planType = 'Regular / Term'; cleanDept = cleanDept.replace(/\s*\((Regular \/ Term)\)$/, '').trim(); }
    const payload = { id: String(userId), username: username ? `@${username.replace('@', '')}` : 'N/A', phone: phone, dept: cleanDept, plan: planType, status: status, reason: reasonText, staff: staffName || 'System Action', time: new Date().toLocaleString('en-US', { timeZone: 'Africa/Addis_Ababa' }), lang: lang.toUpperCase() };
    await fetch(webhook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  } catch (err) {}
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

// ============================================================================
// SYSTEM COMMANDS
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
  if (ctx.chat.type === 'private') return ctx.reply("⚠️ <b>DENIED:</b> Execution requires a supergroup context with topics enabled.", { parse_mode: 'HTML' });
  if (!(await isStaff(ctx))) return ctx.reply("❌ <b>DENIED:</b> Root administrator privileges required.", { parse_mode: 'HTML' });
  const groupId = String(ctx.chat.id);
  const check = await pool.query('SELECT 1 FROM group_settings WHERE group_id = $1', [groupId]);
  if (check.rows.length > 0) await pool.query('UPDATE group_settings SET is_active = TRUE, updated_at = CURRENT_TIMESTAMP WHERE group_id = $1', [groupId]);
  else await pool.query('INSERT INTO group_settings (group_id, is_active) VALUES ($1, TRUE)', [groupId]);
  await ctx.reply("✅ <b>COMMAND CENTER SECURED</b>\n━━━━━━━━━━━━━━━━━━━━\n<blockquote>This group is now configured as the primary Staff Action Panel.</blockquote>", { parse_mode: 'HTML' });
});

bot.command('deadline', async (ctx) => {
  if (!(await isStaff(ctx))) return;
  const unapprovedUsers = await pool.query(`SELECT DISTINCT u.user_id, u.language FROM user_settings u LEFT JOIN tickets t ON u.user_id = t.user_id AND t.status = 'APPROVED' WHERE t.user_id IS NULL`);
  let sent = 0;
  await ctx.reply(`📢 <b>INITIATING DEADLINE BROADCAST:</b> Targeting <code>${unapprovedUsers.rows.length}</code> unapproved students...`, { parse_mode: 'HTML' });
  for (const row of unapprovedUsers.rows) {
    const lang = row.language || 'en';
    const msg = lang === 'am' ? `🚨 <b>የመጨረሻ ማሳሰቢያ: የክፍያ ጊዜው ሊያበቃ ነው</b>\n━━━━━━━━━━━━━━━━━━━━\n<blockquote>በሲስተማችን ላይ እስካሁን የክፍያ ማረጋገጫዎ አልጸደቀም። ሞጁሎች ከመቆለፋቸው በፊት እባክዎን ደረሰኝዎን አሁኑኑ ያስገቡ!</blockquote>` : `🚨 <b>CRITICAL DEADLINE WARNING</b>\n━━━━━━━━━━━━━━━━━━━━\n<blockquote>Our database indicates you do not have an APPROVED tuition clearance.</blockquote>\n\n<i>Failure to submit your receipt will result in locked course modules and revoked campus access. Please submit immediately.</i>`;
    try {
      const kb = new InlineKeyboard().text(lang === 'am' ? "📤 ደረሰኝ አስገባ" : "📤 TRANSMIT RECEIPT", "start_resubmit");
      await bot.api.sendMessage(row.user_id, msg, { parse_mode: 'HTML', reply_markup: kb });
      sent++;
    } catch (e) {}
  }
  await ctx.reply(`✅ <b>DEADLINE BROADCAST COMPLETE</b>\nDelivered to <code>${sent}</code> pending/unregistered students.`, { parse_mode: 'HTML' });
});

bot.command('start', async (ctx) => {
  if (ctx.match && typeof ctx.match === 'string' && ctx.match.startsWith('verify_')) {
    const verifyId = ctx.match.replace('verify_', '').trim();
    if (isNaN(Number(verifyId)) || verifyId === '') return ctx.reply("⚠️ <b>SYSTEM ERROR:</b> Invalid QR Code format.", { parse_mode: 'HTML' });
    const check = await pool.query("SELECT department, status, academic_year, academic_semester, updated_at FROM tickets WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 1", [verifyId]);
    if (check.rows.length === 0) return ctx.reply(`⚠️ <b>SYSTEM ERROR:</b> No official registration record found for UID <code>${escapeHtml(verifyId)}</code>`, { parse_mode: 'HTML' });
    const rec = check.rows[0];

    if (rec.status === 'APPROVED') {
      return ctx.reply(`✅ <b>OFFICIAL CLEARANCE STATUS: VALID</b>\n━━━━━━━━━━━━━━━━━━━━\n<blockquote>• <b>Student ID:</b> <code>${escapeHtml(verifyId)}</code>\n• <b>Department:</b> ${escapeHtml(rec.department)}\n• <b>Term:</b> Year ${rec.academic_year || 1} — Semester ${rec.academic_semester || 1}\n• <b>Status:</b> APPROVED & CLEARED\n• <b>Timestamp:</b> ${new Date(rec.updated_at).toLocaleDateString()}</blockquote>\n\n<i>This student is officially verified for campus integration.</i>`, { parse_mode: 'HTML' });
    } else {
      let statusStr = rec.status === 'WIPED' ? '❌ WIPED & REVOKED' : `❌ ${escapeHtml(rec.status)}`;
      return ctx.reply(`🚨 <b>OFFICIAL CLEARANCE STATUS: INVALID / VOID</b>\n━━━━━━━━━━━━━━━━━━━━\n<blockquote>• <b>Student ID:</b> <code>${escapeHtml(verifyId)}</code>\n• <b>Department:</b> ${escapeHtml(rec.department)}\n• <b>Status:</b> ${statusStr}</blockquote>\n\n⚠️ <b>CRITICAL WARNING:</b> This document is not authorized by administration. Confiscate or reject entry!`, { parse_mode: 'HTML' });
    }
  }

  if (ctx.chat.type === 'private') {
    await pool.query('UPDATE user_settings SET pending_department = NULL WHERE user_id = $1', [ctx.from.id]);
    await dropStudentMenu(ctx.from.id, "🌐 <b>SYSTEM LOCALIZATION / ቋንቋ ይምረጡ:</b>\n━━━━━━━━━━━━━━━━━━━━\n<blockquote>Select your preferred interface language below to initialize the portal.</blockquote>", { inline_keyboard: [[{text: "🇬🇧 ENGLISH", callback_data: "lang_en"}, {text: "🇪🇹 አማርኛ", callback_data: "lang_am"}]] });
  }
});

bot.command('panel', async (ctx) => {
  const authorized = await isStaff(ctx);
  if (!authorized && ctx.chat.type !== 'private') return;
  if (authorized) return ctx.reply("⚙️ <b>COMMAND CENTER ACTION PANEL</b>\n━━━━━━━━━━━━━━━━━━━━\n\n<i>Select a root administrative function below:</i>", { message_thread_id: ctx.message?.message_thread_id, parse_mode: 'HTML', reply_markup: getStaffKeyboard() });
  const lang = await getUserLang(ctx.from.id);
  await dropStudentMenu(ctx.from.id, STRINGS[lang].portalWelcome, await buildStudentMenu(ctx.from.id, lang));
});

bot.command('revoke', async (ctx) => {
  if (!(await isStaff(ctx))) return;
  const topicId = ctx.message.message_thread_id;
  let targetIdStr = ctx.message.text.replace(/^\/revoke/, '').trim();
  if (!targetIdStr && ctx.message.reply_to_message && ctx.message.reply_to_message.text) {
    const match = ctx.message.reply_to_message.text.match(/Student ID:\s*`?(\d+)`?/i) || ctx.message.reply_to_message.text.match(/ID:\s*<code.*?>(\d+)<\/code>/i) || ctx.message.reply_to_message.text.match(/Target UID: <code.*?>(\d+)<\/code>/i) || ctx.message.reply_to_message.text.match(/Target UID:\s*`?(\d+)`?/i);
    if (match) targetIdStr = match[1];
  }
  const targetUserId = Number(targetIdStr);
  if (!targetUserId) return ctx.reply("⚠️ <b>SYNTAX ERROR:</b>\nType: <code>/revoke &lt;UID&gt;</code>\n*Example:* <code>/revoke 123456789</code>", { message_thread_id: topicId, parse_mode: 'HTML' });
  
  const staffName = `${ctx.from.first_name || ''} ${ctx.from.last_name || ''}`.trim() || `Staff`;
  const updateRes = await pool.query(`UPDATE tickets SET status = 'REJECTED', rejection_reason = 'Revoked by Admin', processed_by = $1, processed_by_id = $2, updated_at = CURRENT_TIMESTAMP WHERE user_id = $3 AND status = 'APPROVED' RETURNING department, username`, [staffName, ctx.from.id, targetUserId]);
  if (updateRes.rowCount === 0) return ctx.reply("⚠️ <b>OVERRIDE FAILED:</b> No active clearance found.", { message_thread_id: topicId, parse_mode: 'HTML' });
  
  pushToGoogleSheet(targetUserId, updateRes.rows[0].username, updateRes.rows[0].department, 'REJECTED', staffName, 'Revoked by Admin');
  ctx.reply(`✅ <b>STATUS REVOKED</b>\nUID <code>${targetUserId}</code> has been locked out.`, { message_thread_id: topicId, parse_mode: 'HTML' });
});

bot.command(['changedept', 'changedep'], async (ctx) => {
  if (!(await isStaff(ctx))) return;
  const topicId = ctx.message.message_thread_id;
  let targetIdStr = ctx.message.text.replace(/^\/(changedept|changedep)/, '').trim();
  if (!targetIdStr && ctx.message.reply_to_message && ctx.message.reply_to_message.text) {
    const match = ctx.message.reply_to_message.text.match(/Student ID:\s*`?(\d+)`?/i) || ctx.message.reply_to_message.text.match(/ID:\s*<code.*?>(\d+)<\/code>/i) || ctx.message.reply_to_message.text.match(/Target UID: <code.*?>(\d+)<\/code>/i) || ctx.message.reply_to_message.text.match(/Target UID:\s*`?(\d+)`?/i);
    if (match) targetIdStr = match[1];
  }
  const targetUserId = Number(targetIdStr);
  if (!targetUserId) return ctx.reply("⚠️ <b>SYNTAX ERROR:</b>\nType: <code>/changedept &lt;UID&gt;</code>", { message_thread_id: topicId, parse_mode: 'HTML' });
  
  const kb = new InlineKeyboard().text("📈 MARKETING", `chgdept_${targetUserId}_mkt`).text("💼 BUSINESS", `chgdept_${targetUserId}_biz`).row().text("📊 ACCOUNTING", `chgdept_${targetUserId}_acc`).text("🌾 AGRIBUSINESS", `chgdept_${targetUserId}_agri`).row().text("📚 ED. PLANNING", `chgdept_${targetUserId}_ed`).text("🚚 LOGISTICS", `chgdept_${targetUserId}_log`).row().text("🔙 CANCEL OVERRIDE", `chgdept_${targetUserId}_cancel`);
  await ctx.reply(`📂 <b>SELECT NEW DEPARTMENT FOR UID <code>${targetUserId}</code>:</b>`, { message_thread_id: topicId, parse_mode: 'HTML', reply_markup: kb });
});

bot.command(['deletemodule', 'delmod'], async (ctx) => {
  if (!(await isStaff(ctx))) return;
  await ctx.reply("🗑 <b>MANAGE VAULT PURGE</b>\n━━━━━━━━━━━━━━━━━━━━\n<i>Select a departmental parameter to access its modules for deletion:</i>", { message_thread_id: ctx.message.message_thread_id, parse_mode: 'HTML', reply_markup: getDeleteModuleDepartmentKeyboard() });
});

bot.command(['approved', 'students'], async (ctx) => {
  if (!(await isStaff(ctx))) return;
  await ctx.reply("👥 <b>ACCESS APPROVED DIRECTORY</b>\n━━━━━━━━━━━━━━━━━━━━\n<i>Filter database by departmental parameters:</i>", { message_thread_id: ctx.message.message_thread_id, parse_mode: 'HTML', reply_markup: getApprovedRosterKeyboard() });
});

bot.command('module', async (ctx) => {
  if (!(await isStaff(ctx))) return;
  const staffGroupId = await getActiveStaffGroupId();
  if (!staffGroupId) return ctx.reply("⚠️ <b>DENIED:</b> Execute /bind protocol first.", { parse_mode: 'HTML' });
  const doc = ctx.message.document || ctx.message.reply_to_message?.document;
  if (!doc) return ctx.reply("⚠️ <b>SYNTAX ERROR:</b> Attach PDF via <code>/module Department | Title</code>", { parse_mode: 'HTML' });
  const parts = (ctx.message.caption || ctx.message.text || '').replace(/^\/(module|uploadmodule)/, '').trim().split('|').map(s => s.trim());
  if (parts.length < 2 || !parts[0] || !parts[1]) return ctx.reply("⚠️ <b>SYNTAX ERROR:</b> Strict parsing requires <code>&lt;Dept&gt; | &lt;Title&gt;</code>", { parse_mode: 'HTML' });
  const [dept, title] = parts;
  try {
    const vaultTopicId = await getOrCreateModulesVaultTopic(ctx, staffGroupId);
    const vaultMsg = await ctx.api.sendDocument(staffGroupId, doc.file_id, { message_thread_id: vaultTopicId, caption: `📚 <b>VAULT ARCHIVE INDEX</b>\n<blockquote>• <b>Department:</b> ${escapeHtml(dept)}\n• <b>File Title:</b> ${escapeHtml(title)}</blockquote>`, parse_mode: 'HTML' });
    const insRes = await pool.query("INSERT INTO department_modules (department, title, file_id, file_name) VALUES ($1, $2, $3, $4) RETURNING id", [dept, title, vaultMsg.document.file_id, doc.file_name || `${title}.pdf`]);
    try { await ctx.deleteMessage(); if (ctx.message.reply_to_message) await ctx.api.deleteMessage(ctx.chat.id, ctx.message.reply_to_message.message_id); } catch (e) {}
    const notifyKb = new InlineKeyboard().text("📢 BROADCAST TO NETWORK", `notify_mod_${insRes.rows[0].id}`).row().text("🔕 STEALTH INGEST", "dismiss_mod_notify");
    await ctx.reply(`✅ <b>DOCUMENT STASHED IN VAULT</b>\n━━━━━━━━━━━━━━━━━━━━\n<blockquote>• <b>Sector:</b> ${escapeHtml(dept)}\n• <b>Designation:</b> ${escapeHtml(title)}</blockquote>\n\n<i>Initiate network broadcast sequence?</i>`, { parse_mode: 'HTML', reply_markup: notifyKb });
  } catch (err) { ctx.reply(`❌ <b>CRITICAL ERROR:</b> ${err.message}`, { parse_mode: 'HTML' }); }
});

bot.command(['setterm', 'changeterm'], async (ctx) => {
  if (!(await isStaff(ctx))) return;
  const topicId = ctx.message.message_thread_id;
  const parts = ctx.message.text.split(' ');
  if (parts.length < 4) return ctx.reply("⚠️ <b>SYNTAX ERROR:</b>\nType: <code>/setterm &lt;UID&gt; &lt;Year&gt; &lt;Semester&gt;</code>", { message_thread_id: topicId, parse_mode: 'HTML' });
  const targetUid = Number(parts[1]); const newY = Number(parts[2]); const newS = Number(parts[3]);
  if (isNaN(targetUid) || isNaN(newY) || isNaN(newS)) return ctx.reply("⚠️ <b>ERROR:</b> Invalid numbers.", { message_thread_id: topicId, parse_mode: 'HTML' });
  await pool.query('UPDATE user_settings SET pending_year = $1, pending_semester = $2 WHERE user_id = $3', [newY, newS, targetUid]);
  ctx.reply(`✅ <b>TIMELINE OVERRIDE SUCCESSFUL</b>\nStudent <code>${targetUid}</code>'s next ticket will file as <b>Year ${newY} Semester ${newS}</b>. Historical data was left intact.`, { message_thread_id: topicId, parse_mode: 'HTML' });
});

bot.command('wipestudent', async (ctx) => {
  if (!(await isStaff(ctx))) return;
  const topicId = ctx.message.message_thread_id;
  const parts = ctx.message.text.split(' ');
  if (parts.length < 2) return ctx.reply("⚠️ <b>SYNTAX ERROR:</b>\nType: <code>/wipestudent &lt;UID&gt;</code>", { message_thread_id: topicId, parse_mode: 'HTML' });
  const targetUid = Number(parts[1]);
  if (isNaN(targetUid)) return ctx.reply("⚠️ <b>ERROR:</b> Invalid UID format.", { message_thread_id: topicId, parse_mode: 'HTML' });

  const staffName = `${ctx.from.first_name || ''} ${ctx.from.last_name || ''}`.trim() || `Staff`;

  const updateRes = await pool.query("UPDATE tickets SET status = 'WIPED', rejection_reason = 'System Profile Wiped by Admin', processed_by = $1, processed_by_id = $2, updated_at = CURRENT_TIMESTAMP WHERE user_id = $3 RETURNING username, department", [staffName, ctx.from.id, targetUid]);
  
  if (updateRes.rowCount === 0) {
    return ctx.reply(`❌ <b>WIPE FAILED: UID NOT FOUND</b>\nNo active database records exist for <code>${targetUid}</code>. Please double-check the Telegram ID for typos!`, { message_thread_id: topicId, parse_mode: 'HTML' });
  }

  const uname = updateRes.rows[0].username || 'Unknown';
  const dept = updateRes.rows[0].department || 'Unassigned';

  await pool.query('UPDATE user_settings SET pending_year = 1, pending_semester = 1, pending_department = NULL WHERE user_id = $1', [targetUid]);
  pushToGoogleSheet(targetUid, uname, dept, 'WIPED', staffName, 'System Profile Wiped by Admin');

  try {
    const resSettings = await pool.query('SELECT last_menu_msg_id FROM user_settings WHERE user_id = $1', [targetUid]);
    if (resSettings.rows.length > 0 && resSettings.rows[0].last_menu_msg_id) {
        await bot.api.deleteMessage(targetUid, Number(resSettings.rows[0].last_menu_msg_id));
        await pool.query('UPDATE user_settings SET last_menu_msg_id = NULL WHERE user_id = $1', [targetUid]);
    }
    const sLang = await getUserLang(targetUid);
    const wipeKb = await buildStudentMenu(targetUid, sLang, 'WIPED');
    await dropStudentMenu(targetUid, "🚫 <b>SYSTEM LOCKOUT</b>\n━━━━━━━━━━━━━━━━━━━━\nYour academic profile and historical records have been completely wiped by administration.\n\nAll previous clearances, modules, and PDF certificates are now securely revoked.\n\nClick below to begin a completely fresh registration.", wipeKb);
  } catch(e) {}

  ctx.reply(`✅ <b>STUDENT PROFILE WIPED</b>\nAll <code>${updateRes.rowCount}</code> historical tickets for <code>${targetUid}</code> have been securely revoked and marked as WIPED. Their menu has been locked down. They must start over.`, { message_thread_id: topicId, parse_mode: 'HTML' });
});

bot.command('resetglobal', async (ctx) => {
  if (!(await isStaff(ctx))) return;
  const topicId = ctx.message.message_thread_id;
  await pool.query('UPDATE group_settings SET global_season = 1');
  ctx.reply(`✅ <b>GLOBAL TERM RESET</b>\nThe entire campus timeline has been rolled back to <b>Season 1</b>.`, { message_thread_id: topicId, parse_mode: 'HTML' });
});

// --- TELEGRAM MESSAGE HANDLERS ---
bot.on('message:contact', async (ctx) => {
  if (ctx.chat.type === 'private') {
    const phone = ctx.message.contact.phone_number;
    await pool.query('UPDATE user_settings SET phone_number = $1 WHERE user_id = $2', [phone, ctx.from.id]);
    const lang = await getUserLang(ctx.from.id);
    await ctx.reply(lang === 'am' ? "✅ <b>ስልክዎ ተመዝግቧል!</b>" : "✅ <b>Profile Verified!</b>", { parse_mode: 'HTML', reply_markup: { remove_keyboard: true } });
    await dropStudentMenu(ctx.from.id, STRINGS[lang].portalWelcome, await buildStudentMenu(ctx.from.id, lang));
  }
});

bot.on('message:photo', async (ctx) => {
  if (ctx.chat.type !== 'private' || ctx.from.is_bot) return;
  const userId = ctx.from.id;
  const lang = await getUserLang(userId);

  if (activeUploads.has(userId)) return;
  activeUploads.add(userId);

  try {
    const activeCheck = await pool.query("SELECT 1 FROM tickets WHERE user_id = $1 AND status = 'PENDING' LIMIT 1", [userId]);
    if (activeCheck.rows.length > 0) {
      return dropStudentMenu(userId, STRINGS[lang].pendingExists, await buildStudentMenu(userId, lang, 'PENDING'));
    }

    const pRes = await pool.query('SELECT pending_department, pending_year, pending_semester FROM user_settings WHERE user_id = $1', [userId]);
    const chosenDeptTagged = pRes.rows[0]?.pending_department;
    if (!chosenDeptTagged) {
      return dropStudentMenu(userId, lang === 'am' ? "⚠️ <b>ስህተት:</b> እባክዎን መጀመሪያ ክፍል ይምረጡ።" : "⚠️ <b>ERROR:</b> Missing assignment protocol! Select department first.", await buildStudentMenu(userId, lang));
    }

    const fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
    const staffGroupId = await getActiveStaffGroupId();
    if (!staffGroupId) return ctx.reply("⚠️ <b>SYSTEM HALT:</b> Telemetry link disconnected.");

    const pendingY = pRes.rows[0]?.pending_year || 1;
    const pendingS = pRes.rows[0]?.pending_semester || 1;
    const username = ctx.from.username || ctx.from.first_name || 'Unknown';
    const currentSeason = await getGlobalTerm();
    
    let dbTopicId = await getOrCreateDepartmentTopic(ctx, chosenDeptTagged, staffGroupId);
    let forwardRes;
    try {
      forwardRes = await ctx.api.copyMessage(staffGroupId, ctx.chat.id, ctx.message.message_id, { message_thread_id: dbTopicId });
    } catch (e) {
      if (e.message.includes('message thread not found')) {
          await pool.query('DELETE FROM department_topics WHERE topic_id = $1', [dbTopicId]);
          dbTopicId = await getOrCreateDepartmentTopic(ctx, chosenDeptTagged, staffGroupId);
          forwardRes = await ctx.api.copyMessage(staffGroupId, ctx.chat.id, ctx.message.message_id, { message_thread_id: dbTopicId });
      } else throw e;
    }
    
    const actionKb = new InlineKeyboard().text("✅ APPROVE", `app_${userId}_${dbTopicId}`).row().text("❌ REJECT", `rej_${userId}_${dbTopicId}`).row().text("🔄 OVERRIDE DEPT", `trans_${userId}_${dbTopicId}`);
    
    const cardMsg = `🧾 <b>NEW DATA UPLOAD DETECTED</b>\n━━━━━━━━━━━━━━━━━━━━\n<blockquote>👤 <b>Profile:</b> @${escapeHtml(username)}\n🆔 <b>UID:</b> <code>${userId}</code>\n🏫 <b>Target:</b> ${escapeHtml(chosenDeptTagged)}\n📅 <b>Personal Term:</b> Year ${pendingY} — Semester ${pendingS}</blockquote>\n━━━━━━━━━━━━━━━━━━━━\n⚡️ <i>Analyze the appended media artifact below.</i>`;
    const sentTicketMsg = await ctx.api.sendMessage(staffGroupId, cardMsg, { message_thread_id: dbTopicId, parse_mode: 'HTML', reply_markup: actionKb });
    
    await pool.query('UPDATE user_settings SET pending_department = NULL WHERE user_id = $1', [userId]);
    pushToGoogleSheet(userId, username, chosenDeptTagged, 'PENDING', 'Awaiting Review', '');
    
    await pool.query(`INSERT INTO tickets (user_id, username, receipt_file_id, topic_id, message_id, ticket_msg_id, department, status, academic_year, academic_semester, global_season) VALUES ($1, $2, $3, $4, $5, $6, $7, 'PENDING', $8, $9, $10)`, [userId, username, fileId, dbTopicId, forwardRes.message_id, sentTicketMsg.message_id, chosenDeptTagged, pendingY, pendingS, currentSeason]);
    
    const studentPanelMsg = await dropStudentMenu(userId, STRINGS[lang].receiptReceived, await buildStudentMenu(userId, lang, 'PENDING'));
    if (studentPanelMsg && studentPanelMsg.message_id) {
      await pool.query(`UPDATE tickets SET panel_msg_id = $1 WHERE user_id = $2 AND status = 'PENDING'`, [studentPanelMsg.message_id, userId]);
    }
  } catch (err) { 
    return ctx.reply(`❌ <b>ROUTING ERROR:</b> ${err.message}`, { parse_mode: 'HTML' }); 
  } finally {
    activeUploads.delete(userId);
  }
});

// --- CALLBACK QUERIES ---
bot.callbackQuery(/^lang_(en|am)$/, async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  const lang = ctx.match[1];
  await setUserLang(ctx.from.id, lang);
  const phoneRes = await pool.query('SELECT phone_number FROM user_settings WHERE user_id = $1', [ctx.from.id]);
  await pool.query('UPDATE user_settings SET last_menu_msg_id = $1 WHERE user_id = $2', [ctx.callbackQuery.message.message_id, ctx.from.id]);

  if (!phoneRes.rows[0] || !phoneRes.rows[0].phone_number) {
    const kb = new Keyboard().requestContact(lang === 'am' ? '📱 ስልክ ቁጥር አጋራ' : '📱 Share Phone Number').resized().oneTime();
    try { await ctx.deleteMessage(); } catch (e) {}
    return ctx.reply(lang === 'am' ? "⚠️ <b>ማረጋገጫ ያስፈልጋል:</b>\nእባክዎን ከታች ያለውን 'ስልክ ቁጥር አጋራ' የሚለውን ቁልፍ በመጫን ስልክዎን ያጋሩ።" : "⚠️ <b>VERIFICATION REQUIRED:</b>\nPlease tap the 'Share Phone Number' button below to register your profile.", { parse_mode: 'HTML', reply_markup: kb });
  }
  await dropStudentMenu(ctx.from.id, STRINGS[lang].portalWelcome, await buildStudentMenu(ctx.from.id, lang));
});

bot.callbackQuery('cmd_status', async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  const lang = await getUserLang(ctx.from.id);
  const currentSeason = await getGlobalTerm();
  const res = await pool.query("SELECT department, status, rejection_reason, academic_year, academic_semester, global_season FROM tickets WHERE user_id = $1 AND status != 'WIPED' ORDER BY updated_at DESC LIMIT 1", [ctx.from.id]);
  if (res.rows.length === 0) return dropStudentMenu(ctx.from.id, lang === 'am' ? "ℹ️ ምንም ማመልከቻ የለም።" : "ℹ️ <b>SYSTEM ALERT:</b> No active traces in database.", await buildStudentMenu(ctx.from.id, lang));

  const ticket = res.rows[0];
  let msg = `📊 <b>LIVE PROFILE TELEMETRY</b>\n━━━━━━━━━━━━━━━━━━━━\n<blockquote>• <b>Department:</b> ${escapeHtml(ticket.department)}\n• <b>Academic Term:</b> Year ${ticket.academic_year} — Semester ${ticket.academic_semester}</blockquote>\n`;

  if ((ticket.global_season || 1) < currentSeason && ticket.status === 'APPROVED') {
      msg += `\n⚠️ <b>ACTION REQUIRED:</b> A new registration season has opened. You must submit a new receipt to unlock the module vault.`;
  } else {
      let timeline = "";
      if (ticket.status === 'PENDING') timeline = lang === 'am' ? "<code>[1]</code> <b>ማመልከቻ መላክ:</b> ተጠናቋል\n<code>[2]</code> <b>የቢሮ ግምገማ:</b> ⏳ በመታየት ላይ\n<code>[3]</code> <b>ማጽደቅ:</b> 🔒 ተቆልፏል" : "<code>[1]</code> <b>DATA INGEST:</b> Verified\n<code>[2]</code> <b>STAFF AUDIT:</b> ⏳ In Progress\n<code>[3]</code> <b>CLEARANCE:</b> 🔒 Locked";
      else if (ticket.status === 'APPROVED') timeline = lang === 'am' ? "<code>[1]</code> <b>ማመልከቻ መላክ:</b> ተጠናቋል\n<code>[2]</code> <b>የቢሮ ግምገማ:</b> ተጠናቋል\n<code>[3]</code> <b>ማጽደቅ:</b> ✅ ጸድቋል" : "<code>[1]</code> <b>DATA INGEST:</b> Verified\n<code>[2]</code> <b>STAFF AUDIT:</b> Verified\n<code>[3]</code> <b>CLEARANCE:</b> ✅ ACTIVE";
      else timeline = lang === 'am' ? "<code>[1]</code> <b>ማመልከቻ መላክ:</b> ተጠናቋል\n<code>[2]</code> <b>የቢሮ ግምገማ:</b> ❌ ውድቅ ሆኗል" : "<code>[1]</code> <b>DATA INGEST:</b> Verified\n<code>[2]</code> <b>STAFF AUDIT:</b> ❌ DENIED";

      msg += `<blockquote>• <b>Status:</b> <b>${ticket.status}</b></blockquote>\n${timeline}\n`;
      if (ticket.rejection_reason) msg += `\n<blockquote><b>ROOT CAUSE:</b> ${escapeHtml(ticket.rejection_reason)}</blockquote>`;
  }
  await dropStudentMenu(ctx.from.id, msg, await buildStudentMenu(ctx.from.id, lang, ticket.status));
});

bot.callbackQuery('cmd_history', async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  const lang = await getUserLang(ctx.from.id);
  const res = await pool.query("SELECT id, department, status, rejection_reason, academic_year, academic_semester, created_at FROM tickets WHERE user_id = $1 AND status != 'WIPED' ORDER BY created_at DESC LIMIT 10", [ctx.from.id]);
  if (res.rows.length === 0) return dropStudentMenu(ctx.from.id, lang === 'am' ? "ℹ️ የክፍያ ታሪክ ባዶ ነው።" : "ℹ️ <b>SYSTEM ALERT:</b> Log history empty.", await buildStudentMenu(ctx.from.id, lang));

  let text = "📜 <b>PROFILE AUDIT LOGS:</b>\n━━━━━━━━━━━━━━━━━━━━\n";
  const kb = new InlineKeyboard(); let hasApproved = false;

  for (let idx = 0; idx < res.rows.length; idx++) {
    const r = res.rows[idx];
    const icon = r.status === 'APPROVED' ? "✅" : "❌";
    let itemText = `<code>[${idx + 1}]</code> ${icon} <b>${escapeHtml(r.department)} (Y${r.academic_year || 1}S${r.academic_semester || 1})</b>\n<blockquote>• <b>Status:</b> ${r.status}\n• <b>Timestamp:</b> ${new Date(r.created_at).toLocaleDateString()}</blockquote>\n`;
    if (r.rejection_reason) itemText += `⚠️ <i>Cause: ${escapeHtml(r.rejection_reason)}</i>\n`;
    itemText += `\n`;
    if (r.status === 'APPROVED') { kb.text(`📄 PDF: Y${r.academic_year || 1} Sem ${r.academic_semester || 1}`, `getpdf_${r.id}`).row(); hasApproved = true; }
    if ((text + itemText).length > 3800) { await ctx.reply(text, { parse_mode: 'HTML' }); text = ""; }
    text += itemText;
  }
  kb.text("🔙 Home Menu", "cmd_menu");
  if (text.trim().length > 0) await dropStudentMenu(ctx.from.id, text, hasApproved ? kb : await buildStudentMenu(ctx.from.id, lang));
});

bot.callbackQuery('cmd_submit', async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  const lang = await getUserLang(ctx.from.id);
  const lastAppr = await pool.query("SELECT academic_year, academic_semester FROM tickets WHERE user_id = $1 AND status != 'WIPED' ORDER BY updated_at DESC LIMIT 1", [ctx.from.id]);
  let nextY = 1, nextS = 1;
  if (lastAppr.rows.length > 0) {
      let calcY = lastAppr.rows[0].academic_year || 1;
      let calcS = (lastAppr.rows[0].academic_semester || 1) + 1;
      if (calcS > 2) { calcS = 1; calcY++; }
      nextY = calcY; nextS = calcS;
  }
  await pool.query('UPDATE user_settings SET pending_year = $1, pending_semester = $2 WHERE user_id = $3', [nextY, nextS, ctx.from.id]);
  await dropStudentMenu(ctx.from.id, STRINGS[lang].selectDept, getDepartmentKeyboard());
});

bot.callbackQuery('start_resubmit', async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  const lang = await getUserLang(ctx.from.id);
  await clearPendingDepartment(ctx.from.id);
  const lastAppr = await pool.query("SELECT academic_year, academic_semester FROM tickets WHERE user_id = $1 AND status != 'WIPED' ORDER BY updated_at DESC LIMIT 1", [ctx.from.id]);
  let nextY = 1, nextS = 1;
  if (lastAppr.rows.length > 0) {
      let calcY = lastAppr.rows[0].academic_year || 1;
      let calcS = (lastAppr.rows[0].academic_semester || 1) + 1;
      if (calcS > 2) { calcS = 1; calcY++; }
      nextY = calcY; nextS = calcS;
  }
  await pool.query('UPDATE user_settings SET pending_year = $1, pending_semester = $2 WHERE user_id = $3', [nextY, nextS, ctx.from.id]);
  await dropStudentMenu(ctx.from.id, STRINGS[lang].selectDept, getDepartmentKeyboard());
});

bot.callbackQuery('cmd_cancel_pending', async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  const userId = ctx.from.id;
  const lang = await getUserLang(userId);
  const activeCheck = await pool.query("SELECT id, topic_id, message_id, ticket_msg_id, department, username FROM tickets WHERE user_id = $1 AND status = 'PENDING' ORDER BY updated_at DESC LIMIT 1", [userId]);
  if (activeCheck.rows.length === 0) return dropStudentMenu(userId, "⚠️ No pending submissions found.", await buildStudentMenu(userId, lang));
  
  const t = activeCheck.rows[0];
  const staffGroupId = await getActiveStaffGroupId();
  await pool.query("DELETE FROM tickets WHERE id = $1", [t.id]);
  
  if (staffGroupId && t.message_id && t.ticket_msg_id) {
     try {
       await ctx.api.deleteMessage(staffGroupId, Number(t.message_id));
       await ctx.api.deleteMessage(staffGroupId, Number(t.ticket_msg_id));
     } catch(e) {}
  }
  const cancelMsg = lang === 'am' ? "✅ <b>ማመልከቻዎ ተሰርዟል</b>\nአሁን አዲስ ትክክለኛ ፎቶ መላክ ይችላሉ።" : "✅ <b>SUBMISSION CANCELLED</b>\nYour pending receipt was withdrawn. You may now upload a correct file.";
  await dropStudentMenu(userId, cancelMsg, await buildStudentMenu(userId, lang));
  pushToGoogleSheet(userId, t.username, t.department, 'CANCELLED', 'Student Withdrew');
});

bot.callbackQuery('cmd_advance_term', async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  if (!(await isStaff(ctx))) return;
  const currentSeason = await getGlobalTerm();
  const newSeason = currentSeason + 1;
  await pool.query('UPDATE group_settings SET global_season = $1', [newSeason]);
  await ctx.reply(`🔓 <b>NEW REGISTRATION SEASON OPENED!</b>\n━━━━━━━━━━━━━━━━━━━━\n<blockquote><b>Active Cohort Season:</b> ${newSeason}</blockquote>\n\n<i>The global freeze has been lifted. The 'Transmit Receipt' button is now globally unlocked for all students.</i>`, { message_thread_id: ctx.callbackQuery.message.message_thread_id, parse_mode: 'HTML' });
});

bot.callbackQuery(/^dept_(.+)$/, async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  const fullTaggedDept = ctx.match[1];
  await setPendingDepartment(ctx.from.id, fullTaggedDept);
  const lang = await getUserLang(ctx.from.id);
  await dropStudentMenu(ctx.from.id, STRINGS[lang].sendReceiptPrompt.replace('{dept}', escapeHtml(fullTaggedDept)), null);
});

bot.callbackQuery('cmd_pending_info', async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  const lang = await getUserLang(ctx.from.id);
  await dropStudentMenu(ctx.from.id, lang === 'am' ? "⏳ <b>ማመልከቻዎ በግምገማ ላይ ነው</b>\n\nየላኩት ደረሰኝ በመታየት ላይ ስለሆነ በአሁኑ ወቅት አዲስ ደረሰኝ መላክ አይችሉም። ማመልከቻዎን ለመሰረዝ ከፈለጉ 'ማመልከቻ ሰርዝ' የሚለውን ይጫኑ።" : "⏳ <b>SYSTEM LOCKOUT: PENDING REVIEW</b>\n\n<blockquote>Your submission is currently under active analysis by the Finance node. Duplicate submissions are disabled.</blockquote>", await buildStudentMenu(ctx.from.id, lang, 'PENDING'));
});

bot.callbackQuery('cmd_download_pdf', async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  const lang = await getUserLang(ctx.from.id);
  const currentSeason = await getGlobalTerm();
  const res = await pool.query("SELECT department, username, processed_by, academic_year, academic_semester, global_season, status FROM tickets WHERE user_id = $1 AND status != 'WIPED' ORDER BY updated_at DESC LIMIT 1", [ctx.from.id]);
  if (res.rows.length === 0 || res.rows[0].status !== 'APPROVED' || (res.rows[0].global_season || 1) < currentSeason) {
      return ctx.reply("⚠️ <b>ERROR:</b> Clearance missing or revoked for current active season.", { parse_mode: 'HTML' });
  }
  try {
    const pdfPath = await generateApprovalPDF(ctx.from.id, res.rows[0].username || 'N/A', res.rows[0].department, res.rows[0].processed_by || 'Finance Team', ctx.me?.username, lang, res.rows[0].academic_year || 1, res.rows[0].academic_semester || 1);
    await ctx.replyWithDocument(new InputFile(pdfPath, `Official_Clearance_Y${res.rows[0].academic_year || 1}S${res.rows[0].academic_semester || 1}_${ctx.from.id}.pdf`), { caption: STRINGS[lang].approvedMsg, parse_mode: 'HTML' });
    if (fs.existsSync(pdfPath)) fs.unlinkSync(pdfPath);
  } catch (err) { ctx.reply("❌ <b>SYSTEM ERROR:</b> PDF Generation Engine failed.", { parse_mode: 'HTML' }); }
});

bot.callbackQuery('cmd_modules', async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  const lang = await getUserLang(ctx.from.id);
  const currentSeason = await getGlobalTerm();
  const checkApproval = await pool.query("SELECT department, academic_year, academic_semester, global_season, status FROM tickets WHERE user_id = $1 AND status != 'WIPED' ORDER BY updated_at DESC LIMIT 1", [ctx.from.id]);
  
  if (checkApproval.rows.length === 0 || checkApproval.rows[0].status !== 'APPROVED' || (checkApproval.rows[0].global_season || 1) < currentSeason) {
    const notApprovedMsg = lang === 'am' ? `🔒 <b>የሞጁል ማውረጃ ተቆልፏል</b>\n\nሞጁሎችን ለማውረድ አዲስ ደረሰኝ መላክ አለቦት።` : `🔒 <b>VAULT ACCESS DENIED</b>\n━━━━━━━━━━━━━━━━━━━━\n<blockquote>You must submit an updated clearance receipt to unlock materials for this new season.</blockquote>`;
    return dropStudentMenu(ctx.from.id, notApprovedMsg, await buildStudentMenu(ctx.from.id, lang));
  }
  
  const studentDept = checkApproval.rows[0].department.replace(/\s*\((Regular \/ Term\vert{}4-Year Complete)\)$/, '').trim();
  const modulesRes = await pool.query("SELECT id, title FROM department_modules WHERE department ILIKE $1 ORDER BY id ASC", [`%${studentDept}%`]);
  if (modulesRes.rows.length === 0) return dropStudentMenu(ctx.from.id, `📚 <b>VAULT EMPTY:</b> No documents available for <code>${escapeHtml(studentDept)}</code>.`, await buildStudentMenu(ctx.from.id, lang));
  
  const kb = new InlineKeyboard();
  modulesRes.rows.forEach((m) => kb.text(`📄 ${m.title}`, `dlmod_${m.id}`).row());
  kb.text("🔙 Home Menu", "cmd_menu");
  await dropStudentMenu(ctx.from.id, `📚 <b>SECURE VAULT: <code>${escapeHtml(studentDept)}</code></b>\n━━━━━━━━━━━━━━━━━━━━\n<i>Select document to execute download:</i>`, kb);
});

bot.callbackQuery(/^dlmod_(\d+)$/, async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  const res = await pool.query("SELECT title, file_id FROM department_modules WHERE id = $1", [Number(ctx.match[1])]);
  if (res.rows.length === 0) return ctx.reply("⚠️ <b>ERROR 404:</b> Document purged or corrupted.", { parse_mode: 'HTML' });
  try { await pool.query("INSERT INTO module_downloads (module_id, user_id) VALUES ($1, $2) ON CONFLICT (module_id, user_id) DO NOTHING", [Number(ctx.match[1]), ctx.from.id]); } catch (e) {}
  try { await ctx.replyWithDocument(res.rows[0].file_id, { caption: `📖 <b>${escapeHtml(res.rows[0].title)}</b>\n<blockquote><i>Classified: Renaissance Global Course Module</i></blockquote>`, parse_mode: 'HTML' }); } catch (err) { ctx.reply("❌ <b>TRANSMISSION ERROR:</b> Payload failed.", { parse_mode: 'HTML' }); }
});

bot.callbackQuery(/^app_(\d+)_(\d+)$/, async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  const userId = Number(ctx.match[1]);
  const topicId = Number(ctx.match[2]);
  const staffName = `${ctx.from.first_name || ''} ${ctx.from.last_name || ''}`.trim() || `Staff`;
  const staffGroupId = await getActiveStaffGroupId();

  const updateRes = await pool.query("UPDATE tickets SET status = 'APPROVED', processed_by = $1, processed_by_id = $2, updated_at = CURRENT_TIMESTAMP WHERE user_id = $3 AND status = 'PENDING' RETURNING department, username", [staffName, ctx.from.id, userId]);
  if (updateRes.rowCount === 0) return ctx.editMessageText("⚠️ <b>ERROR:</b> Record already finalized.", { parse_mode: 'HTML' });

  const { department, username } = updateRes.rows[0];
  const lang = await getUserLang(userId);
  pushToGoogleSheet(userId, username, department, 'APPROVED', staffName, '');

  try { await ctx.api.sendMessage(userId, `🔔 <b>STATUS UPDATE:</b>\n\n${STRINGS[lang].approvedMsg}`, { parse_mode: 'HTML' }); } catch (e) {}
  await dropStudentMenu(userId, STRINGS[lang].portalWelcome, await buildStudentMenu(userId, lang, 'APPROVED'));
  
  await ctx.editMessageText(`✅ <b>APPROVAL AUTHORIZED</b>\n━━━━━━━━━━━━━━━━━━━━\n<blockquote>• <b>Target UID:</b> <code>${userId}</code>\n• <b>User Alias:</b> @${escapeHtml(username) || 'N/A'}\n• <b>Vector:</b> ${escapeHtml(department)}\n• <b>Cleared By:</b> ${escapeHtml(staffName)}</blockquote>`, { parse_mode: 'HTML' });
  if (APPROVED_THREAD_ID && staffGroupId) await ctx.api.sendMessage(staffGroupId, await generateSummaryText('APPROVED'), { message_thread_id: APPROVED_THREAD_ID, parse_mode: 'HTML' });
});

bot.callbackQuery(/^rej_(\d+)_(\d+)$/, async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  await ctx.editMessageText("❌ <b>INITIALIZE REJECTION SEQUENCE:</b>", { parse_mode: 'HTML', reply_markup: getRejectionReasonKeyboard(Number(ctx.match[1]), Number(ctx.match[2])) });
});

bot.callbackQuery(/^confirmrej_(\d+)_(\d+)_(.+)$/, async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  const userId = Number(ctx.match[1]);
  const staffName = `${ctx.from.first_name || ''} ${ctx.from.last_name || ''}`.trim() || `Staff`;
  const reasonObj = REJECTION_REASONS.find(r => r.code === ctx.match[3]);
  const reasonText = reasonObj ? reasonObj.label : "Artifact Unverifiable";

  const updateRes = await pool.query(`UPDATE tickets SET status = 'REJECTED', rejection_reason = $1, processed_by = $2, processed_by_id = $3, updated_at = CURRENT_TIMESTAMP WHERE user_id = $4 AND status = 'PENDING' RETURNING department, username`, [reasonText, staffName, ctx.from.id, userId]);
  if (updateRes.rowCount === 0) return ctx.editMessageText("⚠️ <b>ERROR:</b> Database status mismatch.", { parse_mode: 'HTML' });

  const { department, username } = updateRes.rows[0];
  const lang = await getUserLang(userId);
  const customMessage = reasonObj ? (lang === 'am' ? reasonObj.message_am : reasonObj.message_en) : "Please re-upload.";

  pushToGoogleSheet(userId, username, department, 'REJECTED', staffName, reasonText);

  const rejectText = STRINGS[lang].rejectedMsg.replace('{reason}', escapeHtml(reasonText)).replace('{message}', customMessage);
  try { await ctx.api.sendMessage(userId, `🔔 <b>STATUS UPDATE:</b>\n\n${rejectText}`, { parse_mode: 'HTML' }); } catch (e) {}
  await dropStudentMenu(userId, STRINGS[lang].portalWelcome, await buildStudentMenu(userId, lang, 'REJECTED'));

  await ctx.editMessageText(`❌ <b>REJECTION AUTHORIZED</b>\n<blockquote><b>Operator:</b> ${escapeHtml(staffName)}\n<b>Fault:</b> ${escapeHtml(reasonText)}</blockquote>`, { parse_mode: 'HTML' });
});

bot.callbackQuery('cmd_panel_revoke', async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  if (!(await isStaff(ctx))) return;
  await ctx.reply("⚠️ <b>INITIATE STATUS REVOCATION</b>\n\n<i>Reply directly to this system message with the target <b>Student ID</b>.</i>", { message_thread_id: ctx.callbackQuery.message.message_thread_id, parse_mode: 'HTML', reply_markup: { force_reply: true } });
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
  const username = ticketRes.rows[0].username || '';
  const planSuffix = oldDept.includes("(4-Year Complete)") ? "(4-Year Complete)" : "(Regular / Term)";
  const newFullDept = `${deptMap[deptCode]} ${planSuffix}`;

  const staffGroupId = await getActiveStaffGroupId();
  const newTopicId = await getOrCreateDepartmentTopic(ctx, newFullDept, staffGroupId);
  let newMsgId = t.message_id; let newTicketMsgId = t.ticket_msg_id;

  if (staffGroupId && t.topic_id && t.message_id) {
     try {
        const forwardRes = await ctx.api.copyMessage(staffGroupId, staffGroupId, Number(t.message_id), { message_thread_id: newTopicId });
        newMsgId = forwardRes.message_id;
        let newTicketMsg;
        if (t.status === 'PENDING') {
            const kb = new InlineKeyboard().text("✅ APPROVE", `app_${targetUserId}_${newTopicId}`).row().text("❌ REJECT", `rej_${targetUserId}_${newTopicId}`);
            newTicketMsg = await ctx.api.sendMessage(staffGroupId, `🧾 <b>NEW DATA UPLOAD (MIGRATED)</b>\n━━━━━━━━━━━━━━━━━━━━\n<blockquote>👤 <b>Profile:</b> @${escapeHtml(t.username)}\n🆔 <b>UID:</b> <code>${targetUserId}</code>\n🏫 <b>Target:</b> ${escapeHtml(newFullDept)}\n📅 <b>Personal Term:</b> Year ${t.academic_year || 1} — Semester ${t.academic_semester || 1}</blockquote>`, { message_thread_id: newTopicId, parse_mode: 'HTML', reply_markup: kb });
        } else {
            newTicketMsg = await ctx.api.sendMessage(staffGroupId, `✅ <b>CLEARED (MIGRATED BY STAFF)</b>\n━━━━━━━━━━━━━━━━━━━━\n<blockquote>• <b>Target UID:</b> <code>${targetUserId}</code>\n• <b>User Alias:</b> @${escapeHtml(t.username)}\n• <b>Vector:</b> ${escapeHtml(newFullDept)}\n• <b>Cleared By:</b> ${escapeHtml(staffName)}</blockquote>`, { message_thread_id: newTopicId, parse_mode: 'HTML' });
        }
        newTicketMsgId = newTicketMsg.message_id;
        await ctx.api.deleteMessage(staffGroupId, Number(t.message_id));
        if (t.ticket_msg_id) await ctx.api.deleteMessage(staffGroupId, Number(t.ticket_msg_id));
     } catch(e) {}
  }

  await pool.query("UPDATE tickets SET department = $1, processed_by = $2, topic_id = $3, message_id = $4, ticket_msg_id = $5, updated_at = CURRENT_TIMESTAMP WHERE id = $6", [newFullDept, staffName, newTopicId, newMsgId, newTicketMsgId, t.id]);
  pushToGoogleSheet(targetUserId, username, newFullDept, t.status, staffName, 'Department Overridden');
  await ctx.editMessageText(`✅ <b>DEPARTMENT OVERRIDE SUCCESSFUL</b>\n━━━━━━━━━━━━━━━━━━━━\n<blockquote>• <b>Target UID:</b> <code>${targetUserId}</code>\n• <b>New Assignment:</b> ${escapeHtml(newFullDept)}\n• <b>Authorized By:</b> ${escapeHtml(staffName)}</blockquote>\n\n<i>The user's Module Vault has been automatically synced to the new assignment.</i>`, { parse_mode: 'HTML' });

  try {
    const studentLang = await getUserLang(targetUserId);
    const msgUpdate = studentLang === 'am' ? `🔄 <b>የትምህርት ክፍልዎ ተቀይሯል</b>\n━━━━━━━━━━━━━━━━━━━━\n<blockquote>አዲሱ ክፍልዎ፡ <b>${escapeHtml(newFullDept)}</b></blockquote>\nአሁን አዲሶቹን ሞጁሎች በ <b>📚 የትምህርት ሞጁሎች</b> ማውረድ ይችላሉ።` : `🔄 <b>ACADEMIC PLACEMENT UPDATED</b>\n━━━━━━━━━━━━━━━━━━━━\n<blockquote>Your system profile has been transferred to:\n👉 <b>${escapeHtml(newFullDept)}</b></blockquote>\nAccess your new course materials under <b>📚 Access Vault</b>!`;
    await ctx.api.sendMessage(targetUserId, `🔔 <b>STATUS UPDATE:</b>\n\n${msgUpdate}`, { parse_mode: 'HTML' });
    await dropStudentMenu(targetUserId, STRINGS[studentLang].portalWelcome, await buildStudentMenu(targetUserId, studentLang, t.status));
  } catch (err) {}
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
  const res = await pool.query("SELECT id, title, file_name FROM department_modules WHERE department ILIKE $1 ORDER BY id ASC", [`%${dept}%`]);
  if (res.rows.length === 0) return ctx.editMessageText(`ℹ️ <b>VAULT EMPTY:</b> No documents located for <b>${escapeHtml(dept)}</b>.`, { parse_mode: 'HTML' });
  const kb = new InlineKeyboard();
  res.rows.forEach((m) => kb.text(`🗑 REMOVE: ${m.title.substring(0,25)}...`, `confirm_delmod_${m.id}`).row());
  kb.text("🔙 ABORT PROCESS", "delmoddept_cancel");
  await ctx.editMessageText(`🗑 <b>TARGET SECURED: ${escapeHtml(dept)}</b>\n━━━━━━━━━━━━━━━━━━━━\n<i>Warning: Deleting a module instantly revokes access for all enrolled students. Select file to purge:</i>`, { parse_mode: 'HTML', reply_markup: kb });
});

bot.callbackQuery(/^confirm_delmod_(\d+)$/, async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  const res = await pool.query("DELETE FROM department_modules WHERE id = $1 RETURNING title, department", [Number(ctx.match[1])]);
  if (res.rowCount === 0) return ctx.editMessageText("⚠️ <b>ERROR:</b> Document already purged or missing.", { parse_mode: 'HTML' });
  await ctx.editMessageText(`✅ <b>VAULT PURGE SUCCESSFUL</b>\n━━━━━━━━━━━━━━━━━━━━\n<blockquote>• <b>Title:</b> ${escapeHtml(res.rows[0].title)}\n• <b>Sector:</b> ${escapeHtml(res.rows[0].department)}</blockquote>\n\n<i>Document has been permanently eradicated from student access.</i>`, { parse_mode: 'HTML' });
});

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
  if (res.rows.length === 0) return ctx.editMessageText(isAll ? "ℹ️ <b>DATABASE EMPTY:</b> No approved records exist." : `ℹ️ <b>DATABASE EMPTY:</b> No approved records in <b>${escapeHtml(cleanDept)}</b>.`, { parse_mode: 'HTML' });
  
  let text = `🎓 <b>DATABASE EXPORT: ${escapeHtml(isAll ? "ALL DEPARTMENTS" : cleanDept.toUpperCase())}</b> (<code>${res.rows.length}</code> Total)\n━━━━━━━━━━━━━━━━━━━━\n`;
  let currentGroupDept = "";
  for (let idx = 0; idx < res.rows.length; idx++) {
    const r = res.rows[idx];
    let itemText = "";
    if (isAll && r.department !== currentGroupDept) { currentGroupDept = r.department; itemText += `\n📁 <b>${escapeHtml(currentGroupDept)}</b>\n`; }
    itemText += `<code>[${idx + 1}]</code> <b>${escapeHtml(r.username ? `@${r.username}` : `[No @username]`)}</b> (UID: <code>${r.user_id}</code>)\n   ↳ Approved: ${new Date(r.updated_at).toLocaleDateString()}${r.processed_by ? ` (By: ${escapeHtml(r.processed_by)})` : ''}\n`;
    if ((text + itemText).length > 3800) { await ctx.reply(text, { parse_mode: 'HTML' }); text = ""; }
    text += itemText;
  }
  if (text.trim().length > 0) await ctx.reply(text, { parse_mode: 'HTML' });
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
          const sLang = await getUserLang(s.user_id);
          const dlKb = new InlineKeyboard().text(sLang === 'am' ? "⬇️ ሞጁሉን አውርድ" : "⬇️ INITIATE DOWNLOAD", `dlmod_${ctx.match[1]}`);
          await bot.api.sendMessage(s.user_id, sLang === 'am' ? `📚 <b>አዲስ የትምህርት ሞጁል ተጭኗል!</b>\n━━━━━━━━━━━━━━━━━━━━\n<blockquote>• <b>ክፍል:</b> ${escapeHtml(cleanDept)}\n• <b>ሞጁል:</b> ${escapeHtml(title)}</blockquote>\n\n<i>ከታች ያለውን ቁልፍ በመጫን ፋይሉን ያውርዱ፡</i>` : `📚 <b>VAULT UPDATE: NEW MODULE SECURED</b>\n━━━━━━━━━━━━━━━━━━━━\n<blockquote>• <b>Department:</b> ${escapeHtml(cleanDept)}\n• <b>File Title:</b> ${escapeHtml(title)}</blockquote>\n\n<i>Authorized users may initiate download below:</i>`, { parse_mode: 'HTML', reply_markup: dlKb });
          sentCount++; await delay(50);
        } catch (e) {}
    }
  }
  await ctx.editMessageText(`📢 <b>SYSTEM BROADCAST SUCCESSFUL</b>\n━━━━━━━━━━━━━━━━━━━━\n<blockquote>• <b>Target File:</b> ${escapeHtml(title)}\n• <b>Vector:</b> ${escapeHtml(cleanDept)}\n• <b>Delivered to:</b> <code>${sentCount}</code> nodes.</blockquote>`, { parse_mode: 'HTML' });
});

bot.callbackQuery('dismiss_mod_notify', async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  await ctx.editMessageText("🔕 <b>STEALTH MODE:</b> Document ingested silently. Broadcast skipped.", { parse_mode: 'HTML' });
});

bot.callbackQuery('cmd_mod_analytics', async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  if (!(await isStaff(ctx))) return;
  const topicId = ctx.callbackQuery.message.message_thread_id;
  const res = await pool.query(`SELECT m.id, m.title, m.department, COUNT(DISTINCT d.user_id) AS total_downloads FROM department_modules m LEFT JOIN module_downloads d ON m.id = d.module_id GROUP BY m.id, m.title, m.department ORDER BY m.department ASC, total_downloads DESC`);
  if (res.rows.length === 0) return ctx.reply("📊 <b>VAULT ANALYTICS:</b> Storage array empty.", { message_thread_id: topicId, parse_mode: 'HTML' });
  let text = "📈 <b>VAULT ENGAGEMENT TELEMETRY</b>\n━━━━━━━━━━━━━━━━━━━━\n";
  let currentDept = "";
  for (const row of res.rows) {
    if (row.department !== currentDept) { currentDept = row.department; text += `\n📁 <b>${escapeHtml(currentDept)}</b>\n`; }
    const cleanDept = currentDept.replace(/\s*\((Regular \/ Term\vert{}4-Year Complete)\)$/, '').trim();
    const enrolledRes = await pool.query("SELECT COUNT(DISTINCT user_id) as count FROM tickets WHERE status = 'APPROVED' AND department ILIKE $1", [`%${cleanDept}%`]);
    const totalEnrolled = Number(enrolledRes.rows[0].count) || 0;
    const downloads = Number(row.total_downloads);
    const percentage = totalEnrolled > 0 ? Math.round((downloads / totalEnrolled) * 100) : 0;
    text += `• <b>${escapeHtml(row.title)}</b>\n  ↳ Penetration: <b><code>${downloads}/${totalEnrolled}</code> profiles</b> (<code>${percentage}%</code>)\n`;
  }
  await ctx.reply(text, { message_thread_id: topicId, parse_mode: 'HTML' });
});

bot.callbackQuery('cmd_lookfor', async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  await ctx.reply("🔍 <b>DATABASE RECORD QUERY</b>\n━━━━━━━━━━━━━━━━━━━━\n\n<i>Reply directly to this system message with a target <b>UID</b>, <b>@username</b>, or <b>Department Name</b>.</i>", { message_thread_id: ctx.callbackQuery.message.message_thread_id, parse_mode: 'HTML', reply_markup: { force_reply: true } });
});

bot.callbackQuery('cmd_stats', async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  await ctx.reply(`${await generateSummaryText('APPROVED')}\n\n---\n\n${await generateSummaryText('REJECTED')}`, { message_thread_id: ctx.callbackQuery.message.message_thread_id, parse_mode: 'HTML' });
});

bot.callbackQuery('cmd_export', async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  await sendCSVExport(await getActiveStaffGroupId(), ctx.callbackQuery.message.message_thread_id, "📄 <b>DATABASE BACKUP EXPORT GENERATED</b>");
});

bot.callbackQuery('cmd_broadcast', async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  await ctx.reply("📢 <b>INITIALIZE SYSTEM BROADCAST</b>\n━━━━━━━━━━━━━━━━━━━━\n\n<i>Reply directly to this system message with the exact announcement payload to transmit.</i>", { message_thread_id: ctx.callbackQuery.message.message_thread_id, parse_mode: 'HTML', reply_markup: { force_reply: true } });
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

bot.callbackQuery(/^canceltrans_(\d+)_(\d+)$/, async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  const res = await pool.query('SELECT username, department FROM tickets WHERE user_id = $1 AND topic_id = $2 AND status = \'PENDING\' LIMIT 1', [Number(ctx.match[1]), Number(ctx.match[2])]);
  if (res.rows.length === 0) return ctx.editMessageText("⚠️ <b>ERROR:</b> Database status mismatch.", { parse_mode: 'HTML' });
  const kb = new InlineKeyboard().text("✅ APPROVE", `app_${ctx.match[1]}_${ctx.match[2]}`).row().text("❌ REJECT", `rej_${ctx.match[1]}_${ctx.match[2]}`).row().text("🔄 OVERRIDE DEPT", `trans_${ctx.match[1]}_${ctx.match[2]}`);
  await ctx.editMessageText(`🧾 <b>NEW DATA UPLOAD DETECTED</b>\n━━━━━━━━━━━━━━━━━━━━\n<blockquote>👤 <b>Profile:</b> @${escapeHtml(res.rows[0].username || 'Unknown')}\n🆔 <b>UID:</b> <code>${ctx.match[1]}</code>\n🏫 <b>Target:</b> ${escapeHtml(res.rows[0].department)}</blockquote>\n━━━━━━━━━━━━━━━━━━━━\n⚡️ <i>Analyze the appended media artifact below.</i>`, { parse_mode: 'HTML', reply_markup: kb });
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
  const newTicketMsg = await ctx.api.sendMessage(staffGroupId, `🧾 <b>NEW DATA UPLOAD DETECTED (TRANSFERRED)</b>\n━━━━━━━━━━━━━━━━━━━━\n<blockquote>👤 <b>Profile:</b> @${escapeHtml(ticketRes.rows[0].username)}\n🆔 <b>UID:</b> <code>${targetUserId}</code>\n🏫 <b>Target:</b> ${escapeHtml(newDeptTagged)}\n📅 <b>Personal Term:</b> Year ${ticketRes.rows[0].academic_year || 1} — Semester ${ticketRes.rows[0].academic_semester || 1}</blockquote>\n━━━━━━━━━━━━━━━━━━━━\n⚡️ <i>Analyze the appended media artifact below.</i>`, { message_thread_id: newTopicId, parse_mode: 'HTML', reply_markup: kb });

  await pool.query(`UPDATE tickets SET department = $1, topic_id = $2, message_id = $3, ticket_msg_id = $4, updated_at = CURRENT_TIMESTAMP WHERE user_id = $5 AND status = 'PENDING'`, [newDeptTagged, newTopicId, newForwardRes.message_id, newTicketMsg.message_id, targetUserId]);

  try { await ctx.api.deleteMessage(staffGroupId, Number(ticketRes.rows[0].message_id)); } catch (e) {}
  try { await ctx.api.deleteMessage(staffGroupId, Number(ticketRes.rows[0].ticket_msg_id)); } catch (e) {}

  try {
    const sLang = await getUserLang(targetUserId);
    const msgUpdate = sLang === 'am' ? `🔄 <b>መረጃዎ ተስተካክሏል</b>\nየደረሰኝ ማመልከቻዎ ወደ <b>${escapeHtml(newDeptTagged)}</b> ተዛውሯል።` : `🔄 <b>DATABASE UPDATE</b>\nYour dossier has been successfully transferred to <b>${escapeHtml(newDeptTagged)}</b>.`;
    await ctx.api.sendMessage(targetUserId, `🔔 <b>STATUS UPDATE:</b>\n\n${msgUpdate}`, { parse_mode: 'HTML' });
    await dropStudentMenu(targetUserId, STRINGS[sLang].portalWelcome, await buildStudentMenu(targetUserId, sLang, 'PENDING'));
  } catch (e) {}
});

bot.callbackQuery('cmd_menu', async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  const lang = await getUserLang(ctx.from.id);
  await dropStudentMenu(ctx.from.id, STRINGS[lang].portalWelcome, await buildStudentMenu(ctx.from.id, lang));
});

bot.callbackQuery('cmd_help', async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  const lang = await getUserLang(ctx.from.id);
  await dropStudentMenu(ctx.from.id, STRINGS[lang].helpText, await buildStudentMenu(ctx.from.id, lang));
});

// --- CRON JOBS ---

cron.schedule('0 8 * * *', async () => {
  try {
    const staffGroupId = await getActiveStaffGroupId();
    if (!staffGroupId) return;
    const pendingRes = await pool.query("SELECT COUNT(*) as count FROM tickets WHERE status = 'PENDING'");
    const dailyReport = `🌅 <b>SYSTEM CHRON REPORT (DAILY)</b>\n━━━━━━━━━━━━━━━━━━━━\n\n⏳ <b>Unprocessed Packets:</b> <code>${pendingRes.rows[0].count}</code>\n\n---\n\n${await generateSummaryText('APPROVED')}\n\n---\n\n${await generateSummaryText('REJECTED')}`;
    await bot.api.sendMessage(staffGroupId, dailyReport, { message_thread_id: APPROVED_THREAD_ID || null, parse_mode: 'HTML' });
  } catch (err) {}
});

cron.schedule('0 10 * * *', async () => {
  try {
    const currentSeason = await getGlobalTerm();
    const stuckUsers = await pool.query(`SELECT u.user_id, u.language, u.pending_department FROM user_settings u LEFT JOIN tickets t ON u.user_id = t.user_id AND t.global_season = $1 WHERE u.pending_department IS NOT NULL AND (t.user_id IS NULL OR t.status != 'PENDING')`, [currentSeason]);
    for (const row of stuckUsers.rows) {
      const lang = row.language || 'en';
      const msg = lang === 'am' 
        ? `⚠️ <b>ማሳሰቢያ: ማመልከቻዎ አልተጠናቀቀም!</b>\n━━━━━━━━━━━━━━━━━━━━\n<blockquote>ለ <b>${escapeHtml(row.pending_department)}</b> ምዝገባ ጀምረዋል፣ ነገር ግን የክፍያ ደረሰኝ አላስገቡም።</blockquote>\n\n<i>እባክዎን ሂደቱን ለማጠናቀቅ የክፍያ ደረሰኝዎን ፎቶ አሁን ይላኩ።</i>`
        : `⚠️ <b>SYSTEM ALERT: INCOMPLETE REGISTRATION</b>\n━━━━━━━━━━━━━━━━━━━━\n<blockquote>You initiated clearance for <b>${escapeHtml(row.pending_department)}</b> but have not transmitted a receipt photo.</blockquote>\n\n<i>Please upload your receipt image now to secure your clearance and unlock the module vault.</i>`;
      try { await bot.api.sendMessage(row.user_id, msg, { parse_mode: 'HTML' }); await delay(50); } catch (e) {}
    }
  } catch (err) {}
});

// --- SERVER INIT ---

app.use('/webhook', webhookCallback(bot, 'express'));
app.get('/', (req, res) => res.send('Tuition Receipt Bot is active'));

async function main() {
  await initDB();
  try { await bot.init(); } catch (e) { console.error("Warning: Bot initialization failed on startup.", e.message); }

  try {
    await bot.api.deleteMyCommands();
    await bot.api.deleteMyCommands({ scope: { type: 'all_private_chats' } });
    await bot.api.deleteMyCommands({ scope: { type: 'all_group_chats' } });
    await bot.api.deleteMyCommands({ scope: { type: 'all_chat_administrators' } });

    await bot.api.setMyCommands([{ command: 'start', description: 'INITIALIZE PORTAL / VERIFICATION' }], { scope: { type: 'all_private_chats' } });
    await bot.api.setMyCommands([
      { command: 'panel', description: 'ACCESS COMMAND CENTER' },
      { command: 'bind', description: 'SECURE GROUP CHANNEL' },
      { command: 'deadline', description: 'BROADCAST MISSING PAYMENT WARNING' }
    ], { scope: { type: 'all_chat_administrators' } });
  } catch (cmdErr) {}

  const RENDER_EXTERNAL_URL = process.env.RENDER_EXTERNAL_URL; 
  if (RENDER_EXTERNAL_URL) {
    const webhookUrl = `${RENDER_EXTERNAL_URL}/webhook`;
    await bot.api.setWebhook(webhookUrl, { drop_pending_updates: true });
    console.log(`Webhook bound to: ${webhookUrl}`);
  }

  app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
}

main();