require('dotenv').config();
const express = require('express');
const { Bot, InlineKeyboard, InputFile, webhookCallback } = require('grammy');
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const https = require('https');
const cron = require('node-cron');
const PDFDocument = require('pdfkit');

const app = express();
app.use(express.json());

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

// Self keep-alive ping for external web service
setInterval(() => {
  const RENDER_URL = process.env.RENDER_EXTERNAL_URL;
  if (RENDER_URL) {
    https.get(`${RENDER_URL}/`, (res) => {
      console.log(`Keep-alive ping status: ${res.statusCode}`);
    }).on('error', (err) => {
      console.error('Keep-alive ping error:', err.message);
    });
  }
}, 8 * 60 * 1000);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function initDB() {
  try {
    await pool.query(`ALTER TABLE department_topics DROP CONSTRAINT IF EXISTS department_topics_pkey;`);
  } catch (err) {}

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
      pending_module_dept TEXT
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

  try {
    await pool.query(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS panel_msg_id BIGINT;`);
  } catch (err) {}

  try {
    await pool.query(`ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS pending_department TEXT;`);
  } catch (err) {}

  try {
    await pool.query(`ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS pending_module_dept TEXT;`);
  } catch (err) {}

  try {
    await pool.query(`ALTER TABLE group_settings ADD COLUMN IF NOT EXISTS modules_topic_id BIGINT;`);
  } catch (err) {}
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
    await pool.query(`
      INSERT INTO user_settings (user_id, language) VALUES ($1, $2)
      ON CONFLICT (user_id) DO UPDATE SET language = $2
    `, [userId, lang]);
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
    await pool.query(`
      INSERT INTO user_settings (user_id, pending_department) 
      VALUES ($1, $2)
      ON CONFLICT (user_id) 
      DO UPDATE SET pending_department = $2
    `, [userId, dept]);
  } catch (err) {}
}

async function clearPendingDepartment(userId) {
  try {
    await pool.query('UPDATE user_settings SET pending_department = NULL WHERE user_id = $1', [userId]);
  } catch (err) {}
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
    await pool.query(`
      INSERT INTO user_settings (user_id, pending_module_dept) 
      VALUES ($1, $2)
      ON CONFLICT (user_id) 
      DO UPDATE SET pending_module_dept = $2
    `, [userId, dept]);
  } catch (err) {}
}

async function clearStaffPendingModuleDept(userId) {
  try {
    await pool.query('UPDATE user_settings SET pending_module_dept = NULL WHERE user_id = $1', [userId]);
  } catch (err) {}
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
    portalWelcome: "👋 **Welcome to Renaissance Global Student Portal**\n\n🎯 **Quick Guide:**\n1️⃣ Select your payment type & department\n2️⃣ Upload a clear photo of your receipt\n3️⃣ Receive your official approval slip instantly upon verification!\n\nSelect an option below to begin:",
    selectPlan: "💳 **Step 1 of 2: Select Payment Type**\n\nPlease choose your payment plan:",
    selectDept: "📚 **Step 2 of 2: Select Your Department**\n\nPlease select your academic department below:",
    receiptReceived: "✅ Your receipt has been successfully submitted and placed in the review queue. Track its progress anytime using 'Check Status'.",
    sendReceiptPrompt: "✅ Selected Department: **{dept}**\n\nNow, please send your receipt photo or screenshot with your Full Name and Student ID.",
    reuploadPrompt: "🔄 **Re-submitting Receipt**\nPlease choose your payment plan to initiate a new submission:",
    approvedMsg: "✅ **Receipt Verified & Approved!**\nYour payment has been successfully cleared by our finance team.",
    rejectedMsg: "❌ **Receipt Needs Attention**\n\n**Reason:** {reason}\n\n{message}",
    reuploadBtn: "🔄 Re-upload Receipt",
    noFileErr: "⚠️ Please send an actual **photo or screenshot** of your payment receipt. Text-only messages cannot be processed as receipts.",
    deptUpdated: "🔄 **Department Updated**\nYour receipt submission has been transferred to **{dept}**.",
    pendingExists: "⚠️ **Active Submission Pending**\n\nYou already have a receipt under review. Check your live timeline status below.",
    helpText: "❓ **Need Assistance?**\n\nIf you have issues regarding your tuition payments or department registration, please contact the registrar office directly or submit your payment receipt photo."
  },
  am: {
    portalWelcome: "👋 **እንኳን ወደ ሬነሳንስ ግሎባል የተማሪዎች ፖርታል በሰላም መጡ**\n\n🎯 **ፈጣን መመሪያ:**\n1️⃣ የክፍያ ዓይነትዎን እና ትምህርት ክፍልዎን ይምረጡ\n2️⃣ ግልጽ የሆነ የክፍያ ደረሰኝ ፎቶ ይላኩ\n3️⃣ ሲረጋገጥ ይፋዊ ማረጋገጫ ፒዲኤፍዎን ወዲያውኑ ይቀበሉ!\n\nለመጀመር ከታች ካሉት አማራጮች አንዱን ይምረጡ፡",
    selectPlan: "💳 **ደረጃ 1 ከ 2፡ የክፍያ ዓይነት ይምረጡ**\n\nእባክዎን የክፍያ መጠን ዓይነትዎን ይምረጡ፡",
    selectDept: "📚 **ደረጃ 2 ከ 2፡ ትምህርት ክፍልዎን ይምረጡ**\n\nእባክዎን ትምህርት ክፍልዎን ከታች ካሉት ይምረጡ፡",
    receiptReceived: "✅ ደረሰኝዎ በትክክል ተልኳል። 'የደረሰኙን ሁኔታ ያረጋግጡ' የሚለውን በመጫን ሂደቱን መከታተል ይችላሉ።",
    sendReceiptPrompt: "✅ የተመረጠው ትምህርት ክፍል፡ **{dept}**\n\nአሁን እባክዎን የክፍያ ደረሰኝ ፎቶዎን ከሙሉ ስምዎ እና የተማሪ ID ጋር ይላኩ።",
    reuploadPrompt: "🔄 **ደረሰኝ እንደገና መላክ**\nእባክዎን አዲስ ማመልከቻ ለመጀመር የክፍያ ዓይነትዎን ይምረጡ፡",
    approvedMsg: "✅ **ደረሰኝዎ ተረጋግጦ ጸድቋል!**\nየክፍያ ማረጋገጫዎ ተፈቅዷል።",
    rejectedMsg: "❌ **ደረሰኝዎ ማስተካከያ ይፈልጋል**\n\n**ምክንያት:** {reason}\n\n{message}",
    reuploadBtn: "🔄 ደረሰኝ እንደገና ስቀል",
    noFileErr: "⚠️ እባክዎን ትክክለኛ የክፍያ ደረሰኝ **ፎቶ ወይም ስክሪንሾት** ይላኩ። በጽሁፍ ብቻ የሚላክ መረጃ አይቀበልም።",
    deptUpdated: "🔄 **ትምህርት ክፍል ተቀይሯል**\nየደረሰኝ ማመልከቻዎ ወደ **{dept}** ተዛውሯል።",
    pendingExists: "⚠️ **አሁንም በሂደት ላይ ያለ ማመልከቻ አለ**\n\nቀደም ሲል የላኩት ደረሰኝ በመገምገም ላይ ይገኛል። ሁኔታውን ከታች ማየት ይችላሉ።",
    helpText: "❓ **እርዳታ ይፈልጋሉ?**\n\nበትምህርት ክፍያ ወይም በትምህርት ክፍል ምዝገባ ላይ ጥያቄ ወይም ችግር ካለዎት፣ እባክዎን የሬጅስትራር ቢሮውን በቀጥታ ያነጋግሩ።"
  }
};

const REJECTION_REASONS = [
  { 
    label: "📷 Blurry/Unreadable Receipt", 
    code: "blurry",
    message_en: "Please ensure your receipt image is clear, fully visible, and uncropped, then click below to re-upload.",
    message_am: "እባክዎን የደረሰኝዎ ፎቶ ግልጽ፣ ሙሉ በሙሉ የሚታይ እና ያልተቆረጠ መሆኑን አረጋግተው እንደገና ይላኩ።"
  },
  { 
    label: "💵 Incorrect Amount Paid", 
    code: "amount",
    message_en: "The payment amount does not match your required tuition fees. Please verify your transaction details and re-upload the correct receipt.",
    message_am: "የተከፈለው የገንዘብ መጠን ከተፈለገው የትምህርት ክፍያ ጋር አይመሳሰልም። እባክዎን የትራንዛክሽን መረጃዎን አረጋግተው ትክክለኛውን ደረሰኝ ይላኩ።"
  },
  { 
    label: "🚫 Invalid/Fake Receipt", 
    code: "invalid",
    message_en: "This receipt could not be verified by our finance team. Please submit an official bank transaction receipt.",
    message_am: "ይህ ደረሰኝ በገንዘብ ያዥ ቡድኑ ሊረጋገጥ አልቻለም። እባክዎን ኦፊሴላዊ የባንክ ደረሰኝ ይላኩ።"
  },
  { 
    label: "👤 Name/ID Mismatch", 
    code: "mismatch",
    message_en: "The name or Student ID on the receipt does not match your profile details. Please re-upload a receipt that matches your credentials or contact administration.",
    message_am: "በደረሰኙ ላይ ያለው ስም ወይም የተማሪ መታወቂያ ከተመዘገበው መረጃ ጋር አይመሳሰልም። እባክዎን ትክክለኛ መረጃ ያለው ደረሰኝ ይላኩ።"
  }
];

function getPaymentTypeKeyboard(lang = 'en') {
  if (lang === 'am') {
    return new InlineKeyboard()
      .text("💳 መደበኛ የትምህርት ክፍያ (Regular)", "paytype_reg").row()
      .text("🎓 የ 4 ዓመት ሙሉ ክፍያ (Complete)", "paytype_full");
  }
  return new InlineKeyboard()
    .text("💳 Regular Term Tuition", "paytype_reg").row()
    .text("🎓 4-Year Complete Tuition", "paytype_full");
}

function getDepartmentKeyboard(planType = 'reg') {
  const prefix = planType === 'full' ? 'deptfull_' : 'deptreg_';
  return new InlineKeyboard()
    .text("📈 Marketing", `${prefix}Marketing Management`)
    .text("💼 Business", `${prefix}Business Management`).row()
    .text("📊 Accounting & Finance", `${prefix}Accounting and finance`).row()
    .text("🌾 Agribusiness & VCM", `${prefix}Agribusiness and Value chain management`).row()
    .text("📚 Ed. Planning & Mgmt", `${prefix}Educational planning and management`).row()
    .text("🚚 Logistics & SCM", `${prefix}Logistics and Supply chain management`);
}

function getStaffKeyboard() {
  return new InlineKeyboard()
    .text('🔍 Search Record', 'cmd_lookfor')
    .text('📊 Statistics', 'cmd_stats').row()
    .text('📄 Export CSV', 'cmd_export')
    .text('📢 Broadcast', 'cmd_broadcast').row()
    .text('📚 Upload Module', 'cmd_upload_module')
    .text('🗑 Delete Module', 'cmd_delete_module').row()
    .text('📈 Module Analytics', 'cmd_mod_analytics')
    .text('👥 Approved Students', 'cmd_approved_roster');
}

function getModuleDepartmentKeyboard() {
  return new InlineKeyboard()
    .text("📈 Marketing", "moddept_Marketing Management")
    .text("💼 Business", "moddept_Business Management").row()
    .text("📊 Accounting & Finance", "moddept_Accounting and finance").row()
    .text("🌾 Agribusiness & VCM", "moddept_Agribusiness and Value chain management").row()
    .text("📚 Ed. Planning & Mgmt", "moddept_Educational planning and management").row()
    .text("🚚 Logistics & SCM", "moddept_Logistics and Supply chain management").row()
    .text("🔙 Cancel", "moddept_cancel");
}

function getApprovedRosterKeyboard() {
  return new InlineKeyboard()
    .text("🌐 Every Student (All Departments)", "roster_all").row()
    .text("📈 Marketing", "roster_Marketing Management")
    .text("💼 Business", "roster_Business Management").row()
    .text("📊 Accounting & Finance", "roster_Accounting and finance").row()
    .text("🌾 Agribusiness & VCM", "roster_Agribusiness and Value chain management").row()
    .text("📚 Ed. Planning & Mgmt", "roster_Educational planning and management").row()
    .text("🚚 Logistics & SCM", "roster_Logistics and Supply chain management").row()
    .text("🔙 Cancel", "roster_cancel");
}

function getStudentKeyboard(lang = 'en', status = null) {
  const kb = new InlineKeyboard();

  if (lang === 'am') {
    if (status === 'PENDING') {
      kb.text('⏳ በግምገማ ላይ ነው', 'cmd_pending_info');
    } else if (status === 'APPROVED') {
      kb.text('⬇️ ደረሰኝ አውርድ', 'cmd_download_pdf');
    } else {
      kb.text('📤 ደረሰኝ አስገባ', 'cmd_submit');
    }
    kb.text('📌 ሁኔታውን ያረጋግጡ', 'cmd_status').row();
    kb.text('📚 የትምህርት ሞጁሎች', 'cmd_modules').row();
    kb.text('📜 የክፍያ ታሪክ', 'cmd_history');
    kb.text('❓ እርዳታ / እገዛ', 'cmd_help');
  } else {
    if (status === 'PENDING') {
      kb.text('⏳ Under Review', 'cmd_pending_info');
    } else if (status === 'APPROVED') {
      kb.text('⬇️ Download Slip', 'cmd_download_pdf');
    } else {
      kb.text('📤 Submit Payment', 'cmd_submit');
    }
    kb.text('📌 Check Status', 'cmd_status').row();
    kb.text('📚 Course Modules', 'cmd_modules').row();
    kb.text('📜 My History', 'cmd_history');
    kb.text('❓ Help / Support', 'cmd_help');
  }

  return kb;
}

function getTransferKeyboard(userId, topicId) {
  return new InlineKeyboard()
    .text("📈 Marketing Mgmt", `tr_${userId}_${topicId}_mkt`)
    .text("💼 Business Mgmt", `tr_${userId}_${topicId}_biz`).row()
    .text("🌾 Agribusiness & VCM", `tr_${userId}_${topicId}_agri`)
    .text("📚 Ed. Planning", `tr_${userId}_${topicId}_ed`).row()
    .text("📊 Accounting & Finance", `tr_${userId}_${topicId}_acc`)
    .text("🚚 Logistics & SCM", `tr_${userId}_${topicId}_log`).row()
    .text("🔙 Cancel Transfer", `canceltrans_${userId}_${topicId}`);
}

function getRejectionReasonKeyboard(userId, topicId) {
  const kb = new InlineKeyboard();
  REJECTION_REASONS.forEach((r) => {
    kb.text(r.label, `confirmrej_${userId}_${topicId}_${r.code}`).row();
  });
  return kb;
}

async function generateApprovalPDF(userId, username, department, staffName) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50 });
    const filePath = path.join(__dirname, `approval_slip_${userId}.pdf`);
    const stream = fs.createWriteStream(filePath);

    doc.pipe(stream);

    doc.fontSize(20).text('RENAISSANCE GLOBAL', { align: 'center' });
    doc.fontSize(14).text('Official Tuition Payment Approval Slip', { align: 'center' });
    doc.moveDown(2);

    doc.fontSize(12);
    doc.text(`Student ID: ${userId}`);
    doc.text(`Username: @${username}`);
    doc.text(`Department: ${department}`);
    doc.text(`Status: APPROVED`);
    doc.text(`Processed By: ${staffName}`);
    doc.text(`Date: ${new Date().toLocaleString()}`);
    doc.moveDown(4);

    doc.fontSize(10).text('This is an official computer-generated receipt approval slip from the Renaissance Global Student Portal.', { align: 'center' });

    doc.end();

    stream.on('finish', () => resolve(filePath));
    stream.on('error', reject);
  });
}

bot.catch((err) => console.error('Error in bot framework:', err));
async function getOrCreateDepartmentTopic(ctx, departmentName, targetGroupId) {
  const baseDepartment = departmentName.replace(/\s*\((Regular \/ Term|4-Year Complete)\)$/, '').trim();

  const cached = await pool.query(
    'SELECT topic_id FROM department_topics WHERE group_id = $1 AND department = $2 LIMIT 1',
    [targetGroupId, baseDepartment]
  );

  if (cached.rows.length > 0) {
    return Number(cached.rows[0].topic_id);
  }

  const newTopic = await ctx.api.createForumTopic(targetGroupId, `📁 [${baseDepartment}]`);
  const topicId = newTopic.message_thread_id;

  await pool.query(
    'DELETE FROM department_topics WHERE group_id = $1 AND department = $2',
    [targetGroupId, baseDepartment]
  );

  await pool.query(
    'INSERT INTO department_topics (group_id, department, topic_id) VALUES ($1, $2, $3)',
    [targetGroupId, baseDepartment, topicId]
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

  const newTopic = await ctx.api.createForumTopic(targetGroupId, '📚 [Course Modules Vault]');
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
  let text = `📊 **${icon} ${statusType} RECEIPTS SUMMARY**\n\n`;
  if (res.rows.length === 0) {
    text += `_No ${statusType.toLowerCase()} receipts recorded yet._`;
    return text;
  }
  res.rows.forEach((r) => {
    text += `• **${r.department}**: ${r.count} student(s)\n`;
  });
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
      return bot.api.sendMessage(staffGroupId, "⚠️ No receipts found to export.", { message_thread_id: threadId });
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
      { message_thread_id: threadId, caption: captionText, parse_mode: 'Markdown' }
    );
  } catch (err) {
    console.error("Export error:", err);
    await bot.api.sendMessage(staffGroupId, `❌ Export error: ${err.message}`, { message_thread_id: threadId });
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
    return ctx.reply(`🔍 No receipts found matching: **${query}**`, { 
      message_thread_id: topicId, 
      parse_mode: 'Markdown' 
    });
  }

  let text = `🔍 **SEARCH RESULTS FOR:** \`${query}\` (${res.rows.length})\n\n`;

  res.rows.forEach((r, idx) => {
    let statusEmoji = "⏳";
    if (r.status === 'APPROVED') statusEmoji = "✅";
    if (r.status === 'REJECTED') statusEmoji = "❌";

    const uname = r.username ? `@${r.username}` : "N/A";
    const staff = r.processed_by ? ` (Processed by: ${r.processed_by})` : "";
    const dateStr = new Date(r.updated_at).toLocaleDateString();

    text += `${idx + 1}. ${statusEmoji} **${r.department}**\n`;
    text += `   • Student ID: \`${r.user_id}\` (${uname})\n`;
    text += `   • Status: ${r.status}${staff}\n`;
    text += `   • Last Update: ${dateStr}\n`;
    if (r.status === 'REJECTED' && r.rejection_reason) {
      text += `   • Reason: ${r.rejection_reason}\n`;
    }
    text += `\n`;
  });

  await ctx.reply(text, { message_thread_id: topicId, parse_mode: 'Markdown' });
}

async function performBroadcast(ctx, topicId, broadcastMsg) {
  if (!broadcastMsg) {
    return ctx.reply("⚠️ Broadcast text cannot be empty.", { message_thread_id: topicId });
  }

  const usersRes = await pool.query('SELECT DISTINCT user_id FROM tickets');
  const userIds = usersRes.rows.map(r => r.user_id);

  let successCount = 0;
  let failCount = 0;

  await ctx.reply(`📢 Starting broadcast to ${userIds.length} students...`, { message_thread_id: topicId });

  for (const id of userIds) {
    try {
      await bot.api.sendMessage(id, `📢 **ANNOUNCEMENT / ማስታወቂያ**\n\n${broadcastMsg}`, { parse_mode: 'Markdown' });
      successCount++;
    } catch (err) {
      failCount++;
    }
  }

  await ctx.reply(`✅ **Broadcast Complete**\n• Delivered: ${successCount}\n• Failed: ${failCount}`, { message_thread_id: topicId });
}

bot.command('bind', async (ctx) => {
  if (ctx.chat.type === 'private') {
    return ctx.reply("⚠️ This command must be executed inside a supergroup with topics/threads enabled.");
  }

  try {
    const member = await ctx.getChatMember(ctx.from.id);
    if (!['administrator', 'creator'].includes(member.status)) {
      return ctx.reply("❌ Only group administrators can bind this group.");
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
    "✅ **Group Bound Successfully!**\n\nThis group is now registered as the active Staff Panel. All student receipt submissions and department topics will be automatically managed here.",
    { parse_mode: 'Markdown' }
  );
});

bot.command(['start', 'panel'], async (ctx) => {
  const staffGroupId = await getActiveStaffGroupId();
  const isStaffGroup = String(ctx.chat.id) === staffGroupId;
  const isPrivate = ctx.chat.type === 'private';

  if (isStaffGroup) {
    const topicId = ctx.message.message_thread_id;
    return ctx.reply(
      "⚙️ **RENAISSANCE GLOBAL — STAFF ACTION PANEL**\n\nSelect an action below:",
      {
        message_thread_id: topicId,
        parse_mode: 'Markdown',
        reply_markup: getStaffKeyboard()
      }
    );
  }

  if (isPrivate) {
    const userId = ctx.from.id;
    await clearPendingDepartment(userId);

    const langKeyboard = new InlineKeyboard()
      .text("🇬🇧 English", "lang_en")
      .text("🇪🇹 አማርኛ", "lang_am");

    await ctx.reply(
      "🌐 **Please select your language / እባክዎን ቋንቋ ይምረጡ:**",
      { parse_mode: 'Markdown', reply_markup: langKeyboard }
    );
  }
});

// TYPO-PROOF /changedept COMMAND
bot.command(['changedept', 'changedep'], async (ctx) => {
  const authorized = await isStaff(ctx);
  if (!authorized) return;

  const topicId = ctx.message.message_thread_id;

  let targetIdStr = ctx.message.text.replace(/^\/(changedept|changedep)/, '').trim();

  if (!targetIdStr && ctx.message.reply_to_message && ctx.message.reply_to_message.text) {
    const match = ctx.message.reply_to_message.text.match(/Student ID:\s*`?(\d+)`?/i);
    if (match) targetIdStr = match[1];
  }

  const targetUserId = Number(targetIdStr);
  if (!targetUserId) {
    return ctx.reply(
      "⚠️ **How to use:**\nType: `/changedept <StudentID>`\n*Example:* `/changedept 123456789`\n\n*(Or reply directly to the student's approval slip with `/changedept`)*",
      { message_thread_id: topicId, parse_mode: 'Markdown' }
    );
  }

  const res = await pool.query(
    "SELECT id, username, department FROM tickets WHERE user_id = $1 AND status = 'APPROVED' ORDER BY updated_at DESC LIMIT 1",
    [targetUserId]
  );

  if (res.rows.length === 0) {
    return ctx.reply(`⚠️ No approved record found for Student ID: \`${targetUserId}\`.`, { message_thread_id: topicId, parse_mode: 'Markdown' });
  }

  const { username, department } = res.rows[0];

  const kb = new InlineKeyboard()
    .text("📈 Marketing", `chgdept_${targetUserId}_mkt`)
    .text("💼 Business", `chgdept_${targetUserId}_biz`).row()
    .text("📊 Accounting & Finance", `chgdept_${targetUserId}_acc`).row()
    .text("🌾 Agribusiness & VCM", `chgdept_${targetUserId}_agri`).row()
    .text("📚 Ed. Planning & Mgmt", `chgdept_${targetUserId}_ed`).row()
    .text("🚚 Logistics & SCM", `chgdept_${targetUserId}_log`).row()
    .text("🔙 Cancel", `chgdept_${targetUserId}_cancel`);

  await ctx.reply(
    `🔄 **Change Academic Placement**\n\n• **Student ID:** \`${targetUserId}\`\n• **Username:** @${username || 'N/A'}\n• **Current Dept:** ${department}\n\nSelect the new department below:`,
    { message_thread_id: topicId, parse_mode: 'Markdown', reply_markup: kb }
  );
});

bot.callbackQuery(/^chgdept_(\d+)_(mkt|biz|acc|agri|ed|log|cancel)$/, async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}

  const targetUserId = Number(ctx.match[1]);
  const deptCode = ctx.match[2];
  const staffName = `${ctx.from.first_name || ''} ${ctx.from.last_name || ''}`.trim() || `Staff`;

  if (deptCode === 'cancel') {
    return ctx.editMessageText("❌ Department change cancelled.");
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
    "SELECT id, department FROM tickets WHERE user_id = $1 AND status = 'APPROVED' ORDER BY updated_at DESC LIMIT 1",
    [targetUserId]
  );

  if (ticketRes.rows.length === 0) {
    return ctx.editMessageText("⚠️ Could not find approved ticket to update.");
  }

  const oldDept = ticketRes.rows[0].department || '';
  const planSuffix = oldDept.includes("(4-Year Complete)") ? "(4-Year Complete)" : "(Regular / Term)";
  const newFullDept = `${deptMap[deptCode]} ${planSuffix}`;

  await pool.query(
    "UPDATE tickets SET department = $1, processed_by = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3",
    [newFullDept, staffName, ticketRes.rows[0].id]
  );

  await ctx.editMessageText(
    `✅ **Department Changed Successfully!**\n\n• **Student ID:** \`${targetUserId}\`\n• **New Department:** ${newFullDept}\n• **Updated by:** ${staffName}\n\n_Student's module library has been automatically switched to the new department._`,
    { parse_mode: 'Markdown' }
  );

  try {
    const studentLang = await getUserLang(targetUserId);
    const notifMsg = studentLang === 'am'
      ? `🔄 **የትምህርት ክፍልዎ ተቀይሯል**\n\nአዲሱ የትምህርት ክፍልዎ፡ **${newFullDept}**\n\nአሁን አዲሶቹን የትምህርት ሞጁሎች በ '📚 የትምህርት ሞጁሎች' በኩል ማውረድ ይችላሉ።`
      : `🔄 **Academic Placement Updated**\n\nYour academic department has been officially updated to:\n👉 **${newFullDept}**\n\nYou can now access your new course materials under **📚 Course Modules** in your portal!`;

    await bot.api.sendMessage(targetUserId, notifMsg, { parse_mode: 'Markdown' });
  } catch (err) {
    console.error("Could not notify student of dept change:", err);
  }
});

// INTERACTIVE /deletemodule MANAGER
bot.command(['deletemodule', 'delmod'], async (ctx) => {
  const authorized = await isStaff(ctx);
  if (!authorized) return;

  const topicId = ctx.message.message_thread_id;

  const kb = new InlineKeyboard()
    .text("📈 Marketing", "delmoddept_Marketing Management")
    .text("💼 Business", "delmoddept_Business Management").row()
    .text("📊 Accounting & Finance", "delmoddept_Accounting and finance").row()
    .text("🌾 Agribusiness & VCM", "delmoddept_Agribusiness and Value chain management").row()
    .text("📚 Ed. Planning & Mgmt", "delmoddept_Educational planning and management").row()
    .text("🚚 Logistics & SCM", "delmoddept_Logistics and Supply chain management").row()
    .text("🔙 Cancel", "delmoddept_cancel");

  await ctx.reply(
    "🗑 **Delete Course Module**\n\nSelect the academic department to view and remove modules:",
    { message_thread_id: topicId, parse_mode: 'Markdown', reply_markup: kb }
  );
});

bot.callbackQuery(/^delmoddept_(.+)$/, async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  const dept = ctx.match[1];

  if (dept === 'cancel') {
    return ctx.editMessageText("❌ Module deletion cancelled.");
  }

  const res = await pool.query(
    "SELECT id, title, file_name FROM department_modules WHERE department ILIKE $1 ORDER BY id ASC",
    [`%${dept}%`]
  );

  if (res.rows.length === 0) {
    return ctx.editMessageText(`ℹ️ No modules currently found for **${dept}**.`);
  }

  const kb = new InlineKeyboard();
  res.rows.forEach((m) => {
    kb.text(`🗑 ${m.title}`, `confirm_delmod_${m.id}`).row();
  });
  kb.text("🔙 Cancel", "delmoddept_cancel");

  await ctx.editMessageText(
    `🗑 **Modules for ${dept}**\n\nTap any module below to permanently remove student access:`,
    { parse_mode: 'Markdown', reply_markup: kb }
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
    return ctx.editMessageText("⚠️ Module was already deleted or not found.");
  }

  const { title, department } = res.rows[0];

  await ctx.editMessageText(
    `✅ **Module Deleted Successfully!**\n\n• **Title:** ${title}\n• **Department:** ${department}\n\n_This module is no longer accessible or downloadable by any student._`,
    { parse_mode: 'Markdown' }
  );
});

