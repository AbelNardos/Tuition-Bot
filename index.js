require('dotenv').config();
const express = require('express');
const { Bot, InlineKeyboard, InputFile, webhookCallback } = require('grammy');
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const https = require('https');
const cron = require('node-cron');
const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');

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

// HTML Escaper for Telegram Messages
function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// PDF Safe Text Cleaner (Strips emojis & unsupported chars to prevent crashes)
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

  try { await pool.query(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS panel_msg_id BIGINT;`); } catch (err) {}
  try { await pool.query(`ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS pending_department TEXT;`); } catch (err) {}
  try { await pool.query(`ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS pending_module_dept TEXT;`); } catch (err) {}
  try { await pool.query(`ALTER TABLE group_settings ADD COLUMN IF NOT EXISTS modules_topic_id BIGINT;`); } catch (err) {}
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
    portalWelcome: "👋 <b>Welcome to Renaissance Global Student Portal</b>\n━━━━━━━━━━━━━━━━━━━━\n\n🎯 <b>Quick Guide:</b>\n1️⃣ Select your payment type & department\n2️⃣ Upload a clear photo of your receipt\n3️⃣ Receive your official approval slip instantly upon verification!\n\n<i>Select an option below to begin:</i>",
    selectPlan: "💳 <b>Step 1 of 2: Select Payment Type</b>\n\n<i>Please choose your payment plan:</i>",
    selectDept: "📚 <b>Step 2 of 2: Select Your Department</b>\n\n<i>Please select your academic department below:</i>",
    receiptReceived: "✅ Your receipt has been successfully submitted and placed in the review queue.\n\n<i>Track its progress anytime using 'Check Status'.</i>",
    sendReceiptPrompt: "✅ Selected Department: <b>{dept}</b>\n━━━━━━━━━━━━━━━━━━━━\n\n📸 <b>Next Step:</b> Please send your receipt photo or screenshot.\n\n<i>Note: Ensure the transaction details are clear and readable.</i>",
    reuploadPrompt: "🔄 <b>Re-submitting Receipt</b>\n\n<i>Please choose your payment plan to initiate a new submission:</i>",
    approvedMsg: "✅ <b>Receipt Verified & Approved!</b>\n\n🎉 Your payment has been successfully cleared by our finance team.",
    rejectedMsg: "❌ <b>RECEIPT NEEDS ATTENTION</b>\n━━━━━━━━━━━━━━━━━━━━\n<blockquote><b>Reason:</b> {reason}\n\n{message}</blockquote>\n\n<i>Please re-upload a correct receipt to proceed.</i>",
    reuploadBtn: "🔄 Re-upload Receipt",
    noFileErr: "⚠️ <b>Invalid Format:</b> Please send an actual <b>photo or screenshot</b> of your payment receipt. Text-only messages cannot be processed.",
    deptUpdated: "🔄 <b>Department Updated</b>\nYour receipt submission has been safely transferred to <b>{dept}</b>.",
    pendingExists: "⚠️ <b>Active Submission Pending</b>\n\nYou already have a receipt under review. Please wait for verification.",
    helpText: "❓ <b>Need Assistance?</b>\n\nIf you have issues regarding your tuition payments or department registration, please contact the registrar office directly."
  },
  am: {
    portalWelcome: "👋 <b>እንኳን ወደ ሬነሳንስ ግሎባል የተማሪዎች ፖርታል በሰላም መጡ</b>\n━━━━━━━━━━━━━━━━━━━━\n\n🎯 <b>ፈጣን መመሪያ:</b>\n1️⃣ የክፍያ ዓይነትዎን እና ትምህርት ክፍልዎን ይምረጡ\n2️⃣ ግልጽ የሆነ የክፍያ ደረሰኝ ፎቶ ይላኩ\n3️⃣ ሲረጋገጥ ይፋዊ ማረጋገጫ ፒዲኤፍዎን ወዲያውኑ ይቀበሉ!\n\n<i>ለመጀመር ከታች ካሉት አማራጮች አንዱን ይምረጡ፡</i>",
    selectPlan: "💳 <b>ደረጃ 1 ከ 2፡ የክፍያ ዓይነት ይምረጡ</b>\n\n<i>እባክዎን የክፍያ መጠን ዓይነትዎን ይምረጡ፡</i>",
    selectDept: "📚 <b>ደረጃ 2 ከ 2፡ ትምህርት ክፍልዎን ይምረጡ</b>\n\n<i>እባክዎን ትምህርት ክፍልዎን ከታች ካሉት ይምረጡ፡</i>",
    receiptReceived: "✅ ደረሰኝዎ በትክክል ተልኳል።\n\n<i>'የደረሰኙን ሁኔታ ያረጋግጡ' የሚለውን በመጫን ሂደቱን መከታተል ይችላሉ።</i>",
    sendReceiptPrompt: "✅ የተመረጠው ትምህርት ክፍል፡ <b>{dept}</b>\n━━━━━━━━━━━━━━━━━━━━\n\n📸 <b>ቀጣይ እርምጃ:</b> እባክዎን የክፍያ ደረሰኝ ፎቶዎን ይላኩ።\n\n<i>ማሳሰቢያ፡ ፎቶው ግልጽ መሆኑን ያረጋግጡ።</i>",
    reuploadPrompt: "🔄 <b>ደረሰኝ እንደገና መላክ</b>\n\n<i>እባክዎን አዲስ ማመልከቻ ለመጀመር የክፍያ ዓይነትዎን ይምረጡ፡</i>",
    approvedMsg: "✅ <b>ደረሰኝዎ ተረጋግጦ ጸድቋል!</b>\n\n🎉 የክፍያ ማረጋገጫዎ በገንዘብ ያዥ ቡድኑ ተፈቅዷል።",
    rejectedMsg: "❌ <b>ደረሰኝዎ ማስተካከያ ይፈልጋል</b>\n━━━━━━━━━━━━━━━━━━━━\n<blockquote><b>ምክንያት:</b> {reason}\n\n{message}</blockquote>\n\n<i>እባክዎን ትክክለኛውን ደረሰኝ እንደገና ይላኩ።</i>",
    reuploadBtn: "🔄 ደረሰኝ እንደገና ስቀል",
    noFileErr: "⚠️ <b>የተሳሳተ መረጃ:</b> እባክዎን ትክክለኛ የክፍያ ደረሰኝ <b>ፎቶ ወይም ስክሪንሾት</b> ይላኩ። በጽሁፍ ብቻ የሚላክ መረጃ አይቀበልም።",
    deptUpdated: "🔄 <b>ትምህርት ክፍል ተቀይሯል</b>\nየደረሰኝ ማመልከቻዎ ወደ <b>{dept}</b> ተዛውሯል።",
    pendingExists: "⚠️ <b>አሁንም በሂደት ላይ ያለ ማመልከቻ አለ</b>\n\nቀደም ሲል የላኩት ደረሰኝ በመገምገም ላይ ይገኛል።",
    helpText: "❓ <b>እርዳታ ይፈልጋሉ?</b>\n\nበትምህርት ክፍያ ወይም በትምህርት ክፍል ምዝገባ ላይ ችግር ካለዎት፣ እባክዎን የሬጅስትራር ቢሮውን ያነጋግሩ።"
  }
};

const REJECTION_REASONS = [
  { label: "📷 Blurry/Unreadable Receipt", code: "blurry", message_en: "Please ensure your receipt image is clear, fully visible, and uncropped.", message_am: "እባክዎን የደረሰኝዎ ፎቶ ግልጽ እና ሙሉ በሙሉ የሚታይ መሆኑን አረጋግተው እንደገና ይላኩ።" },
  { label: "💵 Incorrect Amount Paid", code: "amount", message_en: "The payment amount does not match your required tuition fees.", message_am: "የተከፈለው የገንዘብ መጠን ከተፈለገው የትምህርት ክፍያ ጋር አይመሳሰልም።" },
  { label: "🚫 Invalid/Fake Receipt", code: "invalid", message_en: "Please submit an official bank transaction receipt.", message_am: "ይህ ደረሰኝ ሊረጋገጥ አልቻለም። እባክዎን ኦፊሴላዊ የባንክ ደረሰኝ ይላኩ።" },
  { label: "👤 Name/ID Mismatch", code: "mismatch", message_en: "The name or Student ID on the receipt does not match your profile details.", message_am: "በደረሰኙ ላይ ያለው ስም ወይም የተማሪ መታወቂያ ከተመዘገበው መረጃ ጋር አይመሳሰልም።" }
];

function getPaymentTypeKeyboard(lang = 'en') {
  if (lang === 'am') {
    return new InlineKeyboard().text("💳 መደበኛ (Regular)", "paytype_reg").row().text("🎓 የ 4 ዓመት (Complete)", "paytype_full");
  }
  return new InlineKeyboard().text("💳 Regular Term", "paytype_reg").row().text("🎓 4-Year Complete", "paytype_full");
}

function getDepartmentKeyboard(planType = 'reg') {
  const p = planType === 'full' ? 'deptfull_' : 'deptreg_';
  return new InlineKeyboard()
    .text("📈 Marketing", `${p}Marketing Management`).text("💼 Business", `${p}Business Management`).row()
    .text("📊 Accounting & Finance", `${p}Accounting and finance`).row()
    .text("🌾 Agribusiness & VCM", `${p}Agribusiness and Value chain management`).row()
    .text("📚 Ed. Planning & Mgmt", `${p}Educational planning and management`).row()
    .text("🚚 Logistics & SCM", `${p}Logistics and Supply chain management`);
}

function getStaffKeyboard() {
  return new InlineKeyboard()
    .text('🔍 Search Record', 'cmd_lookfor').text('👥 Approved Roster', 'cmd_approved_roster').row()
    .text('📚 Upload Module', 'cmd_upload_module').text('🗑 Delete Module', 'cmd_delete_module').row()
    .text('🔄 Change Dept', 'cmd_panel_changedept').text('⚠️ Revoke Approval', 'cmd_panel_revoke').row()
    .text('📊 Stats Summary', 'cmd_stats').text('📈 Module Analytics', 'cmd_mod_analytics').row()
    .text('📄 Export CSV', 'cmd_export').text('📢 Broadcast Alert', 'cmd_broadcast');
}

function getModuleDepartmentKeyboard() {
  return new InlineKeyboard()
    .text("📈 Marketing", "moddept_Marketing Management").text("💼 Business", "moddept_Business Management").row()
    .text("📊 Accounting & Finance", "moddept_Accounting and finance").row()
    .text("🌾 Agribusiness & VCM", "moddept_Agribusiness and Value chain management").row()
    .text("📚 Ed. Planning & Mgmt", "moddept_Educational planning and management").row()
    .text("🚚 Logistics & SCM", "moddept_Logistics and Supply chain management").row()
    .text("🔙 Cancel", "moddept_cancel");
}

function getDeleteModuleDepartmentKeyboard() {
  return new InlineKeyboard()
    .text("📈 Marketing", "delmoddept_Marketing Management").text("💼 Business", "delmoddept_Business Management").row()
    .text("📊 Accounting & Finance", "delmoddept_Accounting and finance").row()
    .text("🌾 Agribusiness & VCM", "delmoddept_Agribusiness and Value chain management").row()
    .text("📚 Ed. Planning & Mgmt", "delmoddept_Educational planning and management").row()
    .text("🚚 Logistics & SCM", "delmoddept_Logistics and Supply chain management").row()
    .text("🔙 Cancel", "delmoddept_cancel");
}

function getApprovedRosterKeyboard() {
  return new InlineKeyboard()
    .text("🌐 Every Student (All Depts)", "roster_all").row()
    .text("📈 Marketing", "roster_Marketing Management").text("💼 Business", "roster_Business Management").row()
    .text("📊 Accounting & Finance", "roster_Accounting and finance").row()
    .text("🌾 Agribusiness & VCM", "roster_Agribusiness and Value chain management").row()
    .text("📚 Ed. Planning & Mgmt", "roster_Educational planning and management").row()
    .text("🚚 Logistics & SCM", "roster_Logistics and Supply chain management").row()
    .text("🔙 Cancel", "roster_cancel");
}

function getStudentKeyboard(lang = 'en', status = null) {
  const kb = new InlineKeyboard();
  const isAm = lang === 'am';

  if (status === 'PENDING') kb.text(isAm ? '⏳ በግምገማ ላይ' : '⏳ Under Review', 'cmd_pending_info');
  else if (status === 'APPROVED') kb.text(isAm ? '⬇️ ደረሰኝ አውርድ' : '⬇️ Download Slip', 'cmd_download_pdf');
  else kb.text(isAm ? '📤 ደረሰኝ አስገባ' : '📤 Submit Payment', 'cmd_submit');

  kb.text(isAm ? '📌 ሁኔታውን እይ' : '📌 Check Status', 'cmd_status').row();
  kb.text(isAm ? '📚 የትምህርት ሞጁሎች' : '📚 Course Modules', 'cmd_modules').row();
  kb.text(isAm ? '📜 የክፍያ ታሪክ' : '📜 My History', 'cmd_history').text(isAm ? '❓ እገዛ' : '❓ Support', 'cmd_help');

  return kb;
}

function getTransferKeyboard(userId, topicId) {
  return new InlineKeyboard()
    .text("📈 Marketing", `tr_${userId}_${topicId}_mkt`).text("💼 Business", `tr_${userId}_${topicId}_biz`).row()
    .text("🌾 Agribusiness", `tr_${userId}_${topicId}_agri`).text("📚 Ed. Planning", `tr_${userId}_${topicId}_ed`).row()
    .text("📊 Accounting", `tr_${userId}_${topicId}_acc`).text("🚚 Logistics", `tr_${userId}_${topicId}_log`).row()
    .text("🔙 Cancel Transfer", `canceltrans_${userId}_${topicId}`);
}

function getRejectionReasonKeyboard(userId, topicId) {
  const kb = new InlineKeyboard();
  REJECTION_REASONS.forEach((r) => kb.text(r.label, `confirmrej_${userId}_${topicId}_${r.code}`).row());
  return kb;
}
// PDF Safe Text Cleaner (Strips emojis & unsupported chars to prevent crashes)
function cleanForPDF(str) {
  if (!str) return '';
  // Removes any non-standard ASCII characters (like emojis) so PDFKit doesn't crash
  return String(str).replace(/[^\x00-\x7F]/g, '').trim();
}

// GENERATE APPROVAL PDF WITH LOGO, WEBSITE, AND BOTTOM QR CODE
async function generateApprovalPDF(userId, username, department, staffName, botUsername, lang = 'en') {
  return new Promise(async (resolve, reject) => {
    try {
      const doc = new PDFDocument({ margin: 50, size: 'A4' });
      const filePath = path.join(__dirname, `approval_slip_${userId}.pdf`);
      const stream = fs.createWriteStream(filePath);
      doc.pipe(stream);

      // Clean variables for PDF compatibility
      const safeUsername = cleanForPDF(username || 'N/A');
      const safeStaff = cleanForPDF(staffName || 'Finance Team');
      const safeDept = cleanForPDF(department);

      // 1. ADD LOGO (Checks if logo.png or logo.jpg exists in folder)
      const logoPng = path.join(__dirname, 'logo.png');
      const logoJpg = path.join(__dirname, 'logo.jpg');
      let logoPath = null;
      if (fs.existsSync(logoPng)) logoPath = logoPng;
      else if (fs.existsSync(logoJpg)) logoPath = logoJpg;

      if (logoPath) {
        // Center the logo (A4 width is 595.28, logo width 120 -> X = 237.64)
        doc.image(logoPath, (doc.page.width - 120) / 2, 40, { width: 120 });
        doc.moveDown(6); 
      } else {
        doc.moveDown(3);
      }

      // 2. HEADER & WEBSITE
      doc.font('Helvetica-Bold').fontSize(22).text('RENAISSANCE GLOBAL', { align: 'center' });
      doc.font('Helvetica').fontSize(11).text('College of Open & Virtual Learning', { align: 'center' });
      doc.fillColor('#0056b3').text('http://reguovle.edu.et/', { align: 'center', link: 'http://reguovle.edu.et/' });
      doc.moveDown(2);

      doc.fillColor('#000000').font('Helvetica-Bold').fontSize(16).text('OFFICIAL TUITION VERIFICATION SLIP', { align: 'center' });
      doc.moveDown(2);

      // 3. STUDENT & RECEIPT DETAILS (Centered)
      doc.font('Helvetica').fontSize(13).lineGap(8);
      doc.text(`Student ID: ${userId}`, { align: 'center' });
      doc.text(`Username: @${safeUsername}`, { align: 'center' });
      doc.text(`Department: ${safeDept}`, { align: 'center' });
      
      doc.moveDown(1);
      doc.font('Helvetica-Bold').fillColor('#28a745').text(`STATUS: APPROVED & CLEARED`, { align: 'center' });
      doc.fillColor('#000000').font('Helvetica');
      doc.text(`Processed By: ${safeStaff}`, { align: 'center' });
      
      // Adapt date format based on user language preference
      const issueDate = lang === 'am' 
        ? new Date().toLocaleDateString('am-ET', { year: 'numeric', month: 'long', day: 'numeric' }) 
        : new Date().toLocaleString();
      doc.text(`Issue Date: ${issueDate}`, { align: 'center' });
      
      doc.moveDown(3);

      // 4. GENERATE & EMBED QR CODE AT THE BOTTOM CENTER
      const qrData = botUsername ? `https://t.me/${botUsername}?start=verify_${userId}` : `RENAISSANCE_GLOBAL_VERIFY:${userId}`;
      const qrBuffer = await QRCode.toBuffer(qrData, { width: 120, margin: 1 });
      
      const qrX = (doc.page.width - 120) / 2;
      doc.image(qrBuffer, qrX, doc.y);
      doc.moveDown(9);

      // 5. FOOTER TEXT
      doc.fontSize(9).fillColor('#555555').text('Scan the QR code with any camera to verify the live clearance status of this student directly through the official Telegram portal.', { align: 'center' });
      doc.moveDown(1);
      doc.fontSize(8).text('Any alterations or unauthorized reproductions invalidate this document.', { align: 'center' });

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

  const newTopic = await ctx.api.createForumTopic(targetGroupId, '📚 [Course Modules Vault]');
  const topicId = newTopic.message_thread_id;
  await pool.query('UPDATE group_settings SET modules_topic_id = $1 WHERE group_id = $2', [topicId, targetGroupId]);
  return topicId;
}

async function generateSummaryText(statusType) {
  const res = await pool.query(`SELECT department, COUNT(*) as count FROM tickets WHERE status = $1 GROUP BY department ORDER BY department ASC`, [statusType]);
  const icon = statusType === 'APPROVED' ? '✅' : '❌';
  let text = `📊 <b>${icon} ${statusType} RECEIPTS SUMMARY</b>\n\n`;
  if (res.rows.length === 0) return text + `<i>No ${statusType.toLowerCase()} receipts recorded yet.</i>`;
  res.rows.forEach(r => text += `• <b>${escapeHtml(r.department)}</b>: ${r.count} student(s)\n`);
  return text;
}

async function sendCSVExport(staffGroupId, threadId, captionText) {
  try {
    const res = await pool.query(`SELECT user_id, username, department, status, rejection_reason, processed_by, created_at, updated_at FROM tickets ORDER BY department ASC, status ASC, updated_at DESC`);
    if (res.rows.length === 0) return bot.api.sendMessage(staffGroupId, "⚠️ No receipts found to export.", { message_thread_id: threadId });
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
    await bot.api.sendMessage(staffGroupId, `❌ Export error: ${err.message}`, { message_thread_id: threadId });
  }
}

async function performSearch(ctx, query, topicId) {
  const cleanQuery = query.replace(/^@/, '');
  const res = await pool.query(`SELECT user_id, username, department, status, rejection_reason, processed_by, created_at, updated_at FROM tickets WHERE user_id::text = $1 OR LOWER(username) = LOWER($1) OR LOWER(department) LIKE LOWER($2) ORDER BY updated_at DESC LIMIT 10`, [cleanQuery, `%${cleanQuery}%`]);

  if (res.rows.length === 0) return ctx.reply(`🔍 No receipts found matching: <b>${escapeHtml(query)}</b>`, { message_thread_id: topicId, parse_mode: 'HTML' });

  let text = `🔍 <b>SEARCH RESULTS FOR:</b> <code>${escapeHtml(query)}</code> (${res.rows.length})\n━━━━━━━━━━━━━━━━━━━━\n\n`;
  res.rows.forEach((r, idx) => {
    let statusEmoji = r.status === 'APPROVED' ? "✅" : (r.status === 'REJECTED' ? "❌" : "⏳");
    const uname = r.username ? `@${r.username}` : "N/A";
    const staff = r.processed_by ? ` (Staff: ${escapeHtml(r.processed_by)})` : "";
    
    text += `${idx + 1}. ${statusEmoji} <b>${escapeHtml(r.department)}</b>\n   • ID: <code>${r.user_id}</code> (${escapeHtml(uname)})\n   • Status: <b>${r.status}</b>${staff}\n   • Updated: ${new Date(r.updated_at).toLocaleDateString()}\n\n`;
  });
  await ctx.reply(text, { message_thread_id: topicId, parse_mode: 'HTML' });
}

async function performBroadcast(ctx, topicId, broadcastMsg) {
  if (!broadcastMsg) return ctx.reply("⚠️ Broadcast text cannot be empty.", { message_thread_id: topicId });
  const usersRes = await pool.query('SELECT DISTINCT user_id FROM tickets');
  let successCount = 0;
  await ctx.reply(`📢 Starting broadcast to ${usersRes.rows.length} students...`, { message_thread_id: topicId });

  for (const row of usersRes.rows) {
    try {
      await bot.api.sendMessage(row.user_id, `📢 <b>ANNOUNCEMENT / ማስታወቂያ</b>\n━━━━━━━━━━━━━━━━━━━━\n\n${escapeHtml(broadcastMsg)}`, { parse_mode: 'HTML' });
      successCount++;
    } catch (err) {}
  }
  await ctx.reply(`✅ <b>Broadcast Complete</b>\n• Delivered successfully: ${successCount} students`, { message_thread_id: topicId, parse_mode: 'HTML' });
}

bot.command('bind', async (ctx) => {
  if (ctx.chat.type === 'private') return ctx.reply("⚠️ This command must be executed inside a supergroup with topics enabled.");
  try {
    const member = await ctx.getChatMember(ctx.from.id);
    if (!['administrator', 'creator'].includes(member.status)) return ctx.reply("❌ Only group administrators can bind this group.");
  } catch (err) {}
  const groupId = String(ctx.chat.id);
  await pool.query(`INSERT INTO group_settings (group_id, is_active) VALUES ($1, TRUE) ON CONFLICT (group_id) DO UPDATE SET is_active = TRUE, updated_at = CURRENT_TIMESTAMP`, [groupId]);
  await ctx.reply("✅ <b>Group Bound Successfully!</b>\n\nThis group is now registered as the active Staff Panel.", { parse_mode: 'HTML' });
});
// STUDENT /start COMMAND
bot.command('start', async (ctx) => {
  // Live camera scan verification
  if (ctx.match && typeof ctx.match === 'string' && ctx.match.startsWith('verify_')) {
    const verifyId = ctx.match.replace('verify_', '').trim();
    const check = await pool.query("SELECT department, status, rejection_reason, updated_at FROM tickets WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 1", [verifyId]);

    if (check.rows.length === 0) return ctx.reply(`⚠️ No official registration record found for Student ID: <code>${verifyId}</code>`, { parse_mode: 'HTML' });
    const rec = check.rows[0];
    if (rec.status === 'APPROVED') {
      return ctx.reply(`✅ <b>OFFICIAL TUITION CLEARANCE: VALID</b>\n━━━━━━━━━━━━━━━━━━━━\n• <b>Student ID:</b> <code>${verifyId}</code>\n• <b>Department:</b> ${escapeHtml(rec.department)}\n• <b>Status:</b> APPROVED & CLEARED\n• <b>Date:</b> ${new Date(rec.updated_at).toLocaleDateString()}\n\n<i>This student is officially cleared for campus entry and examinations.</i>`, { parse_mode: 'HTML' });
    } else {
      return ctx.reply(`🚨 <b>OFFICIAL VERIFICATION: INVALID / VOIDED SLIP</b>\n━━━━━━━━━━━━━━━━━━━━\n• <b>Student ID:</b> <code>${verifyId}</code>\n• <b>Department:</b> ${escapeHtml(rec.department)}\n• <b>Status:</b> ❌ ${rec.status}\n\n<blockquote>⚠️ <b>WARNING:</b> This slip has been revoked or rejected by administration. Do not accept this document!</blockquote>`, { parse_mode: 'HTML' });
    }
  }

  if (ctx.chat.type === 'private') {
    await clearPendingDepartment(ctx.from.id);
    const langKb = new InlineKeyboard().text("🇬🇧 English", "lang_en").text("🇪🇹 አማርኛ", "lang_am");
    await ctx.reply("🌐 <b>Please select your language / እባክዎን ቋንቋ ይምረጡ:</b>", { parse_mode: 'HTML', reply_markup: langKb });
  }
});

// UNIVERSAL STAFF /panel (WORKS IN BOTH SUPERGROUP & PRIVATE DM)
bot.command('panel', async (ctx) => {
  const authorized = await isStaff(ctx);
  if (!authorized && ctx.chat.type !== 'private') return;

  if (authorized) {
    const topicId = ctx.message?.message_thread_id;
    return ctx.reply(
      "⚙️ <b>RENAISSANCE GLOBAL — STAFF ACTION PANEL</b>\n━━━━━━━━━━━━━━━━━━━━\n\n<i>Select an action below:</i>",
      { message_thread_id: topicId, parse_mode: 'HTML', reply_markup: getStaffKeyboard() }
    );
  }

  const userId = ctx.from.id;
  const lang = await getUserLang(userId);
  await ctx.reply(
    STRINGS[lang].portalWelcome,
    { parse_mode: 'HTML', reply_markup: getStudentKeyboard(lang, null) }
  );
});

// /revoke COMMAND & PANEL HANDLERS (REVERSES ACCIDENTAL APPROVALS)
async function executeRevoke(ctx, targetUserId, topicId) {
  const staffName = `${ctx.from.first_name || ''} ${ctx.from.last_name || ''}`.trim() || `Staff`;
  const updateRes = await pool.query(
    `UPDATE tickets SET status = 'REJECTED', rejection_reason = 'Approval revoked by administration (Verification error / Audit mismatch)', processed_by = $1, updated_at = CURRENT_TIMESTAMP 
     WHERE id = (SELECT id FROM tickets WHERE user_id = $2 AND status = 'APPROVED' ORDER BY updated_at DESC LIMIT 1) RETURNING department, panel_msg_id`,
    [staffName, targetUserId]
  );

  if (updateRes.rowCount === 0) return ctx.reply(`⚠️ No approved record found to revoke for Student ID: <code>${targetUserId}</code>.`, { message_thread_id: topicId, parse_mode: 'HTML' });
  
  const { department, panel_msg_id } = updateRes.rows[0];
  const studentLang = await getUserLang(targetUserId);

  if (panel_msg_id) {
    try { await ctx.api.editMessageReplyMarkup(targetUserId, Number(panel_msg_id), { reply_markup: getStudentKeyboard(studentLang, 'REJECTED') }); } catch (e) {}
  }

  const notifMsg = studentLang === 'am'
    ? `⚠️ <b>የውሳኔ ማስተካከያ ማሳሰቢያ</b>\n\nውድ ተማሪ፣ ለ<b>${escapeHtml(department)}</b> የተሰጠው የክፍያ ማረጋገጫ በስህተት በመጽደቁ ምክንያት ውድቅ ተደርጓል።\n\n❌ <b>ሁኔታ:</b> ውድቅ ተደርጓል (Revoked)\n<blockquote>📌 <b>ማሳሰቢያ:</b> ቀደም ሲል ያወረዱት ፒዲኤፍ ደረሰኝ በፈተና ወቅት ተቀባይነት የለውም።</blockquote>\n\n<i>እባክዎን ትክክለኛውን ደረሰኝ እንደገና ይላኩ።</i>`
    : `⚠️ <b>NOTICE OF APPROVAL REVOCATION</b>\n\nDear Student,\nYour tuition approval for <b>${escapeHtml(department)}</b> has been revoked by administration due to an audit check / issued in error.\n\n❌ <b>Status:</b> REVOKED / REJECTED\n<blockquote>📌 <b>Warning:</b> Any previously printed or downloaded slip is now officially VOID.</blockquote>\n\n<i>Please re-upload your valid bank receipt below:</i>`;

  const resubmitKb = new InlineKeyboard().text(STRINGS[studentLang].reuploadBtn, "start_resubmit");
  try { await ctx.api.sendMessage(targetUserId, notifMsg, { parse_mode: 'HTML', reply_markup: resubmitKb }); } catch (e) {}

  await ctx.reply(`✅ <b>Approval Revoked!</b>\n━━━━━━━━━━━━━━━━━━━━\n• <b>Student ID:</b> <code>${targetUserId}</code>\n• <b>Department:</b> ${escapeHtml(department)}\n• <b>Revoked by:</b> ${escapeHtml(staffName)}\n\n<i>Student notified, modules locked, and QR verification voided.</i>`, { message_thread_id: topicId, parse_mode: 'HTML' });
}

bot.command('revoke', async (ctx) => {
  if (!(await isStaff(ctx))) return;
  const topicId = ctx.message.message_thread_id;
  let targetIdStr = ctx.message.text.replace(/^\/revoke/, '').trim();
  if (!targetIdStr && ctx.message.reply_to_message?.text) {
    const match = ctx.message.reply_to_message.text.match(/Student ID:\s*`?(\d+)`?/i) || ctx.message.reply_to_message.text.match(/ID:\s*<code.*?>(\d+)<\/code>/i) || ctx.message.reply_to_message.text.match(/Student ID: (\d+)/i);
    if (match) targetIdStr = match[1];
  }
  const targetUserId = Number(targetIdStr);
  if (!targetUserId) return ctx.reply("⚠️ Usage: <code>/revoke &lt;StudentID&gt;</code> or reply to an approval message with <code>/revoke</code>", { message_thread_id: topicId, parse_mode: 'HTML' });
  await executeRevoke(ctx, targetUserId, topicId);
});

bot.callbackQuery('cmd_panel_revoke', async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  if (!(await isStaff(ctx))) return;
  await ctx.reply("⚠️ <b>Revoke Student Approval</b>\n\nReply directly to this message with the <b>Student ID</b> you want to revoke.", {
    message_thread_id: ctx.callbackQuery.message.message_thread_id,
    parse_mode: 'HTML',
    reply_markup: { force_reply: true }
  });
});

