const { Telegraf } = require('telegraf');
const express = require('express');
const cors = require('cors');
const webpush = require('web-push');
const { Pool } = require('pg');
const { randomUUID } = require('crypto');

const TOKEN = process.env.BOT_TOKEN;

if (!TOKEN) {
  throw new Error('BOT_TOKEN is not configured');
}

const bot = new Telegraf(TOKEN);
const app = express();

const WEBHOOK_URL = process.env.WEBHOOK_URL;
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET;
const WEBHOOK_PATH = '/telegram/webhook';

if (!WEBHOOK_URL || !WEBHOOK_SECRET) {
  throw new Error('Webhook environment variables are not configured');
}

if (!/^[A-Za-z0-9_-]{1,256}$/.test(WEBHOOK_SECRET)) {
  throw new Error('Invalid Telegram webhook secret format');
}

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

      ALTER TABLE orders
      ADD COLUMN IF NOT EXISTS public_number SMALLINT;
      
      CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_active_public_number
      ON orders(public_number)
      WHERE status = 'pending';

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

ALTER TABLE order_events
ADD COLUMN IF NOT EXISTS frontend_processed_at TIMESTAMPTZ;


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

app.use(
  bot.webhookCallback(WEBHOOK_PATH, {
    secretToken: WEBHOOK_SECRET
  })
);

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