// APPROVED STUDENTS DIRECTORY ROSTER (WITH HTML PARSE MODE FIX)
bot.command(['approved', 'students'], async (ctx) => {
  const authorized = await isStaff(ctx);
  if (!authorized) return;

  const topicId = ctx.message.message_thread_id;

  await ctx.reply(
    "👥 **Approved Students Directory**\n\nSelect **'Every Student'** to see all approved students, or choose a specific department:",
    { message_thread_id: topicId, parse_mode: 'Markdown', reply_markup: getApprovedRosterKeyboard() }
  );
});

bot.callbackQuery('cmd_approved_roster', async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  if (!(await isStaff(ctx))) return;

  const topicId = ctx.callbackQuery.message.message_thread_id;

  await ctx.reply(
    "👥 **Approved Students Directory**\n\nSelect **'Every Student'** to see all approved students, or choose a specific department:",
    { message_thread_id: topicId, parse_mode: 'Markdown', reply_markup: getApprovedRosterKeyboard() }
  );
});

bot.callbackQuery(/^roster_(.+)$/, async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  const targetDept = ctx.match[1];

  if (targetDept === 'cancel') {
    return ctx.editMessageText("❌ Roster view cancelled.");
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
      ? "ℹ️ No approved students registered yet."
      : `ℹ️ No approved students found in <b>${escapeHtml(cleanDept)}</b>.`;
    return ctx.editMessageText(emptyMsg, { parse_mode: 'HTML' });
  }

  const headerTitle = isAll ? "ALL DEPARTMENTS" : cleanDept.toUpperCase();
  let text = `🎓 <b>APPROVED ROSTER — ${escapeHtml(headerTitle)}</b> (${res.rows.length} Total)\n\n`;
  let currentGroupDept = "";

  for (let idx = 0; idx < res.rows.length; idx++) {
    const r = res.rows[idx];
    const rawUname = r.username ? `@${r.username}` : `[No @username]`;
    const uname = escapeHtml(rawUname);
    const dateStr = new Date(r.updated_at).toLocaleDateString();
    const staff = r.processed_by ? ` (Staff: ${escapeHtml(r.processed_by)})` : '';

    let itemText = "";
    if (isAll && r.department !== currentGroupDept) {
      currentGroupDept = r.department;
      itemText += `\n📁 <b>${escapeHtml(currentGroupDept)}</b>\n`;
    }

    itemText += `${idx + 1}. <b>${uname}</b> (ID: <code>${r.user_id}</code>)\n   • Approved: ${dateStr}${staff}\n`;

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
  const modRes = await pool.query('SELECT title, department, file_id FROM department_modules WHERE id = $1', [moduleId]);
  if (modRes.rows.length === 0) {
    return ctx.editMessageText("⚠️ Module no longer exists or was removed.");
  }

  const { title, department } = modRes.rows[0];
  const cleanDept = department.replace(/\s*\((Regular \/ Term|4-Year Complete)\)$/, '').trim();

  const studentsRes = await pool.query(
    "SELECT DISTINCT user_id FROM tickets WHERE status = 'APPROVED' AND department ILIKE $1",
    [`%${cleanDept}%`]
  );

  const students = studentsRes.rows;
  if (students.length === 0) {
    return ctx.editMessageText(`ℹ️ No approved students enrolled in **${cleanDept}** to notify.`);
  }

  let sentCount = 0;
  for (const s of students) {
    try {
      const sLang = await getUserLang(s.user_id);
      const notifText = sLang === 'am'
        ? `📚 **አዲስ የትምህርት ሞጁል ተጭኗል!**\n\n• **ክፍል:** ${cleanDept}\n• **ሞጁል:** ${title}\n\nከታች ያለውን ቁልፍ በመጫን ወዲያውኑ ማውረድ ይችላሉ፡`
        : `📚 **NEW COURSE MODULE AVAILABLE**\n\n• **Department:** ${cleanDept}\n• **Module:** ${title}\n\nTap below to download directly to your chat:`;

      const dlKb = new InlineKeyboard().text(sLang === 'am' ? "⬇️ አውርድ (Download)" : "⬇️ Download Module", `dlmod_${moduleId}`);
      await bot.api.sendMessage(s.user_id, notifText, { parse_mode: 'Markdown', reply_markup: dlKb });
      sentCount++;
    } catch (e) {}
  }

  await ctx.editMessageText(
    `📢 **Notification Broadcast Complete!**\n\n• **Module:** ${title}\n• **Department:** ${cleanDept}\n• **Delivered to:** ${sentCount} / ${students.length} approved students.`,
    { parse_mode: 'Markdown' }
  );
});

