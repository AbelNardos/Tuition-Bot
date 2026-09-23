const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

pool.on('error', (err) => {
  console.error('[PostgreSQL Idle Error]:', err.message);
});

async function initDB() {
  try { await pool.query(`ALTER TABLE department_topics DROP CONSTRAINT IF EXISTS department_topics_pkey;`); } catch (err) {}
  await pool.query(`
    CREATE TABLE IF NOT EXISTS group_settings (group_id TEXT PRIMARY KEY, is_active BOOLEAN DEFAULT TRUE, modules_topic_id BIGINT, global_season INT DEFAULT 1, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS tickets (id SERIAL PRIMARY KEY, user_id BIGINT, username TEXT, receipt_file_id TEXT, topic_id BIGINT, message_id BIGINT, ticket_msg_id BIGINT, panel_msg_id BIGINT, department TEXT, status TEXT DEFAULT 'PENDING', rejection_reason TEXT, processed_by TEXT, processed_by_id BIGINT, academic_year INT DEFAULT 1, academic_semester INT DEFAULT 1, global_season INT DEFAULT 1, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS user_settings (user_id BIGINT PRIMARY KEY, language TEXT DEFAULT 'en', pending_department TEXT, pending_module_dept TEXT, phone_number TEXT, pending_year INT DEFAULT 1, pending_semester INT DEFAULT 1, last_menu_msg_id BIGINT);
    CREATE TABLE IF NOT EXISTS department_topics (id SERIAL PRIMARY KEY, group_id TEXT NOT NULL DEFAULT '', department TEXT NOT NULL, topic_id BIGINT);
    CREATE TABLE IF NOT EXISTS department_modules (id SERIAL PRIMARY KEY, department TEXT NOT NULL, title TEXT NOT NULL, file_id TEXT NOT NULL, file_name TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS module_downloads (id SERIAL PRIMARY KEY, module_id INT REFERENCES department_modules(id) ON DELETE CASCADE, user_id BIGINT NOT NULL, downloaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, UNIQUE(module_id, user_id));
  `);
}

async function getGlobalTerm() {
  try {
    const res = await pool.query('SELECT global_season FROM group_settings LIMIT 1');
    return res.rows.length > 0 ? (res.rows[0].global_season || 1) : 1;
  } catch (err) { return 1; }
}

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

async function getPendingDepartment(userId) {
  try {
    const res = await pool.query('SELECT pending_department FROM user_settings WHERE user_id = $1', [userId]);
    return res.rows[0]?.pending_department || null;
  } catch (err) { return null; }
}

async function setPendingDepartment(userId, dept) {
  try {
    await pool.query(`INSERT INTO user_settings (user_id, pending_department) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET pending_department = $2`, [userId, dept]);
  } catch (err) {
    console.error('[setPendingDepartment Error]:', err.message);
  }
}

async function clearPendingDepartment(userId) {
  try { await pool.query('UPDATE user_settings SET pending_department = NULL WHERE user_id = $1', [userId]); } catch (err) {}
}

async function getStaffPendingModuleDept(userId) {
  try {
    const res = await pool.query('SELECT pending_module_dept FROM user_settings WHERE user_id = $1', [userId]);
    return res.rows[0]?.pending_module_dept || null;
  } catch (err) { return null; }
}

async function setStaffPendingModuleDept(userId, dept) {
  try { await pool.query(`INSERT INTO user_settings (user_id, pending_module_dept) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET pending_module_dept = $2`, [userId, dept]); } catch (err) {}
}

async function clearStaffPendingModuleDept(userId) {
  try { await pool.query('UPDATE user_settings SET pending_module_dept = NULL WHERE user_id = $1', [userId]); } catch (err) {}
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

function escapeHtml(str) { return str ? String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') : ''; }

function formatDeptForDashboard(dept) {
  if (!dept) return 'Unassigned';
  let cleaned = String(dept).replace(/\s*\((Regular \/ Term\vert{}4-Year Complete)\)/ig, '').trim();
  return cleaned || 'Unassigned';
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

module.exports = {
  pool, initDB, getGlobalTerm, getActiveStaffGroupId, isStaff,
  getUserLang, setUserLang, getPendingDepartment, setPendingDepartment, clearPendingDepartment,
  getStaffPendingModuleDept, setStaffPendingModuleDept, clearStaffPendingModuleDept,
  getOrCreateDepartmentTopic, getOrCreateModulesVaultTopic,
  escapeHtml, formatDeptForDashboard, generateSummaryText, pushToGoogleSheet
};