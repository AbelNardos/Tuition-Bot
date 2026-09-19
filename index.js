require('dotenv').config();
const express = require('express');
const { Bot, InlineKeyboard, Keyboard, InputFile, webhookCallback } = require('grammy');
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const https = require('https');
const cron = require('node-cron');
const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

const PORT = process.env.PORT || 10000;
const bot = new Bot(process.env.BOT_TOKEN);

const APPROVED_THREAD_ID = process.env.APPROVED_THREAD_ID ? Number(process.env.APPROVED_THREAD_ID) : null;
const REJECTED_THREAD_ID = process.env.REJECTED_THREAD_ID ? Number(process.env.REJECTED_THREAD_ID) : null;

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception thrown:', err);
});

setInterval(() => {
  const RENDER_URL = process.env.RENDER_EXTERNAL_URL;
  if (RENDER_URL) {
    https.get(`${RENDER_URL}/`, (res) => {}).on('error', (err) => {});
  }
}, 8 * 60 * 1000);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// POST ROUTE FOR REACT DASHBOARD BROADCASTS
app.post('/api/broadcast', async (req, res) => {
  const { message } = req.body;

  try {
    const { rows } = await pool.query('SELECT DISTINCT user_id FROM user_settings WHERE user_id IS NOT NULL');
    let successCount = 0;

    for (const row of rows) {
      try {
        await bot.api.sendMessage(row.user_id, `📢 **RENAISSANCE GLOBAL ALERT**\n\n${message}`);
        successCount++;
      } catch (err) {
        console.error(`Failed to send to ${row.user_id}:`, err.message);
      }
    }

    res.status(200).json({ success: true, deliveredTo: successCount });
  } catch (error) {
    console.error('Broadcast error:', error);
    res.status(500).json({ error: 'Database/Server error during broadcast.' });
  }
});