// Создание заказа, сохранение в PostgreSQL и отправка курьеру
app.post('/api/orders', async (req, res) => {
  const {
    courierName,
    courierChatId,
    clientPhone,
    clientAddress,
    comment,
    items
  } = req.body;

  if (
    typeof courierName !== 'string' ||
    !courierName.trim() ||
    !courierChatId ||
    !Array.isArray(items) ||
    items.length === 0 ||
    items.length > 100
  ) {
    return res.status(400).json({
      error: 'Некорректные данные заказа'
    });
  }

  const validItems = items.every(item =>
    item &&
    typeof item.title === 'string' &&
    item.title.trim().length > 0 &&
    item.title.length <= 250 &&
    Number.isInteger(Number(item.qty)) &&
    Number(item.qty) > 0 &&
    Number(item.qty) <= 10000
  );

  if (!validItems) {
    return res.status(400).json({
      error: 'Некорректный состав заказа'
    });
  }

  
const client = await pool.connect();
const orderId = randomUUID();
let publicNumber;

try {
  await client.query('BEGIN');

  // Не допускаем одновременную выдачу одинаковых номеров
  await client.query(
    'SELECT pg_advisory_xact_lock(497001)'
  );

  // Ищем свободный трёхзначный номер
  const numberResult = await client.query(
    `SELECT candidate AS public_number
     FROM generate_series(100, 999) AS candidate
     WHERE NOT EXISTS (
       SELECT 1
       FROM orders
       WHERE public_number = candidate
       AND status = 'pending'
     )
     ORDER BY candidate
     LIMIT 1`
  );

  if (numberResult.rowCount === 0) {
    await client.query('ROLLBACK');

    return res.status(409).json({
      error: 'Все трёхзначные номера заказов заняты'
    });
  }

  publicNumber = numberResult.rows[0].public_number;


    await client.query(
      `INSERT INTO orders (
       id, public_number, courier_name, courier_chat_id,
       client_phone, client_address, comment
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        orderId,
        publicNumber,
        courierName.trim(),
        String(courierChatId),
        clientPhone || null,
        clientAddress || null,
        comment || null
      ]
    );

    for (const item of items) {
      await client.query(
        `INSERT INTO order_items (
          order_id, product_id, title, quantity, photo
        ) VALUES ($1, $2, $3, $4, $5)`,
        [
          orderId,
          item.productId ? String(item.productId) : null,
          item.title.trim(),
          Number(item.qty),
          item.photo || null
        ]
      );
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Order creation error:', error.message);

    return res.status(500).json({
      error: 'Не удалось сохранить заказ'
    });
  } finally {
    client.release();
  }

  const itemsText = items
    .map(item => `• ${item.title} — ${Number(item.qty)} шт.`)
    .join('\n');

  const messageText =
    `📦 НОВЫЙ ЗАКАЗ НА ДОСТАВКУ!\n\n` +
    `🆔 Номер заказа: ${publicNumber}\n\n` +
    `🛍 Товары:\n${itemsText}\n\n` +
    `📍 Адрес: ${clientAddress || 'Не указан'}\n` +
    `📞 Телефон: ${clientPhone || 'Не указан'}\n` +
    `${comment ? `💬 Комментарий: ${comment}\n` : ''}\n` +
    `Пожалуйста, подтвердите статус кнопкой ниже.`;

  try {
    const telegramMessage = await bot.telegram.sendMessage(
      String(courierChatId),
      messageText,
      {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: '✅ Доставлено',
                callback_data: `delivered:${orderId}`
              },
              {
                text: '⚠️ Возврат',
                callback_data: `return:${orderId}`
              }
            ]
          ]
        }
      }
    );

    return res.status(201).json({
      success: true,
      orderId,
      publicNumber,
      status: 'pending',
      telegramMessageId: telegramMessage.message_id,
      message: 'Заказ сохранён и отправлен курьеру'
    });

  } catch (error) {
    console.error('Telegram send error:', error.message);

    return res.status(502).json({
      success: false,
      orderId,
      saved: true,
      error: 'Заказ сохранён в базе, но Telegram не смог отправить сообщение'
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

// Проверка принадлежности заказа курьеру
async function getCourierOrder(orderId, chatId) {
  const result = await pool.query(
    `SELECT id, status
     FROM orders
     WHERE id = $1 AND courier_chat_id = $2`,
    [orderId, String(chatId)]
  );

  return result.rows[0] || null;
}

// Обработка кнопок Telegram
bot.on('callback_query', async (ctx) => {
  const data = ctx.callbackQuery.data || '';
  const chatId = ctx.chat.id;

  try {
    const [action, orderId] = data.split(':');

    if (!orderId || !['delivered', 'return'].includes(action)) {
      await ctx.answerCbQuery('Неизвестная команда');
      return;
    }

    const order = await getCourierOrder(orderId, chatId);

    if (!order) {
      await ctx.answerCbQuery('Заказ не найден или не принадлежит вам');
      return;
    }

    if (order.status !== 'pending') {
      await ctx.answerCbQuery('Этот заказ уже обработан');
      return;
    }

    if (action === 'delivered') {
      const client = await pool.connect();

      try {
        await client.query('BEGIN');

        const event = await client.query(
          `INSERT INTO order_events (
            order_id, event_type, telegram_callback_id
          )
          VALUES ($1, 'DELIVERED', $2)
          ON CONFLICT (telegram_callback_id) DO NOTHING
          RETURNING id`,
          [orderId, String(ctx.callbackQuery.id)]
        );

        if (event.rowCount > 0) {
          await client.query(
            `UPDATE orders
             SET status = 'delivered', updated_at = NOW()
             WHERE id = $1 AND status = 'pending'`,
            [orderId]
          );
        }

        await client.query('COMMIT');

        if (event.rowCount === 0) {
          await ctx.answerCbQuery('Этот ответ уже обработан');
          return;
        }
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }

      await ctx.answerCbQuery('Заказ отмечен как доставленный');
      await ctx.editMessageText(
        '✅ Заказ успешно доставлен клиенту.'
      );

      await sendPushNotification(
        'Заказ доставлен!',
        'Курьер успешно доставил заказ клиенту.'
      );

    } else if (action === 'return') {
      waitingForReason.set(String(chatId), orderId);

      await ctx.answerCbQuery();
      await ctx.reply(
        '⚠️ Напишите причину возврата ответным сообщением в этот чат.'
      );
    }

  } catch (error) {
    console.error('Telegram callback error:', error.message);

    try {
      await ctx.answerCbQuery('Ошибка обработки. Попробуйте позже.');
    } catch (_) {}
  }
});

// Получение причины возврата
bot.on('text', async (ctx) => {
  const chatId = String(ctx.chat.id);
  const orderId = waitingForReason.get(chatId);

  if (!orderId) return;

  const reasonText = ctx.message.text.trim();

  if (!reasonText || reasonText.length > 1000) {
    await ctx.reply(
      'Причина должна содержать от 1 до 1000 символов.'
    );
    return;
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const order = await client.query(
      `SELECT id, status
       FROM orders
       WHERE id = $1 AND courier_chat_id = $2
       FOR UPDATE`,
      [orderId, chatId]
    );

    if (!order.rows[0] || order.rows[0].status !== 'pending') {
      await client.query('ROLLBACK');
      waitingForReason.delete(chatId);

      await ctx.reply('Заказ не найден или уже обработан.');
      return;
    }

    const event = await client.query(
      `INSERT INTO order_events (
        order_id, event_type, reason, telegram_callback_id
      )
      VALUES ($1, 'RETURN', $2, $3)
      ON CONFLICT (telegram_callback_id) DO NOTHING
      RETURNING id`,
      [
        orderId,
        reasonText,
        `message:${ctx.message.message_id}`
      ]
    );

    if (event.rowCount > 0) {
      await client.query(
        `UPDATE orders
         SET status = 'returned',
             return_reason = $2,
             updated_at = NOW()
         WHERE id = $1`,
        [orderId, reasonText]
      );
    }

    await client.query('COMMIT');

    waitingForReason.delete(chatId);

    if (event.rowCount === 0) {
      await ctx.reply('Этот ответ уже был обработан.');
      return;
    }

    await ctx.reply(
      '✅ Причина возврата сохранена. Менеджер получит уведомление.'
    );

    await sendPushNotification(
      'Внимание: возврат',
      `Причина: ${reasonText}`
    );

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Return processing error:', error.message);

    await ctx.reply(
      'Не удалось сохранить причину. Попробуйте ещё раз.'
    );
  } finally {
    client.release();
  }
});


// Получение необработанных событий из PostgreSQL
app.get('/api/updates', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT
        id,
        order_id AS "orderId",
        event_type AS type,
        reason,
        created_at AS "createdAt"
       FROM order_events
       WHERE frontend_processed_at IS NULL
       ORDER BY id ASC
       LIMIT 100`
    );

    res.json(result.rows);
  } catch (error) {
    console.error('Updates fetch error:', error.message);
    res.status(500).json({
      error: 'Не удалось получить обновления'
    });
  }
});

