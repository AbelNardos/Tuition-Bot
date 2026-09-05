const express = require('express');
const app = express();
const port = process.env.PORT || 10000;

app.get('/', (req, res) => {
  res.send('Bot is alive and running!');
});

app.listen(port, '0.0.0.0', () => {
  console.log(`Web server listening on port ${port}`);
});
require('dotenv').config();
const { Bot, InlineKeyboard, InputFile } = require('grammy');
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const bot = new Bot(process.env.BOT_TOKEN);

const STAFF_GROUP_ID = String(process.env.STAFF_GROUP_ID).trim();
const APPROVED_THREAD_ID = process.env.APPROVED_THREAD_ID ? Number(process.env.APPROVED_THREAD_ID) : 0;
const REJECTED_THREAD_ID = process.env.REJECTED_THREAD_ID ? Number(process.env.REJECTED_THREAD_ID) : 0;

const db = new Database('tickets.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS tickets (
    user_id INTEGER,
    topic_id INTEGER,
    message_id INTEGER,
    ticket_msg_id INTEGER,
    department TEXT,
    status TEXT DEFAULT 'PENDING',
    rejection_reason TEXT,
    processed_by TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS department_topics (
    department TEXT PRIMARY KEY,
    topic_id INTEGER
  );
`);

const pendingDepartments = new Map();

const DEPARTMENTS = [
  "Marketing Management",
  "Business Management",
  "Agribusiness and Value chain management",
  "Educational planning and management",
  "Accounting and finance",
  "Logistics and Supply chain management",
  "4-Year Complete Tuition"
];

function getTransferKeyboard(userId) {
  const keyboard = new InlineKeyboard();
  keyboard
    .text("📈 Marketing Mgmt", `tr_${userId}_Marketing Management`)
    .text("💼 Business Mgmt", `tr_${userId}_Business Management`).row()
    .text("🌾 Agribusiness & VCM", `tr_${userId}_Agribusiness and Value chain management`)
    .text("📚 Ed. Planning", `tr_${userId}_Educational planning and management`).row()
    .text("📊 Accounting & Finance", `tr_${userId}_Accounting and finance`)
    .text("🚚 Logistics & SCM", `tr_${userId}_Logistics and Supply chain management`).row()
    .text("🎓 4-Year Complete Tuition", `tr_${userId}_4-Year Complete Tuition`);
  return keyboard;
}

const stmtSaveTicket = db.prepare(`
  INSERT INTO tickets (user_id, topic_id, message_id, ticket_msg_id, department, status) 
  VALUES (?, ?, ?, ?, ?, 'PENDING')
`);

bot.catch((err) => console.error('Error in bot:', err));

async function getOrCreateDepartmentTopic(ctx, department) {
  const cached = db.prepare('SELECT topic_id FROM department_topics WHERE department = ?').get(department);
  if (cached) {
    return cached.topic_id;
  }

  const newTopic = await ctx.api.createForumTopic(STAFF_GROUP_ID, `📁 [${department}]`);
  const topicId = newTopic.message_thread_id;

  db.prepare(`
    INSERT INTO department_topics (department, topic_id) 
    VALUES (?, ?) 
    ON CONFLICT(department) DO UPDATE SET topic_id = excluded.topic_id
  `).run(department, topicId);

  return topicId;
}

function getApprovedByDepartmentText() {
  let output = "📂 **MASTER APPROVED RECEIPTS REPORT**\n\n";
  DEPARTMENTS.forEach((dept) => {
    const records = db.prepare(`
      SELECT user_id, processed_by, updated_at 
      FROM tickets 
      WHERE status = 'APPROVED' AND department = ?
      ORDER BY updated_at DESC
    `).all(dept);

    output += `📂 **${dept}** (${records.length})\n`;
    if (records.length === 0) {
      output += `  └ _No approved receipts yet_\n\n`;
    } else {
      records.forEach((r) => {
        const staff = r.processed_by ? ` (Approved by: ${r.processed_by})` : "";
        output += `  ├ User ID: \`${r.user_id}\`${staff}\n`;
      });
      output += `\n`;
    }
  });
  return output;
}