// GET ROUTE FOR DASHBOARD LIVE METRICS
app.get('/api/live-dashboard', async (req, res) => {
  try {
    const countRes = await pool.query('SELECT COUNT(DISTINCT user_id) as count FROM user_settings');
    
    const logsRes = await pool.query(`
      SELECT id, updated_at as timestamp, status as event, username as user, user_id as chatid 
      FROM tickets ORDER BY updated_at DESC LIMIT 15
    `);
    
   const accountsRes = await pool.query(`
      SELECT t.id, t.username as name, t.department as role, t.user_id as chatid, t.status, u.phone_number 
      FROM tickets t
      LEFT JOIN user_settings u ON t.user_id = u.user_id
      WHERE t.status = 'APPROVED' 
      ORDER BY t.updated_at DESC LIMIT 50
    `);
    res.json({
      success: true,
      metrics: {
        totalLinked: parseInt(countRes.rows[0]?.count || 0),
        activeToday: logsRes.rows.length, 
        lastBroadcast: new Date().toISOString().split('T')[0]
      },
      logs: logsRes.rows.map(r => ({
        id: r.id, 
        timestamp: new Date(r.timestamp).toLocaleString('en-US', { timeZone: 'Africa/Addis_Ababa' }), 
        event: `TICKET_${r.event}`, 
        user: r.user ? `@${r.user}` : 'UNKNOWN', 
        chatId: r.chatid
      })),
     accounts: accountsRes.rows.map(r => ({
        id: r.id, 
        name: r.name ? `@${r.name}` : 'UNKNOWN', 
        role: (r.role || '').replace(' (Regular / Term)', '').replace(' (4-Year Complete)', '') || 'GENERAL', 
        phone: r.phone_number || 'Not Provided', 
        chatId: r.chatid, 
        status: r.status
      }))
    });
  } catch (error) {
    console.error('Dashboard Fetch Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function cleanForPDF(str) {
  if (!str) return '';
  return String(str).replace(/[^\x00-\x7F]/g, '').trim();
}

async function initDB() {
  try { await pool.query(`ALTER TABLE department_topics DROP CONSTRAINT IF EXISTS department_topics_pkey;`); } catch (err) {}

  await pool.query(`
    CREATE TABLE IF NOT EXISTS group_settings (
      group_id TEXT PRIMARY KEY,
      is_active BOOLEAN DEFAULT TRUE,
      modules_topic_id BIGINT,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS tickets (
      id SERIAL PRIMARY KEY,
      user_id BIGINT,
      username TEXT,
      receipt_file_id TEXT,
      topic_id BIGINT,
      message_id BIGINT,
      ticket_msg_id BIGINT,
      panel_msg_id BIGINT,
      department TEXT,
      status TEXT DEFAULT 'PENDING',
      rejection_reason TEXT,
      processed_by TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS user_settings (
      user_id BIGINT PRIMARY KEY,
      language TEXT DEFAULT 'en',
      pending_department TEXT,
      pending_module_dept TEXT,
      phone_number TEXT
    );

    CREATE TABLE IF NOT EXISTS department_topics (
      id SERIAL PRIMARY KEY,
      group_id TEXT NOT NULL DEFAULT '',
      department TEXT NOT NULL,
      topic_id BIGINT
    );

    CREATE TABLE IF NOT EXISTS department_modules (
      id SERIAL PRIMARY KEY,
      department TEXT NOT NULL,
      title TEXT NOT NULL,
      file_id TEXT NOT NULL,
      file_name TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS module_downloads (
      id SERIAL PRIMARY KEY,
      module_id INT REFERENCES department_modules(id) ON DELETE CASCADE,
      user_id BIGINT NOT NULL,
      downloaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(module_id, user_id)
    );
  `);

  try { await pool.query(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS panel_msg_id BIGINT;`); } catch (err) {}
  try { await pool.query(`ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS pending_department TEXT;`); } catch (err) {}
  try { await pool.query(`ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS pending_module_dept TEXT;`); } catch (err) {}
  try { await pool.query(`ALTER TABLE group_settings ADD COLUMN IF NOT EXISTS modules_topic_id BIGINT;`); } catch (err) {}
  try { await pool.query(`ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS phone_number TEXT;`); } catch (err) {}
}

async function getActiveStaffGroupId() {
  try {
    const res = await pool.query('SELECT group_id FROM group_settings WHERE is_active = TRUE ORDER BY updated_at DESC LIMIT 1');
    if (res.rows.length > 0) return res.rows[0].group_id;
  } catch (err) {}
  return String(process.env.STAFF_GROUP_ID || '').trim();
}

async function getUserLang(userId) {
  try {
    const res = await pool.query('SELECT language FROM user_settings WHERE user_id = $1', [userId]);
    if (res.rows.length > 0 && res.rows[0].language) return res.rows[0].language;
  } catch (err) {}
  return 'en';
}

async function setUserLang(userId, lang) {
  try {
    await pool.query(`INSERT INTO user_settings (user_id, language) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET language = $2`, [userId, lang]);
  } catch (err) {}
}

async function getPendingDepartment(userId) {
  try {
    const res = await pool.query('SELECT pending_department FROM user_settings WHERE user_id = $1', [userId]);
    if (res.rows.length > 0) return res.rows[0].pending_department;
  } catch (err) {}
  return null;
}

async function setPendingDepartment(userId, dept) {
  try {
    await pool.query(`INSERT INTO user_settings (user_id, pending_department) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET pending_department = $2`, [userId, dept]);
  } catch (err) {}
}

async function clearPendingDepartment(userId) {
  try { await pool.query('UPDATE user_settings SET pending_department = NULL WHERE user_id = $1', [userId]); } catch (err) {}
}

async function getStaffPendingModuleDept(userId) {
  try {
    const res = await pool.query('SELECT pending_module_dept FROM user_settings WHERE user_id = $1', [userId]);
    if (res.rows.length > 0) return res.rows[0].pending_module_dept;
  } catch (err) {}
  return null;
}

async function setStaffPendingModuleDept(userId, dept) {
  try {
    await pool.query(`INSERT INTO user_settings (user_id, pending_module_dept) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET pending_module_dept = $2`, [userId, dept]);
  } catch (err) {}
}

async function clearStaffPendingModuleDept(userId) {
  try { await pool.query('UPDATE user_settings SET pending_module_dept = NULL WHERE user_id = $1', [userId]); } catch (err) {}
}

async function isStaff(ctx) {
  try {
    const staffGroupId = await getActiveStaffGroupId();
    if (!staffGroupId) return false;
    const member = await ctx.api.getChatMember(staffGroupId, ctx.from.id);
    return ['creator', 'administrator', 'member'].includes(member.status);
  } catch (err) {
    return false;
  }
}

async function pushToGoogleSheet(userId, username, fullDept, status, staffName, reasonText = '') {
  const webhook = process.env.GOOGLE_SHEETS_WEBHOOK;
  if (!webhook) return;

  try {
    const userRes = await pool.query('SELECT phone_number, language FROM user_settings WHERE user_id = $1', [userId]);
    const phone = userRes.rows[0]?.phone_number || 'N/A';
    const lang = userRes.rows[0]?.language || 'en';

    let planType = 'Unknown';
    let cleanDept = fullDept || 'Unknown';

    if (cleanDept.includes('(4-Year Complete)')) {
      planType = '4-Year Complete';
      cleanDept = cleanDept.replace(/\s*\((4-Year Complete)\)$/, '').trim();
    } else if (cleanDept.includes('(Regular / Term)')) {
      planType = 'Regular / Term';
      cleanDept = cleanDept.replace(/\s*\((Regular \/ Term)\)$/, '').trim();
    }

    const payload = {
      id: String(userId),
      username: username ? `@${username.replace('@', '')}` : 'N/A',
      phone: phone,
      dept: cleanDept,
      plan: planType,
      status: status,
      reason: reasonText,
      staff: staffName || 'System Action',
      time: new Date().toLocaleString('en-US', { timeZone: 'Africa/Addis_Ababa' }),
      lang: lang.toUpperCase()
    };

    await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  } catch (err) {
    console.error("Google Sheets Sync Error:", err.message);
  }
}

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

const STRINGS = {
  en: {
    portalWelcome: "🏛 <b>RENAISSANCE GLOBAL</b> | <i>Portal</i>\n━━━━━━━━━━━━━━━━━━━━\n\n<blockquote><b>Welcome to your secure academic gateway.</b>\nClear your tuition to unlock course modules and campus access.</blockquote>\n\n<b>⚡️ SYSTEM SEQUENCE:</b>\n<code>[1]</code> Select payment type & department\n<code>[2]</code> Upload a pristine receipt photo\n<code>[3]</code> Obtain your official QR clearance\n\n👇 <i>Awaiting input...</i>",
    selectPlan: "💳 <b>TRANSACTION PROTOCOL (1/2)</b>\n━━━━━━━━━━━━━━━━━━━━\n<blockquote>Please select your active payment plan tier.</blockquote>",
    selectDept: "📚 <b>ACADEMIC PLACEMENT (2/2)</b>\n━━━━━━━━━━━━━━━━━━━━\n<blockquote>Target your designated academic department below.</blockquote>",
    receiptReceived: "✅ <b>UPLOAD SECURED</b>\nYour document is securely queued. Monitor progress via <b>Track Status</b>.",
    sendReceiptPrompt: "✅ <b>TARGET:</b> <code>{dept}</code>\n━━━━━━━━━━━━━━━━━━━━\n\n📸 <b>AWAITING MEDIA:</b> Transmit your receipt photo now.\n\n<blockquote><i>Note: Low-resolution or cropped images will be auto-rejected by the review team.</i></blockquote>",
    reuploadPrompt: "🔄 <b>OVERRIDE SUBMISSION</b>\nSelect your payment plan to initiate a fresh upload:",
    approvedMsg: "✅ <b>SYSTEM CLEARANCE APPROVED</b>\nYour tuition transaction has been verified by the Finance Office.",
    rejectedMsg: "❌ <b>CLEARANCE DENIED</b>\n━━━━━━━━━━━━━━━━━━━━\n<blockquote><b>ERROR REASON:</b> {reason}</blockquote>\n\n{message}",
    reuploadBtn: "🔄 INITIATE RE-UPLOAD",
    noFileErr: "⚠️ <b>INVALID INPUT:</b> You must transmit an actual <b>photo or screenshot</b>. Text data is ignored.",
    deptUpdated: "🔄 <b>DATABASE UPDATE</b>\nYour dossier has been successfully transferred to <b>{dept}</b>.",
    pendingExists: "⚠️ <b>LOCKOUT: ACTIVE SUBMISSION</b>\n\nYou have a document currently under active staff review. Await resolution.",
    helpText: "❓ <b>SUPPORT DIRECTORY</b>\n\n<blockquote>For technical faults or payment discrepancies, report directly to the central Registrar Office.</blockquote>"
  },
  am: {
    portalWelcome: "🏛 <b>ሬነሳንስ ግሎባል</b> | <i>የተማሪ ፖርታል</i>\n━━━━━━━━━━━━━━━━━━━━\n\n<blockquote><b>እንኳን ወደ ተማሪዎች ማዕከል በሰላም መጡ።</b>\nሞጁሎችን ለማውረድ የክፍያዎን ሂደት ያጠናቅቁ።</blockquote>\n\n<b>⚡️ ዋና እርምጃዎች:</b>\n<code>[1]</code> የክፍያ ዓይነት እና ትምህርት ክፍል ይምረጡ\n<code>[2]</code> ግልጽ የሆነ ደረሰኝ ፎቶ ይላኩ\n<code>[3]</code> ይፋዊ ማረጋገጫ (QR) ይቀበሉ\n\n👇 <i>ለመጀመር ከታች ይምረጡ፡</i>",
    selectPlan: "💳 <b>የክፍያ ሂደት (1/2)</b>\n━━━━━━━━━━━━━━━━━━━━\n<blockquote>እባክዎን የክፍያ መጠን ዓይነትዎን ይምረጡ፡</blockquote>",
    selectDept: "📚 <b>የትምህርት ክፍል (2/2)</b>\n━━━━━━━━━━━━━━━━━━━━\n<blockquote>እባክዎን ትምህርት ክፍልዎን ይምረጡ፡</blockquote>",
    receiptReceived: "✅ <b>ማመልከቻዎ ገብቷል</b>\nየላኩት ደረሰኝ ተመዝግቧል። 'ሁኔታውን እይ' በመጫን መከታተል ይችላሉ።",
    sendReceiptPrompt: "✅ <b>የተመረጠው ክፍል፡</b> <code>{dept}</code>\n━━━━━━━━━━━━━━━━━━━━\n\n📸 <b>ቀጣይ እርምጃ፡</b> የክፍያ ደረሰኝ ፎቶዎን አሁን ይላኩ።\n\n<blockquote><i>ማሳሰቢያ፡ ብዥ ያለ ወይም የተቆረጠ ፎቶ ተቀባይነት የለውም።</i></blockquote>",
    reuploadPrompt: "🔄 <b>እንደገና መላክ</b>\nአዲስ ማመልከቻ ለመጀመር የክፍያ ዓይነትዎን ይምረጡ፡",
    approvedMsg: "✅ <b>ማረጋገጫዎ ጸድቋል</b>\nየክፍያ ማረጋገጫዎ በፋይናንስ ቢሮ ተቀባይነት አግኝቷል።",
    rejectedMsg: "❌ <b>ማመልከቻዎ ውድቅ ተደርጓል</b>\n━━━━━━━━━━━━━━━━━━━━\n<blockquote><b>ምክንያት:</b> {reason}</blockquote>\n\n{message}",
    reuploadBtn: "🔄 ደረሰኝ እንደገና ስቀል",
    noFileErr: "⚠️ <b>ስህተት:</b> እባክዎን ትክክለኛ የክፍያ ደረሰኝ <b>ፎቶ ወይም ስክሪንሾት</b> ይላኩ። ጽሁፍ አይቀበልም።",
    deptUpdated: "🔄 <b>መረጃዎ ተስተካክሏል</b>\nየደረሰኝ ማመልከቻዎ ወደ <b>{dept}</b> ተዛውሯል።",
    pendingExists: "⚠️ <b>በሂደት ላይ ያለ ማመልከቻ አለ</b>\n\nቀደም ሲል የላኩት ደረሰኝ በግምገማ ላይ ነው። መታየት እስኪያልቅ ይጠብቁ።",
    helpText: "❓ <b>የድጋፍ ማዕከል</b>\n\n<blockquote>በክፍያ ወይም በምዝገባ ላይ ችግር ካለዎት፣ እባክዎን የሬጅስትራር ቢሮውን ያነጋግሩ።</blockquote>"
  }
};

const REJECTION_REASONS = [
  { label: "📷 BLURRY/UNREADABLE MEDIA", code: "blurry", message_en: "Please ensure your receipt image is clear, fully visible, and uncropped, then click below to re-upload.", message_am: "እባክዎን የደረሰኝዎ ፎቶ ግልጽ እና ሙሉ በሙሉ የሚታይ መሆኑን አረጋግተው እንደገና ይላኩ።" },
  { label: "💵 TRANSACTION AMOUNT MISMATCH", code: "amount", message_en: "The payment amount does not match your required tuition fees. Please verify your transaction details and re-upload the correct receipt.", message_am: "የተከፈለው የገንዘብ መጠን ከተፈለገው የትምህርት ክፍያ ጋር አይመሳሰልም።" },
  { label: "🚫 INVALID/UNVERIFIED RECEIPT", code: "invalid", message_en: "This receipt could not be verified by our finance team. Please submit an official bank transaction receipt.", message_am: "ይህ ደረሰኝ ሊረጋገጥ አልቻለም። እባክዎን ኦፊሴላዊ የባንክ ደረሰኝ ይላኩ።" },
  { label: "👤 CREDENTIAL MISMATCH (NAME/ID)", code: "mismatch", message_en: "The name or Student ID on the receipt does not match your profile details. Please re-upload a receipt that matches your credentials or contact administration.", message_am: "በደረሰኙ ላይ ያለው ስም ወይም የተማሪ መታወቂያ ከተመዘገበው መረጃ ጋር አይመሳሰልም።" }
];

function getPaymentTypeKeyboard(lang = 'en') {
  if (lang === 'am') {
    return new InlineKeyboard().text("💳 መደበኛ (REGULAR)", "paytype_reg").row().text("🎓 የ 4 ዓመት (FULL COMPLETE)", "paytype_full");
  }
  return new InlineKeyboard().text("💳 REGULAR TIER", "paytype_reg").row().text("🎓 FULL 4-YEAR TIER", "paytype_full");
}

function getDepartmentKeyboard(planType = 'reg') {
  const prefix = planType === 'full' ? 'deptfull_' : 'deptreg_';
  return new InlineKeyboard()
    .text("📈 MARKETING", `${prefix}Marketing Management`).text("💼 BUSINESS", `${prefix}Business Management`).row()
    .text("📊 ACCOUNTING & FINANCE", `${prefix}Accounting and finance`).row()
    .text("🌾 AGRIBUSINESS & VCM", `${prefix}Agribusiness and Value chain management`).row()
    .text("📚 ED. PLANNING & MGMT", `${prefix}Educational planning and management`).row()
    .text("🚚 LOGISTICS & SCM", `${prefix}Logistics and Supply chain management`);
}

function getStaffKeyboard() {
  return new InlineKeyboard()
    .text('🟢 APPROVED DIRECTORY', 'cmd_approved_roster').text('🔍 SEARCH ID', 'cmd_lookfor').row()
    .text('📂 UPLOAD MODULE', 'cmd_upload_module').text('🗑 MANAGE VAULT', 'cmd_delete_module').row()
    .text('🔄 OVERRIDE DEPT', 'cmd_panel_changedept').text('⚠️ REVOKE STATUS', 'cmd_panel_revoke').row()
    .text('📊 LIVE ANALYTICS', 'cmd_stats').text('📈 VAULT STATS', 'cmd_mod_analytics').row()
    .text('📥 EXPORT DATABASE (CSV)', 'cmd_export').row()
    .text('📢 BROADCAST SYSTEM ALERT', 'cmd_broadcast');
}

function getStudentKeyboard(lang = 'en', status = null) {
  const kb = new InlineKeyboard();
  const isAm = lang === 'am';

  if (status === 'PENDING') kb.text(isAm ? '⏳ በግምገማ ላይ...' : '⏳ Review In Progress...', 'cmd_pending_info');
  else if (status === 'APPROVED') kb.text(isAm ? '⬇️ የይለፍ ማረጋገጫ' : '⬇️ Download Clearance', 'cmd_download_pdf');
  else kb.text(isAm ? '📤 ደረሰኝ አስገባ' : '📤 Transmit Receipt', 'cmd_submit');

  kb.text(isAm ? '📌 ሁኔታውን እይ' : '📌 Track Status', 'cmd_status').row();
  kb.text(isAm ? '📚 የትምህርት ሞጁሎች' : '📚 Access Vault', 'cmd_modules').row();
  
  kb.text(isAm ? '📜 የክፍያ ታሪክ' : '📜 Audit History', 'cmd_history')
    .text(isAm ? '❓ እገዛ' : '❓ Get Support', 'cmd_help');

  return kb;
}

function getModuleDepartmentKeyboard() {
  return new InlineKeyboard()
    .text("📈 MARKETING", "moddept_Marketing Management").text("💼 BUSINESS", "moddept_Business Management").row()
    .text("📊 ACCOUNTING & FINANCE", "moddept_Accounting and finance").row()
    .text("🌾 AGRIBUSINESS & VCM", "moddept_Agribusiness and Value chain management").row()
    .text("📚 ED. PLANNING & MGMT", "moddept_Educational planning and management").row()
    .text("🚚 LOGISTICS & SCM", "moddept_Logistics and Supply chain management").row()
    .text("🔙 CANCEL", "moddept_cancel");
}

function getDeleteModuleDepartmentKeyboard() {
  return new InlineKeyboard()
    .text("📈 MARKETING", "delmoddept_Marketing Management").text("💼 BUSINESS", "delmoddept_Business Management").row()
    .text("📊 ACCOUNTING & FINANCE", "delmoddept_Accounting and finance").row()
    .text("🌾 AGRIBUSINESS & VCM", "delmoddept_Agribusiness and Value chain management").row()
    .text("📚 ED. PLANNING & MGMT", "delmoddept_Educational planning and management").row()
    .text("🚚 LOGISTICS & SCM", "delmoddept_Logistics and Supply chain management").row()
    .text("🔙 CANCEL", "delmoddept_cancel");
}

function getApprovedRosterKeyboard() {
  return new InlineKeyboard()
    .text("🌐 EVERY STUDENT (ALL DEPTS)", "roster_all").row()
    .text("📈 MARKETING", "roster_Marketing Management").text("💼 BUSINESS", "roster_Business Management").row()
    .text("📊 ACCOUNTING & FINANCE", "roster_Accounting and finance").row()
    .text("🌾 AGRIBUSINESS & VCM", "roster_Agribusiness and Value chain management").row()
    .text("📚 ED. PLANNING", "roster_Educational planning and management").row()
    .text("🚚 LOGISTICS & SCM", "roster_Logistics and Supply chain management").row()
    .text("🔙 CANCEL", "roster_cancel");
}

function getTransferKeyboard(userId, topicId) {
  return new InlineKeyboard()
    .text("📈 MARKETING", `tr_${userId}_${topicId}_mkt`).text("💼 BUSINESS", `tr_${userId}_${topicId}_biz`).row()
    .text("🌾 AGRIBUSINESS", `tr_${userId}_${topicId}_agri`).text("📚 ED. PLANNING", `tr_${userId}_${topicId}_ed`).row()
    .text("📊 ACCOUNTING", `tr_${userId}_${topicId}_acc`).text("🚚 LOGISTICS", `tr_${userId}_${topicId}_log`).row()
    .text("🔙 CANCEL TRANSFER", `canceltrans_${userId}_${topicId}`);
}

function getRejectionReasonKeyboard(userId, topicId) {
  const kb = new InlineKeyboard();
  REJECTION_REASONS.forEach((r) => kb.text(r.label, `confirmrej_${userId}_${topicId}_${r.code}`).row());
  return kb;
}

async function generateApprovalPDF(userId, username, department, staffName, botUsername, lang = 'en') {
  return new Promise(async (resolve, reject) => {
    try {
      const doc = new PDFDocument({ 
        margin: 0, 
        size: 'A4',
        info: {
          Title: `Official Tuition Clearance - ${userId}`,
          Author: 'Renaissance Global - Finance Office',
          Creator: 'Renaissance Global Secure System',
          Keywords: 'tuition, clearance, verified, secure'
        }
      });
      
      const filePath = path.join(__dirname, `approval_slip_${userId}.pdf`);
      const stream = fs.createWriteStream(filePath);
      doc.pipe(stream);

      const pw = doc.page.width;
      const ph = doc.page.height;
      const serialNum = `RG-CLR-${userId}-${Date.now().toString(36).toUpperCase()}`;

      doc.save();
      doc.translate(pw / 2, ph / 2);
      doc.rotate(-45);
      doc.font('Helvetica-Bold').fontSize(48).fillColor('#000000').fillOpacity(0.04);
      doc.text('VERIFIED CLEARANCE • RENAISSANCE GLOBAL', -400, -50, { width: 800, align: 'center' });
      doc.text(`SECURITY UID: ${userId} • SECURITY UID: ${userId}`, -400, 20, { width: 800, align: 'center' });
      doc.restore(); 

      doc.rect(20, 20, pw - 40, ph - 40).lineWidth(4).stroke('#0a192f');
      doc.rect(28, 28, pw - 56, ph - 56).lineWidth(1).stroke('#cda434');

      let currentY = 70;

      const extensions = ['logo.png', 'logo.jpg', 'logo.jpeg', 'Logo.png', 'Logo.jpg'];
      let logoPath = null;
      for (const ext of extensions) {
        const p = path.join(__dirname, ext);
        if (fs.existsSync(p)) {
          logoPath = p;
          break;
        }
      }

      if (logoPath) {
        doc.image(logoPath, (pw - 110) / 2, currentY, { width: 110 });
        currentY += 125;
      } else {
        doc.circle(pw / 2, currentY + 40, 40).lineWidth(2).stroke('#0a192f');
        doc.font('Helvetica-Bold').fontSize(36).fillColor('#0a192f').text('RG', 0, currentY + 22, { align: 'center', width: pw });
        currentY += 100;
      }

      doc.font('Helvetica-Bold').fontSize(24).fillColor('#0a192f').text('RENAISSANCE GLOBAL', 0, currentY, { align: 'center', width: pw, characterSpacing: 2 });
      currentY += 30;
      doc.font('Helvetica').fontSize(12).fillColor('#475569').text('COLLEGE OF OPEN & VIRTUAL LEARNING', 0, currentY, { align: 'center', width: pw, characterSpacing: 1 });
      currentY += 20;
      doc.fontSize(10).fillColor('#2563eb').text('https://reguovle.edu.et', 0, currentY, { align: 'center', width: pw, link: 'https://reguovle.edu.et' });
      currentY += 45;

      doc.moveTo(80, currentY).lineTo(pw - 80, currentY).lineWidth(1).stroke('#e2e8f0');
      currentY += 30;

      doc.font('Helvetica-Bold').fontSize(16).fillColor('#0f172a').text('OFFICIAL TUITION CLEARANCE CERTIFICATE', 0, currentY, { align: 'center', width: pw, characterSpacing: 1 });
      currentY += 20;
      doc.font('Helvetica-Oblique').fontSize(9).fillColor('#64748b').text(`SECURE SERIAL: ${serialNum}`, 0, currentY, { align: 'center', width: pw });
      currentY += 35;

      const pillWidth = 320;
      const pillX = (pw - pillWidth) / 2;
      doc.roundedRect(pillX, currentY, pillWidth, 34, 17).fill('#10b981');
      doc.font('Helvetica-Bold').fontSize(12).fillColor('#ffffff').text('●  VERIFIED & CLEARED FOR REGISTRATION', 0, currentY + 11.5, { align: 'center', width: pw, characterSpacing: 1 });
      currentY += 65;

      const cardX = 65;
      const cardWidth = pw - (cardX * 2);
      const cardY = currentY;
      doc.roundedRect(cardX, cardY, cardWidth, 190, 8).fillAndStroke('#f8fafc', '#cbd5e1');
      
      currentY += 25;
      doc.font('Helvetica-Bold').fontSize(13).fillColor('#1e293b').text('STUDENT CREDENTIALS', cardX + 25, currentY);
      
      doc.moveTo(cardX + 25, currentY + 20).lineTo(cardX + cardWidth - 25, currentY + 20).lineWidth(1).stroke('#e2e8f0');
      currentY += 40;

      const leftCol = cardX + 25;
      const rightCol = cardX + 130;
      const rowGap = 28;
      
      doc.font('Helvetica-Bold').fontSize(11).fillColor('#475569').text('Telegram UID:', leftCol, currentY);
      doc.font('Helvetica-Bold').fillColor('#0f172a').text(String(userId), rightCol, currentY);
      currentY += rowGap;

      doc.font('Helvetica-Bold').fillColor('#475569').text('Username:', leftCol, currentY);
      doc.font('Helvetica').fillColor('#0f172a').text(`@${cleanForPDF(username || 'N/A')}`, rightCol, currentY);
      currentY += rowGap;

      doc.font('Helvetica-Bold').fillColor('#475569').text('Department:', leftCol, currentY);
      doc.font('Helvetica-Bold').fillColor('#0a192f').text(cleanForPDF(department), rightCol, currentY, { width: cardWidth - 140 });
      
      currentY = cardY + 190 + 35; 

      const issueDate = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
      const issueTime = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
      
      const authX = 80;
      doc.font('Helvetica-Bold').fontSize(11).fillColor('#334155').text('VERIFICATION DETAILS', authX, currentY);
      doc.font('Helvetica').fontSize(10).fillColor('#475569');
      doc.text(`Authorized By: ${cleanForPDF(staffName)}`, authX, currentY + 20);
      doc.text(`Timestamp: ${issueDate} at ${issueTime}`, authX, currentY + 38);
      doc.text(`System Signature: SHA-256 Validated`, authX, currentY + 56);

      const qrData = botUsername ? `https://t.me/${botUsername}?start=verify_${userId}` : `RENAISSANCE_GLOBAL_VERIFY:${userId}`;
      const qrBuffer = await QRCode.toBuffer(qrData, { width: 110, margin: 1, color: { dark: '#0a192f', light: '#ffffff' } });
      
      const qrX = pw - 80 - 110;
      doc.rect(qrX - 2, currentY - 2, 114, 114).lineWidth(1).stroke('#cbd5e1'); 
      doc.image(qrBuffer, qrX, currentY);
      
      currentY += 130;

      doc.moveTo(80, ph - 110).lineTo(pw - 80, ph - 110).lineWidth(1).stroke('#e2e8f0');
      
      doc.font('Helvetica-Bold').fontSize(12).fillColor('#0a192f').text('FINANCE / REGISTRAR OFFICE', 80, ph - 85);
      doc.moveTo(80, ph - 65).lineTo(260, ph - 65).lineWidth(1).stroke('#0a192f');
      doc.font('Helvetica-Oblique').fontSize(8).fillColor('#64748b').text('Authorized Digital System Signature', 80, ph - 55);
      
      doc.font('Helvetica').fontSize(7).fillColor('#94a3b8').text('This document contains encrypted live QR verification and digital telemetry. Any digital alteration, unauthorized reproduction, or tampering renders this clearance permanently void and subject to academic penalty.', pw - 300, ph - 85, { width: 220, align: 'right' });

      doc.end();
      stream.on('finish', () => resolve(filePath));
      stream.on('error', reject);
    } catch (err) {
      reject(err);
    }
  });
}

bot.catch((err) => console.error('Bot Error:', err));

async function getOrCreateDepartmentTopic(ctx, departmentName, targetGroupId) {
  const baseDept = departmentName.replace(/\s*\((Regular \/ Term|4-Year Complete)\)$/, '').trim();

  const cached = await pool.query(
    'SELECT topic_id FROM department_topics WHERE group_id = $1 AND department = $2 LIMIT 1',
    [targetGroupId, baseDept]
  );

  if (cached.rows.length > 0) {
    return Number(cached.rows[0].topic_id);
  }

  const newTopic = await ctx.api.createForumTopic(targetGroupId, `📁 [${baseDept}]`);
  const topicId = newTopic.message_thread_id;

  await pool.query(
    'DELETE FROM department_topics WHERE group_id = $1 AND department = $2',
    [targetGroupId, baseDept]
  );

  await pool.query(
    'INSERT INTO department_topics (group_id, department, topic_id) VALUES ($1, $2, $3)',
    [targetGroupId, baseDept, topicId]
  );

  return topicId;
}

async function getOrCreateModulesVaultTopic(ctx, targetGroupId) {
  const cached = await pool.query(
    'SELECT modules_topic_id FROM group_settings WHERE group_id = $1 LIMIT 1',
    [targetGroupId]
  );

  if (cached.rows.length > 0 && cached.rows[0].modules_topic_id) {
    return Number(cached.rows[0].modules_topic_id);
  }

  const newTopic = await ctx.api.createForumTopic(targetGroupId, '📚 [COURSE MODULES VAULT]');
  const topicId = newTopic.message_thread_id;

  await pool.query(
    'UPDATE group_settings SET modules_topic_id = $1 WHERE group_id = $2',
    [topicId, targetGroupId]
  );

  return topicId;
}

async function generateSummaryText(statusType) {
  const res = await pool.query(`
    SELECT department, COUNT(*) as count 
    FROM tickets 
    WHERE status = $1 
    GROUP BY department 
    ORDER BY department ASC
  `, [statusType]);

  const icon = statusType === 'APPROVED' ? '✅' : '❌';
  let text = `📊 <b>${icon} ${statusType} RECEIPTS DIRECTORY</b>\n━━━━━━━━━━━━━━━━━━━━\n`;
  if (res.rows.length === 0) {
    text += `<blockquote><i>No ${statusType.toLowerCase()} records in database.</i></blockquote>`;
    return text;
  }
  text += `<blockquote>`;
  res.rows.forEach((r) => {
    text += `• <b>${escapeHtml(r.department)}</b>: <code>${r.count}</code> student(s)\n`;
  });
  text += `</blockquote>`;
  return text;
}

async function sendCSVExport(staffGroupId, threadId, captionText) {
  try {
    const res = await pool.query(`
      SELECT user_id, username, department, status, rejection_reason, processed_by, created_at, updated_at 
      FROM tickets 
      ORDER BY department ASC, status ASC, updated_at DESC
    `);

    if (res.rows.length === 0) {
      return bot.api.sendMessage(staffGroupId, "⚠️ <b>EMPTY DATABASE:</b> No receipts found to export.", { message_thread_id: threadId, parse_mode: 'HTML' });
    }

    let csv = "Student Telegram ID,Username,Department & Tag,Status,Rejection Reason,Processed By,Created At,Updated At\n";
    res.rows.forEach((r) => {
      const uname = r.username ? `"${r.username.replace(/"/g, '""')}"` : "";
      const reason = r.rejection_reason ? `"${r.rejection_reason.replace(/"/g, '""')}"` : "";
      const staff = r.processed_by ? `"${r.processed_by.replace(/"/g, '""')}"` : "";
      csv += `${r.user_id},${uname},"${r.department}",${r.status},${reason},${staff},${r.created_at},${r.updated_at}\n`;
    });

    const filePath = path.join(__dirname, 'receipts_audit.csv');
    fs.writeFileSync(filePath, csv);

    await bot.api.sendDocument(
      staffGroupId,
      new InputFile(filePath, `Receipts_Audit_${new Date().toISOString().split('T')[0]}.csv`),
      { message_thread_id: threadId, caption: captionText, parse_mode: 'HTML' }
    );
  } catch (err) {
    console.error("Export error:", err);
    await bot.api.sendMessage(staffGroupId, `❌ <b>SYSTEM ERROR:</b> ${err.message}`, { message_thread_id: threadId, parse_mode: 'HTML' });
  }
}

async function performSearch(ctx, query, topicId) {
  const cleanQuery = query.replace(/^@/, '');

  const res = await pool.query(
    `SELECT user_id, username, department, status, rejection_reason, processed_by, created_at, updated_at 
     FROM tickets 
     WHERE user_id::text = $1 
        OR LOWER(username) = LOWER($1) 
        OR LOWER(department) LIKE LOWER($2)
     ORDER BY updated_at DESC LIMIT 10`,
    [cleanQuery, `%${cleanQuery}%`]
  );

  if (res.rows.length === 0) {
    return ctx.reply(`🔍 <b>DATABASE QUERY FAILED:</b> No records matching <code>${escapeHtml(query)}</code>`, { 
      message_thread_id: topicId, 
      parse_mode: 'HTML' 
    });
  }

  let text = `🔍 <b>QUERY RESULTS:</b> <code>${escapeHtml(query)}</code> (${res.rows.length})\n━━━━━━━━━━━━━━━━━━━━\n\n`;

  res.rows.forEach((r, idx) => {
    let statusEmoji = r.status === 'APPROVED' ? "✅" : (r.status === 'REJECTED' ? "❌" : "⏳");
    const uname = r.username ? `@${r.username}` : "N/A";
    const staff = r.processed_by ? `\n   ↳ <i>Cleared By: ${escapeHtml(r.processed_by)}</i>` : "";
    
    text += `<code>[${idx + 1}]</code> ${statusEmoji} <b>${escapeHtml(r.department)}</b>\n<blockquote>• <b>ID:</b> <code>${r.user_id}</code> (${escapeHtml(uname)})\n• <b>Status:</b> <b>${r.status}</b>${staff}\n• <b>Timestamp:</b> ${new Date(r.updated_at).toLocaleDateString()}</blockquote>\n\n`;
  });

  await ctx.reply(text, { message_thread_id: topicId, parse_mode: 'HTML' });
}

async function performBroadcast(ctx, topicId, broadcastMsg) {
  if (!broadcastMsg) {
    return ctx.reply("⚠️ <b>ERROR:</b> Broadcast text payload cannot be empty.", { message_thread_id: topicId, parse_mode: 'HTML' });
  }

  const usersRes = await pool.query('SELECT DISTINCT user_id FROM user_settings');
  let successCount = 0;
  await ctx.reply(`📢 <b>INITIATING SYSTEM BROADCAST:</b> Targeting <code>${usersRes.rows.length}</code> students...`, { message_thread_id: topicId, parse_mode: 'HTML' });

  for (const row of usersRes.rows) {
    try {
      await bot.api.sendMessage(row.user_id, `📢 <b>SYSTEM ANNOUNCEMENT / ማስታወቂያ</b>\n━━━━━━━━━━━━━━━━━━━━\n\n<blockquote>${escapeHtml(broadcastMsg)}</blockquote>`, { parse_mode: 'HTML' });
      successCount++;
    } catch (err) {}
  }

  await ctx.reply(`✅ <b>BROADCAST TRANSMISSION COMPLETE</b>\n━━━━━━━━━━━━━━━━━━━━\n• <b>Delivered to:</b> <code>${successCount}</code> students`, { message_thread_id: topicId, parse_mode: 'HTML' });
}

bot.command('bind', async (ctx) => {
  if (ctx.chat.type === 'private') {
    return ctx.reply("⚠️ <b>DENIED:</b> Execution requires a supergroup context with topics enabled.", { parse_mode: 'HTML' });
  }

  try {
    const member = await ctx.getChatMember(ctx.from.id);
    if (!['administrator', 'creator'].includes(member.status)) {
      return ctx.reply("❌ <b>DENIED:</b> Root administrator privileges required.", { parse_mode: 'HTML' });
    }
  } catch (err) {
    console.error("Error checking permissions:", err);
  }

  const groupId = String(ctx.chat.id);

  const check = await pool.query('SELECT 1 FROM group_settings WHERE group_id = $1', [groupId]);
  if (check.rows.length > 0) {
    await pool.query('UPDATE group_settings SET is_active = TRUE, updated_at = CURRENT_TIMESTAMP WHERE group_id = $1', [groupId]);
  } else {
    await pool.query('INSERT INTO group_settings (group_id, is_active) VALUES ($1, TRUE)', [groupId]);
  }

  await ctx.reply(
    "✅ <b>COMMAND CENTER SECURED</b>\n━━━━━━━━━━━━━━━━━━━━\n<blockquote>This group is now configured as the primary Staff Action Panel. All telemetry, receipt submissions, and database controls will route here.</blockquote>",
    { parse_mode: 'HTML' }
  );
});

bot.command('deadline', async (ctx) => {
  if (!(await isStaff(ctx))) return;
  
  const unapprovedUsers = await pool.query(`
    SELECT DISTINCT u.user_id, u.language 
    FROM user_settings u
    LEFT JOIN tickets t ON u.user_id = t.user_id AND t.status = 'APPROVED'
    WHERE t.user_id IS NULL
  `);

  let sent = 0;
  await ctx.reply(`📢 <b>INITIATING DEADLINE BROADCAST:</b> Targeting <code>${unapprovedUsers.rows.length}</code> unapproved students...`, { parse_mode: 'HTML' });

  for (const row of unapprovedUsers.rows) {
    const lang = row.language || 'en';
    const msg = lang === 'am'
      ? `🚨 <b>የመጨረሻ ማሳሰቢያ: የክፍያ ጊዜው ሊያበቃ ነው</b>\n━━━━━━━━━━━━━━━━━━━━\n<blockquote>በሲስተማችን ላይ እስካሁን የክፍያ ማረጋገጫዎ አልጸደቀም። ሞጁሎች ከመቆለፋቸው በፊት እባክዎን ደረሰኝዎን አሁኑኑ ያስገቡ!</blockquote>`
      : `🚨 <b>CRITICAL DEADLINE WARNING</b>\n━━━━━━━━━━━━━━━━━━━━\n<blockquote>Our database indicates you do not have an APPROVED tuition clearance.</blockquote>\n\n<i>Failure to submit your receipt will result in locked course modules and revoked campus access. Please submit immediately.</i>`;
    
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
    const check = await pool.query(
      "SELECT department, status, rejection_reason, updated_at FROM tickets WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 1",
      [verifyId]
    );

    if (check.rows.length === 0) {
      return ctx.reply(`⚠️ <b>SYSTEM ERROR:</b> No official registration record found for UID <code>${escapeHtml(verifyId)}</code>`, { parse_mode: 'HTML' });
    }

    const rec = check.rows[0];
    if (rec.status === 'APPROVED') {
      return ctx.reply(
        `✅ <b>OFFICIAL CLEARANCE STATUS: VALID</b>\n━━━━━━━━━━━━━━━━━━━━\n<blockquote>• <b>Student ID:</b> <code>${escapeHtml(verifyId)}</code>\n• <b>Department:</b> ${escapeHtml(rec.department)}\n• <b>Status:</b> APPROVED & CLEARED\n• <b>Timestamp:</b> ${new Date(rec.updated_at).toLocaleDateString()}</blockquote>\n\n<i>This student is officially verified for campus integration.</i>`,
        { parse_mode: 'HTML' }
      );
    } else {
      return ctx.reply(
        `🚨 <b>OFFICIAL CLEARANCE STATUS: INVALID / VOID</b>\n━━━━━━━━━━━━━━━━━━━━\n<blockquote>• <b>Student ID:</b> <code>${escapeHtml(verifyId)}</code>\n• <b>Department:</b> ${escapeHtml(rec.department)}\n• <b>Status:</b> ❌ ${escapeHtml(rec.status)}</blockquote>\n\n⚠️ <b>CRITICAL WARNING:</b> This document is not authorized by administration. Confiscate or reject entry!`,
        { parse_mode: 'HTML' }
      );
    }
  }

  if (ctx.chat.type === 'private') {
    const userId = ctx.from.id;
    await clearPendingDepartment(userId);

    const langKeyboard = new InlineKeyboard()
      .text("🇬🇧 ENGLISH", "lang_en")
      .text("🇪🇹 አማርኛ", "lang_am");

    await ctx.reply(
      "🌐 <b>SYSTEM LOCALIZATION / ቋንቋ ይምረጡ:</b>\n━━━━━━━━━━━━━━━━━━━━\n<blockquote>Select your preferred interface language below to initialize the portal.</blockquote>",
      { parse_mode: 'HTML', reply_markup: langKeyboard }
    );
  }
});

bot.command('panel', async (ctx) => {
  const authorized = await isStaff(ctx);

  if (!authorized && ctx.chat.type !== 'private') return;

  if (authorized) {
    const topicId = ctx.message?.message_thread_id;
    return ctx.reply(
      "⚙️ <b>COMMAND CENTER ACTION PANEL</b>\n━━━━━━━━━━━━━━━━━━━━\n\n<i>Select a root administrative function below:</i>",
      {
        message_thread_id: topicId,
        parse_mode: 'HTML',
        reply_markup: getStaffKeyboard()
      }
    );
  }

  const userId = ctx.from.id;
  const lang = await getUserLang(userId);
  await ctx.reply(
    STRINGS[lang].portalWelcome,
    { parse_mode: 'HTML', reply_markup: getStudentKeyboard(lang, null) }
  );
});

bot.on('message:contact', async (ctx) => {
  if (ctx.chat.type === 'private') {
    const phone = ctx.message.contact.phone_number;
    await pool.query('UPDATE user_settings SET phone_number = $1 WHERE user_id = $2', [phone, ctx.from.id]);
    
    const lang = await getUserLang(ctx.from.id);
    
    await ctx.reply(lang === 'am' ? "✅ <b>ስልክዎ ተመዝግቧል!</b>" : "✅ <b>Profile Verified!</b>", { parse_mode: 'HTML', reply_markup: { remove_keyboard: true } });
    
    await ctx.reply(STRINGS[lang].portalWelcome, { parse_mode: 'HTML', reply_markup: getStudentKeyboard(lang, null) });
  }
});

async function executeRevoke(ctx, targetUserId, topicId) {
  const staffName = `${ctx.from.first_name || ''} ${ctx.from.last_name || ''}`.trim() || `Staff`;
  const reasonText = 'Approval revoked by administration (Verification error / Audit mismatch)';

  const updateRes = await pool.query(
    `UPDATE tickets 
     SET status = 'REJECTED', 
         rejection_reason = $1, 
         processed_by = $2, 
         updated_at = CURRENT_TIMESTAMP 
     WHERE id = (
       SELECT id FROM tickets WHERE user_id = $3 AND status = 'APPROVED' ORDER BY updated_at DESC LIMIT 1
     ) RETURNING department, username, panel_msg_id`,
    [reasonText, staffName, targetUserId]
  );

  if (updateRes.rowCount === 0) {
    return ctx.reply(`⚠️ <b>OVERRIDE FAILED:</b> No approved record found to revoke for UID <code>${targetUserId}</code>.`, { message_thread_id: topicId, parse_mode: 'HTML' });
  }

  const { department, username, panel_msg_id } = updateRes.rows[0];
  const studentLang = await getUserLang(targetUserId);

  pushToGoogleSheet(targetUserId, username, department, 'REVOKED', staffName, reasonText);

  if (panel_msg_id) {
    try {
      await ctx.api.editMessageReplyMarkup(targetUserId, Number(panel_msg_id), {
        reply_markup: getStudentKeyboard(studentLang, 'REJECTED')
      });
    } catch (e) {}
  }

  const notifMsg = studentLang === 'am'
    ? `⚠️ <b>የውሳኔ ማስተካከያ ማሳሰቢያ</b>\n━━━━━━━━━━━━━━━━━━━━\nውድ ተማሪ፣ ለ<b>${escapeHtml(department)}</b> የተሰጠው የክፍያ ማረጋገጫ በስህተት በመጽደቁ ምክንያት ውድቅ ተደርጓል።\n\n<blockquote>❌ <b>ሁኔታ:</b> ውድቅ ተደርጓል (REVOKED)</blockquote>\n📌 <b>ማሳሰቢያ:</b> ቀደም ሲል ያወረዱት ፒዲኤፍ ደረሰኝ በፈተና ወቅት ተቀባይነት የለውም።\n\n<i>እባክዎን ትክክለኛውን ደረሰኝ እንደገና ይላኩ።</i>`
    : `⚠️ <b>NOTICE OF APPROVAL REVOCATION</b>\n━━━━━━━━━━━━━━━━━━━━\nDear Student,\nYour tuition clearance for <b>${escapeHtml(department)}</b> has been revoked by administration following a system audit.\n\n<blockquote>❌ <b>STATUS:</b> REVOKED / REJECTED</blockquote>\n📌 <b>WARNING:</b> Any previously downloaded PDF slip is now officially VOID.\n\n<i>Please re-upload your valid bank receipt below:</i>`;

  const resubmitKb = new InlineKeyboard().text(STRINGS[studentLang].reuploadBtn, "start_resubmit");
  try {
    await ctx.api.sendMessage(targetUserId, notifMsg, { parse_mode: 'HTML', reply_markup: resubmitKb });
  } catch (e) {}

  await ctx.reply(
    `✅ <b>OVERRIDE SUCCESSFUL: STATUS REVOKED</b>\n━━━━━━━━━━━━━━━━━━━━\n<blockquote>• <b>Target UID:</b> <code>${targetUserId}</code>\n• <b>Department:</b> ${escapeHtml(department)}\n• <b>Authorized By:</b> ${escapeHtml(staffName)}</blockquote>\n\n<i>Student modules are locked. Live QR scans will now flag as VOID.</i>`,
    { message_thread_id: topicId, parse_mode: 'HTML' }
  );
}

bot.command('revoke', async (ctx) => {
  const authorized = await isStaff(ctx);
  if (!authorized) return;

  const topicId = ctx.message.message_thread_id;
  let targetIdStr = ctx.message.text.replace(/^\/revoke/, '').trim();

  if (!targetIdStr && ctx.message.reply_to_message && ctx.message.reply_to_message.text) {
    const match = ctx.message.reply_to_message.text.match(/Student ID:\s*`?(\d+)`?/i) || ctx.message.reply_to_message.text.match(/ID:\s*<code.*?>(\d+)<\/code>/i) || ctx.message.reply_to_message.text.match(/Student ID: (\d+)/i) || ctx.message.reply_to_message.text.match(/Target UID: <code.*?>(\d+)<\/code>/i) || ctx.message.reply_to_message.text.match(/Target UID:\s*`?(\d+)`?/i);
    if (match) targetIdStr = match[1];
  }

  const targetUserId = Number(targetIdStr);
  if (!targetUserId) {
    return ctx.reply(
      "⚠️ <b>SYNTAX ERROR:</b>\nType: <code>/revoke &lt;UID&gt;</code>\n*Example:* <code>/revoke 123456789</code>\n\n<i>(Alternatively, reply directly to an approved receipt with <code>/revoke</code>)</i>",
      { message_thread_id: topicId, parse_mode: 'HTML' }
    );
  }

  await executeRevoke(ctx, targetUserId, topicId);
});

bot.callbackQuery('cmd_panel_revoke', async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  if (!(await isStaff(ctx))) return;

  await ctx.reply(
    "⚠️ <b>INITIATE STATUS REVOCATION</b>\n\n<i>Reply directly to this system message with the target <b>Student ID</b>.</i>",
    {
      message_thread_id: ctx.callbackQuery.message.message_thread_id,
      parse_mode: 'HTML',
      reply_markup: { force_reply: true }
    }
  );
});

async function executeChangeDeptPrompt(ctx, targetUserId, topicId) {
  const res = await pool.query(
    "SELECT username, department FROM tickets WHERE user_id = $1 AND status = 'APPROVED' ORDER BY updated_at DESC LIMIT 1",
    [targetUserId]
  );

  if (res.rows.length === 0) {
    return ctx.reply(`⚠️ <b>OVERRIDE FAILED:</b> No active clearance found for UID <code>${targetUserId}</code>.`, { message_thread_id: topicId, parse_mode: 'HTML' });
  }

  const { username, department } = res.rows[0];

  const kb = new InlineKeyboard()
    .text("📈 MARKETING", `chgdept_${targetUserId}_mkt`)
    .text("💼 BUSINESS", `chgdept_${targetUserId}_biz`).row()
    .text("📊 ACCOUNTING", `chgdept_${targetUserId}_acc`)
    .text("🌾 AGRIBUSINESS", `chgdept_${targetUserId}_agri`).row()
    .text("📚 ED. PLANNING", `chgdept_${targetUserId}_ed`)
    .text("🚚 LOGISTICS", `chgdept_${targetUserId}_log`).row()
    .text("🔙 ABORT CHANGE", `chgdept_${targetUserId}_cancel`);

  await ctx.reply(
    `🔄 <b>MODIFY ACADEMIC PLACEMENT</b>\n━━━━━━━━━━━━━━━━━━━━\n<blockquote>• <b>Target UID:</b> <code>${targetUserId}</code>\n• <b>User Alias:</b> @${escapeHtml(username) || 'N/A'}\n• <b>Current Assg:</b> ${escapeHtml(department)}</blockquote>\n\n<i>Select the new department parameter below:</i>`,
    { message_thread_id: topicId, parse_mode: 'HTML', reply_markup: kb }
  );
}

bot.command(['changedept', 'changedep'], async (ctx) => {
  const authorized = await isStaff(ctx);
  if (!authorized) return;

  const topicId = ctx.message.message_thread_id;
  let targetIdStr = ctx.message.text.replace(/^\/(changedept|changedep)/, '').trim();

  if (!targetIdStr && ctx.message.reply_to_message && ctx.message.reply_to_message.text) {
    const match = ctx.message.reply_to_message.text.match(/Student ID:\s*`?(\d+)`?/i) || ctx.message.reply_to_message.text.match(/ID:\s*<code.*?>(\d+)<\/code>/i) || ctx.message.reply_to_message.text.match(/Student ID: (\d+)/i) || ctx.message.reply_to_message.text.match(/Target UID: <code.*?>(\d+)<\/code>/i) || ctx.message.reply_to_message.text.match(/Target UID:\s*`?(\d+)`?/i);
    if (match) targetIdStr = match[1];
  }

  const targetUserId = Number(targetIdStr);
  if (!targetUserId) {
    return ctx.reply(
      "⚠️ <b>SYNTAX ERROR:</b>\nType: <code>/changedept &lt;UID&gt;</code>\n*Example:* <code>/changedept 123456789</code>\n\n<i>(Alternatively, reply directly to an approved receipt with <code>/changedept</code>)</i>",
      { message_thread_id: topicId, parse_mode: 'HTML' }
    );
  }

  await executeChangeDeptPrompt(ctx, targetUserId, topicId);
});

bot.callbackQuery('cmd_panel_changedept', async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  if (!(await isStaff(ctx))) return;

  await ctx.reply(
    "🔄 <b>INITIATE DEPARTMENT OVERRIDE</b>\n\n<i>Reply directly to this system message with the target <b>Student ID</b>.</i>",
    {
      message_thread_id: ctx.callbackQuery.message.message_thread_id,
      parse_mode: 'HTML',
      reply_markup: { force_reply: true }
    }
  );
});

