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

const STAFF_GROUP_ID = String(process.env.STAFF_GROUP_ID || '').trim();
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
    CREATE TABLE IF NOT EXISTS tickets (
      user_id BIGINT,
      username TEXT,
      receipt_file_id TEXT,
      topic_id BIGINT,
      message_id BIGINT,
      ticket_msg_id BIGINT,
      department TEXT,
      status TEXT DEFAULT 'PENDING',
      rejection_reason TEXT,
      processed_by TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    ALTER TABLE tickets ADD COLUMN IF NOT EXISTS user_id BIGINT;
    ALTER TABLE tickets ADD COLUMN IF NOT EXISTS username TEXT;
    ALTER TABLE tickets ADD COLUMN IF NOT EXISTS receipt_file_id TEXT;
    ALTER TABLE tickets ADD COLUMN IF NOT EXISTS topic_id BIGINT;
    ALTER TABLE tickets ADD COLUMN IF NOT EXISTS message_id BIGINT;
    ALTER TABLE tickets ADD COLUMN IF NOT EXISTS ticket_msg_id BIGINT;
    ALTER TABLE tickets ADD COLUMN IF NOT EXISTS department TEXT;
    ALTER TABLE tickets ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'PENDING';
    ALTER TABLE tickets ADD COLUMN IF NOT EXISTS rejection_reason TEXT;
    ALTER TABLE tickets ADD COLUMN IF NOT EXISTS processed_by TEXT;
    ALTER TABLE tickets ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
    ALTER TABLE tickets ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;

    CREATE TABLE IF NOT EXISTS department_topics (
      department TEXT PRIMARY KEY,
      topic_id BIGINT
    );
  `);
}

async function safeAnswer(ctx, text) {
  try {
    await ctx.answerCallbackQuery(text ? { text } : undefined);
  } catch (err) {
    // Ignore expired or invalid query errors silently
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
const userLanguages = new Map();

const DEPARTMENTS = [
  "Marketing Management",
  "Business Management",
  "Agribusiness and Value chain management",
  "Educational planning and management",
  "Accounting and finance",
  "Logistics and Supply chain management"
];

const STRINGS = {
  en: {
    portalWelcome: "👋 **Welcome to Renaissance Global Student Portal**\n\nSelect an option below to manage your tuition submissions:",
    welcome: "👋 **Welcome to the Tuition Payment Portal!**",
    selectPlan: "💳 **Step 1 of 2: Select Payment Type**\n\nPlease choose your payment plan:",
    selectDept: "📚 **Step 2 of 2: Select Your Department**\n\nPlease select your academic department below:",
    receiptReceived: "✅ Your receipt has been sent to the staff review team. We will notify you once verified.",
    sendReceiptPrompt: "✅ Selected Department: **{dept}**\n\nNow, please send your receipt photo or screenshot with your Full Name and Student ID.",
    reuploadPrompt: "🔄 **Re-submitting Receipt**\nPlease choose your payment plan to initiate a new submission:",
    approvedMsg: "✅ **Receipt Verified!**\nYour payment submission has been approved. Your official approval PDF slip is attached below.",
    rejectedMsg: "❌ **Receipt Rejected**\n\n**Reason:** {reason}\n\n{message}",
    reuploadBtn: "🔄 Re-upload Receipt",
    noFileErr: "⚠️ Please send an actual **photo or screenshot** of your payment receipt. Text-only messages cannot be processed as receipts.",
    deptUpdated: "🔄 **Department Updated**\nYour receipt submission has been transferred to **{dept}**. Our review team will process your payment under this department.",
    pendingExists: "⚠️ **Active Submission Pending**\n\nYou already have a receipt under review. Please wait for staff verification or check your status before submitting a new one.",
    helpText: "❓ **Need Assistance?**\n\nIf you have issues regarding your tuition payments or department registration, please contact the registrar office directly or submit your payment receipt photo."
  },
  am: {
    portalWelcome: "👋 **እንኳን ወደ ሬነሳንስ ግሎባል የተማሪዎች ፖርታል በሰላም መጡ**\n\nየክፍያ ማመልከቻዎን ለማስተዳደር ከታች ካሉት አማራጮች አንዱን ይምረጡ፡",
    welcome: "👋 **እንኳን ወደ ክፍያ መላኪያ ቦት በሰላም መጡ!**",
    selectPlan: "💳 **ደረጃ 1 ከ 2፡ የክፍያ ዓይነት ይምረጡ**\n\nእባክዎን የክፍያ መጠን ዓይነትዎን ይምረጡ፡",
    selectDept: "📚 **ደረጃ 2 ከ 2፡ ትምህርት ክፍልዎን ይምረጡ**\n\nእባክዎን ትምህርት ክፍልዎን ከታች ካሉት ይምረጡ፡",
    receiptReceived: "✅ ደረሰኝዎ ለክትትል ቡድኑ ተልኳል። እንደተረጋገጠ እናሳውቅዎታለን።",
    sendReceiptPrompt: "✅ የተመረጠው ትምህርት ክፍል፡ **{dept}**\n\nአሁን እባክዎን የክፍያ ደረሰኝ ፎቶዎን ከሙሉ ስምዎ እና የተማሪ ID ጋር ይላኩ።",
    reuploadPrompt: "🔄 **ደረሰኝ እንደገና መላክ**\nእባክዎን አዲስ ማመልከቻ ለመጀመር የክፍያ ዓይነትዎን ይምረጡ፡",
    approvedMsg: "✅ **ደረሰኝዎ ተረጋግጧል!**\nየክፍያ ማረጋገጫዎ ጸድቋል። ይፋዊ የማረጋገጫ ፒዲኤፍ ደረሰኝዎ ከታች ተያይዟል።",
    rejectedMsg: "❌ **ደረሰኝዎ ውድቅ ተደርጓል**\n\n**ምክንያት:** {reason}\n\n{message}",
    reuploadBtn: "🔄 ደረሰኝ እንደገና ስቀል",
    noFileErr: "⚠️ እባክዎን ትክክለኛ የክፍያ ደረሰኝ **ፎቶ ወይም ስክሪንሾት** ይላኩ። በጽሁፍ ብቻ የሚላክ መረጃ አይቀበልም።",
    deptUpdated: "🔄 **ትምህርት ክፍል ተቀይሯል**\nየደረሰኝ ማመልከቻዎ ወደ **{dept}** ተዛውሯል። መረጃዎ በዚህ ትምህርት ክፍል ስር የሚታይ ይሆናል።",
    pendingExists: "⚠️ **አሁንም በሂደት ላይ ያለ ማመልከቻ አለ**\n\nቀደም ሲል የላኩት ደረሰኝ በመገምገም ላይ ይገኛል። እባክዎን የቡድኑን ምላሽ ይጠብቁ።",
    helpText: "❓ **እርዳታ ይፈልጋሉ?**\n\nበትምህርት ክፍያ ወይም በትምህርት ክፍል ምዝገባ ላይ ጥያቄ ወይም ችግር ካለዎት፣ እባክዎን የሬጅስትራር ቢሮውን በቀጥታ ያነጋግሩ ወይም የክፍያ ደረሰኝ ፎቶዎን ይላኩ።"
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
    message_am: "በደረሰኙ ላይ ያለው ስም ወይም የተማሪ መታወቂያ ከተመዘገበው መረጃ ጋር አይመሳሰልም። እባክዎን ትክክለኛ መረጃ ያለው ደረሰኝ ይላኩ ወይም የአስተዳደር ክፍሉን ያነጋግሩ።"
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

function getStudentKeyboard(lang = 'en') {
  if (lang === 'am') {
    return new InlineKeyboard()
      .text('📤 ደረሰኝ አስገባ', 'cmd_submit')
      .text('📌 የደረሰኙን ሁኔታ ያረጋግጡ', 'cmd_status').row()
      .text('📜 የክፍያ ታሪክ', 'cmd_history')
      .text('❓ እርዳታ / እገዛ', 'cmd_help');
  }
  return new InlineKeyboard()
    .text('📤 Submit Payment', 'cmd_submit')
    .text('📌 Check Status', 'cmd_status').row()
    .text('📜 My History', 'cmd_history')
    .text('❓ Help / Support', 'cmd_help');
}

function getTransferKeyboard(userId) {
  return new InlineKeyboard()
    .text("📈 Marketing Mgmt", `tr_${userId}_Marketing Management (Regular / Term)`)
    .text("💼 Business Mgmt", `tr_${userId}_Business Management (Regular / Term)`).row()
    .text("🌾 Agribusiness & VCM", `tr_${userId}_Agribusiness and Value chain management (Regular / Term)`)
    .text("📚 Ed. Planning", `tr_${userId}_Educational planning and management (Regular / Term)`).row()
    .text("📊 Accounting & Finance", `tr_${userId}_Accounting and finance (Regular / Term)`)
    .text("🚚 Logistics & SCM", `tr_${userId}_Logistics and Supply chain management (Regular / Term)`);
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

async function getOrCreateDepartmentTopic(ctx, departmentName) {
  const baseDepartment = departmentName.replace(/\s*\((Regular \/ Term|4-Year Complete)\)$/, '').trim();

  const cached = await pool.query('SELECT topic_id FROM department_topics WHERE department = $1', [baseDepartment]);
  if (cached.rows.length > 0) {
    return Number(cached.rows[0].topic_id);
  }

  const newTopic = await ctx.api.createForumTopic(STAFF_GROUP_ID, `📁 [${baseDepartment}]`);
  const topicId = newTopic.message_thread_id;

  await pool.query(`
    INSERT INTO department_topics (department, topic_id) 
    VALUES ($1, $2) 
    ON CONFLICT(department) DO UPDATE SET topic_id = EXCLUDED.topic_id
  `, [baseDepartment, topicId]);

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

async function sendCSVExport(threadId, captionText) {
  try {
    const res = await pool.query(`
      SELECT user_id, username, department, status, rejection_reason, processed_by, created_at, updated_at 
      FROM tickets 
      ORDER BY department ASC, status ASC, updated_at DESC
    `);

    if (res.rows.length === 0) {
      return bot.api.sendMessage(STAFF_GROUP_ID, "⚠️ No receipts found to export.", { message_thread_id: threadId });
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
      STAFF_GROUP_ID,
      new InputFile(filePath, `Receipts_Audit_${new Date().toISOString().split('T')[0]}.csv`),
      { message_thread_id: threadId, caption: captionText, parse_mode: 'Markdown' }
    );
  } catch (err) {
    console.error("Export error:", err);
    await bot.api.sendMessage(STAFF_GROUP_ID, `❌ Export error: ${err.message}`, { message_thread_id: threadId });
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

bot.command(['start', 'panel'], async (ctx) => {
  const isStaffGroup = String(ctx.chat.id) === STAFF_GROUP_ID;
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
  const lang = ctx.match[1];
  userLanguages.set(ctx.from.id, lang);
  await safeAnswer(ctx);

  const t = STRINGS[lang];

  await ctx.editMessageText(
    t.portalWelcome,
    { parse_mode: 'Markdown', reply_markup: getStudentKeyboard(lang) }
  );
});

bot.callbackQuery('cmd_lookfor', async (ctx) => {
  await safeAnswer(ctx);
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
  await safeAnswer(ctx);
  const topicId = ctx.callbackQuery.message.message_thread_id;
  const appSummary = await generateSummaryText('APPROVED');
  const rejSummary = await generateSummaryText('REJECTED');
  await ctx.reply(`${appSummary}\n\n---\n\n${rejSummary}`, { message_thread_id: topicId, parse_mode: 'Markdown' });
});

bot.callbackQuery('cmd_export', async (ctx) => {
  await safeAnswer(ctx);
  const topicId = ctx.callbackQuery.message.message_thread_id;
  await sendCSVExport(topicId, "📄 **Receipt Audit Export**");
});

bot.callbackQuery('cmd_broadcast', async (ctx) => {
  await safeAnswer(ctx);
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
  await safeAnswer(ctx);
  const userId = ctx.from.id;
  const lang = userLanguages.get(userId) || 'en';
  const t = STRINGS[lang];

  await ctx.reply(
    t.selectPlan,
    { parse_mode: 'Markdown', reply_markup: getPaymentTypeKeyboard(lang) }
  );
});

bot.callbackQuery(/^paytype_(reg|full)$/, async (ctx) => {
  const planType = ctx.match[1];
  const userId = ctx.from.id;
  const lang = userLanguages.get(userId) || 'en';
  const t = STRINGS[lang];

  await safeAnswer(ctx);
  await ctx.editMessageText(
    t.selectDept,
    { parse_mode: 'Markdown', reply_markup: getDepartmentKeyboard(planType) }
  );
});

bot.callbackQuery('cmd_status', async (ctx) => {
  await safeAnswer(ctx);
  const userId = ctx.from.id;
  const lang = userLanguages.get(userId) || 'en';

  const res = await pool.query(
    'SELECT department, status, rejection_reason, updated_at FROM tickets WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 1',
    [userId]
  );

  if (res.rows.length === 0) {
    const noSubMsg = lang === 'am' 
      ? "ℹ️ እስከ አሁን ምንም ደረሰኝ አላስገቡም። ለማስገባት የታችኛውን ቁልፎች ይጫኑ።"
      : "ℹ️ You have not submitted any payment receipts yet. Use the action panel below to start.";
    return ctx.reply(noSubMsg, { parse_mode: 'Markdown' });
  }

  const ticket = res.rows[0];
  let statusEmoji = "⏳";
  let statusText = lang === 'am' ? "በመጠባበቅ ላይ" : "Pending Review";

  if (ticket.status === 'APPROVED') {
    statusEmoji = "✅";
    statusText = lang === 'am' ? "ተረጋግጧል" : "Approved";
  } else if (ticket.status === 'REJECTED') {
    statusEmoji = "❌";
    statusText = lang === 'am' ? "ውድቅ ተደርጓል" : "Rejected";
  }

  let msg = lang === 'am' 
    ? `📋 **የክፍያዎ ሁኔታ**\n\n• **ትምህርት ክፍል:** ${ticket.department}\n• **ሁኔታ:** ${statusEmoji} **${statusText}**\n`
    : `📋 **Your Payment Status**\n\n• **Department:** ${ticket.department}\n• **Status:** ${statusEmoji} **${statusText}**\n`;
  
  if (ticket.status === 'REJECTED' && ticket.rejection_reason) {
    msg += lang === 'am' 
      ? `• **ምክንያት:** ${ticket.rejection_reason}\n\nእባክዎን አዲስ ደረሰኝ ለመላክ 'ደረሰኝ አስገባ' የሚለውን ይጫኑ።`
      : `• **Reason:** ${ticket.rejection_reason}\n\nTap 'Submit Payment' in the panel to re-upload.`;
  } else if (ticket.status === 'PENDING') {
    msg += lang === 'am' 
      ? `\nየክትትል ቡድኑ ደረሰኝዎን እየገመገመ ነው። እንደተጠናቀቀ እናሳውቅዎታለን።`
      : `\nOur staff team is currently reviewing your receipt. We will notify you here once processed.`;
  }

  await ctx.reply(msg, { parse_mode: 'Markdown' });
});

bot.callbackQuery('cmd_history', async (ctx) => {
  await safeAnswer(ctx);
  const userId = ctx.from.id;
  const lang = userLanguages.get(userId) || 'en';

  const res = await pool.query(
    'SELECT department, status, rejection_reason, created_at FROM tickets WHERE user_id = $1 ORDER BY created_at DESC',
    [userId]
  );

  if (res.rows.length === 0) {
    const noHistory = lang === 'am'
      ? "ℹ️ ምንም የተመዘገበ የክፍያ ታሪክ የለም።"
      : "ℹ️ No payment submission history found.";
    return ctx.reply(noHistory, { parse_mode: 'Markdown' });
  }

  let text = lang === 'am'
    ? `📜 **የክፍያ ታሪክዎት (${res.rows.length}):**\n\n`
    : `📜 **Your Payment History (${res.rows.length}):**\n\n`;

  res.rows.forEach((r, idx) => {
    const dateStr = new Date(r.created_at).toLocaleDateString();
    let statusIcon = "⏳";
    if (r.status === 'APPROVED') statusIcon = "✅";
    if (r.status === 'REJECTED') statusIcon = "❌";

    text += `${idx + 1}. ${statusIcon} **${r.department}**\n`;
    text += `   • Status: ${r.status}\n`;
    text += `   • Date: ${dateStr}\n`;
    if (r.status === 'REJECTED' && r.rejection_reason) {
      text += `   • Reason: ${r.rejection_reason}\n`;
    }
    text += `\n`;
  });

  await ctx.reply(text, { parse_mode: 'Markdown' });
});

bot.callbackQuery('cmd_help', async (ctx) => {
  await safeAnswer(ctx);
  const lang = userLanguages.get(ctx.from.id) || 'en';
  const t = STRINGS[lang];
  await ctx.reply(t.helpText, { parse_mode: 'Markdown' });
});

bot.callbackQuery('start_resubmit', async (ctx) => {
  await safeAnswer(ctx);
  const userId = ctx.from.id;
  const lang = userLanguages.get(userId) || 'en';
  const t = STRINGS[lang];

  pendingDepartments.delete(userId);

  await ctx.reply(
    t.selectPlan,
    { parse_mode: 'Markdown', reply_markup: getPaymentTypeKeyboard(lang) }
  );
});

bot.callbackQuery(/^dept(reg|full)_(.+)$/, async (ctx) => {
  const isFull = ctx.match[1] === 'full';
  const baseDept = ctx.match[2];
  const userId = ctx.from.id;
  const lang = userLanguages.get(userId) || 'en';
  const t = STRINGS[lang];

  const fullTaggedDept = isFull 
    ? `${baseDept} (4-Year Complete)`
    : `${baseDept} (Regular / Term)`;

  pendingDepartments.set(userId, fullTaggedDept);

  await safeAnswer(ctx);
  await ctx.editMessageText(
    t.sendReceiptPrompt.replace('{dept}', fullTaggedDept),
    { parse_mode: 'Markdown' }
  );
});

bot.callbackQuery(/^tr_(\d+)_(.+)$/, async (ctx) => {
  const targetUserId = Number(ctx.match[1]);
  const newDeptTagged = ctx.match[2];
  const staffName = `${ctx.from.first_name || ''} ${ctx.from.last_name || ''}`.trim() || `ID: ${ctx.from.id}`;

  await safeAnswer(ctx);

  const ticketRes = await pool.query('SELECT topic_id, message_id, ticket_msg_id, username FROM tickets WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 1', [targetUserId]);

  if (ticketRes.rows.length > 0) {
    const ticket = ticketRes.rows[0];
    const username = ticket.username || 'Unknown';
    if (ticket.ticket_msg_id) {
      try {
        await ctx.api.deleteMessage(STAFF_GROUP_ID, Number(ticket.ticket_msg_id));
      } catch (e) {
        console.error("Could not delete old ticket message:", e);
      }
    }

    const newTopicId = await getOrCreateDepartmentTopic(ctx, newDeptTagged);

    try {
      await ctx.api.copyMessage(STAFF_GROUP_ID, STAFF_GROUP_ID, Number(ticket.message_id), {
        message_thread_id: newTopicId
      });

      const actionKeyboard = new InlineKeyboard()
        .text("✅ Approve", `app_${targetUserId}_${newTopicId}`).row()
        .text("❌ Reject", `rej_${targetUserId}_${newTopicId}`).row()
        .text("🔄 Transfer Dept", `trans_${targetUserId}`);

      const newTicketMsg = await ctx.api.sendMessage(
        STAFF_GROUP_ID,
        `📥 New Submission\n• Student ID: ${targetUserId}\n• Username: @${username}\n• Department: ${newDeptTagged}`,
        { message_thread_id: newTopicId, reply_markup: actionKeyboard }
      );

      await pool.query(`
        UPDATE tickets 
        SET department = $1, topic_id = $2, ticket_msg_id = $3, updated_at = CURRENT_TIMESTAMP 
        WHERE user_id = $4
      `, [newDeptTagged, newTopicId, newTicketMsg.message_id, targetUserId]);

      try {
        const studentLang = userLanguages.get(targetUserId) || 'en';
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
      console.error("Error moving message during transfer:", e);
    }
  }

  await ctx.editMessageText(
    `🔄 Student receipt (ID: \`${targetUserId}\`) successfully transferred to **${newDeptTagged}** by **${staffName}**.`,
    { parse_mode: 'Markdown' }
  );
});