// /changedept COMMAND & PANEL HANDLERS
async function executeChangeDeptPrompt(ctx, targetUserId, topicId) {
  const res = await pool.query("SELECT username, department FROM tickets WHERE user_id = $1 AND status = 'APPROVED' ORDER BY updated_at DESC LIMIT 1", [targetUserId]);
  if (res.rows.length === 0) return ctx.reply(`⚠️ No approved record found for Student ID: <code>${targetUserId}</code>.`, { message_thread_id: topicId, parse_mode: 'HTML' });

  const { username, department } = res.rows[0];
  const kb = new InlineKeyboard()
    .text("📈 Marketing", `chgdept_${targetUserId}_mkt`).text("💼 Business", `chgdept_${targetUserId}_biz`).row()
    .text("📊 Accounting & Finance", `chgdept_${targetUserId}_acc`).text("🌾 Agribusiness & VCM", `chgdept_${targetUserId}_agri`).row()
    .text("📚 Ed. Planning & Mgmt", `chgdept_${targetUserId}_ed`).text("🚚 Logistics & SCM", `chgdept_${targetUserId}_log`).row()
    .text("🔙 Cancel", `chgdept_${targetUserId}_cancel`);

  await ctx.reply(`🔄 <b>Change Academic Placement</b>\n━━━━━━━━━━━━━━━━━━━━\n• <b>Student ID:</b> <code>${targetUserId}</code>\n• <b>Username:</b> @${escapeHtml(username) || 'N/A'}\n• <b>Current Dept:</b> ${escapeHtml(department)}\n\n<i>Select the new department below:</i>`, { message_thread_id: topicId, parse_mode: 'HTML', reply_markup: kb });
}