bot.callbackQuery(/^chgdept_(\d+)_(mkt|biz|acc|agri|ed|log|cancel)$/, async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}

  const targetUserId = Number(ctx.match[1]);
  const deptCode = ctx.match[2];
  const staffName = `${ctx.from.first_name || ''} ${ctx.from.last_name || ''}`.trim() || `Staff`;

  if (deptCode === 'cancel') {
    return ctx.editMessageText("❌ <b>OPERATION ABORTED:</b> Department override cancelled.", { parse_mode: 'HTML' });
  }

  const deptMap = {
    mkt: "Marketing Management",
    biz: "Business Management",
    acc: "Accounting and finance",
    agri: "Agribusiness and Value chain management",
    ed: "Educational planning and management",
    log: "Logistics and Supply chain management"
  };

  const ticketRes = await pool.query(
    "SELECT id, department, username FROM tickets WHERE user_id = $1 AND status = 'APPROVED' ORDER BY updated_at DESC LIMIT 1",
    [targetUserId]
  );

  if (ticketRes.rows.length === 0) {
    return ctx.editMessageText("⚠️ <b>ERROR:</b> Target record no longer active/approved.", { parse_mode: 'HTML' });
  }

  const oldDept = ticketRes.rows[0].department || '';
  const username = ticketRes.rows[0].username || '';
  const planSuffix = oldDept.includes("(4-Year Complete)") ? "(4-Year Complete)" : "(Regular / Term)";
  const newFullDept = `${deptMap[deptCode]} ${planSuffix}`;

  await pool.query(
    "UPDATE tickets SET department = $1, processed_by = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3",
    [newFullDept, staffName, ticketRes.rows[0].id]
  );

  pushToGoogleSheet(targetUserId, username, newFullDept, 'APPROVED', staffName, 'Department Overridden');

  await ctx.editMessageText(
    `✅ <b>DEPARTMENT OVERRIDE SUCCESSFUL</b>\n━━━━━━━━━━━━━━━━━━━━\n<blockquote>• <b>Target UID:</b> <code>${targetUserId}</code>\n• <b>New Assignment:</b> ${escapeHtml(newFullDept)}\n• <b>Authorized By:</b> ${escapeHtml(staffName)}</blockquote>\n\n<i>The user's Module Vault has been automatically synced to the new assignment.</i>`,
    { parse_mode: 'HTML' }
  );

  try {
    const studentLang = await getUserLang(targetUserId);
    const notifMsg = studentLang === 'am'
      ? `🔄 <b>የትምህርት ክፍልዎ ተቀይሯል</b>\n━━━━━━━━━━━━━━━━━━━━\n<blockquote>አዲሱ ክፍልዎ፡ <b>${escapeHtml(newFullDept)}</b></blockquote>\nአሁን አዲሶቹን ሞጁሎች በ <b>📚 የትምህርት ሞጁሎች</b> ማውረድ ይችላሉ።`
      : `🔄 <b>ACADEMIC PLACEMENT UPDATED</b>\n━━━━━━━━━━━━━━━━━━━━\n<blockquote>Your system profile has been transferred to:\n👉 <b>${escapeHtml(newFullDept)}</b></blockquote>\nAccess your new course materials under <b>📚 Access Vault</b>!`;

    await bot.api.sendMessage(targetUserId, notifMsg, { parse_mode: 'HTML' });
  } catch (err) {
    console.error("Could not notify student of dept change:", err);
  }
});

