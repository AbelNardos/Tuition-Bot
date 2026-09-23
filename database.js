const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

pool.on('error', (err, client) => {
  console.error('[PostgreSQL Idle Error]:', err.message);
  process.exit(-1); 
});

async function initDB() {
  try { await pool.query(`ALTER TABLE department_topics DROP CONSTRAINT IF EXISTS department_topics_pkey;`); } catch (err) {}
  await pool.query(`
    CREATE TABLE IF NOT EXISTS group_settings (group_id TEXT PRIMARY KEY, is_active BOOLEAN DEFAULT TRUE, modules_topic_id BIGINT, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS tickets (id SERIAL PRIMARY KEY, user_id BIGINT, username TEXT, receipt_file_id TEXT, topic_id BIGINT, message_id BIGINT, ticket_msg_id BIGINT, panel_msg_id BIGINT, department TEXT, status TEXT DEFAULT 'PENDING', rejection_reason TEXT, processed_by TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS user_settings (user_id BIGINT PRIMARY KEY, language TEXT DEFAULT 'en', pending_department TEXT, pending_module_dept TEXT, phone_number TEXT);
    CREATE TABLE IF NOT EXISTS department_topics (id SERIAL PRIMARY KEY, group_id TEXT NOT NULL DEFAULT '', department TEXT NOT NULL, topic_id BIGINT);
    CREATE TABLE IF NOT EXISTS department_modules (id SERIAL PRIMARY KEY, department TEXT NOT NULL, title TEXT NOT NULL, file_id TEXT NOT NULL, file_name TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS module_downloads (id SERIAL PRIMARY KEY, module_id INT REFERENCES department_modules(id) ON DELETE CASCADE, user_id BIGINT NOT NULL, downloaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, UNIQUE(module_id, user_id));
  `);
  
  const alterQueries = [
    `ALTER TABLE tickets ADD COLUMN IF NOT EXISTS panel_msg_id BIGINT;`,
    `ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS pending_department TEXT;`,
    `ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS pending_module_dept TEXT;`,
    `ALTER TABLE group_settings ADD COLUMN IF NOT EXISTS modules_topic_id BIGINT;`,
    `ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS phone_number TEXT;`,
    `ALTER TABLE group_settings ADD COLUMN IF NOT EXISTS current_year INT DEFAULT 1;`,
    `ALTER TABLE group_settings ADD COLUMN IF NOT EXISTS current_semester INT DEFAULT 1;`,
    `ALTER TABLE group_settings ADD COLUMN IF NOT EXISTS global_season INT DEFAULT 1;`,
    `ALTER TABLE tickets ADD COLUMN IF NOT EXISTS academic_year INT DEFAULT 1;`,
    `ALTER TABLE tickets ADD COLUMN IF NOT EXISTS academic_semester INT DEFAULT 1;`,
    `ALTER TABLE tickets ADD COLUMN IF NOT EXISTS global_season INT DEFAULT 1;`,
    `ALTER TABLE tickets ADD COLUMN IF NOT EXISTS processed_by_id BIGINT;`,
    `ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS pending_year INT DEFAULT 1;`,
    `ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS pending_semester INT DEFAULT 1;`,
    `ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS last_menu_msg_id BIGINT;`
  ];
  for (let q of alterQueries) { try { await pool.query(q); } catch (e) {} }
}

async function getGlobalTerm() {
  try {
    const res = await pool.query('SELECT global_season FROM group_settings LIMIT 1');
    if (res.rows.length > 0) return res.rows[0].global_season || 1;
  } catch (err) {}
  return 1;
}

module.exports = { pool, initDB, getGlobalTerm };