bot.command(['changedept', 'changedep'], async (ctx) => {
  if (!(await isStaff(ctx))) return;
  const topicId = ctx.message.message_thread_id;
  let targetIdStr = ctx.message.text.replace(/^\/(changedept|changedep)/, '').trim();
  if (!targetIdStr && ctx.message.reply_to_message?.text) {
    const match = ctx.message.reply_to_message.text.match(/Student ID:\s*`?(\d+)`?/i) || ctx.message.reply_to_message.text.match(/ID:\s*<code.*?>(\d+)<\/code>/i) || ctx.message.reply_to_message.text.match(/Student ID: (\d+)/i);
    if (match) targetIdStr = match[1];
  }
  const targetUserId = Number(targetIdStr);
  if (!targetUserId) return ctx.reply("⚠️ Usage: <code>/changedept &lt;StudentID&gt;</code> or reply to an approval card with <code>/changedept</code>", { message_thread_id: topicId, parse_mode: 'HTML' });
  await executeChangeDeptPrompt(ctx, targetUserId, topicId);
});

bot.callbackQuery('cmd_panel_changedept', async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  if (!(await isStaff(ctx))) return;
  await ctx.reply("🔄 <b>Change Student Placement</b>\n\nReply directly to this message with the <b>Student ID</b> you want to change.", {
    message_thread_id: ctx.callbackQuery.message.message_thread_id,
    parse_mode: 'HTML',
    reply_markup: { force_reply: true }
  });
});