bot.command(['deletemodule', 'delmod'], async (ctx) => {
  const authorized = await isStaff(ctx);
  if (!authorized) return;

  const topicId = ctx.message.message_thread_id;

  await ctx.reply(
    "🗑 <b>MANAGE VAULT PURGE</b>\n━━━━━━━━━━━━━━━━━━━━\n<i>Select a departmental parameter to access its modules for deletion:</i>",
    { message_thread_id: topicId, parse_mode: 'HTML', reply_markup: getDeleteModuleDepartmentKeyboard() }
  );
});

bot.callbackQuery('cmd_delete_module', async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  const authorized = await isStaff(ctx);
  if (!authorized) return;

  await clearStaffPendingModuleDept(ctx.from.id);

  await ctx.reply(
    "🗑 <b>MANAGE VAULT PURGE</b>\n━━━━━━━━━━━━━━━━━━━━\n<i>Select a departmental parameter to access its modules for deletion:</i>",
    { message_thread_id: ctx.callbackQuery.message.message_thread_id, parse_mode: 'HTML', reply_markup: getDeleteModuleDepartmentKeyboard() }
  );
});

bot.callbackQuery(/^delmoddept_(.+)$/, async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  const dept = ctx.match[1];

  if (dept === 'cancel') {
    return ctx.editMessageText("❌ <b>OPERATION ABORTED:</b> Vault purge cancelled.", { parse_mode: 'HTML' });
  }

  const res = await pool.query(
    "SELECT id, title, file_name FROM department_modules WHERE department ILIKE $1 ORDER BY id ASC",
    [`%${dept}%`]
  );

  if (res.rows.length === 0) {
    return ctx.editMessageText(`ℹ️ <b>VAULT EMPTY:</b> No documents located for <b>${escapeHtml(dept)}</b>.`, { parse_mode: 'HTML' });
  }

  const kb = new InlineKeyboard();
  res.rows.forEach((m) => {
    kb.text(`🗑 REMOVE: ${m.title.substring(0,25)}...`, `confirm_delmod_${m.id}`).row();
  });
  kb.text("🔙 ABORT PROCESS", "delmoddept_cancel");

  await ctx.editMessageText(
    `🗑 <b>TARGET SECURED: ${escapeHtml(dept)}</b>\n━━━━━━━━━━━━━━━━━━━━\n<i>Warning: Deleting a module instantly revokes access for all enrolled students. Select file to purge:</i>`,
    { parse_mode: 'HTML', reply_markup: kb }
  );
});