function generateSummaryText(statusType) {
  const rows = db.prepare(`
    SELECT department, COUNT(*) as count 
    FROM tickets 
    WHERE status = ? 
    GROUP BY department 
    ORDER BY department ASC
  `).all(statusType);

  const icon = statusType === 'APPROVED' ? '✅' : '❌';
  let text = `📊 **${icon} ${statusType} RECEIPTS SUMMARY**\n\n`;
  if (rows.length === 0) {
    text += `_No ${statusType.toLowerCase()} receipts recorded yet._`;
    return text;
  }
  rows.forEach((r) => {
    text += `• **${r.department}**: ${r.count} student(s)\n`;
  });
  return text;
}

async function sendCSVExport(threadId, captionText) {
  try {
    const records = db.prepare(`
      SELECT user_id, department, status, rejection_reason, processed_by, created_at, updated_at 
      FROM tickets 
      ORDER BY department ASC, status ASC, updated_at DESC
    `).all();

    if (records.length === 0) {
      return bot.api.sendMessage(STAFF_GROUP_ID, "⚠️ No receipts found to export.", { message_thread_id: threadId });
    }

    let csv = "Student Telegram ID,Department,Status,Rejection Reason,Processed By,Created At,Updated At\n";
    records.forEach((r) => {
      const reason = r.rejection_reason ? `"${r.rejection_reason.replace(/"/g, '""')}"` : "";
      const staff = r.processed_by ? `"${r.processed_by.replace(/"/g, '""')}"` : "";
      csv += `${r.user_id},"${r.department}",${r.status},${reason},${staff},${r.created_at},${r.updated_at}\n`;
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
  await ctx.reply(
    "👋 **Welcome to the Tuition Payment Portal!**\n\nPlease select your **Department** below before sending your receipt and details:",
    { parse_mode: 'Markdown', reply_markup: getDepartmentKeyboard() }
  );
});

bot.callbackQuery('start_resubmit', async (ctx) => {
  await ctx.answerCallbackQuery();
  pendingDepartments.delete(ctx.from.id);
  await ctx.reply(
    "🔄 **Re-submitting Receipt**\nPlease choose your department to initiate a new submission:",
    { parse_mode: 'Markdown', reply_markup: getDepartmentKeyboard() }
  );
});

bot.callbackQuery(/^dept_(.+)$/, async (ctx) => {
  const selectedDept = ctx.match[1];
  const userId = ctx.from.id;
  
  pendingDepartments.set(userId, selectedDept);

  await ctx.answerCallbackQuery();
  await ctx.editMessageText(
    `✅ Selected Department: **${selectedDept}**\n\nNow, please send your receipt photo or screenshot with your Full Name and Student ID.`,
    { parse_mode: 'Markdown' }
  );
});

bot.callbackQuery(/^tr_(\d+)_(.+)$/, async (ctx) => {
  const targetUserId = Number(ctx.match[1]);
  const newDept = ctx.match[2];
  const staffName = `${ctx.from.first_name || ''} ${ctx.from.last_name || ''}`.trim() || `ID: ${ctx.from.id}`;

  await ctx.answerCallbackQuery();

  const ticket = db.prepare('SELECT topic_id, message_id, ticket_msg_id FROM tickets WHERE user_id = ? ORDER BY updated_at DESC LIMIT 1').get(targetUserId);

  if (ticket) {
    if (ticket.ticket_msg_id) {
      try {
        await ctx.api.deleteMessage(STAFF_GROUP_ID, ticket.ticket_msg_id);
      } catch (e) {
        console.error("Could not delete old ticket message:", e);
      }
    }

    const newTopicId = await getOrCreateDepartmentTopic(ctx, newDept);

    try {
      await ctx.api.copyMessage(STAFF_GROUP_ID, STAFF_GROUP_ID, ticket.message_id, {
        message_thread_id: newTopicId
      });

      const actionKeyboard = new InlineKeyboard()
        .text("✅ Approve", `app_${targetUserId}_${newTopicId}`).row()
        .text("❌ Reject", `rej_${targetUserId}_${newTopicId}`).row()
        .text("🔄 Transfer Dept", `trans_${targetUserId}`);

      const newTicketMsg = await ctx.api.sendMessage(
        STAFF_GROUP_ID,
        `📥 **Transferred Submission**\n• Student ID: \`${targetUserId}\`\n• Department: **${newDept}**\n• Transferred by: **${staffName}**`,
        { message_thread_id: newTopicId, parse_mode: 'Markdown', reply_markup: actionKeyboard }
      );

      db.prepare('UPDATE tickets SET department = ?, topic_id = ?, ticket_msg_id = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? ORDER BY updated_at DESC LIMIT 1').run(newDept, newTopicId, newTicketMsg.message_id, targetUserId);

    } catch (e) {
      console.error("Error moving message during transfer:", e);
    }
  }

  await ctx.editMessageText(
    `🔄 Student receipt successfully transferred to **${newDept}** by **${staffName}**.`,
    { parse_mode: 'Markdown' }
  );
});

bot.on('message', async (ctx) => {
  if (ctx.from && ctx.from.is_bot) return;

  const isStaffGroup = String(ctx.chat.id) === STAFF_GROUP_ID;
  if (!isStaffGroup && ctx.message.text && ctx.message.text.startsWith('/')) return;

  if (!isStaffGroup) {
    const userId = ctx.from.id;
    const chosenDept = pendingDepartments.get(userId) || "4-Year Complete Tuition";

    try {
      const topicId = await getOrCreateDepartmentTopic(ctx, chosenDept);

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
        `📥 **New Submission**\n• Student ID: \`${userId}\`\n• Department: **${chosenDept}**`,
        { message_thread_id: topicId, parse_mode: 'Markdown', reply_markup: actionKeyboard }
      );

      stmtSaveTicket.run(userId, topicId, forwardedMsgId, sentTicketMsg.message_id, chosenDept);

      pendingDepartments.delete(userId);
      await ctx.reply("✅ Your receipt has been sent to the staff review team. We will notify you once verified.", { parse_mode: 'Markdown' });
    } catch (err) {
      console.error("Failed to forward receipt:", err);
      return ctx.reply("Error submitting receipt. Please try again later.");
    }
  } 
  else if (isStaffGroup) {
    const topicId = ctx.message.message_thread_id; 
    const text = (ctx.message.text || "").trim();
    const lowerText = text.toLowerCase();

    if (lowerText === 'stats' || lowerText === '/stats') {
      const appSummary = generateSummaryText('APPROVED');
      const rejSummary = generateSummaryText('REJECTED');
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
  db.prepare("UPDATE tickets SET status = 'APPROVED', processed_by = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND topic_id = ?").run(staffName, userId, topicId);

  await ctx.api.sendMessage(
    userId,
    `✅ **Receipt Verified!**\nYour payment submission has been approved. Thank you!`,
    { parse_mode: 'Markdown' }
  );

  await ctx.editMessageText(`✅ Receipt approved by **${staffName}**.`, { parse_mode: 'Markdown' });

  if (APPROVED_THREAD_ID) {
    const sortedReport = getApprovedByDepartmentText();
    await ctx.api.sendMessage(STAFF_GROUP_ID, sortedReport, { message_thread_id: APPROVED_THREAD_ID, parse_mode: 'Markdown' });
  }
});

bot.callbackQuery(/^rej_(\d+)_(\d+)$/, async (ctx) => {
  const userId = Number(ctx.match[1]);
  const topicId = Number(ctx.match[2]);
  const staffName = `${ctx.from.first_name || ''} ${ctx.from.last_name || ''}`.trim() || `ID: ${ctx.from.id}`;

  await ctx.answerCallbackQuery();
  db.prepare("UPDATE tickets SET status = 'REJECTED', processed_by = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND topic_id = ?").run(staffName, userId, topicId);

  const resubmitKeyboard = new InlineKeyboard().text("🔄 Re-upload Receipt", "start_resubmit");

  await ctx.api.sendMessage(
    userId,
    `❌ **Receipt Rejected**\n\nPlease click below to upload a clear screenshot or receipt photo.`,
    { parse_mode: 'Markdown', reply_markup: resubmitKeyboard }
  );

  await ctx.editMessageText(`❌ Receipt rejected by **${staffName}**.`, { parse_mode: 'Markdown' });

  if (REJECTED_THREAD_ID) {
    await ctx.api.sendMessage(
      STAFF_GROUP_ID,
      `❌ **REJECTED RECEIPT**\n• Student ID: \`${userId}\`\n• Staff: **${staffName}**`,
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

async function main() {
  await bot.api.deleteWebhook({ drop_pending_updates: true });
  console.log("Tuition Receipt Bot is online and ready!");
  bot.start();
}

main();