bot.callbackQuery(/^chgdept_(\d+)_(mkt|biz|acc|agri|ed|log|cancel)$/, async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  const targetUserId = Number(ctx.match[1]);
  const deptCode = ctx.match[2];
  const staffName = `${ctx.from.first_name || ''} ${ctx.from.last_name || ''}`.trim() || `Staff`;
  if (deptCode === 'cancel') return ctx.editMessageText("❌ Department change cancelled.");

  const deptMap = { mkt: "Marketing Management", biz: "Business Management", acc: "Accounting and finance", agri: "Agribusiness and Value chain management", ed: "Educational planning and management", log: "Logistics and Supply chain management" };
  const ticketRes = await pool.query("SELECT id, department FROM tickets WHERE user_id = $1 AND status = 'APPROVED' ORDER BY updated_at DESC LIMIT 1", [targetUserId]);
  if (ticketRes.rows.length === 0) return ctx.editMessageText("⚠️ Could not find approved ticket to update.");

  const oldDept = ticketRes.rows[0].department || '';
  const planSuffix = oldDept.includes("(4-Year Complete)") ? "(4-Year Complete)" : "(Regular / Term)";
  const newFullDept = `${deptMap[deptCode]} ${planSuffix}`;

  await pool.query("UPDATE tickets SET department = $1, processed_by = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3", [newFullDept, staffName, ticketRes.rows[0].id]);
  await ctx.editMessageText(`✅ <b>Department Changed Successfully!</b>\n━━━━━━━━━━━━━━━━━━━━\n• <b>Student ID:</b> <code>${targetUserId}</code>\n• <b>New Department:</b> ${escapeHtml(newFullDept)}\n• <b>Updated by:</b> ${escapeHtml(staffName)}\n\n<i>Student's module library has been automatically switched to the new department.</i>`, { parse_mode: 'HTML' });

  try {
    const studentLang = await getUserLang(targetUserId);
    const notifMsg = studentLang === 'am'
      ? `🔄 <b>የትምህርት ክፍልዎ ተቀይሯል</b>\n\nአዲሱ ክፍልዎ፡ <b>${escapeHtml(newFullDept)}</b>\nአሁን አዲሶቹን ሞጁሎች በ '📚 የትምህርት ሞጁሎች' ማውረድ ይችላሉ።`
      : `🔄 <b>Academic Placement Updated</b>\n\nYour department has been officially updated to:\n👉 <b>${escapeHtml(newFullDept)}</b>\nAccess new course materials under <b>📚 Course Modules</b>!`;
    await bot.api.sendMessage(targetUserId, notifMsg, { parse_mode: 'HTML' });
  } catch (err) {}
});