bot.callbackQuery('dismiss_mod_notify', async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  await ctx.editMessageText("🔕 Notification skipped. Module uploaded silently.");
});

bot.callbackQuery('cmd_mod_analytics', async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  if (!(await isStaff(ctx))) return;

  const topicId = ctx.callbackQuery.message.message_thread_id;

  const res = await pool.query(`
    SELECT 
      m.id, 
      m.title, 
      m.department,
      COUNT(DISTINCT d.user_id) AS total_downloads
    FROM department_modules m
    LEFT JOIN module_downloads d ON m.id = d.module_id
    GROUP BY m.id, m.title, m.department
    ORDER BY m.department ASC, total_downloads DESC
  `);

  if (res.rows.length === 0) {
    return ctx.reply("📊 **Module Analytics:** No modules uploaded yet.", { message_thread_id: topicId });
  }

  let text = "📈 **COURSE MODULE ENGAGEMENT ANALYTICS**\n\n";
  let currentDept = "";

  for (const row of res.rows) {
    if (row.department !== currentDept) {
      currentDept = row.department;
      text += `\n📁 **${currentDept}**\n`;
    }

    const cleanDept = currentDept.replace(/\s*\((Regular \/ Term|4-Year Complete)\)$/, '').trim();
    const enrolledRes = await pool.query(
      "SELECT COUNT(DISTINCT user_id) as count FROM tickets WHERE status = 'APPROVED' AND department ILIKE $1",
      [`%${cleanDept}%`]
    );
    const totalEnrolled = Number(enrolledRes.rows[0].count) || 0;
    const downloads = Number(row.total_downloads);
    const percentage = totalEnrolled > 0 ? Math.round((downloads / totalEnrolled) * 100) : 0;

    text += `• **${row.title}**\n  ↳ Downloaded by: **${downloads}/${totalEnrolled} students** (${percentage}%)\n`;
  }

  await ctx.reply(text, { message_thread_id: topicId, parse_mode: 'Markdown' });
});