bot.callbackQuery(/^confirm_delmod_(\d+)$/, async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  const moduleId = Number(ctx.match[1]);

  const res = await pool.query(
    "DELETE FROM department_modules WHERE id = $1 RETURNING title, department",
    [moduleId]
  );

  if (res.rowCount === 0) {
    return ctx.editMessageText("⚠️ <b>ERROR:</b> Document already purged or missing.", { parse_mode: 'HTML' });
  }

  const { title, department } = res.rows[0];

  await ctx.editMessageText(
    `✅ <b>VAULT PURGE SUCCESSFUL</b>\n━━━━━━━━━━━━━━━━━━━━\n<blockquote>• <b>Title:</b> ${escapeHtml(title)}\n• <b>Sector:</b> ${escapeHtml(department)}</blockquote>\n\n<i>Document has been permanently eradicated from student access.</i>`,
    { parse_mode: 'HTML' }
  );
});

bot.command(['approved', 'students'], async (ctx) => {
  const authorized = await isStaff(ctx);
  if (!authorized) return;

  const topicId = ctx.message.message_thread_id;

  await ctx.reply(
    "👥 <b>ACCESS APPROVED DIRECTORY</b>\n━━━━━━━━━━━━━━━━━━━━\n<i>Filter database by departmental parameters:</i>",
    { message_thread_id: topicId, parse_mode: 'HTML', reply_markup: getApprovedRosterKeyboard() }
  );
});

bot.callbackQuery('cmd_approved_roster', async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  if (!(await isStaff(ctx))) return;

  const topicId = ctx.callbackQuery.message.message_thread_id;

  await ctx.reply(
    "👥 <b>ACCESS APPROVED DIRECTORY</b>\n━━━━━━━━━━━━━━━━━━━━\n<i>Filter database by departmental parameters:</i>",
    { message_thread_id: topicId, parse_mode: 'HTML', reply_markup: getApprovedRosterKeyboard() }
  );
});

bot.callbackQuery(/^roster_(.+)$/, async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  const targetDept = ctx.match[1];

  if (targetDept === 'cancel') {
    return ctx.editMessageText("❌ <b>OPERATION ABORTED:</b> Directory search cancelled.", { parse_mode: 'HTML' });
  }

  const isAll = targetDept === 'all';
  const cleanDept = targetDept.replace(/\s*\((Regular \/ Term|4-Year Complete)\)$/, '').trim();

  let query = `
    SELECT t.user_id, t.username, t.department, t.processed_by, t.updated_at
    FROM tickets t
    INNER JOIN (
      SELECT user_id, MAX(updated_at) as max_date
      FROM tickets
      WHERE status = 'APPROVED'
      GROUP BY user_id
    ) latest ON t.user_id = latest.user_id AND t.updated_at = latest.max_date
    WHERE t.status = 'APPROVED'
  `;

  const params = [];
  if (!isAll) {
    query += ` AND t.department ILIKE $1`;
    params.push(`%${cleanDept}%`);
  }
  query += ` ORDER BY t.department ASC, t.updated_at DESC LIMIT 100`;

  const res = await pool.query(query, params);

  if (res.rows.length === 0) {
    const emptyMsg = isAll 
      ? "ℹ️ <b>DATABASE EMPTY:</b> No approved records exist."
      : `ℹ️ <b>DATABASE EMPTY:</b> No approved records in <b>${escapeHtml(cleanDept)}</b>.`;
    return ctx.editMessageText(emptyMsg, { parse_mode: 'HTML' });
  }

  const headerTitle = isAll ? "ALL DEPARTMENTS" : cleanDept.toUpperCase();
  let text = `🎓 <b>DATABASE EXPORT: ${escapeHtml(headerTitle)}</b> (<code>${res.rows.length}</code> Total)\n━━━━━━━━━━━━━━━━━━━━\n`;
  let currentGroupDept = "";

  for (let idx = 0; idx < res.rows.length; idx++) {
    const r = res.rows[idx];
    const rawUname = r.username ? `@${r.username}` : `[No @username]`;
    const uname = escapeHtml(rawUname);
    const dateStr = new Date(r.updated_at).toLocaleDateString();
    const staff = r.processed_by ? ` (By: ${escapeHtml(r.processed_by)})` : '';

    let itemText = "";
    if (isAll && r.department !== currentGroupDept) {
      currentGroupDept = r.department;
      itemText += `\n📁 <b>${escapeHtml(currentGroupDept)}</b>\n`;
    }

    itemText += `<code>[${idx + 1}]</code> <b>${uname}</b> (UID: <code>${r.user_id}</code>)\n   ↳ Approved: ${dateStr}${staff}\n`;

    if ((text + itemText).length > 3800) {
      await ctx.reply(text, { parse_mode: 'HTML' });
      text = "";
    }
    text += itemText;
  }

  if (text.trim().length > 0) {
    await ctx.reply(text, { parse_mode: 'HTML' });
  }
});

bot.callbackQuery(/^notify_mod_(\d+)$/, async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  if (!(await isStaff(ctx))) return;

  const moduleId = Number(ctx.match[1]);
  const modRes = await pool.query('SELECT title, department FROM department_modules WHERE id = $1', [moduleId]);
  if (modRes.rows.length === 0) return ctx.editMessageText("⚠️ <b>ERROR:</b> Target document missing from Vault.", { parse_mode: 'HTML' });

  const { title, department } = modRes.rows[0];
  const cleanDept = department.replace(/\s*\((Regular \/ Term|4-Year Complete)\)$/, '').trim();

  const studentsRes = await pool.query("SELECT DISTINCT user_id FROM tickets WHERE status = 'APPROVED' AND department ILIKE $1", [`%${cleanDept}%`]);
  const students = studentsRes.rows;
  if (students.length === 0) return ctx.editMessageText(`ℹ️ <b>NOTICE:</b> No approved profiles in <b>${escapeHtml(cleanDept)}</b> to target.`, { parse_mode: 'HTML' });

  let sentCount = 0;
  for (const s of students) {
    try {
      const sLang = await getUserLang(s.user_id);
      const notifText = sLang === 'am'
        ? `📚 <b>አዲስ የትምህርት ሞጁል ተጭኗል!</b>\n━━━━━━━━━━━━━━━━━━━━\n<blockquote>• <b>ክፍል:</b> ${escapeHtml(cleanDept)}\n• <b>ሞጁል:</b> ${escapeHtml(title)}</blockquote>\n\n<i>ከታች ያለውን ቁልፍ በመጫን ፋይሉን ያውርዱ፡</i>`
        : `📚 <b>VAULT UPDATE: NEW MODULE SECURED</b>\n━━━━━━━━━━━━━━━━━━━━\n<blockquote>• <b>Department:</b> ${escapeHtml(cleanDept)}\n• <b>File Title:</b> ${escapeHtml(title)}</blockquote>\n\n<i>Authorized users may initiate download below:</i>`;

      const dlKb = new InlineKeyboard().text(sLang === 'am' ? "⬇️ ሞጁሉን አውርድ" : "⬇️ INITIATE DOWNLOAD", `dlmod_${moduleId}`);
      await bot.api.sendMessage(s.user_id, notifText, { parse_mode: 'HTML', reply_markup: dlKb });
      sentCount++;
    } catch (e) {}
  }

  await ctx.editMessageText(`📢 <b>SYSTEM BROADCAST SUCCESSFUL</b>\n━━━━━━━━━━━━━━━━━━━━\n<blockquote>• <b>Target File:</b> ${escapeHtml(title)}\n• <b>Vector:</b> ${escapeHtml(cleanDept)}\n• <b>Delivered to:</b> <code>${sentCount}/${students.length}</code> nodes.</blockquote>`, { parse_mode: 'HTML' });
});