// INTERACTIVE /deletemodule MANAGER
bot.command(['deletemodule', 'delmod'], async (ctx) => {
  if (!(await isStaff(ctx))) return;
  await ctx.reply("🗑 <b>Delete Course Module</b>\n\nSelect academic department:", { message_thread_id: ctx.message.message_thread_id, parse_mode: 'HTML', reply_markup: getDeleteModuleDepartmentKeyboard() });
});

bot.callbackQuery('cmd_delete_module', async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  if (!(await isStaff(ctx))) return;
  await clearStaffPendingModuleDept(ctx.from.id);
  await ctx.reply("🗑 <b>Delete Course Module</b>\n\nSelect academic department to remove modules from:", { message_thread_id: ctx.callbackQuery.message.message_thread_id, parse_mode: 'HTML', reply_markup: getDeleteModuleDepartmentKeyboard() });
});

bot.callbackQuery(/^delmoddept_(.+)$/, async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  const dept = ctx.match[1];
  if (dept === 'cancel') return ctx.editMessageText("❌ Module deletion cancelled.");

  const res = await pool.query("SELECT id, title FROM department_modules WHERE department ILIKE $1 ORDER BY id ASC", [`%${dept}%`]);
  if (res.rows.length === 0) return ctx.editMessageText(`ℹ️ No modules currently found for <b>${escapeHtml(dept)}</b>.`, { parse_mode: 'HTML' });

  const kb = new InlineKeyboard();
  res.rows.forEach((m) => kb.text(`🗑 ${m.title}`, `confirm_delmod_${m.id}`).row());
  kb.text("🔙 Cancel", "delmoddept_cancel");
  await ctx.editMessageText(`🗑 <b>Modules for ${escapeHtml(dept)}</b>\n\nTap any module below to remove student access:`, { parse_mode: 'HTML', reply_markup: kb });
});

bot.callbackQuery(/^confirm_delmod_(\d+)$/, async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  const res = await pool.query("DELETE FROM department_modules WHERE id = $1 RETURNING title, department", [Number(ctx.match[1])]);
  if (res.rowCount === 0) return ctx.editMessageText("⚠️ Module was already deleted or not found.");
  await ctx.editMessageText(`✅ <b>Module Deleted!</b>\n━━━━━━━━━━━━━━━━━━━━\n• <b>Title:</b> ${escapeHtml(res.rows[0].title)}\n• <b>Department:</b> ${escapeHtml(res.rows[0].department)}`, { parse_mode: 'HTML' });
});

// APPROVED STUDENTS ROSTER DIRECTORY
bot.command(['approved', 'students'], async (ctx) => {
  if (!(await isStaff(ctx))) return;
  await ctx.reply("👥 <b>Approved Students Directory</b>\n\nSelect department or view all:", { message_thread_id: ctx.message.message_thread_id, parse_mode: 'HTML', reply_markup: getApprovedRosterKeyboard() });
});

bot.callbackQuery('cmd_approved_roster', async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  if (!(await isStaff(ctx))) return;
  await ctx.reply("👥 <b>Approved Students Directory</b>\n\nSelect department or view all:", { message_thread_id: ctx.callbackQuery.message.message_thread_id, parse_mode: 'HTML', reply_markup: getApprovedRosterKeyboard() });
});