bot.on('message', async (ctx) => {
  if (ctx.from && ctx.from.is_bot) return;

  const isStaffGroup = String(ctx.chat.id) === STAFF_GROUP_ID;
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
    const lang = userLanguages.get(userId) || 'en';
    const t = STRINGS[lang];

    const activeCheck = await pool.query(
      "SELECT 1 FROM tickets WHERE user_id = $1 AND status = 'PENDING' LIMIT 1",
      [userId]
    );

    if (activeCheck.rows.length > 0) {
      return ctx.reply(t.pendingExists, { parse_mode: 'Markdown' });
    }

    const username = ctx.from.username || ctx.from.first_name || 'Unknown';
    const chosenDeptTagged = pendingDepartments.get(userId) || "General (Regular / Term)";
    
    const fileId = ctx.message.photo 
      ? ctx.message.photo[ctx.message.photo.length - 1].file_id 
      : (ctx.message.document ? ctx.message.document.file_id : null);

    if (!fileId) {
      await ctx.reply(t.noFileErr, { parse_mode: 'Markdown' });
      return;
    }

    try {
      const topicId = await getOrCreateDepartmentTopic(ctx, chosenDeptTagged);

      const forwardRes = await ctx.api.copyMessage(STAFF_GROUP_ID, ctx.chat.id, ctx.message.message_id, {
        message_thread_id: topicId
      });
      const forwardedMsgId = forwardRes.message_id;

      const actionKeyboard = new InlineKeyboard()
        .text("✅ Approve", `app_${userId}_${topicId}`).row()
        .text("❌ Reject", `rej_${userId}_${topicId}`).row()
        .text("🔄 Transfer Dept", `trans_${userId}`);

      const sentTicketMsg = await ctx.api.sendMessage(
        STAFF_GROUP_ID,
        `📥 New Submission\n• Student ID: ${userId}\n• Username: @${username}\n• Department: ${chosenDeptTagged}`,
        { message_thread_id: topicId, reply_markup: actionKeyboard }
      );

      await pool.query(`
        INSERT INTO tickets (user_id, username, receipt_file_id, topic_id, message_id, ticket_msg_id, department, status) 
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'PENDING')
      `, [userId, username, fileId, topicId, forwardedMsgId, sentTicketMsg.message_id, chosenDeptTagged]);

      pendingDepartments.delete(userId);

      await ctx.reply(t.receiptReceived, { parse_mode: 'Markdown' });
    } catch (err) {
      console.error("Failed to forward receipt:", err);
      return ctx.reply(`❌ Error submitting receipt: ${err.message}`);
    }
  }
});

