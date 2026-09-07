require('dotenv').config();
const { Bot, InlineKeyboard } = require('grammy');
const { Pool } = require('pg');

// 1. Initialize Bot & Database Connection Pool
const bot = new Bot(process.env.BOT_TOKEN);
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const STAFF_GROUP_ID = process.env.STAFF_GROUP_ID; // e.g., "-100123456789"

// --- KEYBOARD LAYOUT BUILDERS ---

// Staff Action Panel (for group chat)
function getStaffKeyboard() {
  return new InlineKeyboard()
    .text('🔍 Search Record', 'cmd_lookfor')
    .text('📊 Statistics', 'cmd_stats')
    .row()
    .text('📄 Export CSV', 'cmd_export')
    .text('📢 Broadcast', 'cmd_broadcast');
}

// Student Action Panel (for private chat)
function getStudentKeyboard() {
  return new InlineKeyboard()
    .text('📤 Submit Payment', 'cmd_submit')
    .text('📌 Check Status', 'cmd_status')
    .row()
    .text('📜 My History', 'cmd_history')
    .text('❓ Help / Support', 'cmd_help');
}

// --- COMMAND HANDLERS ---

// Unified /start and /panel Command
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
    return ctx.reply(
      "👋 **Welcome to Renaissance Global Student Portal**\n\nSelect an option below to manage your tuition submissions:",
      {
        parse_mode: 'Markdown',
        reply_markup: getStudentKeyboard()
      }
    );
  }
});

// --- STAFF CALLBACK BUTTON ACTIONS ---

// 1. Staff Search Trigger
bot.callbackQuery('cmd_lookfor', async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.reply(
    "🔍 **Search Student Record**\n\nReply directly to this message with a **User ID**, **@username**, or **Department**.",
    {
      message_thread_id: ctx.callbackQuery.message.message_thread_id,
      parse_mode: 'Markdown',
      reply_markup: { force_reply: true }
    }
  );
});

// 2. Staff Statistics Trigger
bot.callbackQuery('cmd_stats', async (ctx) => {
  await ctx.answerCallbackQuery();
  const topicId = ctx.callbackQuery.message.message_thread_id;

  try {
    const totalRes = await pool.query(`SELECT COUNT(*) FROM tickets`);
    const appRes = await pool.query(`SELECT COUNT(*) FROM tickets WHERE status = 'APPROVED'`);
    const rejRes = await pool.query(`SELECT COUNT(*) FROM tickets WHERE status = 'REJECTED'`);
    const pendRes = await pool.query(`SELECT COUNT(*) FROM tickets WHERE status = 'PENDING'`);

    const total = parseInt(totalRes.rows[0].count) || 0;
    const approved = parseInt(appRes.rows[0].count) || 0;
    const rejected = parseInt(rejRes.rows[0].count) || 0;
    const pending = parseInt(pendRes.rows[0].count) || 0;

    const text = 
      `📊 **APPROVALS & REJECTIONS SUMMARY**\n\n` +
      `• **Total Submissions:** ${total}\n` +
      `• ✅ **Approved:** ${approved}\n` +
      `• ❌ **Rejected:** ${rejected}\n` +
      `• ⏳ **Pending Review:** ${pending}`;

    await ctx.reply(text, { message_thread_id: topicId, parse_mode: 'Markdown' });
  } catch (err) {
    console.error('Stats Error:', err);
    await ctx.reply("⚠️ Error fetching statistics.", { message_thread_id: topicId });
  }
});

// 3. Staff Export CSV Trigger
bot.callbackQuery('cmd_export', async (ctx) => {
  await ctx.answerCallbackQuery();
  const topicId = ctx.callbackQuery.message.message_thread_id;
  await handleExportCSV(ctx, topicId);
});

// 4. Staff Broadcast Trigger
bot.callbackQuery('cmd_broadcast', async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.reply(
    "📢 **Send Student Announcement**\n\nReply directly to this message with the exact text or announcement photo you want to send to all registered students.",
    {
      message_thread_id: ctx.callbackQuery.message.message_thread_id,
      parse_mode: 'Markdown',
      reply_markup: { force_reply: true }
    }
  );
});

// --- STUDENT CALLBACK BUTTON ACTIONS ---

// 1. Student Submit Payment
bot.callbackQuery('cmd_submit', async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.reply(
    "📸 **Submit Payment Receipt**\n\nPlease reply directly to this message with a **photo or PDF** of your bank deposit receipt.",
    { parse_mode: 'Markdown', reply_markup: { force_reply: true } }
  );
});