bot.callbackQuery(/^roster_(.+)$/, async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  const targetDept = ctx.match[1];
  if (targetDept === 'cancel') return ctx.editMessageText("❌ Roster view cancelled.");

  const isAll = targetDept === 'all';
  const cleanDept = targetDept.replace(/\s*\((Regular \/ Term|4-Year Complete)\)$/, '').trim();

  let query = `
    SELECT t.user_id, t.username, t.department, t.processed_by, t.updated_at FROM tickets t
    INNER JOIN (SELECT user_id, MAX(updated_at) as max_date FROM tickets WHERE status = 'APPROVED' GROUP BY user_id) latest 
    ON t.user_id = latest.user_id AND t.updated_at = latest.max_date WHERE t.status = 'APPROVED'
  `;
  const params = [];
  if (!isAll) {
    query += ` AND t.department ILIKE $1`;
    params.push(`%${cleanDept}%`);
  }
  query += ` ORDER BY t.department ASC, t.updated_at DESC LIMIT 100`;

  const res = await pool.query(query, params);
  if (res.rows.length === 0) return ctx.editMessageText(isAll ? "ℹ️ No approved students registered yet." : `ℹ️ No approved students found in <b>${escapeHtml(cleanDept)}</b>.`, { parse_mode: 'HTML' });

  const headerTitle = isAll ? "ALL DEPARTMENTS" : cleanDept.toUpperCase();
  let text = `🎓 <b>APPROVED ROSTER — ${escapeHtml(headerTitle)}</b> (${res.rows.length} Total)\n\n`;
  let currentGroupDept = "";

  for (let idx = 0; idx < res.rows.length; idx++) {
    const r = res.rows[idx];
    const uname = escapeHtml(r.username ? `@${r.username}` : `[No @username]`);
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
  if (text.trim().length > 0) await ctx.reply(text, { parse_mode: 'HTML' });
});
bot.callbackQuery(/^notify_mod_(\d+)$/, async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  if (!(await isStaff(ctx))) return;

  const moduleId = Number(ctx.match[1]);
  const modRes = await pool.query('SELECT title, department FROM department_modules WHERE id = $1', [moduleId]);
  if (modRes.rows.length === 0) return ctx.editMessageText("⚠️ Module no longer exists.");

  const { title, department } = modRes.rows[0];
  const cleanDept = department.replace(/\s*\((Regular \/ Term|4-Year Complete)\)$/, '').trim();

  const studentsRes = await pool.query("SELECT DISTINCT user_id FROM tickets WHERE status = 'APPROVED' AND department ILIKE $1", [`%${cleanDept}%`]);
  const students = studentsRes.rows;
  if (students.length === 0) return ctx.editMessageText(`ℹ️ No approved students enrolled in <b>${escapeHtml(cleanDept)}</b> to notify.`, { parse_mode: 'HTML' });

  let sentCount = 0;
  for (const s of students) {
    try {
      const sLang = await getUserLang(s.user_id);
      const notifText = sLang === 'am'
        ? `📚 <b>አዲስ የትምህርት ሞጁል ተጭኗል!</b>\n━━━━━━━━━━━━━━━━━━━━\n• <b>ክፍል:</b> ${escapeHtml(cleanDept)}\n• <b>ሞጁል:</b> ${escapeHtml(title)}\n\n<i>ከታች ያለውን ቁልፍ በመጫን ማውረድ ይችላሉ፡</i>`
        : `📚 <b>NEW COURSE MODULE AVAILABLE</b>\n━━━━━━━━━━━━━━━━━━━━\n• <b>Department:</b> ${escapeHtml(cleanDept)}\n• <b>Module:</b> ${escapeHtml(title)}\n\n<i>Tap below to download:</i>`;

      const dlKb = new InlineKeyboard().text(sLang === 'am' ? "⬇️ አውርድ (Download)" : "⬇️ Download Module", `dlmod_${moduleId}`);
      await bot.api.sendMessage(s.user_id, notifText, { parse_mode: 'HTML', reply_markup: dlKb });
      sentCount++;
    } catch (e) {}
  }

  await ctx.editMessageText(`📢 <b>Broadcast Complete!</b>\n━━━━━━━━━━━━━━━━━━━━\n• <b>Module:</b> ${escapeHtml(title)}\n• <b>Department:</b> ${escapeHtml(cleanDept)}\n• <b>Delivered to:</b> ${sentCount}/${students.length} students.`, { parse_mode: 'HTML' });
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
    SELECT m.id, m.title, m.department, COUNT(DISTINCT d.user_id) AS total_downloads
    FROM department_modules m LEFT JOIN module_downloads d ON m.id = d.module_id
    GROUP BY m.id, m.title, m.department ORDER BY m.department ASC, total_downloads DESC
  `);

  if (res.rows.length === 0) return ctx.reply("📊 <b>Module Analytics:</b> No modules uploaded yet.", { message_thread_id: topicId, parse_mode: 'HTML' });

  let text = "📈 <b>COURSE MODULE ENGAGEMENT ANALYTICS</b>\n\n";
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
    text += `• <b>${escapeHtml(row.title)}</b>\n  ↳ Downloaded by: <b>${downloads}/${totalEnrolled} students</b> (${percentage}%)\n`;
  }
  await ctx.reply(text, { message_thread_id: topicId, parse_mode: 'HTML' });
});

bot.callbackQuery(/^lang_(en|am)$/, async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  const lang = ctx.match[1];
  await setUserLang(ctx.from.id, lang);
  await ctx.editMessageText(STRINGS[lang].portalWelcome, { parse_mode: 'HTML', reply_markup: getStudentKeyboard(lang, null) });
});

bot.callbackQuery('cmd_lookfor', async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  await ctx.reply("🔍 <b>Search Student Record</b>\n\n<i>Reply directly to this message with a <b>User ID</b>, <b>@username</b>, or <b>Department</b>.</i>", {
    message_thread_id: ctx.callbackQuery.message.message_thread_id, parse_mode: 'HTML', reply_markup: { force_reply: true }
  });
});

bot.callbackQuery('cmd_stats', async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  await ctx.reply(`${await generateSummaryText('APPROVED')}\n\n---\n\n${await generateSummaryText('REJECTED')}`, { message_thread_id: ctx.callbackQuery.message.message_thread_id, parse_mode: 'HTML' });
});

bot.callbackQuery('cmd_export', async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  await sendCSVExport(await getActiveStaffGroupId(), ctx.callbackQuery.message.message_thread_id, "📄 <b>Receipt Audit Export</b>");
});

bot.callbackQuery('cmd_broadcast', async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  await ctx.reply("📢 <b>Send Student Announcement</b>\n\n<i>Reply directly to this message with the exact announcement text to broadcast.</i>", {
    message_thread_id: ctx.callbackQuery.message.message_thread_id, parse_mode: 'HTML', reply_markup: { force_reply: true }
  });
});

bot.callbackQuery('cmd_upload_module', async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  if (!(await isStaff(ctx))) return;
  await ctx.reply("📚 <b>Upload Course Module</b>\n\n<i>Select academic department:</i>", { message_thread_id: ctx.callbackQuery.message.message_thread_id, parse_mode: 'HTML', reply_markup: getModuleDepartmentKeyboard() });
});

bot.callbackQuery(/^moddept_(.+)$/, async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  const dept = ctx.match[1];
  if (dept === 'cancel') {
    await clearStaffPendingModuleDept(ctx.from.id);
    return ctx.editMessageText("❌ Module upload cancelled.");
  }
  await setStaffPendingModuleDept(ctx.from.id, dept);
  await ctx.editMessageText(`✅ Selected Department: <b>${escapeHtml(dept)}</b>\n\n<i>Now, simply send or forward the PDF document for this module.</i>`, { parse_mode: 'HTML' });
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
    : "⏳ <b>Submission Under Review</b>\n\nYour receipt is currently being verified by staff. Submissions are disabled until review completes.";
  await ctx.reply(msg, { parse_mode: 'HTML', reply_markup: getStudentKeyboard(lang, 'PENDING') });
});

bot.callbackQuery('cmd_download_pdf', async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  const userId = ctx.from.id;
  const lang = await getUserLang(userId);
  const res = await pool.query("SELECT department, username, processed_by FROM tickets WHERE user_id = $1 AND status = 'APPROVED' ORDER BY updated_at DESC LIMIT 1", [userId]);
  if (res.rows.length === 0) return ctx.reply("⚠️ No approved receipt found.");

  const { department, username, processed_by } = res.rows[0];
  const botUsername = ctx.me?.username;
  try {
    const pdfPath = await generateApprovalPDF(userId, username || 'N/A', department, processed_by || 'Finance Team', botUsername, lang);
    await ctx.replyWithDocument(new InputFile(pdfPath, `Tuition_Approval_Slip_${userId}.pdf`), { caption: STRINGS[lang].approvedMsg, parse_mode: 'HTML' });
    if (fs.existsSync(pdfPath)) fs.unlinkSync(pdfPath);
  } catch (err) {
    ctx.reply("❌ Unable to generate PDF slip.");
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
      : "🔒 <b>Modules Locked</b>\n\nCourse modules are only accessible to students with an <b>APPROVED</b> tuition payment.";
    return ctx.reply(notApprovedMsg, { parse_mode: 'HTML', reply_markup: getStudentKeyboard(lang, null) });
  }

  const studentDept = checkApproval.rows[0].department.replace(/\s*\((Regular \/ Term|4-Year Complete)\)$/, '').trim();
  const modulesRes = await pool.query("SELECT id, title FROM department_modules WHERE department ILIKE $1 ORDER BY id ASC", [`%${studentDept}%`]);
  if (modulesRes.rows.length === 0) return ctx.reply(`📚 No modules uploaded for <b>${escapeHtml(studentDept)}</b> yet.`, { parse_mode: 'HTML' });

  const kb = new InlineKeyboard();
  modulesRes.rows.forEach((m) => kb.text(`📄 ${m.title}`, `dlmod_${m.id}`).row());
  await ctx.reply(`📚 <b>Course Modules (${escapeHtml(studentDept)})</b>\n\n<i>Select a module below to download:</i>`, { parse_mode: 'HTML', reply_markup: kb });
});

bot.callbackQuery(/^dlmod_(\d+)$/, async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  const moduleId = Number(ctx.match[1]);
  const res = await pool.query("SELECT title, file_id FROM department_modules WHERE id = $1", [moduleId]);
  if (res.rows.length === 0) return ctx.reply("⚠️ Module not found or removed.");

  try {
    await pool.query("INSERT INTO module_downloads (module_id, user_id) VALUES ($1, $2) ON CONFLICT (module_id, user_id) DO NOTHING", [moduleId, ctx.from.id]);
  } catch (e) {}

  try {
    await ctx.replyWithDocument(res.rows[0].file_id, { caption: `📖 <b>${escapeHtml(res.rows[0].title)}</b>\n\n<i>Renaissance Global Official Course Module</i>`, parse_mode: 'HTML' });
  } catch (err) {
    ctx.reply("❌ Unable to download module.");
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
  if (res.rows.length === 0) return ctx.reply(lang === 'am' ? "ℹ️ ምንም ደረሰኝ አላስገቡም።" : "ℹ️ No payment receipts submitted yet.", { reply_markup: getStudentKeyboard(lang, null) });

  const ticket = res.rows[0];
  let timeline = "";
  if (ticket.status === 'PENDING') {
    timeline = lang === 'am' 
      ? "🟢 <b>1. ደረሰኝ መላክ</b> — ተጠናቋል\n🟡 <b>2. የሰራተኞች ግምገማ</b> — በሂደት ላይ...\n⚪️ <b>3. ማጽደቅ / ፒዲኤፍ</b> — ተቆልፏል" 
      : "🟢 <b>Step 1: Submission</b> — Complete\n🟡 <b>Step 2: Verification</b> — In Progress...\n⚪️ <b>Step 3: PDF Slip</b> — Locked";
  } else if (ticket.status === 'APPROVED') {
    timeline = lang === 'am' 
      ? "🟢 <b>1. ደረሰኝ መላክ</b> — ተጠናቋል\n🟢 <b>2. የሰራተኞች ግምገማ</b> — ተጠናቋል\n🟢 <b>3. ጸድቋል / ፒዲኤፍ</b> — ክፍት ነው" 
      : "🟢 <b>Step 1: Submission</b> — Complete\n🟢 <b>Step 2: Verification</b> — Complete\n🟢 <b>Step 3: Approved & Cleared</b> — Unlocked";
  } else {
    timeline = lang === 'am' 
      ? "🟢 <b>1. ደረሰኝ መላክ</b> — ተጠናቋል\n🔴 <b>2. ውድቅ ተደርጓል</b> — ማስተካከያ ይፈልጋል" 
      : "🟢 <b>Step 1: Submission</b> — Complete\n🔴 <b>Step 2: Rejected</b> — Action Required";
  }

  let msg = `📊 <b>YOUR CLEARANCE STATUS</b>\n━━━━━━━━━━━━━━━━━━━━\n• <b>Department:</b> ${escapeHtml(ticket.department)}\n• <b>Status:</b> <b>${ticket.status}</b>\n\n${timeline}\n`;
  if (ticket.status === 'REJECTED' && ticket.rejection_reason) msg += `\n<blockquote><b>Reason:</b> ${escapeHtml(ticket.rejection_reason)}</blockquote>`;
  await ctx.reply(msg, { parse_mode: 'HTML', reply_markup: getStudentKeyboard(lang, ticket.status) });
});

bot.callbackQuery('cmd_history', async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  const userId = ctx.from.id;
  const lang = await getUserLang(userId);
  const res = await pool.query('SELECT department, status, rejection_reason, created_at FROM tickets WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20', [userId]);
  if (res.rows.length === 0) return ctx.reply("ℹ️ No submission history.", { reply_markup: getStudentKeyboard(lang, null) });

  let text = "📜 <b>Payment History:</b>\n━━━━━━━━━━━━━━━━━━━━\n";
  for (let idx = 0; idx < res.rows.length; idx++) {
    const r = res.rows[idx];
    const icon = r.status === 'APPROVED' ? "✅" : (r.status === 'REJECTED' ? "❌" : "⏳");
    let itemText = `${idx + 1}. ${icon} <b>${escapeHtml(r.department)}</b>\n   • Status: ${r.status}\n   • Date: ${new Date(r.created_at).toLocaleDateString()}\n`;
    if (r.status === 'REJECTED' && r.rejection_reason) itemText += `   <blockquote>Reason: ${escapeHtml(r.rejection_reason)}</blockquote>\n`;
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
  if (!staffGroupId) return ctx.reply("⚠️ Run /bind in staff group first.");

  const doc = ctx.message.document || ctx.message.reply_to_message?.document;
  if (!doc) return ctx.reply("⚠️ Format: Attach or reply to PDF with <code>/module Department | Title</code>", { parse_mode: 'HTML' });

  const parts = (ctx.message.caption || ctx.message.text || '').replace(/^\/(module|uploadmodule)/, '').trim().split('|').map(s => s.trim());
  if (parts.length < 2 || !parts[0] || !parts[1]) return ctx.reply("⚠️ Provide both <code>&lt;Dept&gt; | &lt;Title&gt;</code>", { parse_mode: 'HTML' });

  const [dept, title] = parts;
  try {
    const vaultTopicId = await getOrCreateModulesVaultTopic(ctx, staffGroupId);
    const vaultMsg = await ctx.api.sendDocument(staffGroupId, doc.file_id, {
      message_thread_id: vaultTopicId,
      caption: `📚 <b>COURSE MODULE ARCHIVE</b>\n• Department: ${escapeHtml(dept)}\n• Title: ${escapeHtml(title)}`,
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

    const notifyKb = new InlineKeyboard().text("📢 Notify Enrolled Students", `notify_mod_${newModId}`).row().text("🔕 Silent Upload", "dismiss_mod_notify");
    await ctx.reply(`✅ <b>Module Stashed in Vault!</b>\n• Department: ${escapeHtml(dept)}\n• Title: ${escapeHtml(title)}\n\nBroadcast to enrolled students?`, { parse_mode: 'HTML', reply_markup: notifyKb });
  } catch (err) {
    ctx.reply(`❌ Failed: ${err.message}`);
  }
});

bot.callbackQuery(/^trans_(\d+)_(\d+)$/, async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  await ctx.editMessageText("📂 <b>Select new department:</b>", { parse_mode: 'HTML', reply_markup: getTransferKeyboard(Number(ctx.match[1]), Number(ctx.match[2])) });
});

bot.callbackQuery(/^canceltrans_(\d+)_(\d+)$/, async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  const res = await pool.query('SELECT username, department FROM tickets WHERE user_id = $1 AND topic_id = $2 AND status = \'PENDING\' LIMIT 1', [Number(ctx.match[1]), Number(ctx.match[2])]);
  if (res.rows.length === 0) return ctx.editMessageText("⚠️ Ticket status changed.");
  const kb = new InlineKeyboard().text("✅ Approve", `app_${ctx.match[1]}_${ctx.match[2]}`).row().text("❌ Reject", `rej_${ctx.match[1]}_${ctx.match[2]}`).row().text("🔄 Transfer Dept", `trans_${ctx.match[1]}_${ctx.match[2]}`);
  await ctx.editMessageText(`🧾 <b>NEW TUITION PAYMENT</b>\n━━━━━━━━━━━━━━━━━━━━\n👤 <b>Student:</b> @${escapeHtml(res.rows[0].username || 'Unknown')}\n🆔 <b>ID:</b> <code>${ctx.match[1]}</code>\n🏫 <b>Program:</b> ${escapeHtml(res.rows[0].department)}\n━━━━━━━━━━━━━━━━━━━━\n⚡️ <i>Please review the attached document below.</i>`, { parse_mode: 'HTML', reply_markup: kb });
});

bot.callbackQuery(/^tr_(\d+)_(\d+)_(mkt|biz|agri|ed|acc|log)$/, async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  const targetUserId = Number(ctx.match[1]);
  const originTopicId = Number(ctx.match[2]);
  const staffGroupId = await getActiveStaffGroupId();
  if (!staffGroupId) return;

  const ticketRes = await pool.query('SELECT topic_id, message_id, ticket_msg_id, username, department FROM tickets WHERE user_id = $1 AND topic_id = $2 AND status = \'PENDING\' ORDER BY updated_at DESC LIMIT 1', [targetUserId, originTopicId]);
  if (ticketRes.rows.length === 0) return ctx.editMessageText("⚠️ Already transferred or processed.");

  const deptMap = { mkt: "Marketing Management", biz: "Business Management", agri: "Agribusiness and Value chain management", ed: "Educational planning and management", acc: "Accounting and finance", log: "Logistics and Supply chain management" };
  const planSuffix = ticketRes.rows[0].department.includes("(4-Year Complete)") ? "(4-Year Complete)" : "(Regular / Term)";
  const newDeptTagged = `${deptMap[ctx.match[3]]} ${planSuffix}`;
  const newTopicId = await getOrCreateDepartmentTopic(ctx, newDeptTagged, staffGroupId);

  const newForwardRes = await ctx.api.copyMessage(staffGroupId, staffGroupId, Number(ticketRes.rows[0].message_id), { message_thread_id: newTopicId });
  const kb = new InlineKeyboard().text("✅ Approve", `app_${targetUserId}_${newTopicId}`).row().text("❌ Reject", `rej_${targetUserId}_${newTopicId}`).row().text("🔄 Transfer Dept", `trans_${targetUserId}_${newTopicId}`);
  const newTicketMsg = await ctx.api.sendMessage(staffGroupId, `🧾 <b>NEW TUITION PAYMENT</b>\n━━━━━━━━━━━━━━━━━━━━\n👤 <b>Student:</b> @${escapeHtml(ticketRes.rows[0].username)}\n🆔 <b>ID:</b> <code>${targetUserId}</code>\n🏫 <b>Program:</b> ${escapeHtml(newDeptTagged)}\n━━━━━━━━━━━━━━━━━━━━\n⚡️ <i>Please review the attached document below.</i>`, { message_thread_id: newTopicId, parse_mode: 'HTML', reply_markup: kb });

  await pool.query(`UPDATE tickets SET department = $1, topic_id = $2, message_id = $3, ticket_msg_id = $4, updated_at = CURRENT_TIMESTAMP WHERE user_id = $5 AND status = 'PENDING'`, [newDeptTagged, newTopicId, newForwardRes.message_id, newTicketMsg.message_id, targetUserId]);
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

  let staffDept = await getStaffPendingModuleDept(ctx.from.id);
  if (!staffDept && ctx.message.reply_to_message?.text) {
    const match = ctx.message.reply_to_message.text.match(/Selected Department:\s*([^\n]+)/);
    if (match) staffDept = match[1].trim();
  }

  if (isStaffGroup && staffDept && ctx.message.document) {
    const doc = ctx.message.document;
    const moduleTitle = doc.file_name ? doc.file_name.replace(/\.pdf$/i, '') : 'Course Module';
    try {
      const vaultTopicId = await getOrCreateModulesVaultTopic(ctx, staffGroupId);
      const vaultMsg = await ctx.api.sendDocument(staffGroupId, doc.file_id, {
        message_thread_id: vaultTopicId,
        caption: `📚 <b>COURSE MODULE ARCHIVE</b>\n• Department: ${escapeHtml(staffDept)}\n• Title: ${escapeHtml(moduleTitle)}`,
        parse_mode: 'HTML'
      });
      const insRes = await pool.query("INSERT INTO department_modules (department, title, file_id, file_name) VALUES ($1, $2, $3, $4) RETURNING id", [staffDept, moduleTitle, vaultMsg.document.file_id, doc.file_name || `${moduleTitle}.pdf`]);
      await clearStaffPendingModuleDept(ctx.from.id);
      try { await ctx.deleteMessage(); } catch (e) {}

      const notifyKb = new InlineKeyboard().text("📢 Notify Enrolled Students", `notify_mod_${insRes.rows[0].id}`).row().text("🔕 Silent Upload", "dismiss_mod_notify");
      return ctx.reply(`✅ <b>Module Stashed in Vault!</b>\n• Department: ${escapeHtml(staffDept)}\n• Title: ${escapeHtml(moduleTitle)}\n\nNotify enrolled students now?`, { message_thread_id: topicId, parse_mode: 'HTML', reply_markup: notifyKb });
    } catch (err) {
      return ctx.reply(`❌ Upload error: ${err.message}`, { message_thread_id: topicId });
    }
  }

  if (isStaffGroup && ctx.message.reply_to_message) {
    const orig = ctx.message.reply_to_message.text || '';
    if (orig.includes("Search Student Record")) return performSearch(ctx, ctx.message.text.trim(), topicId);
    if (orig.includes("Send Announcement")) return performBroadcast(ctx, topicId, ctx.message.text.trim());
    if (orig.includes("Change Student Placement")) return executeChangeDeptPrompt(ctx, Number(ctx.message.text.trim()), topicId);
    if (orig.includes("Revoke Student Approval")) return executeRevoke(ctx, Number(ctx.message.text.trim()), topicId);
  }

  if (isPrivate) {
    const userId = ctx.from.id;
    const lang = await getUserLang(userId);
    const activeCheck = await pool.query("SELECT 1 FROM tickets WHERE user_id = $1 AND status = 'PENDING' LIMIT 1", [userId]);
    if (activeCheck.rows.length > 0) return ctx.reply(STRINGS[lang].pendingExists, { parse_mode: 'HTML', reply_markup: getStudentKeyboard(lang, 'PENDING') });

    const chosenDeptTagged = await getPendingDepartment(userId);
    if (!chosenDeptTagged) return ctx.reply(lang === 'am' ? "⚠️ እባክዎን መጀመሪያ ክፍል ይምረጡ።" : "⚠️ Please select your department first!", { parse_mode: 'HTML', reply_markup: getStudentKeyboard(lang, null) });

    const fileId = ctx.message.photo ? ctx.message.photo[ctx.message.photo.length - 1].file_id : (ctx.message.document ? ctx.message.document.file_id : null);
    if (!fileId) return ctx.reply(STRINGS[lang].noFileErr, { parse_mode: 'HTML' });
    if (!staffGroupId) return ctx.reply("⚠️ Staff group not registered.");

    const username = ctx.from.username || ctx.from.first_name || 'Unknown';
    try {
      const topicId = await getOrCreateDepartmentTopic(ctx, chosenDeptTagged, staffGroupId);
      const forwardRes = await ctx.api.copyMessage(staffGroupId, ctx.chat.id, ctx.message.message_id, { message_thread_id: topicId });
      const kb = new InlineKeyboard().text("✅ Approve", `app_${userId}_${topicId}`).row().text("❌ Reject", `rej_${userId}_${topicId}`).row().text("🔄 Transfer Dept", `trans_${userId}_${topicId}`);
      
      const cardMsg = `🧾 <b>NEW TUITION PAYMENT</b>\n━━━━━━━━━━━━━━━━━━━━\n👤 <b>Student:</b> @${escapeHtml(username)}\n🆔 <b>ID:</b> <code>${userId}</code>\n🏫 <b>Program:</b> ${escapeHtml(chosenDeptTagged)}\n━━━━━━━━━━━━━━━━━━━━\n⚡️ <i>Please review the attached document below.</i>`;
      const sentTicketMsg = await ctx.api.sendMessage(staffGroupId, cardMsg, { message_thread_id: topicId, parse_mode: 'HTML', reply_markup: kb });

      await clearPendingDepartment(userId);
      const studentPanelMsg = await ctx.reply(STRINGS[lang].receiptReceived, { parse_mode: 'HTML', reply_markup: getStudentKeyboard(lang, 'PENDING') });
      await pool.query(`INSERT INTO tickets (user_id, username, receipt_file_id, topic_id, message_id, ticket_msg_id, panel_msg_id, department, status) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'PENDING')`, [userId, username, fileId, topicId, forwardRes.message_id, sentTicketMsg.message_id, studentPanelMsg.message_id, chosenDeptTagged]);
    } catch (err) {
      return ctx.reply(`❌ Submission error: ${err.message}`);
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
  if (updateRes.rowCount === 0) return ctx.reply("⚠️ Ticket not found or not pending.", { message_thread_id: topicId });

  const { department, username, panel_msg_id } = updateRes.rows[0];
  const lang = await getUserLang(userId);

  if (panel_msg_id) {
    try { await ctx.api.editMessageReplyMarkup(userId, Number(panel_msg_id), { reply_markup: getStudentKeyboard(lang, 'APPROVED') }); } catch (e) {}
  }
  try { await ctx.api.sendMessage(userId, STRINGS[lang].approvedMsg, { parse_mode: 'HTML', reply_markup: getStudentKeyboard(lang, 'APPROVED') }); } catch (e) {}
  await ctx.editMessageText(`✅ <b>Payment Approved!</b>\n━━━━━━━━━━━━━━━━━━━━\n• <b>Student ID:</b> <code>${userId}</code>\n• <b>Username:</b> @${escapeHtml(username) || 'N/A'}\n• <b>Department:</b> ${escapeHtml(department)}\n• <b>Approved by:</b> ${escapeHtml(staffName)}`, { parse_mode: 'HTML' });

  if (APPROVED_THREAD_ID && staffGroupId) {
    await ctx.api.sendMessage(staffGroupId, await generateSummaryText('APPROVED'), { message_thread_id: APPROVED_THREAD_ID, parse_mode: 'HTML' });
  }
});

bot.callbackQuery(/^rej_(\d+)_(\d+)$/, async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  await ctx.editMessageText("❌ <b>Select rejection reason:</b>", { parse_mode: 'HTML', reply_markup: getRejectionReasonKeyboard(Number(ctx.match[1]), Number(ctx.match[2])) });
});

bot.callbackQuery(/^confirmrej_(\d+)_(\d+)_(.+)$/, async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  const userId = Number(ctx.match[1]);
  const topicId = Number(ctx.match[2]);
  const staffName = `${ctx.from.first_name || ''} ${ctx.from.last_name || ''}`.trim() || `Staff`;
  const reasonObj = REJECTION_REASONS.find(r => r.code === ctx.match[3]);
  const reasonText = reasonObj ? reasonObj.label : "Receipt details unverified";

  const updateRes = await pool.query(`UPDATE tickets SET status = 'REJECTED', rejection_reason = $1, processed_by = $2, updated_at = CURRENT_TIMESTAMP WHERE user_id = $3 AND status = 'PENDING' RETURNING panel_msg_id`, [reasonText, staffName, userId]);
  if (updateRes.rowCount === 0) return ctx.reply("⚠️ Ticket not pending.", { message_thread_id: topicId });

  const lang = await getUserLang(userId);
  const customMessage = reasonObj ? (lang === 'am' ? reasonObj.message_am : reasonObj.message_en) : "Please re-upload.";

  if (updateRes.rows[0].panel_msg_id) {
    try { await ctx.api.editMessageReplyMarkup(userId, Number(updateRes.rows[0].panel_msg_id), { reply_markup: getStudentKeyboard(lang, 'REJECTED') }); } catch (e) {}
  }

  const resubmitKeyboard = new InlineKeyboard().text(STRINGS[lang].reuploadBtn, "start_resubmit");
  await ctx.api.sendMessage(userId, STRINGS[lang].rejectedMsg.replace('{reason}', escapeHtml(reasonText)).replace('{message}', escapeHtml(customMessage)), { parse_mode: 'HTML', reply_markup: resubmitKeyboard });
  await ctx.editMessageText(`❌ <b>Receipt Rejected by ${escapeHtml(staffName)}</b>\n<blockquote><b>Reason:</b> ${escapeHtml(reasonText)}</blockquote>`, { parse_mode: 'HTML' });
});

cron.schedule('0 8 * * *', async () => {
  try {
    const staffGroupId = await getActiveStaffGroupId();
    if (!staffGroupId) return;
    const pendingRes = await pool.query("SELECT COUNT(*) FROM tickets WHERE status = 'PENDING'");
    const dailyReport = `🌅 <b>DAILY TUITION PORTAL SUMMARY</b>\n\n⏳ <b>Total Pending:</b> ${pendingRes.rows[0].count}\n\n---\n\n${await generateSummaryText('APPROVED')}\n\n---\n\n${await generateSummaryText('REJECTED')}`;
    await bot.api.sendMessage(staffGroupId, dailyReport, { message_thread_id: APPROVED_THREAD_ID || null, parse_mode: 'HTML' });
  } catch (err) {}
});

app.use('/webhook', webhookCallback(bot, 'express'));
app.get('/', (req, res) => res.send('Tuition Receipt Bot is active'));

async function main() {
  await initDB();

  try {
    await bot.api.deleteMyCommands();
    await bot.api.deleteMyCommands({ scope: { type: 'all_private_chats' } });
    await bot.api.deleteMyCommands({ scope: { type: 'all_group_chats' } });
    await bot.api.deleteMyCommands({ scope: { type: 'all_chat_administrators' } });

    // Students only see /start
    await bot.api.setMyCommands([
      { command: 'start', description: 'Open Student Portal & Submit Receipt' }
    ], { scope: { type: 'all_private_chats' } });

    // Staff/Admins only see /panel and /bind in group
    await bot.api.setMyCommands([
      { command: 'panel', description: 'Open Staff Command Center Dashboard' },
      { command: 'bind', description: 'Bind group as active staff panel' }
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
