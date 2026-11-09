'use strict';

const { randomBytes, createHash } = require('crypto');
const { Pool } = require('pg');

const courierChatId = String(process.argv[2] || '').trim();
const courierName = String(process.argv[3] || '').trim();

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not configured.');
  process.exit(1);
}
if (!/^\d{5,20}$/.test(courierChatId)) {
  console.error('Usage: npm run create:courier-token -- <telegram_chat_id> <courier_name>');
  process.exit(1);
}
if (!courierName || courierName.length > 120) {
  console.error('Courier name must contain 1–120 characters.');
  process.exit(1);
}

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  const token = randomBytes(32).toString('base64url');
  const tokenHash = createHash('sha256').update(token, 'utf8').digest('hex');

  try {
    await pool.query(
      `INSERT INTO courier_app_tokens (token_hash, courier_chat_id, courier_name)
       VALUES ($1, $2, $3)`,
      [tokenHash, courierChatId, courierName]
    );
    console.log('Courier token created. Copy it now; it will not be shown again:');
    console.log(token);
  } finally {
    await pool.end();
  }
}

main().catch(error => {
  console.error('Could not create courier token:', error.message);
  process.exit(1);
});
