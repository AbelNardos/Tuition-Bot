process.env.TZ = 'Africa/Addis_Ababa';
require('dotenv').config();

const express = require('express');
const { Bot, Keyboard, InputFile, webhookCallback } = require('grammy');
const cors = require('cors');

// --- MODULAR IMPORTS ---
const { 
  pool, initDB, getGlobalTerm, getActiveStaffGroupId, isStaff, getUserState,
  getUserLang, setUserLang, getPendingDepartment, setPendingDepartment, clearPendingDepartment,
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
    if (!e.message.includes('message is not modified')) {
      console.error("[Transform Menu Error]:", e.message);
    }
  }
}

// ============================================================================
// COMMAND ROUTING & ADMIN TERMINAL OUTPUTS
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
  
  await ctx.reply("✅ <b>COMMAND CENTER UPLINK SECURED</b>\n━━━━━━━━━━━━━━━━━━━━\n<blockquote><b>SYSTEM STATUS:</b> Online & Authenticated\n<b>SECTOR:</b> Primary Operations Interface</blockquote>\n\n<i>All incoming telemetry, transaction artifacts, and system alerts will now be routed directly to this secure encrypted channel.</i>", { parse_mode: 'HTML' });
});

bot.command('start', async (ctx) => {
  if (ctx.match && typeof ctx.match === 'string' && ctx.match.startsWith('verify_')) {
    const verifyId = ctx.match.replace('verify_', '').trim();
    if (isNaN(Number(verifyId)) || verifyId === '') return ctx.reply("⚠️ <b>SYSTEM ERROR:</b> Invalid QR Code format.", { parse_mode: 'HTML' });
    const check = await pool.query("SELECT department, status, academic_year, academic_semester, updated_at FROM tickets WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 1", [verifyId]);
    
    if (check.rows.length === 0) return ctx.reply(`⚠️ <b>FATAL ERROR: ANOMALY DETECTED</b>\n━━━━━━━━━━━━━━━━━━━━\n<blockquote><b>TARGET UID:</b> <code>${escapeHtml(verifyId)}</code>\n<b>RESULT:</b> Zero records found. Potential forgery.</blockquote>`, { parse_mode: 'HTML' });
    
    const rec = check.rows[0];
    if (rec.status === 'APPROVED') {
      return ctx.reply(`✅ <b>OFFICIAL CLEARANCE: AUTHENTICATED</b>\n━━━━━━━━━━━━━━━━━━━━\n<blockquote>• <b>STUDENT ID:</b> <code>${escapeHtml(verifyId)}</code>\n• <b>SECTOR:</b> ${escapeHtml(rec.department)}\n• <b>ACADEMIC TERM:</b> Year ${rec.academic_year || 1} — Semester ${rec.academic_semester || 1}\n• <b>STATUS:</b> Fully Cleared & Valid\n• <b>VERIFIED AT:</b> ${new Date(rec.updated_at).toLocaleDateString()}</blockquote>\n\n<i>Student clearance is authorized for campus integration.</i>`, { parse_mode: 'HTML' });
    } else {
      return ctx.reply(`🚨 <b>VOIDED CLEARANCE: ACCESS DENIED</b>\n━━━━━━━━━━━━━━━━━━━━\n<blockquote>• <b>STUDENT ID:</b> <code>${escapeHtml(verifyId)}</code>\n• <b>SECTOR:</b> ${escapeHtml(rec.department)}\n• <b>LOCKED STATUS:</b> ${escapeHtml(rec.status)}</blockquote>\n\n⚠️ <i>WARNING: This digital artifact is strictly unauthorized or revoked by administration. Deny entry!</i>`, { parse_mode: 'HTML' });
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
  const kb = getStudentKeyboard(status, userSeason, currentSeason, lang);
  await dropMenu(ctx.from.id, STRINGS[lang].portalWelcome, kb);
});

bot.command('wipestudent', async (ctx) => {
  if (!(await isStaff(ctx))) return;
  const topicId = ctx.message.message_thread_id;
  const parts = ctx.message.text.split(' ');
  
  if (parts.length < 2) return ctx.reply("⚠️ <b>SYNTAX ERROR: INVALID PARAMETERS</b>\n━━━━━━━━━━━━━━━━━━━━\n<blockquote><b>EXPECTED FORMAT:</b> <code>/wipestudent &lt;UID&gt;</code></blockquote>", { message_thread_id: topicId, parse_mode: 'HTML' });
  const targetUid = Number(parts[1]); 
  if (isNaN(targetUid)) return ctx.reply("⚠️ <b>DATA TYPE ERROR: INVALID UID FORMAT</b>\n━━━━━━━━━━━━━━━━━━━━\n<blockquote>Ensure the target identifier is strictly numerical.</blockquote>", { message_thread_id: topicId, parse_mode: 'HTML' });

  const staffName = `${ctx.from.first_name || ''} ${ctx.from.last_name || ''}`.trim() || `Staff`;
  const updateRes = await pool.query("UPDATE tickets SET status = 'WIPED', rejection_reason = 'System Profile Wiped by Admin', processed_by = $1, processed_by_id = $2, updated_at = CURRENT_TIMESTAMP WHERE user_id = $3 RETURNING username, department", [staffName, ctx.from.id, targetUid]);
  
  if (updateRes.rowCount === 0) return ctx.reply(`❌ <b>WIPE OPERATION FAILED</b>\n━━━━━━━━━━━━━━━━━━━━\n<blockquote><b>ERROR CAUSE:</b> Target UID <code>${targetUid}</code> not located in the active database matrix.</blockquote>\n\n<i>Verify target identification number and re-initiate protocol.</i>`, { message_thread_id: topicId, parse_mode: 'HTML' });

  await pool.query('UPDATE user_settings SET pending_year = 1, pending_semester = 1, pending_department = NULL WHERE user_id = $1', [targetUid]);
  pushToGoogleSheet(targetUid, updateRes.rows[0].username, updateRes.rows[0].department, 'WIPED', staffName, 'Wiped by Admin');

  try {
    const { lang } = await getUserState(targetUid);
    const currentSeason = await getGlobalTerm();
    const wipeKb = getStudentKeyboard('WIPED', 0, currentSeason, lang);
    await dropMenu(targetUid, "🚫 <b>CRITICAL SYSTEM LOCKOUT</b>\n━━━━━━━━━━━━━━━━━━━━\n<blockquote>Your academic profile, historical records, and Vault access have been aggressively expunged by the central administration.</blockquote>\n\n<i>Click below to re-initiate the registration protocol from a blank slate.</i>", wipeKb);
  } catch(e) {}

  ctx.reply(`✅ <b>STUDENT DOSSIER EXPUNGED</b>\n━━━━━━━━━━━━━━━━━━━━\n<blockquote><b>TARGET UID:</b> <code>${targetUid}</code>\n<b>ACTION:</b> Full Database Override\n<b>STATUS:</b> All historical records, Modules, and Clearances successfully revoked.</blockquote>\n\n<i>Target terminal is locked. Subject must initiate a complete fresh registration protocol.</i>`, { message_thread_id: topicId, parse_mode: 'HTML' });
});

bot.command('module', async (ctx) => {
  if (!(await isStaff(ctx))) return;
  const staffGroupId = await getActiveStaffGroupId();
  if (!staffGroupId) return ctx.reply("⚠️ <b>SYSTEM HALT:</b> Execute /bind protocol first.", { parse_mode: 'HTML' });
  
  const doc = ctx.message.document || ctx.message.reply_to_message?.document;
  if (!doc) return ctx.reply("⚠️ <b>SYNTAX ERROR: INVALID PARAMETERS</b>\n━━━━━━━━━━━━━━━━━━━━\n<blockquote><b>EXPECTED FORMAT:</b> <code>/module &lt;Department&gt; | &lt;Module Title&gt;</code></blockquote>\n\n<i>Please attach the PDF document and provide the exact caption format to ingest data.</i>", { parse_mode: 'HTML' });
  
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

// ============================================================================
// MESSAGE UPLOAD HANDLERS
// ============================================================================

bot.on('message:contact', async (ctx) => {
  if (ctx.chat.type === 'private') {
    const phone = ctx.message.contact.phone_number;
    await pool.query('UPDATE user_settings SET phone_number = $1 WHERE user_id = $2', [phone, ctx.from.id]);
    const { lang, status, userSeason } = await getUserState(ctx.from.id);
    await ctx.reply(lang === 'am' ? "✅ <b>ስልክዎ ተመዝግቧል!</b>" : "✅ <b>Profile Verified!</b>", { parse_mode: 'HTML', reply_markup: { remove_keyboard: true } });
    const currentSeason = await getGlobalTerm();
    const kb = getStudentKeyboard(status, userSeason, currentSeason, lang);
    await dropMenu(ctx.from.id, STRINGS[lang].portalWelcome, kb);
  }
});

bot.on('message:photo', async (ctx) => {
  if (ctx.chat.type !== 'private' || ctx.from.is_bot) return;
  const userId = ctx.from.id;
  const { lang, status, userSeason } = await getUserState(userId);
  const currentSeason = await getGlobalTerm();

  if (activeUploads.has(userId)) return;
  activeUploads.add(userId);

  try {
    if (status === 'PENDING') return dropMenu(userId, STRINGS[lang].pendingExists, getStudentKeyboard('PENDING', userSeason, currentSeason, lang));
    
    const chosenDeptTagged = await getPendingDepartment(userId);
    if (!chosenDeptTagged) return dropMenu(userId, "⚠️ <b>ERROR:</b> Select an academic department first.", getStudentKeyboard(status, userSeason, currentSeason, lang));

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
    
    // MASSIVE UPGRADE TO INCOMING TICKET UI
    const cardMsg = `🚨 <b>NEW INCOMING DATA TRANSMISSION</b>\n━━━━━━━━━━━━━━━━━━━━\n<blockquote>👤 <b>STUDENT ALIAS:</b> @${escapeHtml(ctx.from.username || 'Unknown')}\n🆔 <b>SYSTEM UID:</b> <code>${userId}</code>\n🏫 <b>TARGET SECTOR:</b> ${escapeHtml(chosenDeptTagged)}\n📅 <b>ACADEMIC TERM:</b> Year ${pRes.rows[0].pending_year || 1} — Semester ${pRes.rows[0].pending_semester || 1}\n⚙️ <b>GLOBAL COHORT:</b> Season ${currentSeason}</blockquote>\n━━━━━━━━━━━━━━━━━━━━\n⚠️ <i>FINANCE NODE: Analyze the appended transaction artifact above and execute a strict clearance directive below.</i>`;
    
    const sentTicketMsg = await ctx.api.sendMessage(staffGroupId, cardMsg, { message_thread_id: dbTopicId, parse_mode: 'HTML', reply_markup: actionKb });
    
    await clearPendingDepartment(userId);
    await pool.query(`INSERT INTO tickets (user_id, username, receipt_file_id, topic_id, message_id, ticket_msg_id, department, status, academic_year, academic_semester, global_season) VALUES ($1, $2, $3, $4, $5, $6, $7, 'PENDING', $8, $9, $10)`, [userId, ctx.from.username || 'Unknown', fileId, dbTopicId, forwardRes.message_id, sentTicketMsg.message_id, chosenDeptTagged, pRes.rows[0].pending_year || 1, pRes.rows[0].pending_semester || 1, currentSeason]);
    
    await dropMenu(userId, STRINGS[lang].receiptReceived, getStudentKeyboard('PENDING', currentSeason, currentSeason, lang));
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

  const { status, userSeason } = await getUserState(ctx.from.id);
  const currentSeason = await getGlobalTerm();
  const kb = getStudentKeyboard(status, userSeason, currentSeason, lang);
  await transformMenu(ctx, STRINGS[lang].portalWelcome, kb);
});

bot.callbackQuery('cmd_status', async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  const { lang, status, userSeason } = await getUserState(ctx.from.id);
  const currentSeason = await getGlobalTerm();
  
  if (!status) return transformMenu(ctx, "ℹ️ <b>SYSTEM ALERT:</b> No active traces in database.", getStudentKeyboard(null, 0, currentSeason, lang));
  
  const res = await pool.query("SELECT department, academic_year, academic_semester FROM tickets WHERE user_id = $1 AND status != 'WIPED' ORDER BY updated_at DESC LIMIT 1", [ctx.from.id]);
  const t = res.rows[0];
  let msg = `📊 <b>LIVE PROFILE TELEMETRY</b>\n━━━━━━━━━━━━━━━━━━━━\n<blockquote>• <b>Department:</b> ${escapeHtml(t.department)}\n• <b>Academic Term:</b> Year ${t.academic_year} — Semester ${t.academic_semester}</blockquote>\n`;
  
  if (userSeason < currentSeason && status === 'APPROVED') {
    msg += `\n⚠️ <b>ACTION REQUIRED:</b> A new registration season has opened. You must submit a new receipt to unlock the module vault.`;
  } else {
    msg += `<blockquote>• <b>Status:</b> <b>${status}</b></blockquote>`;
  }
  
  await transformMenu(ctx, msg, getStudentKeyboard(status, userSeason, currentSeason, lang));
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
    return transformMenu(ctx, `🔒 <b>VAULT ACCESS DENIED</b>\n━━━━━━━━━━━━━━━━━━━━\n<blockquote>You must submit an updated clearance receipt to unlock materials for this new season.</blockquote>`, getStudentKeyboard(status, userSeason, currentSeason, lang));
  }
  const res = await pool.query("SELECT department FROM tickets WHERE user_id = $1 AND status = 'APPROVED' ORDER BY updated_at DESC LIMIT 1", [ctx.from.id]);
  const studentDept = res.rows[0].department.replace(/\s*\((Regular \/ Term\vert{}4-Year Complete)\)$/, '').trim();
  const mods = await pool.query("SELECT id, title FROM department_modules WHERE department ILIKE $1 ORDER BY id ASC", [`%${studentDept}%`]);
  
  if (mods.rows.length === 0) return transformMenu(ctx, `📚 <b>VAULT EMPTY</b>\n━━━━━━━━━━━━━━━━━━━━\n<blockquote>No documents actively listed for <code>${escapeHtml(studentDept)}</code>.</blockquote>`, getStudentKeyboard(status, userSeason, currentSeason, lang));
  
  const kb = new InlineKeyboard();
  mods.rows.forEach((m) => kb.text(`📄 ${m.title}`, `dlmod_${m.id}`).row());
  kb.text("🔙 Home Menu", "cmd_menu");
  await transformMenu(ctx, `📚 <b>SECURE VAULT: <code>${escapeHtml(studentDept)}</code></b>\n━━━━━━━━━━━━━━━━━━━━\n<i>Select document to execute download:</i>`, kb);
});

bot.callbackQuery('cmd_menu', async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  const { lang, status, userSeason } = await getUserState(ctx.from.id);
  await transformMenu(ctx, STRINGS[lang].portalWelcome, getStudentKeyboard(status, userSeason, await getGlobalTerm(), lang));
});

bot.callbackQuery('cmd_history', async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  const { lang, status, userSeason } = await getUserState(ctx.from.id);
  const currentSeason = await getGlobalTerm();
  const res = await pool.query("SELECT department, status, academic_year, academic_semester, created_at FROM tickets WHERE user_id = $1 AND status != 'WIPED' ORDER BY created_at DESC LIMIT 10", [ctx.from.id]);
  if (res.rows.length === 0) return transformMenu(ctx, "ℹ️ <b>SYSTEM ALERT:</b> Log history empty.", getStudentKeyboard(status, userSeason, currentSeason, lang));

  let text = "📜 <b>PROFILE AUDIT LOGS:</b>\n━━━━━━━━━━━━━━━━━━━━\n";
  for (let idx = 0; idx < res.rows.length; idx++) {
    const r = res.rows[idx];
    const icon = r.status === 'APPROVED' ? "✅" : "❌";
    text += `<code>[${idx + 1}]</code> ${icon} <b>${escapeHtml(r.department)} (Y${r.academic_year || 1}S${r.academic_semester || 1})</b>\n`;
  }
  await transformMenu(ctx, text, getStudentKeyboard(status, userSeason, currentSeason, lang));
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
  await transformMenu(ctx, "✅ <b>SUBMISSION CANCELLED</b>\nYour pending receipt was aggressively withdrawn.", getStudentKeyboard(null, 0, await getGlobalTerm(), lang));
});

// ============================================================================
// ADMIN STAFF CALLBACK QUERIES (THE INTENSE UI OVERHAUL)
// ============================================================================

bot.callbackQuery(/^app_(\d+)_(\d+)$/, async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  const userId = Number(ctx.match[1]);
  const staffName = `${ctx.from.first_name || ''} ${ctx.from.last_name || ''}`.trim() || `Staff`;
  const updateRes = await pool.query("UPDATE tickets SET status = 'APPROVED', processed_by = $1, updated_at = CURRENT_TIMESTAMP WHERE user_id = $2 AND status = 'PENDING' RETURNING department, username", [staffName, userId]);
  
  if (updateRes.rowCount === 0) return ctx.editMessageText("⚠️ <b>SYSTEM ERROR:</b> Record already finalized or expunged.", { parse_mode: 'HTML' });
  const { department, username } = updateRes.rows[0];
  const { lang } = await getUserState(userId);
  
  await ctx.api.sendMessage(userId, STRINGS[lang].approvedMsg).catch(()=>{});
  await dropMenu(userId, STRINGS[lang].portalWelcome, getStudentKeyboard('APPROVED', await getGlobalTerm(), await getGlobalTerm(), lang));
  
  await ctx.editMessageText(`✅ <b>CLEARANCE DIRECTIVE: AUTHORIZED</b>\n━━━━━━━━━━━━━━━━━━━━\n<blockquote>• <b>TARGET UID:</b> <code>${userId}</code>\n• <b>USER ALIAS:</b> @${escapeHtml(username) || 'N/A'}\n• <b>SECTOR:</b> ${escapeHtml(department)}\n• <b>CLEARED BY:</b> ${escapeHtml(staffName)}\n• <b>TIMESTAMP:</b> ${new Date().toLocaleString()}</blockquote>\n\n<i>Clearance PDF generated and transmitted. Subject unlocked.</i>`, { parse_mode: 'HTML' });
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
  await dropMenu(userId, STRINGS[lang].portalWelcome, getStudentKeyboard('REJECTED', 0, await getGlobalTerm(), lang));
  
  await ctx.editMessageText(`❌ <b>CLEARANCE DIRECTIVE: DENIED</b>\n━━━━━━━━━━━━━━━━━━━━\n<blockquote>• <b>TARGET UID:</b> <code>${userId}</code>\n• <b>USER ALIAS:</b> @${escapeHtml(username) || 'N/A'}\n• <b>OPERATOR:</b> ${escapeHtml(staffName)}\n• <b>FAULT PARAMETER:</b> ${escapeHtml(reasonText)}</blockquote>\n\n<i>Student terminal locked. Re-transmission demanded.</i>`, { parse_mode: 'HTML' });
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

// --- SERVER INIT ---
app.use('/webhook', webhookCallback(bot, 'express'));
app.get('/', (req, res) => res.send('Renaissance UI Overhaul Bot Active'));

async function main() {
  await initDB();
  try { await bot.init(); } catch (e) {}
  const url = process.env.RENDER_EXTERNAL_URL; 
  if (url) { await bot.api.setWebhook(`${url}/webhook`, { drop_pending_updates: true }); }
  app.listen(PORT, () => console.log(`Live on ${PORT}`));
}
main();