bot.callbackQuery(/^lang_(en|am)$/, async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  const lang = ctx.match[1];
  const userId = ctx.from.id;
  await setUserLang(userId, lang);

  const t = STRINGS[lang];

  try {
    await ctx.editMessageText(
      t.portalWelcome,
      { parse_mode: 'Markdown', reply_markup: getStudentKeyboard(lang, null) }
    );
  } catch (e) {}
});

bot.callbackQuery('cmd_lookfor', async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  await ctx.reply(
    "🔍 **Search Student Record**\n\nReply directly to this message with a **User ID**, **@username**, or **Department**.",
    {
      message_thread_id: ctx.callbackQuery.message.message_thread_id,
      parse_mode: 'Markdown',
      reply_markup: { force_reply: true }
    }
  );
});

bot.callbackQuery('cmd_stats', async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  const topicId = ctx.callbackQuery.message.message_thread_id;
  const appSummary = await generateSummaryText('APPROVED');
  const rejSummary = await generateSummaryText('REJECTED');
  await ctx.reply(`${appSummary}\n\n---\n\n${rejSummary}`, { message_thread_id: topicId, parse_mode: 'Markdown' });
});

bot.callbackQuery('cmd_export', async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  const staffGroupId = await getActiveStaffGroupId();
  const topicId = ctx.callbackQuery.message.message_thread_id;
  await sendCSVExport(staffGroupId, topicId, "📄 **Receipt Audit Export**");
});

bot.callbackQuery('cmd_broadcast', async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  await ctx.reply(
    "📢 **Send Student Announcement**\n\nReply directly to this message with the exact announcement text you want to send to all registered students.",
    {
      message_thread_id: ctx.callbackQuery.message.message_thread_id,
      parse_mode: 'Markdown',
      reply_markup: { force_reply: true }
    }
  );
});

bot.callbackQuery('cmd_upload_module', async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  const authorized = await isStaff(ctx);
  if (!authorized) return;

  await ctx.reply(
    "📚 **Upload Course Module**\n\nPlease select the department for this module:",
    {
      message_thread_id: ctx.callbackQuery.message.message_thread_id,
      parse_mode: 'Markdown',
      reply_markup: getModuleDepartmentKeyboard()
    }
  );
});

bot.callbackQuery('cmd_delete_module', async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  const authorized = await isStaff(ctx);
  if (!authorized) return;

  const kb = new InlineKeyboard()
    .text("📈 Marketing", "delmoddept_Marketing Management")
    .text("💼 Business", "delmoddept_Business Management").row()
    .text("📊 Accounting & Finance", "delmoddept_Accounting and finance").row()
    .text("🌾 Agribusiness & VCM", "delmoddept_Agribusiness and Value chain management").row()
    .text("📚 Ed. Planning & Mgmt", "delmoddept_Educational planning and management").row()
    .text("🚚 Logistics & SCM", "delmoddept_Logistics and Supply chain management").row()
    .text("🔙 Cancel", "delmoddept_cancel");

  await ctx.reply(
    "🗑 **Delete Course Module**\n\nSelect the academic department to view and remove modules:",
    { message_thread_id: ctx.callbackQuery.message.message_thread_id, parse_mode: 'Markdown', reply_markup: kb }
  );
});