bot.callbackQuery('dismiss_mod_notify', async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  await ctx.editMessageText("🔕 <b>STEALTH MODE:</b> Document ingested silently. Broadcast skipped.", { parse_mode: 'HTML' });
});

bot.callbackQuery('cmd_mod_analytics', async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  if (!(await isStaff(ctx))) return;

  const topicId = ctx.callbackQuery.message.message_thread_id;
  const res = await pool.query(`
    SELECT m.id, m.title, m.department, COUNT(DISTINCT d.user_id) AS total_downloads
    FROM department_modules m LEFT JOIN module_downloads d ON m.id = d.module_id
    GROUP BY m.id, m.title, m.department ORDER BY m.department ASC, total_downloads DESC
  `);

  if (res.rows.length === 0) return ctx.reply("📊 <b>VAULT ANALYTICS:</b> Storage array empty.", { message_thread_id: topicId, parse_mode: 'HTML' });

  let text = "📈 <b>VAULT ENGAGEMENT TELEMETRY</b>\n━━━━━━━━━━━━━━━━━━━━\n";
  let currentDept = "";

  for (const row of res.rows) {
    if (row.department !== currentDept) {
      currentDept = row.department;
      text += `\n📁 <b>${escapeHtml(currentDept)}</b>\n`;
    }
    const cleanDept = currentDept.replace(/\s*\((Regular \/ Term|4-Year Complete)\)$/, '').trim();
    const enrolledRes = await pool.query("SELECT COUNT(DISTINCT user_id) as count FROM tickets WHERE status = 'APPROVED' AND department ILIKE $1", [`%${cleanDept}%`]);
    const totalEnrolled = Number(enrolledRes.rows[0].count) || 0;
    const downloads = Number(row.total_downloads);
    const percentage = totalEnrolled > 0 ? Math.round((downloads / totalEnrolled) * 100) : 0;
    text += `• <b>${escapeHtml(row.title)}</b>\n  ↳ Penetration: <b><code>${downloads}/${totalEnrolled}</code> profiles</b> (<code>${percentage}%</code>)\n`;
  }
  await ctx.reply(text, { message_thread_id: topicId, parse_mode: 'HTML' });
});

bot.callbackQuery(/^lang_(en|am)$/, async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  const lang = ctx.match[1];
  await setUserLang(ctx.from.id, lang);
  
  const phoneRes = await pool.query('SELECT phone_number FROM user_settings WHERE user_id = $1', [ctx.from.id]);
  
  if (!phoneRes.rows[0] || !phoneRes.rows[0].phone_number) {
    const kb = new Keyboard().requestContact(lang === 'am' ? '📱 ስልክ ቁጥር አጋራ' : '📱 Share Phone Number').resized().oneTime();
    
    try { await ctx.deleteMessage(); } catch (e) {}
    
    return ctx.reply(
      lang === 'am' 
        ? "⚠️ <b>ማረጋገጫ ያስፈልጋል:</b>\nእባክዎን ከታች ያለውን 'ስልክ ቁጥር አጋራ' የሚለውን ቁልፍ በመጫን ስልክዎን ያጋሩ።"
        : "⚠️ <b>VERIFICATION REQUIRED:</b>\nPlease tap the 'Share Phone Number' button below to register your profile.",
      { parse_mode: 'HTML', reply_markup: kb }
    );
  }

  await ctx.editMessageText(STRINGS[lang].portalWelcome, { parse_mode: 'HTML', reply_markup: getStudentKeyboard(lang, null) });
});

bot.callbackQuery('cmd_lookfor', async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  await ctx.reply("🔍 <b>DATABASE RECORD QUERY</b>\n━━━━━━━━━━━━━━━━━━━━\n\n<i>Reply directly to this system message with a target <b>UID</b>, <b>@username</b>, or <b>Department Name</b>.</i>", {
    message_thread_id: ctx.callbackQuery.message.message_thread_id, parse_mode: 'HTML', reply_markup: { force_reply: true }
  });
});

bot.callbackQuery('cmd_stats', async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  const tId = ctx.callbackQuery.message.message_thread_id;
  await ctx.reply(`${await generateSummaryText('APPROVED')}\n\n---\n\n${await generateSummaryText('REJECTED')}`, { message_thread_id: tId, parse_mode: 'HTML' });
});

bot.callbackQuery('cmd_export', async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  await sendCSVExport(await getActiveStaffGroupId(), ctx.callbackQuery.message.message_thread_id, "📄 <b>DATABASE BACKUP EXPORT GENERATED</b>");
});

bot.callbackQuery('cmd_broadcast', async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  await ctx.reply("📢 <b>INITIALIZE SYSTEM BROADCAST</b>\n━━━━━━━━━━━━━━━━━━━━\n\n<i>Reply directly to this system message with the exact announcement payload to transmit.</i>", {
    message_thread_id: ctx.callbackQuery.message.message_thread_id, parse_mode: 'HTML', reply_markup: { force_reply: true }
  });
});

bot.callbackQuery('cmd_upload_module', async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  if (!(await isStaff(ctx))) return;
  await ctx.reply("📂 <b>VAULT INGESTION PROTOCOL</b>\n━━━━━━━━━━━━━━━━━━━━\n<i>Select target departmental array:</i>", { message_thread_id: ctx.callbackQuery.message.message_thread_id, parse_mode: 'HTML', reply_markup: getModuleDepartmentKeyboard() });
});

bot.callbackQuery(/^moddept_(.+)$/, async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  const dept = ctx.match[1];
  if (dept === 'cancel') {
    await clearStaffPendingModuleDept(ctx.from.id);
    return ctx.editMessageText("❌ <b>OPERATION ABORTED:</b> Ingestion cancelled.", { parse_mode: 'HTML' });
  }
  await setStaffPendingModuleDept(ctx.from.id, dept);
  await ctx.editMessageText(`✅ <b>TARGET LOCKED:</b> <code>${escapeHtml(dept)}</code>\n━━━━━━━━━━━━━━━━━━━━\n\n<i>System ready. Transmit or forward the PDF document to ingest.</i>`, { parse_mode: 'HTML' });
});

bot.callbackQuery('cmd_submit', async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  const lang = await getUserLang(ctx.from.id);
  await ctx.reply(STRINGS[lang].selectPlan, { parse_mode: 'HTML', reply_markup: getPaymentTypeKeyboard(lang) });
});

bot.callbackQuery('cmd_pending_info', async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  const lang = await getUserLang(ctx.from.id);
  const msg = lang === 'am'
    ? "⏳ <b>ማመልከቻዎ በግምገማ ላይ ነው</b>\n\nየላኩት ደረሰኝ በመታየት ላይ ስለሆነ በአሁኑ ወቅት አዲስ ደረሰኝ መላክ አይችሉም።"
    : "⏳ <b>SYSTEM LOCKOUT: PENDING REVIEW</b>\n\n<blockquote>Your submission is currently under active analysis by the Finance node. Duplicate submissions are disabled.</blockquote>";
  await ctx.reply(msg, { parse_mode: 'HTML', reply_markup: getStudentKeyboard(lang, 'PENDING') });
});

bot.callbackQuery('cmd_download_pdf', async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  const userId = ctx.from.id;
  const lang = await getUserLang(userId);
  const res = await pool.query("SELECT department, username, processed_by FROM tickets WHERE user_id = $1 AND status = 'APPROVED' ORDER BY updated_at DESC LIMIT 1", [userId]);
  if (res.rows.length === 0) return ctx.reply("⚠️ <b>ERROR:</b> Clearance missing or revoked.", { parse_mode: 'HTML' });

  const { department, username, processed_by } = res.rows[0];
  const botUsername = ctx.me?.username;
  try {
    const pdfPath = await generateApprovalPDF(userId, username || 'N/A', department, processed_by || 'Finance Team', botUsername, lang);
    await ctx.replyWithDocument(new InputFile(pdfPath, `Official_Clearance_${userId}.pdf`), { caption: STRINGS[lang].approvedMsg, parse_mode: 'HTML' });
    if (fs.existsSync(pdfPath)) fs.unlinkSync(pdfPath);
  } catch (err) {
    ctx.reply("❌ <b>SYSTEM ERROR:</b> PDF Generation Engine failed.", { parse_mode: 'HTML' });
  }
});

bot.callbackQuery('cmd_modules', async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  const userId = ctx.from.id;
  const lang = await getUserLang(userId);

  const checkApproval = await pool.query("SELECT department FROM tickets WHERE user_id = $1 AND status = 'APPROVED' ORDER BY updated_at DESC LIMIT 1", [userId]);
  if (checkApproval.rows.length === 0) {
    const notApprovedMsg = lang === 'am'
      ? "🔒 <b>የሞጁል ማውረጃ ተቆልፏል</b>\n\nሞጁሎችን ለማውረድ የክፍያ ደረሰኝዎ መጽደቅ አለበት።"
      : "🔒 <b>VAULT ACCESS DENIED</b>\n━━━━━━━━━━━━━━━━━━━━\n<blockquote>Storage arrays are encrypted and strictly isolated. <b>APPROVED</b> status is required to bypass firewalls.</blockquote>";
    return ctx.reply(notApprovedMsg, { parse_mode: 'HTML', reply_markup: getStudentKeyboard(lang, null) });
  }

  const studentDept = checkApproval.rows[0].department.replace(/\s*\((Regular \/ Term|4-Year Complete)\)$/, '').trim();
  const modulesRes = await pool.query("SELECT id, title FROM department_modules WHERE department ILIKE $1 ORDER BY id ASC", [`%${studentDept}%`]);
  if (modulesRes.rows.length === 0) return ctx.reply(`📚 <b>VAULT EMPTY:</b> No documents available for <code>${escapeHtml(studentDept)}</code>.`, { parse_mode: 'HTML' });

  const kb = new InlineKeyboard();
  modulesRes.rows.forEach((m) => kb.text(`📄 ${m.title}`, `dlmod_${m.id}`).row());
  await ctx.reply(`📚 <b>SECURE VAULT: <code>${escapeHtml(studentDept)}</code></b>\n━━━━━━━━━━━━━━━━━━━━\n<i>Select document to execute download:</i>`, { parse_mode: 'HTML', reply_markup: kb });
});

bot.callbackQuery(/^dlmod_(\d+)$/, async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  const moduleId = Number(ctx.match[1]);
  const res = await pool.query("SELECT title, file_id FROM department_modules WHERE id = $1", [moduleId]);
  if (res.rows.length === 0) return ctx.reply("⚠️ <b>ERROR 404:</b> Document purged or corrupted.", { parse_mode: 'HTML' });

  try {
    await pool.query("INSERT INTO module_downloads (module_id, user_id) VALUES ($1, $2) ON CONFLICT (module_id, user_id) DO NOTHING", [moduleId, ctx.from.id]);
  } catch (e) {}

  try {
    await ctx.replyWithDocument(res.rows[0].file_id, { caption: `📖 <b>${escapeHtml(res.rows[0].title)}</b>\n<blockquote><i>Classified: Renaissance Global Course Module</i></blockquote>`, parse_mode: 'HTML' });
  } catch (err) {
    ctx.reply("❌ <b>TRANSMISSION ERROR:</b> Payload failed.", { parse_mode: 'HTML' });
  }
});

bot.callbackQuery(/^paytype_(reg|full)$/, async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  const lang = await getUserLang(ctx.from.id);
  await ctx.editMessageText(STRINGS[lang].selectDept, { parse_mode: 'HTML', reply_markup: getDepartmentKeyboard(ctx.match[1]) });
});

bot.callbackQuery('cmd_status', async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  const userId = ctx.from.id;
  const lang = await getUserLang(userId);
  const res = await pool.query('SELECT department, status, rejection_reason FROM tickets WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 1', [userId]);
  if (res.rows.length === 0) return ctx.reply(lang === 'am' ? "ℹ️ ምንም ማመልከቻ የለም።" : "ℹ️ <b>SYSTEM ALERT:</b> No active traces in database.", { parse_mode: 'HTML', reply_markup: getStudentKeyboard(lang, null) });

  const ticket = res.rows[0];
  let timeline = "";
  if (ticket.status === 'PENDING') {
    timeline = lang === 'am' 
      ? "<code>[1]</code> <b>ማመልከቻ መላክ:</b> ተጠናቋል\n<code>[2]</code> <b>የቢሮ ግምገማ:</b> ⏳ በመታየት ላይ\n<code>[3]</code> <b>ማጽደቅ:</b> 🔒 ተቆልፏል" 
      : "<code>[1]</code> <b>DATA INGEST:</b> Verified\n<code>[2]</code> <b>STAFF AUDIT:</b> ⏳ In Progress\n<code>[3]</code> <b>CLEARANCE:</b> 🔒 Locked";
  } else if (ticket.status === 'APPROVED') {
    timeline = lang === 'am' 
      ? "<code>[1]</code> <b>ማመልከቻ መላክ:</b> ተጠናቋል\n<code>[2]</code> <b>የቢሮ ግምገማ:</b> ተጠናቋል\n<code>[3]</code> <b>ማጽደቅ:</b> ✅ ጸድቋል" 
      : "<code>[1]</code> <b>DATA INGEST:</b> Verified\n<code>[2]</code> <b>STAFF AUDIT:</b> Verified\n<code>[3]</code> <b>CLEARANCE:</b> ✅ ACTIVE";
  } else {
    timeline = lang === 'am' 
      ? "<code>[1]</code> <b>ማመልከቻ መላክ:</b> ተጠናቋል\n<code>[2]</code> <b>የቢሮ ግምገማ:</b> ❌ ውድቅ ሆኗል" 
      : "<code>[1]</code> <b>DATA INGEST:</b> Verified\n<code>[2]</code> <b>STAFF AUDIT:</b> ❌ DENIED";
  }

  let msg = `📊 <b>LIVE PROFILE TELEMETRY</b>\n━━━━━━━━━━━━━━━━━━━━\n<blockquote>• <b>Department:</b> ${escapeHtml(ticket.department)}\n• <b>System Status:</b> <b>${ticket.status}</b></blockquote>\n${timeline}\n`;
  if (ticket.status === 'REJECTED' && ticket.rejection_reason) msg += `\n<blockquote><b>ROOT CAUSE:</b> ${escapeHtml(ticket.rejection_reason)}</blockquote>`;
  await ctx.reply(msg, { parse_mode: 'HTML', reply_markup: getStudentKeyboard(lang, ticket.status) });
});