bot.callbackQuery(/^app_(\d+)_(\d+)$/, async (ctx) => {
  const userId = Number(ctx.match[1]);
  const topicId = Number(ctx.match[2]);
  const staffName = `${ctx.from.first_name || ''} ${ctx.from.last_name || ''}`.trim() || `ID: ${ctx.from.id}`;

  await safeAnswer(ctx);
  
  const updateRes = await pool.query(
    "UPDATE tickets SET status = 'APPROVED', processed_by = $1, updated_at = CURRENT_TIMESTAMP WHERE user_id = $2 AND status = 'PENDING' RETURNING department, username",
    [staffName, userId]
  );
  
  if (updateRes.rowCount === 0) {
    return ctx.reply("⚠️ Error: Could not find an active pending ticket record in the database for this user.", { message_thread_id: topicId });
  }

  const deptTag = updateRes.rows[0].department;
  const username = updateRes.rows[0].username || 'N/A';
  const lang = userLanguages.get(userId) || 'en';
  const t = STRINGS[lang];

  try {
    const pdfPath = await generateApprovalPDF(userId, username, deptTag, staffName);
    await ctx.api.sendDocument(
      userId,
      new InputFile(pdfPath, `Tuition_Approval_Slip_${userId}.pdf`),
      { caption: t.approvedMsg, parse_mode: 'Markdown' }
    );
    if (fs.existsSync(pdfPath)) {
      fs.unlinkSync(pdfPath);
    }
  } catch (pdfErr) {
    console.error("Failed to generate or send approval PDF:", pdfErr);
    await ctx.api.sendMessage(userId, t.approvedMsg, { parse_mode: 'Markdown' });
  }

  await ctx.editMessageText(
    `✅ Approved Submission\n• Student ID: ${userId}\n• Username: @${username}\n• Department: ${deptTag}\n• Approved by: ${staffName}`,
    { parse_mode: 'Markdown' }
  );

  if (APPROVED_THREAD_ID) {
    const sortedReport = await generateSummaryText('APPROVED');
    await ctx.api.sendMessage(STAFF_GROUP_ID, sortedReport, { message_thread_id: APPROVED_THREAD_ID, parse_mode: 'Markdown' });
  }
});