bot.callbackQuery(/^moddept_(.+)$/, async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  const dept = ctx.match[1];

  if (dept === 'cancel') {
    await clearStaffPendingModuleDept(ctx.from.id);
    return ctx.editMessageText("❌ Module upload cancelled.");
  }

  await setStaffPendingModuleDept(ctx.from.id, dept);

  await ctx.editMessageText(
    `✅ Selected Department:\n${dept}\n\nNow, simply send or forward the PDF document for this module.`
  );
});

bot.callbackQuery('cmd_submit', async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  const userId = ctx.from.id;
  const lang = await getUserLang(userId);
  const t = STRINGS[lang];

  await ctx.reply(
    t.selectPlan,
    { parse_mode: 'Markdown', reply_markup: getPaymentTypeKeyboard(lang) }
  );
});

bot.callbackQuery('cmd_pending_info', async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  const userId = ctx.from.id;
  const lang = await getUserLang(userId);
  
  const msg = lang === 'am'
    ? "⏳ **ማመልከቻዎ በግምገማ ላይ ነው**\n\nየላኩት ደረሰኝ በበላይ ኃላፊዎች በመታየት ላይ ስለሆነ በአሁኑ ወቅት አዲስ ደረሰኝ መላክ አይችሉም። ውሳኔ ሲሰጥበት ወዲያውኑ ማሳወቂያ ይደርስዎታል።"
    : "⏳ **Submission Under Review**\n\nYour submitted receipt is currently being verified by finance staff. Submitting a new receipt is disabled until staff completes the review process.";

  await ctx.reply(msg, { 
    parse_mode: 'Markdown', 
    reply_markup: getStudentKeyboard(lang, 'PENDING') 
  });
});

bot.callbackQuery('cmd_download_pdf', async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  const userId = ctx.from.id;
  const lang = await getUserLang(userId);
  const t = STRINGS[lang];

  const res = await pool.query(
    "SELECT department, username, processed_by FROM tickets WHERE user_id = $1 AND status = 'APPROVED' ORDER BY updated_at DESC LIMIT 1",
    [userId]
  );

  if (res.rows.length === 0) {
    return ctx.reply("⚠️ No approved receipt found for download.", { parse_mode: 'Markdown' });
  }

  const { department, username, processed_by } = res.rows[0];

  try {
    const pdfPath = await generateApprovalPDF(userId, username || 'N/A', department, processed_by || 'Finance Team');
    await ctx.replyWithDocument(
      new InputFile(pdfPath, `Tuition_Approval_Slip_${userId}.pdf`),
      { caption: t.approvedMsg, parse_mode: 'Markdown' }
    );
    if (fs.existsSync(pdfPath)) {
      fs.unlinkSync(pdfPath);
    }
  } catch (err) {
    console.error("Error generating requested PDF:", err);
    await ctx.reply("❌ Unable to generate PDF slip. Please try again later.");
  }
});

// STUDENT MODULES BROWSER
bot.callbackQuery('cmd_modules', async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  const userId = ctx.from.id;
  const lang = await getUserLang(userId);

  const checkApproval = await pool.query(
    "SELECT department FROM tickets WHERE user_id = $1 AND status = 'APPROVED' ORDER BY updated_at DESC LIMIT 1",
    [userId]
  );

  if (checkApproval.rows.length === 0) {
    const notApprovedMsg = lang === 'am'
      ? "🔒 **የሞጁል ማውረጃ ተቆልፏል**\n\nየትምህርት ሞጁሎችን ለማውረድ የክፍያ ደረሰኝዎ በገንዘብ ያዥ ቡድኑ መጽደቅ አለበት። እባክዎን መጀመሪያ ደረሰኝዎን ያስገቡ ወይም ውሳኔ እስኪያገኝ ይጠብቁ።"
      : "🔒 **Modules Locked**\n\nCourse modules are only accessible to students with an **APPROVED** tuition payment. Please submit your payment receipt first or wait for staff verification.";
    
    return ctx.reply(notApprovedMsg, { 
      parse_mode: 'Markdown',
      reply_markup: getStudentKeyboard(lang, null)
    });
  }

  const studentDept = checkApproval.rows[0].department
    .replace(/\s*\((Regular \/ Term|4-Year Complete)\)$/, '')
    .trim();

  const modulesRes = await pool.query(
    "SELECT id, title FROM department_modules WHERE department ILIKE $1 ORDER BY id ASC",
    [`%${studentDept}%`]
  );

  if (modulesRes.rows.length === 0) {
    const noModulesMsg = lang === 'am'
      ? `📚 **ትምህርት ክፍል:** ${studentDept}\n\nለዚህ ክፍል እስካሁን የተጫነ ሞጁል የለም። በቅርቡ ይጫናል።`
      : `📚 **Department:** ${studentDept}\n\nNo modules uploaded for this department yet. Please check back later.`;
    
    return ctx.reply(noModulesMsg, { parse_mode: 'Markdown' });
  }

  const kb = new InlineKeyboard();
  modulesRes.rows.forEach((m) => {
    kb.text(`📄 ${m.title}`, `dlmod_${m.id}`).row();
  });

  const headerMsg = lang === 'am'
    ? `📚 **የትምህርት ክፍል ሞጁሎች (${studentDept})**\n\nለማውረድ የሚፈልጉትን ሞጁል ይምረጡ፡`
    : `📚 **Course Modules (${studentDept})**\n\nSelect a module below to download:`;

  await ctx.reply(headerMsg, { parse_mode: 'Markdown', reply_markup: kb });
});

bot.callbackQuery(/^dlmod_(\d+)$/, async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  const moduleId = Number(ctx.match[1]);

  const res = await pool.query("SELECT title, file_id, file_name FROM department_modules WHERE id = $1", [moduleId]);
  if (res.rows.length === 0) {
    return ctx.reply("⚠️ Module not found or removed.");
  }

  const mod = res.rows[0];

  // Log unique student download for analytics
  try {
    await pool.query(`
      INSERT INTO module_downloads (module_id, user_id)
      VALUES ($1, $2)
      ON CONFLICT (module_id, user_id) DO NOTHING
    `, [moduleId, ctx.from.id]);
  } catch (logErr) {
    console.error("Error logging module download:", logErr);
  }

  try {
    await ctx.replyWithDocument(mod.file_id, {
      caption: `📖 **${mod.title}**\n\n_Renaissance Global Official Course Module_`,
      parse_mode: 'Markdown'
    });
  } catch (err) {
    console.error("Error sending module document:", err);
    await ctx.reply("❌ Unable to download this module right now. Please notify administration.");
  }
});

bot.callbackQuery(/^paytype_(reg|full)$/, async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  const planType = ctx.match[1];
  const userId = ctx.from.id;
  const lang = await getUserLang(userId);
  const t = STRINGS[lang];

  try {
    await ctx.editMessageText(
      t.selectDept,
      { parse_mode: 'Markdown', reply_markup: getDepartmentKeyboard(planType) }
    );
  } catch (e) {}
});

bot.callbackQuery('cmd_status', async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  const userId = ctx.from.id;
  const lang = await getUserLang(userId);

  const res = await pool.query(
    'SELECT department, status, rejection_reason, updated_at FROM tickets WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 1',
    [userId]
  );

  if (res.rows.length === 0) {
    const noSubMsg = lang === 'am' 
      ? "ℹ️ እስከ አሁን ምንም ደረሰኝ አላስገቡም። ለማስገባት የታችኛውን ቁልፎች ይጫኑ።"
      : "ℹ️ You have not submitted any payment receipts yet. Use the action panel below to start.";
    return ctx.reply(noSubMsg, { parse_mode: 'Markdown', reply_markup: getStudentKeyboard(lang, null) });
  }

  const ticket = res.rows[0];
  let timeline = "";
  let statusText = "";

  if (ticket.status === 'PENDING') {
    timeline = lang === 'am'
      ? "📌 **የሂደት ሁኔታ ማሳያ (Timeline):**\n\n✅ 1. ደረሰኝ መላክ\n⏳ 2. የሰራተኞች ግምገማ (በሂደት ላይ...)\n❌ 3. ማጽደቅ / ፒዲኤፍ ማግኘት"
      : "📌 **Live Progress Timeline:**\n\n✅ 1. Receipt Submitted\n⏳ 2. Staff Review (In Progress...)\n❌ 3. Approval & PDF Generation";
    statusText = lang === 'am' ? "በመጠባበቅ ላይ (Pending Review)" : "Pending Review";
  } else if (ticket.status === 'APPROVED') {
    timeline = lang === 'am'
      ? "📌 **የሂደት ሁኔታ ማሳያ (Timeline):**\n\n✅ 1. ደረሰኝ መላክ\n✅ 2. የሰራተኞች ግምገማ\n✅ 3. ጸድቋል & ፒዲኤፍ ተልኳል"
      : "📌 **Live Progress Timeline:**\n\n✅ 1. Receipt Submitted\n✅ 2. Staff Review\n✅ 3. Approved & PDF Dispatched";
    statusText = lang === 'am' ? "ተረጋግጧል (Approved)" : "Approved";
  } else if (ticket.status === 'REJECTED') {
    timeline = lang === 'am'
      ? "📌 **የሂደት ሁኔታ ማሳያ (Timeline):**\n\n✅ 1. ደረሰኝ መላክ\n✅ 2. ግምገማ ተጠናቋል\n❌ 3. ውድቅ ተደርጓል (ማስተካከያ ይፈልጋል)"
      : "📌 **Live Progress Timeline:**\n\n✅ 1. Receipt Submitted\n✅ 2. Staff Review Completed\n❌ 3. Rejected (Action Required)";
    statusText = lang === 'am' ? "ውድቅ ተደርጓል (Rejected)" : "Rejected";
  }

  let msg = lang === 'am' 
    ? `📋 **የክፍያዎ ሁኔታ ማጠቃለያ**\n\n• **ትምህርት ክፍል:** ${ticket.department}\n• **ሁኔታ:** **${statusText}**\n\n${timeline}\n`
    : `📋 **Your Payment Status Tracker**\n\n• **Department:** ${ticket.department}\n• **Status:** **${statusText}**\n\n${timeline}\n`;
  
  if (ticket.status === 'REJECTED' && ticket.rejection_reason) {
    msg += lang === 'am' 
      ? `\n• **ምክንያት:** ${ticket.rejection_reason}\n\nእባክዎን አዲስ ደረሰኝ ለመላክ 'ደረሰኝ አስገባ' የሚለውን ይጫኑ።`
      : `\n• **Reason:** ${ticket.rejection_reason}\n\nTap 'Submit Payment' in the panel to re-upload.`;
  }

  await ctx.reply(msg, { parse_mode: 'Markdown', reply_markup: getStudentKeyboard(lang, ticket.status) });
});

