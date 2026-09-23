const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

pool.on('error', (err, client) => {
  console.error('[PostgreSQL Idle Error]:', err.message);
});

async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS group_settings (group_id TEXT PRIMARY KEY, is_active BOOLEAN DEFAULT TRUE, modules_topic_id BIGINT, global_season INT DEFAULT 1, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE IF NOT EXISTS tickets (id SERIAL PRIMARY KEY, user_id BIGINT, username TEXT, receipt_file_id TEXT, topic_id BIGINT, message_id BIGINT, ticket_msg_id BIGINT, panel_msg_id BIGINT, department TEXT, status TEXT DEFAULT 'PENDING', rejection_reason TEXT, processed_by TEXT, academic_year INT DEFAULT 1, academic_semester INT DEFAULT 1, global_season INT DEFAULT 1, processed_by_id BIGINT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE IF NOT EXISTS user_settings (user_id BIGINT PRIMARY KEY, language TEXT DEFAULT 'en', pending_department TEXT, pending_module_dept TEXT, phone_number TEXT, pending_year INT DEFAULT 1, pending_semester INT DEFAULT 1, last_menu_msg_id BIGINT, is_active BOOLEAN DEFAULT TRUE);
      CREATE TABLE IF NOT EXISTS department_topics (id SERIAL PRIMARY KEY, group_id TEXT NOT NULL DEFAULT '', department TEXT NOT NULL, topic_id BIGINT);
      CREATE TABLE IF NOT EXISTS department_modules (id SERIAL PRIMARY KEY, department TEXT NOT NULL, title TEXT NOT NULL, file_id TEXT NOT NULL, file_name TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE IF NOT EXISTS module_downloads (id SERIAL PRIMARY KEY, module_id INT REFERENCES department_modules(id) ON DELETE CASCADE, user_id BIGINT NOT NULL, downloaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, UNIQUE(module_id, user_id));
    `);
  } catch (err) { console.error('[InitDB Error]:', err.message); }
}

async function getGlobalTerm() {
  try {
    const res = await pool.query('SELECT global_season FROM group_settings LIMIT 1');
    return res.rows.length > 0 ? (res.rows[0].global_season || 1) : 1;
  } catch (err) { return 1; }
}

async function getUserState(userId) {
  try {
    const sRes = await pool.query('SELECT language FROM user_settings WHERE user_id = $1', [userId]);
    const lang = sRes.rows[0]?.language || 'en';
    const tRes = await pool.query("SELECT status, global_season, academic_year, academic_semester, rejection_reason, department FROM tickets WHERE user_id = $1 AND status != 'WIPED' ORDER BY updated_at DESC LIMIT 1", [userId]);
    return { lang, ticket: tRes.rows[0] || null };
  } catch (err) { console.error('[getUserState Error]:', err.message); return { lang: 'en', ticket: null }; }
}

module.exports = { pool, initDB, getGlobalTerm, getUserState };