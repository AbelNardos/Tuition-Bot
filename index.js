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

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS group_settings (
      group_id TEXT PRIMARY KEY,
      is_active BOOLEAN DEFAULT TRUE,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS tickets (
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
      language TEXT DEFAULT 'en'
    );
  `);

  try {
    await pool.query(`
      ALTER TABLE tickets ADD COLUMN IF NOT EXISTS panel_msg_id BIGINT;
    `);

    // Ensure department_topics exists with correct structure
    await pool.query(`
      CREATE TABLE IF NOT EXISTS department_topics (
        group_id TEXT NOT NULL DEFAULT '',
        department TEXT NOT NULL,
        topic_id BIGINT,
        PRIMARY KEY (group_id, department)
      );
    `);

    // Migrate existing table constraints if it was created under old schemas
    await pool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'department_topics_pkey'
        ) THEN
          ALTER TABLE department_topics DROP CONSTRAINT IF EXISTS department_topics_department_key;
          ALTER TABLE department_topics ADD PRIMARY KEY (group_id, department);
        END IF;
      EXCEPTION WHEN OTHERS THEN
        NULL;
      END $$;
    `);
  } catch (err) {
    console.error("Migration check error:", err);
  }
}

async function getActiveStaffGroupId() {
  try {
    const res = await pool.query('SELECT group_id FROM group_settings WHERE is_active = TRUE ORDER BY updated_at DESC LIMIT 1');
    if (res.rows.length > 0) {
      return res.rows[0].group_id;
    }
  } catch (err) {
    console.error("Error fetching active staff group ID:", err);
  }
  return String(process.env.STAFF_GROUP_ID || '').trim();
}

async function getUserLang(userId) {
  try {
    const res = await pool.query('SELECT language FROM user_settings WHERE user_id = $1', [userId]);
    if (res.rows.length > 0) {
      return res.rows[0].language;
    }
  } catch (err) {
    console.error("Error fetching user language:", err);
  }
  return 'en';
}

async function setUserLang(userId, lang) {
  try {
    await pool.query(`
      INSERT INTO user_settings (user_id, language) 
      VALUES ($1, $2) 
      ON CONFLICT (user_id) DO UPDATE SET language = EXCLUDED.language
    `, [userId, lang]);
  } catch (err) {
    console.error("Error setting user language:", err);
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

const pendingDepartments = new Map();

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
    .text('📢 Broadcast', 'cmd_broadcast');
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
    kb.text('📜 የክፍያ ታሪክ', 'cmd_history');
    kb.text('❓ እርዳታ / እገዛ', 'cmd_help');
  } else {
    if (status === 'PENDING') {
      kb.text('⏳ Under Review', 'cmd_pending_info');
    } else if (status === 'APPROVED') {
      kb.text('⬇️ Download Receipt', 'cmd_download_pdf');
    } else {
      kb.text('📤 Submit Payment', 'cmd_submit');
    }
    kb.text('📌 Check Status', 'cmd_status').row();
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

  // Step 1: Check if topic already exists for this group and department
  const cached = await pool.query(
    'SELECT topic_id FROM department_topics WHERE group_id = $1 AND department = $2 LIMIT 1',
    [targetGroupId, baseDepartment]
  );

  if (cached.rows.length > 0) {
    return Number(cached.rows[0].topic_id);
  }

  // Step 2: Create new Telegram Forum Topic
  const newTopic = await ctx.api.createForumTopic(targetGroupId, `📁 [${baseDepartment}]`);
  const topicId = newTopic.message_thread_id;

  // Step 3: Insert or update safely without strict unique constraint dependency
  await pool.query(
    `DELETE FROM department_topics WHERE group_id = $1 AND department = $2`,
    [targetGroupId, baseDepartment]
  );

  await pool.query(
    `INSERT INTO department_topics (group_id, department, topic_id) VALUES ($1, $2, $3)`,
    [targetGroupId, baseDepartment, topicId]
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

  await pool.query(`
    INSERT INTO group_settings (group_id, is_active) 
    VALUES ($1, TRUE) 
    ON CONFLICT (group_id) DO UPDATE SET is_active = TRUE, updated_at = CURRENT_TIMESTAMP
  `, [groupId]);

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
    pendingDepartments.delete(userId);

    const langKeyboard = new InlineKeyboard()
      .text("🇬🇧 English", "lang_en")
      .text("🇪🇹 አማርኛ", "lang_am");

    await ctx.reply(
      "🌐 **Please select your language / እባክዎን ቋንቋ ይምረጡ:**",
      { parse_mode: 'Markdown', reply_markup: langKeyboard }
    );
  }
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

  pendingDepartments.delete(userId);

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

  pendingDepartments.set(userId, fullTaggedDept);

  try {
    await ctx.editMessageText(
      t.sendReceiptPrompt.replace('{dept}', fullTaggedDept),
      { parse_mode: 'Markdown' }
    );
  } catch (e) {}
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

  const deptMap = {
    mkt: "Marketing Management (Regular / Term)",
    biz: "Business Management (Regular / Term)",
    agri: "Agribusiness and Value chain management (Regular / Term)",
    ed: "Educational planning and management (Regular / Term)",
    acc: "Accounting and finance (Regular / Term)",
    log: "Logistics and Supply chain management (Regular / Term)"
  };

  const newDeptTagged = deptMap[deptCode];

  const ticketRes = await pool.query(
    'SELECT topic_id, message_id, ticket_msg_id, username FROM tickets WHERE user_id = $1 AND topic_id = $2 AND status = \'PENDING\' ORDER BY updated_at DESC LIMIT 1',
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

bot.on('message', async (ctx) => {
  if (ctx.from && ctx.from.is_bot) return;

  const staffGroupId = await getActiveStaffGroupId();
  const isStaffGroup = staffGroupId && String(ctx.chat.id) === staffGroupId;
  const isPrivate = ctx.chat.type === 'private';
  const topicId = ctx.message.message_thread_id;

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

    const chosenDeptTagged = pendingDepartments.get(userId);
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

      pendingDepartments.delete(userId);

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
      { command: 'bind', description: 'Bind current group as staff panel (Admins only)' }
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