bot.callbackQuery('cmd_history', async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  const userId = ctx.from.id;
  const lang = await getUserLang(userId);
  const res = await pool.query('SELECT department, status, rejection_reason, created_at FROM tickets WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20', [userId]);
  if (res.rows.length === 0) return ctx.reply("ℹ️ <b>SYSTEM ALERT:</b> Log history empty.", { parse_mode: 'HTML', reply_markup: getStudentKeyboard(lang, null) });

  let text = "📜 <b>PROFILE AUDIT LOGS:</b>\n━━━━━━━━━━━━━━━━━━━━\n";
  for (let idx = 0; idx < res.rows.length; idx++) {
    const r = res.rows[idx];
    const icon = r.status === 'APPROVED' ? "✅" : (r.status === 'REJECTED' ? "❌" : "⏳");
    let itemText = `<code>[${idx + 1}]</code> ${icon} <b>${escapeHtml(r.department)}</b>\n<blockquote>• <b>Status:</b> ${r.status}\n• <b>Timestamp:</b> ${new Date(r.created_at).toLocaleDateString()}</blockquote>\n`;
    if (r.status === 'REJECTED' && r.rejection_reason) itemText += `⚠️ <i>Cause: ${escapeHtml(r.rejection_reason)}</i>\n`;
    itemText += `\n`;
    if ((text + itemText).length > 3800) {
      await ctx.reply(text, { parse_mode: 'HTML' });
      text = "";
    }
    text += itemText;
  }
  if (text.trim().length > 0) await ctx.reply(text, { parse_mode: 'HTML', reply_markup: getStudentKeyboard(lang, null) });
});

bot.callbackQuery('cmd_help', async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  const lang = await getUserLang(ctx.from.id);
  await ctx.reply(STRINGS[lang].helpText, { parse_mode: 'HTML', reply_markup: getStudentKeyboard(lang, null) });
});

bot.callbackQuery('start_resubmit', async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  const lang = await getUserLang(ctx.from.id);
  await clearPendingDepartment(ctx.from.id);
  await ctx.reply(STRINGS[lang].selectPlan, { parse_mode: 'HTML', reply_markup: getPaymentTypeKeyboard(lang) });
});

bot.callbackQuery(/^dept(reg|full)_(.+)$/, async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  const fullTaggedDept = `${ctx.match[2]} ${ctx.match[1] === 'full' ? '(4-Year Complete)' : '(Regular / Term)'}`;
  await setPendingDepartment(ctx.from.id, fullTaggedDept);
  const lang = await getUserLang(ctx.from.id);
  await ctx.editMessageText(STRINGS[lang].sendReceiptPrompt.replace('{dept}', escapeHtml(fullTaggedDept)), { parse_mode: 'HTML' });
});

bot.command(['module', 'uploadmodule'], async (ctx) => {
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
    const vaultMsg = await ctx.api.sendDocument(staffGroupId, doc.file_id, {
      message_thread_id: vaultTopicId,
      caption: `📚 <b>VAULT ARCHIVE INDEX</b>\n<blockquote>• <b>Department:</b> ${escapeHtml(dept)}\n• <b>File Title:</b> ${escapeHtml(title)}</blockquote>`,
      parse_mode: 'HTML'
    });

    const insRes = await pool.query("INSERT INTO department_modules (department, title, file_id, file_name) VALUES ($1, $2, $3, $4) RETURNING id", [dept, title, vaultMsg.document.file_id, doc.file_name || `${title}.pdf`]);
    const newModId = insRes.rows[0].id;

    if (ctx.chat.type !== 'private' && ctx.message.message_thread_id !== vaultTopicId) {
      try {
        await ctx.deleteMessage();
        if (ctx.message.reply_to_message) await ctx.api.deleteMessage(ctx.chat.id, ctx.message.reply_to_message.message_id);
      } catch (e) {}
    }

    const notifyKb = new InlineKeyboard().text("📢 BROADCAST TO NETWORK", `notify_mod_${newModId}`).row().text("🔕 STEALTH INGEST", "dismiss_mod_notify");
    await ctx.reply(`✅ <b>DOCUMENT STASHED IN VAULT</b>\n━━━━━━━━━━━━━━━━━━━━\n<blockquote>• <b>Sector:</b> ${escapeHtml(dept)}\n• <b>Designation:</b> ${escapeHtml(title)}</blockquote>\n\n<i>Initiate network broadcast sequence?</i>`, { parse_mode: 'HTML', reply_markup: notifyKb });
  } catch (err) {
    ctx.reply(`❌ <b>CRITICAL ERROR:</b> ${err.message}`, { parse_mode: 'HTML' });
  }
});

bot.callbackQuery(/^trans_(\d+)_(\d+)$/, async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  await ctx.editMessageText("📂 <b>SELECT OVERRIDE PARAMETER:</b>", { parse_mode: 'HTML', reply_markup: getTransferKeyboard(Number(ctx.match[1]), Number(ctx.match[2])) });
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

  const ticketRes = await pool.query('SELECT topic_id, message_id, ticket_msg_id, username, department FROM tickets WHERE user_id = $1 AND topic_id = $2 AND status = \'PENDING\' ORDER BY updated_at DESC LIMIT 1', [targetUserId, originTopicId]);
  if (ticketRes.rows.length === 0) return ctx.editMessageText("⚠️ <b>ERROR:</b> Artifact processed or vanished.", { parse_mode: 'HTML' });

  const deptMap = { mkt: "Marketing Management", biz: "Business Management", agri: "Agribusiness and Value chain management", ed: "Educational planning and management", acc: "Accounting and finance", log: "Logistics and Supply chain management" };
  const planSuffix = ticketRes.rows[0].department.includes("(4-Year Complete)") ? "(4-Year Complete)" : "(Regular / Term)";
  const newDeptTagged = `${deptMap[ctx.match[3]]} ${planSuffix}`;
  const newTopicId = await getOrCreateDepartmentTopic(ctx, newDeptTagged, staffGroupId);

  const newForwardRes = await ctx.api.copyMessage(staffGroupId, staffGroupId, Number(ticketRes.rows[0].message_id), { message_thread_id: newTopicId });
  const kb = new InlineKeyboard().text("✅ APPROVE", `app_${targetUserId}_${newTopicId}`).row().text("❌ REJECT", `rej_${targetUserId}_${newTopicId}`).row().text("🔄 OVERRIDE DEPT", `trans_${targetUserId}_${newTopicId}`);
  const newTicketMsg = await ctx.api.sendMessage(staffGroupId, `🧾 <b>NEW DATA UPLOAD DETECTED (TRANSFERRED)</b>\n━━━━━━━━━━━━━━━━━━━━\n<blockquote>👤 <b>Profile:</b> @${escapeHtml(ticketRes.rows[0].username)}\n🆔 <b>UID:</b> <code>${targetUserId}</code>\n🏫 <b>Target:</b> ${escapeHtml(newDeptTagged)}</blockquote>\n━━━━━━━━━━━━━━━━━━━━\n⚡️ <i>Analyze the appended media artifact below.</i>`, { message_thread_id: newTopicId, parse_mode: 'HTML', reply_markup: kb });

  await pool.query(`UPDATE tickets SET department = $1, topic_id = $2, message_id = $3, ticket_msg_id = $4, updated_at = CURRENT_TIMESTAMP WHERE user_id = $5 AND status = 'PENDING'`, [newDeptTagged, newTopicId, newForwardRes.message_id, newTicketMsg.message_id, targetUserId]);
  
  pushToGoogleSheet(targetUserId, ticketRes.rows[0].username, newDeptTagged, 'PENDING', 'System Action', 'Transferred / Awaiting Review');

  try { await ctx.api.deleteMessage(staffGroupId, Number(ticketRes.rows[0].message_id)); } catch (e) {}
  try { await ctx.api.deleteMessage(staffGroupId, Number(ticketRes.rows[0].ticket_msg_id)); } catch (e) {}

  try {
    const sLang = await getUserLang(targetUserId);
    await ctx.api.sendMessage(targetUserId, STRINGS[sLang].deptUpdated.replace('{dept}', escapeHtml(newDeptTagged)), { parse_mode: 'HTML' });
  } catch (e) {}
});

bot.on('message', async (ctx) => {
  if (ctx.from && ctx.from.is_bot) return;
  if (ctx.message.text && ctx.message.text.startsWith('/')) return;

  const staffGroupId = await getActiveStaffGroupId();
  const isStaffGroup = staffGroupId && String(ctx.chat.id) === staffGroupId;
  const isPrivate = ctx.chat.type === 'private';
  const topicId = ctx.message.message_thread_id;

  if (isPrivate && !ctx.message.contact) {
    const phoneCheck = await pool.query('SELECT phone_number FROM user_settings WHERE user_id = $1', [ctx.from.id]);
    if (!phoneCheck.rows.length || !phoneCheck.rows[0].phone_number) {
      const lang = await getUserLang(ctx.from.id);
      const kb = new Keyboard().requestContact(lang === 'am' ? '📱 ስልክ ቁጥር አጋራ' : '📱 Share Phone Number').resized().oneTime();
      return ctx.reply(
        lang === 'am' 
          ? "⚠️ <b>ስህተት:</b> እባክዎን ከታች ያለውን 'ስልክ ቁጥር አጋራ' ቁልፍ ይጫኑ።"
          : "⚠️ <b>ACCESS DENIED:</b> Please tap the 'Share Phone Number' button below to continue.",
        { parse_mode: 'HTML', reply_markup: kb }
      );
    }
  }

  let staffDept = await getStaffPendingModuleDept(ctx.from.id);
  if (!staffDept && ctx.message.reply_to_message?.text) {
    const match = ctx.message.reply_to_message.text.match(/TARGET LOCKED:\s*([^\n]+)/);
    if (match) staffDept = match[1].trim();
  }

  if (isStaffGroup && staffDept && ctx.message.document) {
    const doc = ctx.message.document;
    const moduleTitle = doc.file_name ? doc.file_name.replace(/\.pdf$/i, '') : 'Course Module';
    try {
      const vaultTopicId = await getOrCreateModulesVaultTopic(ctx, staffGroupId);
      const vaultMsg = await ctx.api.sendDocument(staffGroupId, doc.file_id, {
        message_thread_id: vaultTopicId,
        caption: `📚 <b>VAULT ARCHIVE INDEX</b>\n<blockquote>• <b>Department:</b> ${escapeHtml(staffDept)}\n• <b>File Title:</b> ${escapeHtml(moduleTitle)}</blockquote>`,
        parse_mode: 'HTML'
      });
      const insRes = await pool.query("INSERT INTO department_modules (department, title, file_id, file_name) VALUES ($1, $2, $3, $4) RETURNING id", [staffDept, moduleTitle, vaultMsg.document.file_id, doc.file_name || `${moduleTitle}.pdf`]);
      
      try { await ctx.deleteMessage(); } catch (e) {}

      if (!ctx.message.media_group_id) {
        const notifyKb = new InlineKeyboard().text("📢 BROADCAST TO NETWORK", `notify_mod_${insRes.rows[0].id}`).row().text("✅ TERMINATE UPLOAD LINK", "moddept_cancel");
        return ctx.reply(`✅ <b>DOCUMENT SECURED</b>\n<i>Link established: Stream another payload to append to array.</i>`, { message_thread_id: topicId, parse_mode: 'HTML', reply_markup: notifyKb });
      }
    } catch (err) {
      console.error("Upload error:", err.message);
    }
    return;
  }

  if (isStaffGroup && ctx.message.reply_to_message) {
    const orig = ctx.message.reply_to_message.text || '';
    if (orig.includes("DATABASE RECORD QUERY")) return performSearch(ctx, ctx.message.text.trim(), topicId);
    if (orig.includes("INITIALIZE SYSTEM BROADCAST")) return performBroadcast(ctx, topicId, ctx.message.text.trim());
    if (orig.includes("INITIATE DEPARTMENT OVERRIDE")) return executeChangeDeptPrompt(ctx, Number(ctx.message.text.trim()), topicId);
    if (orig.includes("INITIATE STATUS REVOCATION")) return executeRevoke(ctx, Number(ctx.message.text.trim()), topicId);
  }

  if (isPrivate && !ctx.message.contact) {
    const userId = ctx.from.id;
    const lang = await getUserLang(userId);
    const activeCheck = await pool.query("SELECT 1 FROM tickets WHERE user_id = $1 AND status = 'PENDING' LIMIT 1", [userId]);
    if (activeCheck.rows.length > 0) return ctx.reply(STRINGS[lang].pendingExists, { reply_markup: getStudentKeyboard(lang, 'PENDING') });

    const chosenDeptTagged = await getPendingDepartment(userId);
    if (!chosenDeptTagged) return ctx.reply(lang === 'am' ? "⚠️ <b>ስህተት:</b> እባክዎን መጀመሪያ ክፍል ይምረጡ።" : "⚠️ <b>ERROR:</b> Missing assignment protocol! Select department first.", { parse_mode: 'HTML', reply_markup: getStudentKeyboard(lang, null) });

    const fileId = ctx.message.photo ? ctx.message.photo[ctx.message.photo.length - 1].file_id : (ctx.message.document ? ctx.message.document.file_id : null);
    if (!fileId) return ctx.reply(STRINGS[lang].noFileErr, { parse_mode: 'HTML' });
    if (!staffGroupId) return ctx.reply("⚠️ <b>SYSTEM HALT:</b> Telemetry link disconnected.");

    const username = ctx.from.username || ctx.from.first_name || 'Unknown';
    try {
      const dbTopicId = await getOrCreateDepartmentTopic(ctx, chosenDeptTagged, staffGroupId);
      const forwardRes = await ctx.api.copyMessage(staffGroupId, ctx.chat.id, ctx.message.message_id, { message_thread_id: dbTopicId });
      const kb = new InlineKeyboard().text("✅ APPROVE", `app_${userId}_${dbTopicId}`).row().text("❌ REJECT", `rej_${userId}_${dbTopicId}`).row().text("🔄 OVERRIDE DEPT", `trans_${userId}_${dbTopicId}`);
      
      const cardMsg = `🧾 <b>NEW DATA UPLOAD DETECTED</b>\n━━━━━━━━━━━━━━━━━━━━\n<blockquote>👤 <b>Profile:</b> @${escapeHtml(username)}\n🆔 <b>UID:</b> <code>${userId}</code>\n🏫 <b>Target:</b> ${escapeHtml(chosenDeptTagged)}</blockquote>\n━━━━━━━━━━━━━━━━━━━━\n⚡️ <i>Analyze the appended media artifact below.</i>`;
      const sentTicketMsg = await ctx.api.sendMessage(staffGroupId, cardMsg, { message_thread_id: dbTopicId, parse_mode: 'HTML', reply_markup: kb });

      await clearPendingDepartment(userId);
      
      pushToGoogleSheet(userId, username, chosenDeptTagged, 'PENDING', 'Awaiting Review', '');

      const studentPanelMsg = await ctx.reply(STRINGS[lang].receiptReceived, { parse_mode: 'HTML', reply_markup: getStudentKeyboard(lang, 'PENDING') });
      await pool.query(`INSERT INTO tickets (user_id, username, receipt_file_id, topic_id, message_id, ticket_msg_id, panel_msg_id, department, status) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'PENDING')`, [userId, username, fileId, dbTopicId, forwardRes.message_id, sentTicketMsg.message_id, studentPanelMsg.message_id, chosenDeptTagged]);
    } catch (err) {
      return ctx.reply(`❌ <b>ROUTING ERROR:</b> ${err.message}`, { parse_mode: 'HTML' });
    }
  }
});

