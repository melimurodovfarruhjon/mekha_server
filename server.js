const { Telegraf } = require('telegraf');
const express = require('express');
const cors = require('cors');
const webpush = require('web-push');
const { Pool } = require('pg');

const TOKEN = process.env.BOT_TOKEN;

if (!TOKEN) {
  throw new Error('BOT_TOKEN is not configured');
}

const bot = new Telegraf(TOKEN);
const app = express();

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is not configured');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000
});

async function initializeDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id UUID PRIMARY KEY,
      courier_name TEXT NOT NULL,
      courier_chat_id TEXT NOT NULL,
      client_phone TEXT,
      client_address TEXT,
      comment TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      return_reason TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS order_items (
      id BIGSERIAL PRIMARY KEY,
      order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      product_id TEXT,
      title TEXT NOT NULL,
      quantity INTEGER NOT NULL CHECK (quantity > 0),
      photo TEXT
    );

    CREATE TABLE IF NOT EXISTS order_events (
      id BIGSERIAL PRIMARY KEY,
      order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL CHECK (
        event_type IN ('DELIVERED', 'RETURN')
      ),
      reason TEXT,
      telegram_callback_id TEXT UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id BIGSERIAL PRIMARY KEY,
      endpoint TEXT NOT NULL UNIQUE,
      subscription JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_order_items_order_id
      ON order_items(order_id);

    CREATE INDEX IF NOT EXISTS idx_order_events_order_id
      ON order_events(order_id);
  `);

  console.log('PostgreSQL tables initialized successfully');
}

app.use(cors());
app.use(express.json());

app.get('/api/db-health', async (req, res) => {
  try {
    const result = await pool.query('SELECT NOW() AS server_time');

    res.json({
      status: 'ok',
      database: 'connected',
      serverTime: result.rows[0].server_time
    });
  } catch (error) {
    console.error('Database connection error:', error.message);

    res.status(500).json({
      status: 'error',
      database: 'disconnected'
    });
  }
});

// VAPID keys for Web Push (Render environment variables-raas fudhachuu dandeessa)
const publicVapidKey = process.env.VAPID_PUBLIC_KEY;
const privateVapidKey = process.env.VAPID_PRIVATE_KEY;

if (!publicVapidKey || !privateVapidKey) {
  throw new Error('VAPID keys are not configured');
}

webpush.setVapidDetails(
  'mailto:example@yourdomain.com',
  publicVapidKey,
  privateVapidKey
);

// Kuusaa galmee (Subscriptions) bilbila fayyadamaa
let pushSubscriptions = [];

// Endpoint galmee push notification
app.post('/api/subscribe', (req, res) => {
  const subscription = req.body;
  pushSubscriptions.push(subscription);
  res.status(201).json({ message: 'Subscribed successfully!' });
});

// Fedha Push erguuf tajaajilu
async function sendPushNotification(title, body) {
  const payload = JSON.stringify({ title, body });
  for (const sub of pushSubscriptions) {
    try {
      await webpush.sendNotification(sub, payload);
    } catch (error) {
      console.error('Error sending push notification:', error);
    }
  }
}

const waitingForReason = new Map();
let latestUpdates = [];

bot.on('callback_query', async (ctx) => {
  const data = ctx.callbackQuery.data;
  const chatId = ctx.chat.id;

  if (data === 'delivered') {
    await ctx.answerCbQuery('Заказ отмечен как доставленный!');
    await ctx.editMessageText('✅ Заказ успешно доставлен клиенту.');
    latestUpdates.unshift({ type: 'DELIVERED', time: new Date().toLocaleTimeString() });
    
    // Bilbifataaf / App-ichaaf Push notification erguu
    await sendPushNotification("Заказ доставлен! 🎉", "Курьер успешно доставил заказ клиенту.");

  } else if (data === 'other') {
    waitingForReason.set(chatId, true);
    await ctx.answerCbQuery();
    await ctx.reply('⚠️ Пожалуйста, напишите причину (например, возврат или отказ) ответным сообщением в этот чат:');
  }
});

bot.on('text', async (ctx) => {
  const chatId = ctx.chat.id;
  if (waitingForReason.has(chatId)) {
    const reasonText = ctx.message.text;
    waitingForReason.delete(chatId);
    await ctx.reply(`✅ Причина принята: «${reasonText}». Менеджер получил уведомление.`);
    latestUpdates.unshift({ type: 'RETURN', reason: reasonText, time: new Date().toLocaleTimeString() });

    // Push notification erguu (Возврат)
    await sendPushNotification("Внимание: Возврат ⚠️", `Причина: ${reasonText}`);
  }
});

app.get('/api/updates', (req, res) => {
  res.json(latestUpdates);
  latestUpdates = [];
});

const PORT = process.env.PORT || 3000;

async function startServer() {
  try {
    await initializeDatabase();

    await bot.launch();
    console.log('🤖 Бот запущен!');

    app.listen(PORT, () => {
      console.log(`🌐 Сервер работает на порту ${PORT}`);
    });
  } catch (error) {
    console.error('Server startup failed:', error);
    process.exit(1);
  }
}

startServer();
