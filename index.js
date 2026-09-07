require('dotenv').config();
const express = require('express');
const { Bot, InlineKeyboard, InputFile, webhookCallback } = require('grammy');
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const https = require('https');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;
const bot = new Bot(process.env.BOT_TOKEN);

const STAFF_GROUP_ID = String(process.env.STAFF_GROUP_ID || '').trim();
const APPROVED_THREAD_ID = process.env.APPROVED_THREAD_ID ? Number(process.env.APPROVED_THREAD_ID) : null;
const REJECTED_THREAD_ID = process.env.REJECTED_THREAD_ID ? Number(process.env.REJECTED_THREAD_ID) : null;

// Global process crash prevention handlers
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception thrown:', err);
});

// Internal Self-Ping Service (Keeps Render instance warm)
setInterval(() => {
  const RENDER_URL = process.env.RENDER_EXTERNAL_URL;
  if (RENDER_URL) {
    https.get(`${RENDER_URL}/`, (res) => {
      console.log(`Keep-alive ping status: ${res.statusCode}`);
    }).on('error', (err) => {
      console.error('Keep-alive ping error:', err.message);
    });
  }
}, 8 * 60 * 1000); // Self-pings every 8 minutes

// PostgreSQL Connection
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

const pendingDepartments = new Map();
const userLanguages = new Map(); // Stores userId -> 'en' | 'am'
const pendingConfirmations = new Map(); // Stores userId -> { fileId, department, originalMsgId }

const DEPARTMENTS = [
  "Marketing Management",
  "Business Management",
  "Agribusiness and Value chain management",
  "Educational planning and management",
  "Accounting and finance",
  "Logistics and Supply chain management",
  "4-Year Complete Tuition"
];

// Localized UI Dictionary
const STRINGS = {
  en: {
    welcome: "👋 **Welcome to the Tuition Payment Portal!**\n\nPlease select your **Department** below before sending your receipt and details:",
    selectDept: "Please select your department:",
    receiptReceived: "✅ Your receipt has been sent to the staff review team. We will notify you once verified.",
    sendReceiptPrompt: "✅ Selected Department: **{dept}**\n\nNow, please send your receipt photo or screenshot with your Full Name and Student ID.",
    reuploadPrompt: "🔄 **Re-submitting Receipt**\nPlease choose your department to initiate a new submission:",
    approvedMsg: "✅ **Receipt Verified!**\nYour payment submission has been approved. Thank you!",
    rejectedMsg: "❌ **Receipt Rejected**\n\n**Reason:** {reason}\n\n{message}",
    reuploadBtn: "🔄 Re-upload Receipt",
    noFileErr: "⚠️ Please send an actual **photo or screenshot** of your payment receipt. Text-only messages cannot be processed as receipts.",
    deptUpdated: "🔄 **Department Updated**\nYour receipt submission has been transferred to **{dept}**. Our review team will process your payment under this department."
  },
  am: {
    welcome: "👋 **እንኳን ወደ ክፍያ መላኪያ ቦት በሰላም መጡ!**\n\nእባክዎን ደረሰኝዎን ከመላክዎ በፊት **ትምህርት ክፍልዎን (Department)** ይምረጡ፡",
    selectDept: "እባክዎን ትምህርት ክፍልዎን ይምረጡ፡",
    receiptReceived: "✅ ደረሰኝዎ ለክትትል ቡድኑ ተልኳል። እንደተረጋገጠ እናሳውቅዎታለን።",
    sendReceiptPrompt: "✅ የተመረጠው ትምህርት ክፍል፡ **{dept}**\n\nአሁን እባክዎን የክፍያ ደረሰኝ ፎቶዎን ከሙሉ ስምዎ እና የተማሪ ID ጋር ይላኩ።",
    reuploadPrompt: "🔄 **ደረሰኝ እንደገና መላክ**\nእባክዎን አዲስ ማመልከቻ ለመጀመር ትምህርት ክፍልዎን ይምረጡ፡",
    approvedMsg: "✅ **ደረሰኝዎ ተረጋግጧል!**\nየክፍያ ማረጋገጫዎ ጸድቋል። እናመሰግናለን!",
    rejectedMsg: "❌ **ደረሰኝዎ ውድቅ ተደርጓል**\n\n**ምክንያት:** {reason}\n\n{message}",
    reuploadBtn: "🔄 ደረሰኝ እንደገና ስቀል",
    noFileErr: "⚠️ እባክዎን ትክክለኛ የክፍያ ደረሰኝ **ፎቶ ወይም ስክሪንሾት** ይላኩ። በጽሁፍ ብቻ የሚላክ መረጃ አይቀበልም።",
    deptUpdated: "🔄 **ትምህርት ክፍል ተቀይሯል**\nየደረሰኝ ማመልከቻዎ ወደ **{dept}** ተዛውሯል። መረጃዎ በዚህ ትምህርት ክፍል ስር የሚታይ ይሆናል።"
  }
};