bot.callbackQuery(/^rej_(\d+)_(\d+)$/, async (ctx) => {
  const userId = Number(ctx.match[1]);
  const topicId = Number(ctx.match[2]);

  await safeAnswer(ctx);
  await ctx.editMessageText("Select rejection reason:", {
    reply_markup: getRejectionReasonKeyboard(userId, topicId)
  });
});

bot.callbackQuery(/^confirmrej_(\d+)_(\d+)_(.+)$/, async (ctx) => {
  const userId = Number(ctx.match[1]);
  const topicId = Number(ctx.match[2]);
  const reasonCode = ctx.match[3];
  const staffName = `${ctx.from.first_name || ''} ${ctx.from.last_name || ''}`.trim() || `ID: ${ctx.from.id}`;

  const lang = userLanguages.get(userId) || 'en';
  const t = STRINGS[lang];

  const reasonObj = REJECTION_REASONS.find(r => r.code === reasonCode);
  const reasonText = reasonObj ? reasonObj.label : "Receipt details unverified";
  const customMessage = reasonObj ? (lang === 'am' ? reasonObj.message_am : reasonObj.message_en) : "Please re-upload a valid payment receipt.";

  await safeAnswer(ctx);

  const updateRes = await pool.query(
    `UPDATE tickets 
     SET status = 'REJECTED', rejection_reason = $1, processed_by = $2, updated_at = CURRENT_TIMESTAMP 
     WHERE user_id = $3 AND status = 'PENDING' 
     RETURNING department, username`,
    [reasonText, staffName, userId]
  );

  if (updateRes.rowCount === 0) {
    return ctx.reply("⚠️ Error: Could not find an active pending ticket record for this user.", { message_thread_id: topicId });
  }

  const deptTag = updateRes.rows[0].department;
  const username = updateRes.rows[0].username || 'N/A';

  const resubmitKeyboard = new InlineKeyboard().text(t.reuploadBtn, "start_resubmit");

  await ctx.api.sendMessage(
    userId,
    t.rejectedMsg.replace('{reason}', reasonText).replace('{message}', customMessage),
    { parse_mode: 'Markdown', reply_markup: resubmitKeyboard }
  );

  await ctx.editMessageText(
    `❌ Rejected Submission\n• Student ID: ${userId}\n• Username: @${username}\n• Department: ${deptTag}\n• Rejected by: ${staffName}\n• Reason: ${reasonText}`,
    { parse_mode: 'Markdown' }
  );

  if (REJECTED_THREAD_ID) {
    await ctx.api.sendMessage(
      STAFF_GROUP_ID,
      `❌ **REJECTED RECEIPT**\n• Student ID: \`${userId}\`\n• Staff: **${staffName}**\n• Reason: ${reasonText}`,
      { message_thread_id: REJECTED_THREAD_ID, parse_mode: 'Markdown' }
    );
  }
});

bot.callbackQuery(/^trans_(\d+)$/, async (ctx) => {
  const userId = Number(ctx.match[1]);
  await safeAnswer(ctx);
  await ctx.reply("📂 Select new department for transfer:", {
    reply_markup: getTransferKeyboard(userId)
  });
});

cron.schedule('0 8 * * *', async () => {
  try {
    const appSummary = await generateSummaryText('APPROVED');
    const rejSummary = await generateSummaryText('REJECTED');
    
    const pendingRes = await pool.query("SELECT COUNT(*) FROM tickets WHERE status = 'PENDING'");
    const totalPending = pendingRes.rows[0].count;

    const dailyReport = `🌅 **DAILY TUITION PORTAL SUMMARY**\n\n⏳ **Total Pending:** ${totalPending}\n\n---\n\n${appSummary}\n\n---\n\n${rejSummary}`;

    await bot.api.sendMessage(STAFF_GROUP_ID, dailyReport, { message_thread_id: APPROVED_THREAD_ID || null });
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
      { command: 'panel', description: 'Open interactive action panel' }
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