// Подтверждение обработки событий frontend
app.post('/api/updates/ack', async (req, res) => {
  const { eventIds } = req.body;

  if (
    !Array.isArray(eventIds) ||
    eventIds.length === 0 ||
    eventIds.length > 100 ||
    !eventIds.every(id => Number.isInteger(id) && id > 0)
  ) {
    return res.status(400).json({
      error: 'Некорректные ID событий'
    });
  }

  try {
    const result = await pool.query(
      `UPDATE order_events
       SET frontend_processed_at = NOW()
       WHERE id = ANY($1::bigint[])
       AND frontend_processed_at IS NULL
       RETURNING id`,
      [eventIds]
    );

    res.json({
      success: true,
      acknowledged: result.rowCount
    });
  } catch (error) {
    console.error('Updates acknowledgement error:', error.message);

    res.status(500).json({
      error: 'Не удалось подтвердить обновления'
    });
  }
});

const PORT = process.env.PORT || 3000;

async function startServer() {
  try {
    await initializeDatabase();

    app.listen(PORT, async () => {
      console.log(`🌐 Сервер работает на порту ${PORT}`);

      try {
        const webhookAddress =
          `${WEBHOOK_URL.replace(/\/$/, '')}${WEBHOOK_PATH}`;

        await bot.telegram.setWebhook(webhookAddress, {
          secret_token: WEBHOOK_SECRET,
          allowed_updates: ['message', 'callback_query']
        });

        console.log('🤖 Telegram Webhook успешно установлен!');
      } catch (error) {
        console.error('Telegram Webhook setup failed:', error.message);
      }
    });
  } catch (error) {
    console.error('Server startup failed:', error);
    process.exit(1);
  }
}

startServer();