bot.callbackQuery('cmd_history', async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  const userId = ctx.from.id;
  const lang = await getUserLang(userId);

  const res = await pool.query(
    'SELECT department, status, rejection_reason, created_at FROM tickets WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20',
    [userId]
  );

  if (res.rows.length === 0) {
    const noHistory = lang === 'am'
      ? "ℹ️ ምንም የተመዘገበ የክፍያ ታሪክ የለም።"
      : "ℹ️ No payment submission history found.";
    return ctx.reply(noHistory, { parse_mode: 'Markdown', reply_markup: getStudentKeyboard(lang, null) });
  }

  let text = lang === 'am'
    ? `📜 **የክፍያ ታሪክዎት (የመጨረሻዎቹ ${res.rows.length}):**\n\n`
    : `📜 **Your Payment History (Latest ${res.rows.length}):**\n\n`;

  for (let idx = 0; idx < res.rows.length; idx++) {
    const r = res.rows[idx];
    const dateStr = new Date(r.created_at).toLocaleDateString();
    let statusIcon = "⏳";
    if (r.status === 'APPROVED') statusIcon = "✅";
    if (r.status === 'REJECTED') statusIcon = "❌";

    let itemText = `${idx + 1}. ${statusIcon} **${r.department}**\n`;
    itemText += `   • Status: ${r.status}\n`;
    itemText += `   • Date: ${dateStr}\n`;
    if (r.status === 'REJECTED' && r.rejection_reason) {
      itemText += `   • Reason: ${r.rejection_reason}\n`;
    }
    itemText += `\n`;

    if ((text + itemText).length > 3800) {
      await ctx.reply(text, { parse_mode: 'Markdown' });
      text = "";
    }
    text += itemText;
  }

  if (text.trim().length > 0) {
    await ctx.reply(text, { parse_mode: 'Markdown', reply_markup: getStudentKeyboard(lang, null) });
  }
});

bot.callbackQuery('cmd_help', async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  const userId = ctx.from.id;
  const lang = await getUserLang(userId);
  const t = STRINGS[lang];
  await ctx.reply(t.helpText, { parse_mode: 'Markdown', reply_markup: getStudentKeyboard(lang, null) });
});

bot.callbackQuery('start_resubmit', async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  const userId = ctx.from.id;
  const lang = await getUserLang(userId);
  const t = STRINGS[lang];

  await clearPendingDepartment(userId);

  await ctx.reply(
    t.selectPlan,
    { parse_mode: 'Markdown', reply_markup: getPaymentTypeKeyboard(lang) }
  );
});

bot.callbackQuery(/^dept(reg|full)_(.+)$/, async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  const isFull = ctx.match[1] === 'full';
  const baseDept = ctx.match[2];
  const userId = ctx.from.id;
  const lang = await getUserLang(userId);
  const t = STRINGS[lang];

  const fullTaggedDept = isFull 
    ? `${baseDept} (4-Year Complete)`
    : `${baseDept} (Regular / Term)`;

  await setPendingDepartment(userId, fullTaggedDept);

  try {
    await ctx.editMessageText(
      t.sendReceiptPrompt.replace('{dept}', fullTaggedDept),
      { parse_mode: 'Markdown' }
    );
  } catch (e) {}
});

// COMMAND-BASED UPLOAD (/module Marketing Management | Title)
bot.command(['module', 'uploadmodule'], async (ctx) => {
  const authorized = await isStaff(ctx);
  if (!authorized) return;

  const staffGroupId = await getActiveStaffGroupId();
  if (!staffGroupId) {
    return ctx.reply("⚠️ Staff group configuration missing. Run /bind inside your staff group first.");
  }

  const doc = ctx.message.document || (ctx.message.reply_to_message && ctx.message.reply_to_message.document);
  if (!doc) {
    return ctx.reply(
      "⚠️ **Please attach or reply to a PDF document.**\n\n*Format:*\n`/module <Department> | <Module Title>`\n\n*Example:*\n`/module Marketing Management | Consumer Behavior 101`",
      { parse_mode: 'Markdown' }
    );
  }

  const rawText = ctx.message.caption || ctx.message.text || '';
  const textArgs = rawText.replace(/^\/(module|uploadmodule)/, '').trim();
  const parts = textArgs.split('|').map(s => s.trim());

  if (parts.length < 2 || !parts[0] || !parts[1]) {
    return ctx.reply(
      "⚠️ **Invalid Format!**\nPlease separate the department and title with a pipe (`|`).\n\n*Example:* `/module Accounting and finance | Financial Accounting I`",
      { parse_mode: 'Markdown' }
    );
  }

  const [dept, title] = parts;
  const staffUploader = ctx.from.username ? `@${ctx.from.username}` : `${ctx.from.first_name || 'Staff'}`;

  try {
    let vaultTopicId = await getOrCreateModulesVaultTopic(ctx, staffGroupId);

    const vaultCaption = `📚 **COURSE MODULE ARCHIVE**\n\n• **Department:** ${dept}\n• **Title:** ${title}\n• **Uploaded by:** ${staffUploader}\n• **File:** \`${doc.file_name || 'document.pdf'}\``;

    let vaultMsg;
    try {
      vaultMsg = await ctx.api.sendDocument(staffGroupId, doc.file_id, {
        message_thread_id: vaultTopicId,
        caption: vaultCaption,
        parse_mode: 'Markdown'
      });
    } catch (sendErr) {
      if (sendErr.description && sendErr.description.includes('thread not found')) {
        await pool.query('UPDATE group_settings SET modules_topic_id = NULL WHERE group_id = $1', [staffGroupId]);
        vaultTopicId = await getOrCreateModulesVaultTopic(ctx, staffGroupId);
        vaultMsg = await ctx.api.sendDocument(staffGroupId, doc.file_id, {
          message_thread_id: vaultTopicId,
          caption: vaultCaption,
          parse_mode: 'Markdown'
        });
      } else {
        throw sendErr;
      }
    }

    const savedFileId = vaultMsg.document.file_id;
    const insRes = await pool.query(
      "INSERT INTO department_modules (department, title, file_id, file_name) VALUES ($1, $2, $3, $4) RETURNING id",
      [dept, title, savedFileId, doc.file_name || `${title}.pdf`]
    );
    const newModId = insRes.rows[0].id;

    const isInsideVault = String(ctx.chat.id) === staffGroupId && ctx.message.message_thread_id === vaultTopicId;
    if (ctx.chat.type !== 'private' && !isInsideVault) {
      try {
        await ctx.deleteMessage();
        if (ctx.message.reply_to_message) {
          await ctx.api.deleteMessage(ctx.chat.id, ctx.message.reply_to_message.message_id);
        }
      } catch (delErr) {
        console.error("Auto-cleanup delete error:", delErr);
      }
    }

    const notifyKb = new InlineKeyboard()
      .text("📢 Notify Enrolled Students", `notify_mod_${newModId}`).row()
      .text("🔕 Silent Upload", "dismiss_mod_notify");

    if (ctx.chat.type === 'private') {
      await ctx.reply(
        `✅ **Successfully Stashed in Vault!**\n\n• **Department:** ${dept}\n• **Title:** ${title}\n\nWould you like to broadcast this release to enrolled students?`,
        { parse_mode: 'Markdown', reply_markup: notifyKb }
      );
    } else {
      await ctx.api.sendMessage(
        staffGroupId,
        `✅ Stashed new module for **${dept}** into Vault.\n\nNotify enrolled students now?`,
        { message_thread_id: vaultTopicId, parse_mode: 'Markdown', reply_markup: notifyKb }
      );
    }

  } catch (err) {
    console.error("Failed to stash module:", err);
    await ctx.reply(`❌ Failed to stash module: ${err.message}`);
  }
});

bot.callbackQuery(/^trans_(\d+)_(\d+)$/, async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  const userId = Number(ctx.match[1]);
  const topicId = Number(ctx.match[2]);

  try {
    await ctx.editMessageText("📂 **Select new department for transfer:**", {
      parse_mode: 'Markdown',
      reply_markup: getTransferKeyboard(userId, topicId)
    });
  } catch (e) {}
});