bot.callbackQuery(/^app_(\d+)_(\d+)$/, async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  const userId = Number(ctx.match[1]);
  const topicId = Number(ctx.match[2]);
  const staffName = `${ctx.from.first_name || ''} ${ctx.from.last_name || ''}`.trim() || `Staff`;
  const staffGroupId = await getActiveStaffGroupId();

  const updateRes = await pool.query("UPDATE tickets SET status = 'APPROVED', processed_by = $1, updated_at = CURRENT_TIMESTAMP WHERE user_id = $2 AND status = 'PENDING' RETURNING department, username, panel_msg_id", [staffName, userId]);
  if (updateRes.rowCount === 0) return ctx.reply("⚠️ <b>ERROR:</b> Record already finalized.", { message_thread_id: topicId, parse_mode: 'HTML' });

  const { department, username, panel_msg_id } = updateRes.rows[0];
  const lang = await getUserLang(userId);

  pushToGoogleSheet(userId, username, department, 'APPROVED', staffName, '');

  if (panel_msg_id) {
    try { await ctx.api.editMessageReplyMarkup(userId, Number(panel_msg_id), { reply_markup: getStudentKeyboard(lang, 'APPROVED') }); } catch (e) {}
  }
  try { await ctx.api.sendMessage(userId, STRINGS[lang].approvedMsg, { parse_mode: 'HTML', reply_markup: getStudentKeyboard(lang, 'APPROVED') }); } catch (e) {}
  await ctx.editMessageText(`✅ <b>APPROVAL AUTHORIZED</b>\n━━━━━━━━━━━━━━━━━━━━\n<blockquote>• <b>Target UID:</b> <code>${userId}</code>\n• <b>User Alias:</b> @${escapeHtml(username) || 'N/A'}\n• <b>Vector:</b> ${escapeHtml(department)}\n• <b>Cleared By:</b> ${escapeHtml(staffName)}</blockquote>`, { parse_mode: 'HTML' });

  if (APPROVED_THREAD_ID && staffGroupId) {
    await ctx.api.sendMessage(staffGroupId, await generateSummaryText('APPROVED'), { message_thread_id: APPROVED_THREAD_ID, parse_mode: 'HTML' });
  }
});

bot.callbackQuery(/^rej_(\d+)_(\d+)$/, async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  await ctx.editMessageText("❌ <b>INITIALIZE REJECTION SEQUENCE:</b>", { parse_mode: 'HTML', reply_markup: getRejectionReasonKeyboard(Number(ctx.match[1]), Number(ctx.match[2])) });
});

bot.callbackQuery(/^confirmrej_(\d+)_(\d+)_(.+)$/, async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  const userId = Number(ctx.match[1]);
  const topicId = Number(ctx.match[2]);
  const staffName = `${ctx.from.first_name || ''} ${ctx.from.last_name || ''}`.trim() || `Staff`;
  const reasonObj = REJECTION_REASONS.find(r => r.code === ctx.match[3]);
  const reasonText = reasonObj ? reasonObj.label : "Artifact Unverifiable";

  const updateRes = await pool.query(`UPDATE tickets SET status = 'REJECTED', rejection_reason = $1, processed_by = $2, updated_at = CURRENT_TIMESTAMP WHERE user_id = $3 AND status = 'PENDING' RETURNING panel_msg_id, department, username`, [reasonText, staffName, userId]);
  if (updateRes.rowCount === 0) return ctx.reply("⚠️ <b>ERROR:</b> Database status mismatch.", { message_thread_id: topicId, parse_mode: 'HTML' });

  const { panel_msg_id, department, username } = updateRes.rows[0];
  const lang = await getUserLang(userId);
  const customMessage = reasonObj ? (lang === 'am' ? reasonObj.message_am : reasonObj.message_en) : "Please re-upload.";

  pushToGoogleSheet(userId, username, department, 'REJECTED', staffName, reasonText);

  if (panel_msg_id) {
    try { await ctx.api.editMessageReplyMarkup(userId, Number(panel_msg_id), { reply_markup: getStudentKeyboard(lang, 'REJECTED') }); } catch (e) {}
  }

  const resubmitKeyboard = new InlineKeyboard().text(STRINGS[lang].reuploadBtn, "start_resubmit");
  await ctx.api.sendMessage(userId, STRINGS[lang].rejectedMsg.replace('{reason}', escapeHtml(reasonText)).replace('{message}', customMessage), { parse_mode: 'HTML', reply_markup: resubmitKeyboard });
  await ctx.editMessageText(`❌ <b>REJECTION AUTHORIZED</b>\n<blockquote><b>Operator:</b> ${escapeHtml(staffName)}\n<b>Fault:</b> ${escapeHtml(reasonText)}</blockquote>`, { parse_mode: 'HTML' });
});

cron.schedule('0 8 * * *', async () => {
  try {
    const staffGroupId = await getActiveStaffGroupId();
    if (!staffGroupId) return;
    const pendingRes = await pool.query("SELECT COUNT(*) FROM tickets WHERE status = 'PENDING'");
    const dailyReport = `🌅 <b>SYSTEM CHRON REPORT (DAILY)</b>\n━━━━━━━━━━━━━━━━━━━━\n\n⏳ <b>Unprocessed Packets:</b> <code>${pendingRes.rows[0].count}</code>\n\n---\n\n${await generateSummaryText('APPROVED')}\n\n---\n\n${await generateSummaryText('REJECTED')}`;
    await bot.api.sendMessage(staffGroupId, dailyReport, { message_thread_id: APPROVED_THREAD_ID || null, parse_mode: 'HTML' });
  } catch (err) {}
});

cron.schedule('0 10 * * *', async () => {
  try {
    const stuckUsers = await pool.query(`
      SELECT u.user_id, u.language, u.pending_department 
      FROM user_settings u
      LEFT JOIN tickets t ON u.user_id = t.user_id AND t.status IN ('PENDING', 'APPROVED')
      WHERE u.pending_department IS NOT NULL 
      AND t.user_id IS NULL
    `);

    for (const row of stuckUsers.rows) {
      const lang = row.language || 'en';
      const msg = lang === 'am' 
        ? `⚠️ <b>ማሳሰቢያ: ማመልከቻዎ አልተጠናቀቀም!</b>\n━━━━━━━━━━━━━━━━━━━━\n<blockquote>ለ <b>${escapeHtml(row.pending_department)}</b> ምዝገባ ጀምረዋል፣ ነገር ግን የክፍያ ደረሰኝ አላስገቡም።</blockquote>\n\n<i>እባክዎን ሂደቱን ለማጠናቀቅ የክፍያ ደረሰኝዎን ፎቶ አሁን ይላኩ።</i>`
        : `⚠️ <b>SYSTEM ALERT: INCOMPLETE REGISTRATION</b>\n━━━━━━━━━━━━━━━━━━━━\n<blockquote>You initiated clearance for <b>${escapeHtml(row.pending_department)}</b> but have not transmitted a receipt photo.</blockquote>\n\n<i>Please upload your receipt image now to secure your clearance and unlock the module vault.</i>`;
      
      try {
        await bot.api.sendMessage(row.user_id, msg, { parse_mode: 'HTML' });
      } catch (e) {}
    }
  } catch (err) {
    console.error("Abandonment Cron Error:", err);
  }
});

// --- API ENDPOINTS FOR REACT FRONTEND ---

app.get('/api/student/:userId', async (req, res) => {
  try {
    const userId = req.params.userId;
    const ticketRes = await pool.query(
      "SELECT user_id, username, department, status, rejection_reason, updated_at FROM tickets WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 1",
      [userId]
    );
    
    if (ticketRes.rows.length === 0) {
      return res.status(404).json({ success: false, error: "Student record not found" });
    }

    const settingsRes = await pool.query("SELECT phone_number, language FROM user_settings WHERE user_id = $1", [userId]);
    
    res.json({
      success: true,
      data: {
        ...ticketRes.rows[0],
        phone_number: settingsRes.rows[0]?.phone_number || null,
        language: settingsRes.rows[0]?.language || 'en'
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/modules/:department', async (req, res) => {
  try {
    const dept = decodeURIComponent(req.params.department);
    const mods = await pool.query(
      "SELECT id, title, file_name, created_at FROM department_modules WHERE department ILIKE $1 ORDER BY id ASC",
      [`%${dept}%`]
    );
    res.json({ success: true, count: mods.rows.length, data: mods.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/roster', async (req, res) => {
  try {
    const roster = await pool.query(`
      SELECT t.user_id, t.username, t.department, t.updated_at 
      FROM tickets t
      INNER JOIN (
        SELECT user_id, MAX(updated_at) as max_date FROM tickets WHERE status = 'APPROVED' GROUP BY user_id
      ) latest ON t.user_id = latest.user_id AND t.updated_at = latest.max_date
      WHERE t.status = 'APPROVED'
      ORDER BY t.department ASC
    `);
    res.json({ success: true, count: roster.rows.length, data: roster.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/export', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT user_id, username, department, status, rejection_reason, processed_by, created_at, updated_at 
      FROM tickets 
      ORDER BY department ASC, status ASC, updated_at DESC
    `);

    let csv = "Student Telegram ID,Username,Department & Tag,Status,Rejection Reason,Processed By,Created At,Updated At\n";
    
    result.rows.forEach((r) => {
      const uname = r.username ? `"${r.username.replace(/"/g, '""')}"` : "";
      const reason = r.rejection_reason ? `"${r.rejection_reason.replace(/"/g, '""')}"` : "";
      const staff = r.processed_by ? `"${r.processed_by.replace(/"/g, '""')}"` : "";
      csv += `${r.user_id},${uname},"${r.department}",${r.status},${reason},${staff},${r.created_at},${r.updated_at}\n`;
    });

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="Renaissance_Database_Export.csv"');
    res.status(200).send(csv);
  } catch (err) {
    console.error("Web Export Error:", err);
    res.status(500).json({ error: 'Failed to generate CSV export.' });
  }
});

// --- EXPRESS WEBHOOK & SERVER INIT ---

app.use('/webhook', webhookCallback(bot, 'express'));
app.get('/', (req, res) => res.send('Tuition Receipt Bot is active'));

async function main() {
  await initDB();

  try {
    await bot.api.deleteMyCommands();
    await bot.api.deleteMyCommands({ scope: { type: 'all_private_chats' } });
    await bot.api.deleteMyCommands({ scope: { type: 'all_group_chats' } });
    await bot.api.deleteMyCommands({ scope: { type: 'all_chat_administrators' } });

    await bot.api.setMyCommands([
      { command: 'start', description: 'INITIALIZE PORTAL / VERIFICATION' }
    ], { scope: { type: 'all_private_chats' } });

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