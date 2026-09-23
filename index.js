process.env.TZ = 'Africa/Addis_Ababa';
require('dotenv').config();

const express = require('express');
const { Bot, Keyboard, InputFile, webhookCallback } = require('grammy');
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
  const baseDept = departmentName.replace(/\s*\((Regular \/ Term\vert{}4-Year Complete)\)$/, '').trim();
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

bot.command('bind', async (ctx) => {
  if (ctx.chat.type === 'private') return ctx.reply("⚠️ <b>DENIED:</b> Execution requires a supergroup context with topics enabled.", { parse_mode: 'HTML' });
  if (!(await isStaff(ctx))) return ctx.reply("❌ <b>DENIED:</b> Root administrator privileges required.", { parse_mode: 'HTML' });
  const groupId = String(ctx.chat.id);
  const check = await pool.query('SELECT 1 FROM group_settings WHERE group_id = $1', [groupId]);
  if (check.rows.length > 0) await pool.query('UPDATE group_settings SET is_active = TRUE, updated_at = CURRENT_TIMESTAMP WHERE group_id = $1', [groupId]);
  else await pool.query('INSERT INTO group_settings (group_id, is_active) VALUES ($1, TRUE)', [groupId]);
  await ctx.reply("✅ <b>COMMAND CENTER SECURED</b>\n━━━━━━━━━━━━━━━━━━━━\n<blockquote>This group is now configured as the primary Staff Action Panel.</blockquote>", { parse_mode: 'HTML' });
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
    const sLang = await getUserLang(targetUid);
    const wipeKb = await buildStudentMenu(targetUid, sLang, 'WIPED');
    await dropStudentMenu(targetUid, "🚫 <b>SYSTEM LOCKOUT</b>\n━━━━━━━━━━━━━━━━━━━━\nYour academic profile and historical records have been completely wiped by administration.\n\nAll previous clearances, modules, and PDF certificates are now securely revoked.\n\nClick below to begin a completely fresh registration.", wipeKb);
  } catch(e) {}

  ctx.reply(`✅ <b>STUDENT PROFILE WIPED</b>\nAll <code>${updateRes.rowCount}</code> historical tickets for <code>${targetUid}</code> have been securely revoked and marked as WIPED. Their menu has been locked down. They must start over.`, { message_thread_id: topicId, parse_mode: 'HTML' });
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
    const notifyKb = { inline_keyboard: [[{text: "📢 BROADCAST TO NETWORK", callback_data: `notify_mod_${insRes.rows[0].id}`}], [{text: "🔕 STEALTH INGEST", callback_data: "dismiss_mod_notify"}]] };
    await ctx.reply(`✅ <b>DOCUMENT STASHED IN VAULT</b>\n━━━━━━━━━━━━━━━━━━━━\n<blockquote>• <b>Sector:</b> ${escapeHtml(dept)}\n• <b>Designation:</b> ${escapeHtml(title)}</blockquote>\n\n<i>Initiate network broadcast sequence?</i>`, { parse_mode: 'HTML', reply_markup: notifyKb });
  } catch (err) { ctx.reply(`❌ <b>CRITICAL ERROR:</b> ${err.message}`, { parse_mode: 'HTML' }); }
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
    
    const kb = getTransferKeyboard(userId, dbTopicId); 
    const actionKb = { inline_keyboard: [[{text:"✅ APPROVE", callback_data:`app_${userId}_${dbTopicId}`}, {text:"❌ REJECT", callback_data:`rej_${userId}_${dbTopicId}`}], [{text:"🔄 OVERRIDE DEPT", callback_data:`trans_${userId}_${dbTopicId}`}]] };
    
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

bot.callbackQuery(/^dept_(.+)$/, async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  const fullTaggedDept = ctx.match[1];
  await pool.query(`UPDATE user_settings SET pending_department = $1 WHERE user_id = $2`, [fullTaggedDept, ctx.from.id]);
  const lang = await getUserLang(ctx.from.id);
  await dropStudentMenu(ctx.from.id, STRINGS[lang].sendReceiptPrompt.replace('{dept}', escapeHtml(fullTaggedDept)), null);
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

// --- API & SERVER INITIALIZATION ---

app.use('/webhook', webhookCallback(bot, 'express'));
app.get('/', (req, res) => res.send('Renaissance Tuition Bot Modular System is active'));

async function main() {
  await initDB();
  try { await bot.init(); } catch (e) { console.error("[Bot Init Warning]:", e.message); }

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