bot.callbackQuery(/^canceltrans_(\d+)_(\d+)$/, async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  const userId = Number(ctx.match[1]);
  const topicId = Number(ctx.match[2]);

  const ticketRes = await pool.query(
    'SELECT username, department FROM tickets WHERE user_id = $1 AND topic_id = $2 AND status = \'PENDING\' LIMIT 1',
    [userId, topicId]
  );

  if (ticketRes.rows.length === 0) {
    try {
      return ctx.editMessageText("⚠️ Ticket status changed or non-existent.");
    } catch (e) {
      return;
    }
  }

  const { username, department } = ticketRes.rows[0];

  const actionKeyboard = new InlineKeyboard()
    .text("✅ Approve", `app_${userId}_${topicId}`).row()
    .text("❌ Reject", `rej_${userId}_${topicId}`).row()
    .text("🔄 Transfer Dept", `trans_${userId}_${topicId}`);

  try {
    await ctx.editMessageText(
      `📥 New Submission\n• Student ID: ${userId}\n• Username: @${username || 'Unknown'}\n• Department: ${department}`,
      { reply_markup: actionKeyboard }
    );
  } catch (e) {}
});

bot.callbackQuery(/^tr_(\d+)_(\d+)_(mkt|biz|agri|ed|acc|log)$/, async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}

  const targetUserId = Number(ctx.match[1]);
  const originTopicId = Number(ctx.match[2]);
  const deptCode = ctx.match[3];
  const staffGroupId = await getActiveStaffGroupId();

  if (!staffGroupId) {
    return ctx.reply("⚠️ Staff group configuration missing. Run /bind in your staff group.");
  }

  const ticketRes = await pool.query(
    'SELECT topic_id, message_id, ticket_msg_id, username, department FROM tickets WHERE user_id = $1 AND topic_id = $2 AND status = \'PENDING\' ORDER BY updated_at DESC LIMIT 1',
    [targetUserId, originTopicId]
  );

  if (ticketRes.rows.length === 0) {
    try {
      return ctx.editMessageText("⚠️ This submission is no longer pending or has already been transferred.", { parse_mode: 'Markdown' });
    } catch (e) {
      return;
    }
  }

  const ticket = ticketRes.rows[0];
  const username = ticket.username || 'Unknown';
  const currentDept = ticket.department || '';

  let planSuffix = "(Regular / Term)";
  if (currentDept.includes("(4-Year Complete)")) {
    planSuffix = "(4-Year Complete)";
  }

  const baseDeptMap = {
    mkt: "Marketing Management",
    biz: "Business Management",
    agri: "Agribusiness and Value chain management",
    ed: "Educational planning and management",
    acc: "Accounting and finance",
    log: "Logistics and Supply chain management"
  };

  const newDeptTagged = `${baseDeptMap[deptCode]} ${planSuffix}`;
  const newTopicId = await getOrCreateDepartmentTopic(ctx, newDeptTagged, staffGroupId);

  try {
    const newForwardRes = await ctx.api.copyMessage(staffGroupId, staffGroupId, Number(ticket.message_id), {
      message_thread_id: newTopicId
    });

    const actionKeyboard = new InlineKeyboard()
      .text("✅ Approve", `app_${targetUserId}_${newTopicId}`).row()
      .text("❌ Reject", `rej_${targetUserId}_${newTopicId}`).row()
      .text("🔄 Transfer Dept", `trans_${targetUserId}_${newTopicId}`);

    const newTicketMsg = await ctx.api.sendMessage(
      staffGroupId,
      `📥 New Submission\n• Student ID: ${targetUserId}\n• Username: @${username}\n• Department: ${newDeptTagged}`,
      { message_thread_id: newTopicId, reply_markup: actionKeyboard }
    );

    await pool.query(`
      UPDATE tickets 
      SET department = $1, topic_id = $2, message_id = $3, ticket_msg_id = $4, updated_at = CURRENT_TIMESTAMP 
      WHERE user_id = $5 AND status = 'PENDING'
    `, [newDeptTagged, newTopicId, newForwardRes.message_id, newTicketMsg.message_id, targetUserId]);

    if (ticket.message_id) {
      try {
        await ctx.api.deleteMessage(staffGroupId, Number(ticket.message_id));
      } catch (e) {
        console.error("Could not delete old receipt media message:", e);
      }
    }

    if (ticket.ticket_msg_id) {
      try {
        await ctx.api.deleteMessage(staffGroupId, Number(ticket.ticket_msg_id));
      } catch (e) {
        console.error("Could not delete old action panel message:", e);
      }
    }

    try {
      const studentLang = await getUserLang(targetUserId);
      const t = STRINGS[studentLang];
      await ctx.api.sendMessage(
        targetUserId,
        t.deptUpdated.replace('{dept}', newDeptTagged),
        { parse_mode: 'Markdown' }
      );
    } catch (studentErr) {
      console.error("Could not send transfer notification to student:", studentErr);
    }

  } catch (e) {
    console.error("Error transferring message:", e);
  }
});

// MAIN MESSAGE HANDLER (CATCHES RECEIPTS AND INTERACTIVE MODULE UPLOADS)
bot.on('message', async (ctx) => {
  if (ctx.from && ctx.from.is_bot) return;
  if (ctx.message.text && ctx.message.text.startsWith('/')) return;

  const staffGroupId = await getActiveStaffGroupId();
  const isStaffGroup = staffGroupId && String(ctx.chat.id) === staffGroupId;
  const isPrivate = ctx.chat.type === 'private';
  const topicId = ctx.message.message_thread_id;

  // 1. CATCH INTERACTIVE STAFF MODULE UPLOAD (FROM PROMPT SCREENSHOT)
  let staffDept = await getStaffPendingModuleDept(ctx.from.id);
  
  if (!staffDept && ctx.message.reply_to_message && ctx.message.reply_to_message.text) {
    const match = ctx.message.reply_to_message.text.match(/Selected Department:\s*([^\n]+)/);
    if (match) staffDept = match[1].trim();
  }

  if (isStaffGroup && staffDept && ctx.message.document) {
    const doc = ctx.message.document;
    const moduleTitle = doc.file_name ? doc.file_name.replace(/\.pdf$/i, '') : 'Course Module';
    const staffUploader = ctx.from.username ? `@${ctx.from.username}` : `${ctx.from.first_name || 'Staff'}`;

    try {
      const vaultTopicId = await getOrCreateModulesVaultTopic(ctx, staffGroupId);

      const vaultCaption = `📚 **COURSE MODULE ARCHIVE**\n\n• **Department:** ${staffDept}\n• **Title:** ${moduleTitle}\n• **Uploaded by:** ${staffUploader}\n• **File:** \`${doc.file_name || 'document.pdf'}\``;

      const vaultMsg = await ctx.api.sendDocument(staffGroupId, doc.file_id, {
        message_thread_id: vaultTopicId,
        caption: vaultCaption,
        parse_mode: 'Markdown'
      });

      const insRes = await pool.query(
        "INSERT INTO department_modules (department, title, file_id, file_name) VALUES ($1, $2, $3, $4) RETURNING id",
        [staffDept, moduleTitle, vaultMsg.document.file_id, doc.file_name || `${moduleTitle}.pdf`]
      );
      const newModId = insRes.rows[0].id;

      await clearStaffPendingModuleDept(ctx.from.id);

      // Auto-delete loose PDF from this topic so the group stays clean
      try {
        await ctx.deleteMessage();
      } catch (delErr) {}

      const notifyKb = new InlineKeyboard()
        .text("📢 Notify Enrolled Students", `notify_mod_${newModId}`).row()
        .text("🔕 Silent Upload", "dismiss_mod_notify");

      return ctx.reply(
        `✅ **Module Stashed Successfully!**\n\n• **Department:** ${staffDept}\n• **Title:** ${moduleTitle}\n• Saved in **📚 [Course Modules Vault]**!\n\nNotify enrolled students now?`,
        { message_thread_id: topicId, parse_mode: 'Markdown', reply_markup: notifyKb }
      );
    } catch (err) {
      console.error("Error processing staff module upload:", err);
      return ctx.reply(`❌ Failed to upload module: ${err.message}`, { message_thread_id: topicId });
    }
  }

  // 2. REPLIES INSIDE STAFF GROUP (SEARCH OR BROADCAST)
  if (isStaffGroup && ctx.message.reply_to_message) {
    const originalMsg = ctx.message.reply_to_message;

    if (originalMsg.text && originalMsg.text.includes("Search Student Record")) {
      const query = ctx.message.text ? ctx.message.text.trim() : '';
      if (query) await performSearch(ctx, query, topicId);
      return;
    }

    if (originalMsg.text && originalMsg.text.includes("Send Student Announcement")) {
      const broadcastMsg = ctx.message.text ? ctx.message.text.trim() : '';
      if (broadcastMsg) await performBroadcast(ctx, topicId, broadcastMsg);
      return;
    }
  }

  // 3. STUDENT RECEIPT SUBMISSION
  if (isPrivate) {
    const userId = ctx.from.id;
    const lang = await getUserLang(userId);
    const t = STRINGS[lang];

    const activeCheck = await pool.query(
      "SELECT 1 FROM tickets WHERE user_id = $1 AND status = 'PENDING' LIMIT 1",
      [userId]
    );

    if (activeCheck.rows.length > 0) {
      return ctx.reply(t.pendingExists, { parse_mode: 'Markdown', reply_markup: getStudentKeyboard(lang, 'PENDING') });
    }

    const chosenDeptTagged = await getPendingDepartment(userId);
    if (!chosenDeptTagged) {
      const noDeptMsg = lang === 'am'
        ? "⚠️ **እባክዎን መጀመሪያ ትምህርት ክፍል ይምረጡ**\n\nየመክፈያ ዓይነትዎን እና ትምህርት ክፍልዎን ለመምረጥ ከታች ያለውን ቁልፍ ይጫኑ።"
        : "⚠️ **Please select your department first!**\n\nTap **Submit Payment** below to choose your payment plan and department before sending your receipt photo.";
      
      return ctx.reply(noDeptMsg, {
        parse_mode: 'Markdown',
        reply_markup: getStudentKeyboard(lang, null)
      });
    }

    const fileId = ctx.message.photo 
      ? ctx.message.photo[ctx.message.photo.length - 1].file_id 
      : (ctx.message.document ? ctx.message.document.file_id : null);

    if (!fileId) {
      await ctx.reply(t.noFileErr, { parse_mode: 'Markdown' });
      return;
    }

    if (!staffGroupId) {
      return ctx.reply("⚠️ System configuration incomplete: Staff group not registered. Please contact administration.");
    }

    const username = ctx.from.username || ctx.from.first_name || 'Unknown';

    try {
      const topicId = await getOrCreateDepartmentTopic(ctx, chosenDeptTagged, staffGroupId);

      const forwardRes = await ctx.api.copyMessage(staffGroupId, ctx.chat.id, ctx.message.message_id, {
        message_thread_id: topicId
      });
      const forwardedMsgId = forwardRes.message_id;

      const actionKeyboard = new InlineKeyboard()
        .text("✅ Approve", `app_${userId}_${topicId}`).row()
        .text("❌ Reject", `rej_${userId}_${topicId}`).row()
        .text("🔄 Transfer Dept", `trans_${userId}_${topicId}`);

      const sentTicketMsg = await ctx.api.sendMessage(
        staffGroupId,
        `📥 New Submission\n• Student ID: ${userId}\n• Username: @${username}\n• Department: ${chosenDeptTagged}`,
        { message_thread_id: topicId, reply_markup: actionKeyboard }
      );

      await clearPendingDepartment(userId);

      const studentPanelMsg = await ctx.reply(t.receiptReceived, { 
        parse_mode: 'Markdown',
        reply_markup: getStudentKeyboard(lang, 'PENDING')
      });

      await pool.query(`
        INSERT INTO tickets (user_id, username, receipt_file_id, topic_id, message_id, ticket_msg_id, panel_msg_id, department, status) 
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'PENDING')
      `, [userId, username, fileId, topicId, forwardedMsgId, sentTicketMsg.message_id, studentPanelMsg.message_id, chosenDeptTagged]);

    } catch (err) {
      console.error("Failed to forward receipt:", err);
      return ctx.reply(`❌ Error submitting receipt: ${err.message}`);
    }
  }
});