// 2. Student Check Status
bot.callbackQuery('cmd_status', async (ctx) => {
  await ctx.answerCallbackQuery();

  try {
    const res = await pool.query(
      `SELECT status, department, rejection_reason, created_at 
       FROM tickets WHERE user_id = $1 
       ORDER BY created_at DESC LIMIT 1`,
      [ctx.from.id]
    );

    if (res.rows.length === 0) {
      return ctx.reply("❌ You have not submitted any payment receipts yet.");
    }

    const latest = res.rows[0];
    let text = `📌 **CURRENT SUBMISSION STATUS**\n\n`;
    text += `• **Department:** ${latest.department}\n`;
    text += `• **Status:** ${latest.status}\n`;
    if (latest.status === 'REJECTED' && latest.rejection_reason) {
      text += `• **Reason:** ${latest.rejection_reason}\n`;
    }

    await ctx.reply(text, { parse_mode: 'Markdown' });
  } catch (err) {
    console.error('Status Query Error:', err);
    await ctx.reply("⚠️ Error checking status.");
  }
});

// 3. Student View History
bot.callbackQuery('cmd_history', async (ctx) => {
  await ctx.answerCallbackQuery();

  try {
    const res = await pool.query(
      `SELECT department, status, created_at 
       FROM tickets WHERE user_id = $1 
       ORDER BY created_at DESC LIMIT 5`,
      [ctx.from.id]
    );

    if (res.rows.length === 0) {
      return ctx.reply("📜 No past payment submissions found.");
    }

    let text = `📜 **YOUR LAST ${res.rows.length} SUBMISSIONS:**\n\n`;
    res.rows.forEach((r, i) => {
      const dateStr = new Date(r.created_at).toLocaleDateString();
      text += `${i + 1}. **${r.department}** — ${r.status} (${dateStr})\n`;
    });

    await ctx.reply(text, { parse_mode: 'Markdown' });
  } catch (err) {
    console.error('History Query Error:', err);
    await ctx.reply("⚠️ Error retrieving history.");
  }
});

// 4. Student Help Support
bot.callbackQuery('cmd_help', async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.reply(
    "❓ **Need Assistance?**\n\nIf you have issues regarding your tuition payments or department registration, please contact the registrar office directly or resubmit your receipt photo."
  );
});

// --- REPLY LISTENERS (INTERACTIVE INPUT HANDLERS) ---

bot.on('message:reply_to_message', async (ctx) => {
  const isStaffGroup = String(ctx.chat.id) === STAFF_GROUP_ID;
  const isPrivate = ctx.chat.type === 'private';
  const originalMsg = ctx.message.reply_to_message;
  const topicId = ctx.message.message_thread_id;

  // 1. Staff Search Query
  if (isStaffGroup && originalMsg.text && originalMsg.text.includes("Search Student Record")) {
    const query = ctx.message.text ? ctx.message.text.trim() : '';
    if (query) await performSearch(ctx, query, topicId);
    return;
  }

  // 2. Staff Broadcast Message
  if (isStaffGroup && originalMsg.text && originalMsg.text.includes("Send Student Announcement")) {
    await performBroadcast(ctx, topicId);
    return;
  }

  // 3. Student Receipt Submission
  if (isPrivate && originalMsg.text && originalMsg.text.includes("Submit Payment Receipt")) {
    await handleReceiptSubmission(ctx);
    return;
  }
});

// --- CORE LOGIC FUNCTIONS ---

async function performSearch(ctx, query, topicId) {
  try {
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
  } catch (err) {
    console.error('Search Execution Error:', err);
    await ctx.reply("⚠️ An error occurred while conducting the database search.", { message_thread_id: topicId });
  }
}

async function performBroadcast(ctx, topicId) {
  // Add your broadcast sending implementation here
  await ctx.reply("📢 Announcement broadcast triggered.", { message_thread_id: topicId });
}

async function handleExportCSV(ctx, topicId) {
  // Add your CSV generation and export code here
  await ctx.reply("📄 Generating CSV export file...", { message_thread_id: topicId });
}

async function handleReceiptSubmission(ctx) {
  // Add your receipt processing logic here
  await ctx.reply("✅ Receipt received and sent for staff verification!");
}

// --- BOT INITIALIZATION ---

async function main() {
  // Register single universal command in BotFather menu
  await bot.api.setMyCommands([
    { command: 'panel', description: 'Open interactive action panel' },
    { command: 'start', description: 'Start the bot' }
  ]);

  console.log('🤖 Renaissance Global Bot is online!');
  await bot.start();
}

main().catch((err) => console.error('Startup Error:', err));