// Rejection Reasons with Context-Specific Guidance in EN & AM
const REJECTION_REASONS = [
  { 
    label: "📷 Blurry/Unreadable Receipt", 
    code: "blurry",
    message_en: "Please ensure your receipt image is clear, fully visible, and uncropped, then click below to re-upload.",
    message_am: "እባክዎን የደረሰኝዎ ፎቶ ግልጽ፣ ሙሉ በሙሉ የሚታይ እና ያልተቆረጠ መሆኑን አረጋግጠው እንደገና ይላኩ።"
  },
  { 
    label: "💵 Incorrect Amount Paid", 
    code: "amount",
    message_en: "The payment amount does not match your required tuition fees. Please verify your transaction details and re-upload the correct receipt.",
    message_am: "የተከፈለው የገንዘብ መጠን ከተፈለገው የትምህርት ክፍያ ጋር አይመሳሰልም። እባክዎን የትራንዛክሽን መረጃዎን አረጋግጠው ትክክለኛውን ደረሰኝ ይላኩ።"
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

function getTransferKeyboard(userId) {
  return new InlineKeyboard()
    .text("📈 Marketing Mgmt", `tr_${userId}_Marketing Management`)
    .text("💼 Business Mgmt", `tr_${userId}_Business Management`).row()
    .text("🌾 Agribusiness & VCM", `tr_${userId}_Agribusiness and Value chain management`)
    .text("📚 Ed. Planning", `tr_${userId}_Educational planning and management`).row()
    .text("📊 Accounting & Finance", `tr_${userId}_Accounting and finance`)
    .text("🚚 Logistics & SCM", `tr_${userId}_Logistics and Supply chain management`).row()
    .text("🎓 4-Year Complete Tuition", `tr_${userId}_4-Year Complete Tuition`);
}

function getRejectionReasonKeyboard(userId, topicId) {
  const kb = new InlineKeyboard();
  REJECTION_REASONS.forEach((r) => {
    kb.text(r.label, `confirmrej_${userId}_${topicId}_${r.code}`).row();
  });
  return kb;
}

bot.catch((err) => console.error('Error in bot framework:', err));

async function getOrCreateDepartmentTopic(ctx, department) {
  const cached = await pool.query('SELECT topic_id FROM department_topics WHERE department = $1', [department]);
  if (cached.rows.length > 0) {
    return Number(cached.rows[0].topic_id);
  }

  const newTopic = await ctx.api.createForumTopic(STAFF_GROUP_ID, `📁 [${department}]`);
  const topicId = newTopic.message_thread_id;

  await pool.query(`
    INSERT INTO department_topics (department, topic_id) 
    VALUES ($1, $2) 
    ON CONFLICT(department) DO UPDATE SET topic_id = EXCLUDED.topic_id
  `, [department, topicId]);

  return topicId;
}

async function getApprovedByDepartmentText() {
  let output = "📂 **MASTER APPROVED RECEIPTS REPORT**\n\n";
  for (const dept of DEPARTMENTS) {
    const res = await pool.query(`
      SELECT user_id, processed_by, updated_at 
      FROM tickets 
      WHERE status = 'APPROVED' AND department = $1
      ORDER BY updated_at DESC
    `, [dept]);

    output += `📂 **${dept}** (${res.rows.length})\n`;
    if (res.rows.length === 0) {
      output += `  └ _No approved receipts yet_\n\n`;
    } else {
      res.rows.forEach((r) => {
        const staff = r.processed_by ? ` (Approved by: ${r.processed_by})` : "";
        output += `  ├ User ID: \`${r.user_id}\`${staff}\n`;
      });
      output += `\n`;
    }
  }
  return output;
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

    let csv = "Student Telegram ID,Username,Department,Status,Rejection Reason,Processed By,Created At,Updated At\n";
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

function getDepartmentKeyboard() {
  return new InlineKeyboard()
    .text("Marketing Management", "dept_Marketing Management").row()
    .text("Business Management", "dept_Business Management").row()
    .text("Agribusiness and Value chain management", "dept_Agribusiness and Value chain management").row()
    .text("Educational planning and management", "dept_Educational planning and management").row()
    .text("Accounting and finance", "dept_Accounting and finance").row()
    .text("Logistics and Supply chain management", "dept_Logistics and Supply chain management").row()
    .text("4-Year Complete Tuition", "dept_4-Year Complete Tuition");
}

bot.command('start', async (ctx) => {
  pendingDepartments.delete(ctx.from.id);
  pendingConfirmations.delete(ctx.from.id);

  const langKeyboard = new InlineKeyboard()
    .text("🇬🇧 English", "lang_en")
    .text("🇪🇹 አማርኛ", "lang_am");

  await ctx.reply(
    "🌐 **Please select your language / እባክዎን ቋንቋ ይምረጡ:**",
    { parse_mode: 'Markdown', reply_markup: langKeyboard }
  );
});

bot.callbackQuery(/^lang_(en|am)$/, async (ctx) => {
  const lang = ctx.match[1];
  userLanguages.set(ctx.from.id, lang);

  await ctx.answerCallbackQuery();

  const t = STRINGS[lang];
  await ctx.editMessageText(
    t.welcome,
    { parse_mode: 'Markdown', reply_markup: getDepartmentKeyboard() }
  );
});

bot.command('status', async (ctx) => {
  const isStaffGroup = String(ctx.chat.id) === STAFF_GROUP_ID;
  if (isStaffGroup) return;

  const userId = ctx.from.id;
  const lang = userLanguages.get(userId) || 'en';

  const res = await pool.query(
    'SELECT department, status, rejection_reason, updated_at FROM tickets WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 1',
    [userId]
  );

  if (res.rows.length === 0) {
    const noSubMsg = lang === 'am' 
      ? "ℹ️ እስከ አሁን ምንም ደረሰኝ አላስገቡም። ለማስገባት /start ን ይጫኑ።"
      : "ℹ️ You have not submitted any payment receipts yet. Use /start to begin a submission.";
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
      ? `• **ምክንያት:** ${ticket.rejection_reason}\n\nእባክዎን እንደገና ለመላክ /start ን ይጫኑ።`
      : `• **Reason:** ${ticket.rejection_reason}\n\nType /start or re-upload a clear receipt to resubmit.`;
  } else if (ticket.status === 'PENDING') {
    msg += lang === 'am' 
      ? `\nየክትትል ቡድኑ ደረሰኝዎን እየገመገመ ነው። እንደተጠናቀቀ እናሳውቅዎታለን።`
      : `\nOur staff team is currently reviewing your receipt. We will notify you here once processed.`;
  }

  await ctx.reply(msg, { parse_mode: 'Markdown' });
});

bot.callbackQuery('start_resubmit', async (ctx) => {
  await ctx.answerCallbackQuery();
  const userId = ctx.from.id;
  const lang = userLanguages.get(userId) || 'en';
  const t = STRINGS[lang];

  pendingDepartments.delete(userId);
  pendingConfirmations.delete(userId);
  await ctx.reply(
    t.reuploadPrompt,
    { parse_mode: 'Markdown', reply_markup: getDepartmentKeyboard() }
  );
});

bot.callbackQuery(/^dept_(.+)$/, async (ctx) => {
  const selectedDept = ctx.match[1];
  const userId = ctx.from.id;
  const lang = userLanguages.get(userId) || 'en';
  const t = STRINGS[lang];
  
  pendingDepartments.set(userId, selectedDept);

  await ctx.answerCallbackQuery();
  await ctx.editMessageText(
    t.sendReceiptPrompt.replace('{dept}', selectedDept),
    { parse_mode: 'Markdown' }
  );
});

// Photo upload handler with confirmation preview
bot.on('message:photo', async (ctx) => {
  const isStaffGroup = String(ctx.chat.id) === STAFF_GROUP_ID;
  if (isStaffGroup) return;

  const userId = ctx.from.id;
  const lang = userLanguages.get(userId) || 'en';
  const chosenDept = pendingDepartments.get(userId);

  if (!chosenDept) {
    const msg = lang === 'am' 
      ? "⚠️ እባክዎን አስቀድመው /start በመጫን ትምህርት ክፍልዎን ይምረጡ።"
      : "⚠️ Please select your department first by typing /start.";
    return ctx.reply(msg);
  }

  const fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;

  // Save temp confirmation data
  pendingConfirmations.set(userId, {
    fileId: fileId,
    department: chosenDept,
    originalMsgId: ctx.message.message_id
  });

  const confirmKb = new InlineKeyboard()
    .text(lang === 'am' ? "✅ አረጋግጥ እና ላክ" : "✅ Confirm & Submit", "confirm_student_upload")
    .row()
    .text(lang === 'am' ? "🔄 እንደገና ምረጽ" : "🔄 Change Dept / Retake", "start_resubmit");

  const previewText = lang === 'am'
    ? `📋 **እባክዎን ማመልከቻዎን ያረጋግጡ**\n\n• **ትምህርት ክፍል:** ${chosenDept}\n• **የተማሪ ID:** \`${userId}\`\n\nይህ ደረሰኝ ለክትትል ቡድኑ እንዲላክ ይፈልጋሉ?`
    : `📋 **Please Confirm Your Submission**\n\n• **Department:** ${chosenDept}\n• **Student ID:** \`${userId}\`\n\nAre you ready to submit this receipt for review?`;

  await ctx.replyWithPhoto(fileId, {
    caption: previewText,
    parse_mode: 'Markdown',
    reply_markup: confirmKb
  });
});

// Final receipt confirmation processor
bot.callbackQuery('confirm_student_upload', async (ctx) => {
  const userId = ctx.from.id;
  const username = ctx.from.username || ctx.from.first_name || 'Unknown';
  const lang = userLanguages.get(userId) || 'en';
  const t = STRINGS[lang];

  const pendingData = pendingConfirmations.get(userId);

  if (!pendingData) {
    await ctx.answerCallbackQuery({ text: "Session expired. Please re-upload your receipt.", show_alert: true });
    return;
  }

  await ctx.answerCallbackQuery();

  try {
    const topicId = await getOrCreateDepartmentTopic(ctx, pendingData.department);

    const forwardRes = await ctx.api.copyMessage(STAFF_GROUP_ID, ctx.chat.id, pendingData.originalMsgId, {
      message_thread_id: topicId
    });

    const actionKeyboard = new InlineKeyboard()
      .text("✅ Approve", `app_${userId}_${topicId}`).row()
      .text("❌ Reject", `rej_${userId}_${topicId}`).row()
      .text("🔄 Transfer Dept", `trans_${userId}`);

    const sentTicketMsg = await ctx.api.sendMessage(
      STAFF_GROUP_ID,
      `📥 New Submission\n• Student ID: ${userId}\n• Username: @${username}\n• Department: ${pendingData.department}`,
      { message_thread_id: topicId, reply_markup: actionKeyboard }
    );

    await pool.query(`
      INSERT INTO tickets (user_id, username, receipt_file_id, topic_id, message_id, ticket_msg_id, department, status) 
      VALUES ($1, $2, $3, $4, $5, $6, $7, 'PENDING')
    `, [userId, username, pendingData.fileId, topicId, forwardRes.message_id, sentTicketMsg.message_id, pendingData.department]);

    pendingDepartments.delete(userId);
    pendingConfirmations.delete(userId);

    await ctx.editMessageCaption({
      caption: t.receiptReceived,
      parse_mode: 'Markdown'
    });

  } catch (err) {
    console.error("Failed to forward confirmed receipt:", err);
    await ctx.reply(`❌ Error submitting receipt: ${err.message}`);
  }
});

bot.callbackQuery(/^tr_(\d+)_(.+)$/, async (ctx) => {
  const targetUserId = Number(ctx.match[1]);
  const newDept = ctx.match[2];
  const staffName = `${ctx.from.first_name || ''} ${ctx.from.last_name || ''}`.trim() || `ID: ${ctx.from.id}`;

  await ctx.answerCallbackQuery();

  const ticketRes = await pool.query('SELECT topic_id, message_id, ticket_msg_id FROM tickets WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 1', [targetUserId]);

  if (ticketRes.rows.length > 0) {
    const ticket = ticketRes.rows[0];
    if (ticket.ticket_msg_id) {
      try {
        await ctx.api.deleteMessage(STAFF_GROUP_ID, Number(ticket.ticket_msg_id));
      } catch (e) {
        console.error("Could not delete old ticket message:", e);
      }
    }

    const newTopicId = await getOrCreateDepartmentTopic(ctx, newDept);

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
        `📥 New Transferred Submission\n• Student ID: ${targetUserId}\n• Department: ${newDept}\n• Transferred by: ${staffName}`,
        { message_thread_id: newTopicId, reply_markup: actionKeyboard }
      );

      await pool.query(`
        UPDATE tickets 
        SET department = $1, topic_id = $2, ticket_msg_id = $3, updated_at = CURRENT_TIMESTAMP 
        WHERE user_id = $4
      `, [newDept, newTopicId, newTicketMsg.message_id, targetUserId]);

      try {
        const studentLang = userLanguages.get(targetUserId) || 'en';
        const t = STRINGS[studentLang];
        await ctx.api.sendMessage(
          targetUserId,
          t.deptUpdated.replace('{dept}', newDept),
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
    `🔄 Student receipt (ID: \`${targetUserId}\`) successfully transferred to **${newDept}** by **${staffName}**.`,
    { parse_mode: 'Markdown' }
  );
});

bot.on('message', async (ctx) => {
  if (ctx.from && ctx.from.is_bot) return;

  const isStaffGroup = String(ctx.chat.id) === STAFF_GROUP_ID;

  if (!isStaffGroup) {
    const lang = userLanguages.get(ctx.from.id) || 'en';
    const t = STRINGS[lang];

    if (ctx.message.text && ctx.message.text.startsWith('/')) return;

    // Direct text message handler warning
    if (!ctx.message.photo) {
      await ctx.reply(t.noFileErr, { parse_mode: 'Markdown' });
      return;
    }
  } 
  else if (isStaffGroup) {
    const topicId = ctx.message.message_thread_id; 
    const text = (ctx.message.text || "").trim();
    const lowerText = text.toLowerCase();

    if (lowerText === 'stats' || lowerText === '/stats') {
      const appSummary = await generateSummaryText('APPROVED');
      const rejSummary = await generateSummaryText('REJECTED');
      return ctx.reply(`${appSummary}\n\n---\n\n${rejSummary}`, { message_thread_id: topicId, parse_mode: 'Markdown' });
    }

    if (lowerText === 'export' || lowerText === '/export') {
      return sendCSVExport(topicId, "📄 **Receipt Audit Export**");
    }
  }
});

bot.callbackQuery(/^app_(\d+)_(\d+)$/, async (ctx) => {
  const userId = Number(ctx.match[1]);
  const topicId = Number(ctx.match[2]);
  const staffName = `${ctx.from.first_name || ''} ${ctx.from.last_name || ''}`.trim() || `ID: ${ctx.from.id}`;

  await ctx.answerCallbackQuery();
  
  const updateRes = await pool.query(
    "UPDATE tickets SET status = 'APPROVED', processed_by = $1, updated_at = CURRENT_TIMESTAMP WHERE user_id = $2 AND status = 'PENDING'",
    [staffName, userId]
  );
  
  if (updateRes.rowCount === 0) {
    return ctx.reply("⚠️ Error: Could not find an active pending ticket record in the database for this user.", { message_thread_id: topicId });
  }

  const lang = userLanguages.get(userId) || 'en';
  const t = STRINGS[lang];

  await ctx.api.sendMessage(
    userId,
    t.approvedMsg,
    { parse_mode: 'Markdown' }
  );

  await ctx.editMessageText(`✅ Receipt approved by **${staffName}**.`, { parse_mode: 'Markdown' });

  if (APPROVED_THREAD_ID) {
    const sortedReport = await getApprovedByDepartmentText();
    await ctx.api.sendMessage(STAFF_GROUP_ID, sortedReport, { message_thread_id: APPROVED_THREAD_ID, parse_mode: 'Markdown' });
  }
});

bot.callbackQuery(/^rej_(\d+)_(\d+)$/, async (ctx) => {
  const userId = Number(ctx.match[1]);
  const topicId = Number(ctx.match[2]);

  await ctx.answerCallbackQuery();
  await ctx.reply("Select rejection reason:", {
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

  await ctx.answerCallbackQuery();

  const updateRes = await pool.query(
    `UPDATE tickets 
     SET status = 'REJECTED', rejection_reason = $1, processed_by = $2, updated_at = CURRENT_TIMESTAMP 
     WHERE user_id = $3 AND status = 'PENDING'`,
    [reasonText, staffName, userId]
  );

  if (updateRes.rowCount === 0) {
    return ctx.reply("⚠️ Error: Could not find an active pending ticket record for this user.", { message_thread_id: topicId });
  }

  const resubmitKeyboard = new InlineKeyboard().text(t.reuploadBtn, "start_resubmit");

  await ctx.api.sendMessage(
    userId,
    t.rejectedMsg.replace('{reason}', reasonText).replace('{message}', customMessage),
    { parse_mode: 'Markdown', reply_markup: resubmitKeyboard }
  );

  await ctx.editMessageText(`❌ Receipt rejected by **${staffName}**.\n**Reason:** ${reasonText}`, { parse_mode: 'Markdown' });

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
  await ctx.answerCallbackQuery();
  await ctx.reply("📂 Select new department for transfer:", {
    reply_markup: getTransferKeyboard(userId)
  });
});

// Express Webhook Handling
app.use('/webhook', webhookCallback(bot, 'express'));

app.get('/', (req, res) => {
  res.send('Tuition Receipt Bot is active');
});

async function main() {
  await initDB();

  const RENDER_EXTERNAL_URL = process.env.RENDER_EXTERNAL_URL; 
  if (RENDER_EXTERNAL_URL) {
    const webhookUrl = `${RENDER_EXTERNAL_URL}/webhook`;
    await bot.api.setWebhook(webhookUrl, { drop_pending_updates: true });
    console.log(`Webhook successfully bound to: ${webhookUrl}`);
  }

  app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
    console.log("Tuition Receipt Bot is online and ready!");
  });
}

main();