bot.callbackQuery(/^app_(\d+)_(\d+)$/, async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  const userId = Number(ctx.match[1]);
  const topicId = Number(ctx.match[2]);
  const staffName = `${ctx.from.first_name || ''} ${ctx.from.last_name || ''}`.trim() || `ID: ${ctx.from.id}`;
  const staffGroupId = await getActiveStaffGroupId();

  const updateRes = await pool.query(
    "UPDATE tickets SET status = 'APPROVED', processed_by = $1, updated_at = CURRENT_TIMESTAMP WHERE user_id = $2 AND status = 'PENDING' RETURNING department, username, panel_msg_id",
    [staffName, userId]
  );
  
  if (updateRes.rowCount === 0) {
    return ctx.reply("⚠️ Error: Could not find an active pending ticket record in the database for this user.", { message_thread_id: topicId });
  }

  const { department: deptTag, username, panel_msg_id } = updateRes.rows[0];
  const lang = await getUserLang(userId);
  const t = STRINGS[lang];

  if (panel_msg_id) {
    try {
      await ctx.api.editMessageReplyMarkup(userId, Number(panel_msg_id), {
        reply_markup: getStudentKeyboard(lang, 'APPROVED')
      });
    } catch (err) {
      console.error("Could not edit existing panel markup:", err);
    }
  }

  try {
    await ctx.api.sendMessage(userId, t.approvedMsg, {
      parse_mode: 'Markdown',
      reply_markup: getStudentKeyboard(lang, 'APPROVED')
    });
  } catch (err) {
    console.error("Could not send approval update to student:", err);
  }

  try {
    await ctx.editMessageText(
      `✅ Approved Submission\n• Student ID: ${userId}\n• Username: @${username || 'N/A'}\n• Department: ${deptTag}\n• Approved by: ${staffName}`,
      { parse_mode: 'Markdown' }
    );
  } catch (e) {}

  if (APPROVED_THREAD_ID && staffGroupId) {
    const sortedReport = await generateSummaryText('APPROVED');
    await ctx.api.sendMessage(staffGroupId, sortedReport, { message_thread_id: APPROVED_THREAD_ID, parse_mode: 'Markdown' });
  }
});

bot.callbackQuery(/^rej_(\d+)_(\d+)$/, async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  const userId = Number(ctx.match[1]);
  const topicId = Number(ctx.match[2]);

  try {
    await ctx.editMessageText("❌ **Select rejection reason:**", {
      parse_mode: 'Markdown',
      reply_markup: getRejectionReasonKeyboard(userId, topicId)
    });
  } catch (e) {}
});

bot.callbackQuery(/^confirmrej_(\d+)_(\d+)_(.+)$/, async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  const userId = Number(ctx.match[1]);
  const topicId = Number(ctx.match[2]);
  const reasonCode = ctx.match[3];
  const staffName = `${ctx.from.first_name || ''} ${ctx.from.last_name || ''}`.trim() || `ID: ${ctx.from.id}`;
  const staffGroupId = await getActiveStaffGroupId();

  const lang = await getUserLang(userId);
  const t = STRINGS[lang];

  const reasonObj = REJECTION_REASONS.find(r => r.code === reasonCode);
  const reasonText = reasonObj ? reasonObj.label : "Receipt details unverified";
  const customMessage = reasonObj ? (lang === 'am' ? reasonObj.message_am : reasonObj.message_en) : "Please re-upload a valid payment receipt.";

  const updateRes = await pool.query(
    `UPDATE tickets 
     SET status = 'REJECTED', rejection_reason = $1, processed_by = $2, updated_at = CURRENT_TIMESTAMP 
     WHERE user_id = $3 AND status = 'PENDING' RETURNING panel_msg_id`,
    [reasonText, staffName, userId]
  );

  if (updateRes.rowCount === 0) {
    return ctx.reply("⚠️ Error: Could not find an active pending ticket record for this user.", { message_thread_id: topicId });
  }

  const { panel_msg_id } = updateRes.rows[0];

  if (panel_msg_id) {
    try {
      await ctx.api.editMessageReplyMarkup(userId, Number(panel_msg_id), {
        reply_markup: getStudentKeyboard(lang, 'REJECTED')
      });
    } catch (err) {
      console.error("Could not edit panel markup on rejection:", err);
    }
  }

  const resubmitKeyboard = new InlineKeyboard().text(t.reuploadBtn, "start_resubmit");

  await ctx.api.sendMessage(
    userId,
    t.rejectedMsg.replace('{reason}', reasonText).replace('{message}', customMessage),
    { parse_mode: 'Markdown', reply_markup: resubmitKeyboard }
  );

  try {
    await ctx.editMessageText(`❌ Receipt rejected by **${staffName}**.\n**Reason:** ${reasonText}`, { parse_mode: 'Markdown' });
  } catch (e) {}

  if (REJECTED_THREAD_ID && staffGroupId) {
    await ctx.api.sendMessage(
      staffGroupId,
      `❌ **REJECTED RECEIPT**\n• Student ID: \`${userId}\`\n• Staff: **${staffName}**\n• Reason: ${reasonText}`,
      { message_thread_id: REJECTED_THREAD_ID, parse_mode: 'Markdown' }
    );
  }
});

cron.schedule('0 8 * * *', async () => {
  try {
    const staffGroupId = await getActiveStaffGroupId();
    if (!staffGroupId) return;

    const appSummary = await generateSummaryText('APPROVED');
    const rejSummary = await generateSummaryText('REJECTED');
    
    const pendingRes = await pool.query("SELECT COUNT(*) FROM tickets WHERE status = 'PENDING'");
    const totalPending = pendingRes.rows[0].count;

    const dailyReport = `🌅 **DAILY TUITION PORTAL SUMMARY**\n\n⏳ **Total Pending:** ${totalPending}\n\n---\n\n${appSummary}\n\n---\n\n${rejSummary}`;

    await bot.api.sendMessage(staffGroupId, dailyReport, { message_thread_id: APPROVED_THREAD_ID || null });
  } catch (err) {
    console.error("Error generating daily summary cron report:", err);
  }
});

app.use('/webhook', webhookCallback(bot, 'express'));

app.get('/', (req, res) => {
  res.send('Tuition Receipt Bot is active');
});

async function main() {
  await initDB();

  try {
    await bot.api.deleteMyCommands();
    await bot.api.deleteMyCommands({ scope: { type: 'all_private_chats' } });
    await bot.api.deleteMyCommands({ scope: { type: 'all_group_chats' } });

    await bot.api.setMyCommands([
      { command: 'start', description: 'Start payment receipt submission' },
      { command: 'panel', description: 'Open interactive action panel' },
      { command: 'bind', description: 'Bind current group as staff panel (Admins only)' },
      { command: 'changedept', description: 'Change approved student department (Staff only)' },
      { command: 'deletemodule', description: 'Delete course module from database (Staff only)' },
      { command: 'approved', description: 'View approved students directory (Staff only)' }
    ]);
  } catch (cmdErr) {
    console.error("Failed to register bot commands:", cmdErr.message);
  }

  const RENDER_EXTERNAL_URL = process.env.RENDER_EXTERNAL_URL; 
  if (RENDER_EXTERNAL_URL) {
    const webhookUrl = `${RENDER_EXTERNAL_URL}/webhook`;
    await bot.api.setWebhook(webhookUrl, { drop_pending_updates: true });
    console.log(`Webhook successfully bound to: ${webhookUrl}`);
  }

  app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
  });
}

main();
