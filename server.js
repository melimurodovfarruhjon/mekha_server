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


    CREATE TABLE IF NOT EXISTS support_messages (
      id BIGSERIAL PRIMARY KEY,
      client_id UUID NOT NULL,
      sender TEXT NOT NULL CHECK (sender IN ('client', 'support')),
      message TEXT NOT NULL,
      telegram_message_id BIGINT,
      is_read BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_support_messages_client
      ON support_messages(client_id, id);

    CREATE TABLE IF NOT EXISTS support_telegram_links (
      telegram_message_id BIGINT PRIMARY KEY,
      client_id UUID NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id BIGSERIAL PRIMARY KEY,
      endpoint TEXT NOT NULL UNIQUE,
      subscription JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    
-- =========================================
-- MEKHA SHOP: PROCUREMENT AND INVENTORY
-- =========================================

CREATE TABLE IF NOT EXISTS products (
  id UUID PRIMARY KEY,
  legacy_id TEXT UNIQUE,
  title TEXT NOT NULL,
  photo TEXT,
  current_wholesale_total_tjs NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (current_wholesale_total_tjs >= 0),
  current_cargo_total_tjs NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (current_cargo_total_tjs >= 0),
  current_sale_price_tjs NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (current_sale_price_tjs >= 0),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS purchase_batches (
  id UUID PRIMARY KEY,
  batch_number BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE,
  purchased_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS purchase_batch_items (
  id UUID PRIMARY KEY,
  batch_id UUID NOT NULL REFERENCES purchase_batches(id),
  product_id UUID NOT NULL REFERENCES products(id),

  initial_quantity INTEGER NOT NULL CHECK (initial_quantity > 0),

  wholesale_amount NUMERIC(14,2) NOT NULL CHECK (wholesale_amount >= 0),
  wholesale_currency CHAR(3) NOT NULL,
  wholesale_rate_to_tjs NUMERIC(14,6) NOT NULL CHECK (wholesale_rate_to_tjs > 0),
  wholesale_total_tjs NUMERIC(14,2) NOT NULL CHECK (wholesale_total_tjs >= 0),

  cargo_amount NUMERIC(14,2) NOT NULL CHECK (cargo_amount >= 0),
  cargo_currency CHAR(3) NOT NULL,
  cargo_rate_to_tjs NUMERIC(14,6) NOT NULL CHECK (cargo_rate_to_tjs > 0),
  cargo_total_tjs NUMERIC(14,2) NOT NULL CHECK (cargo_total_tjs >= 0),

  unit_cost_tjs NUMERIC(14,4) NOT NULL CHECK (unit_cost_tjs >= 0),
  current_sale_price_tjs NUMERIC(14,2) NOT NULL DEFAULT 0
    CHECK (current_sale_price_tjs >= 0),

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (batch_id, product_id)
);

CREATE TABLE IF NOT EXISTS purchase_batch_item_variants (
  id UUID PRIMARY KEY,
  batch_item_id UUID NOT NULL
    REFERENCES purchase_batch_items(id),

  color_name TEXT NOT NULL DEFAULT 'Без цвета',
  size_name TEXT NOT NULL DEFAULT 'Без размера',

  initial_quantity INTEGER NOT NULL CHECK (initial_quantity >= 0),
  reserved_quantity INTEGER NOT NULL DEFAULT 0 CHECK (reserved_quantity >= 0),
  sold_quantity INTEGER NOT NULL DEFAULT 0 CHECK (sold_quantity >= 0),

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CHECK (reserved_quantity + sold_quantity <= initial_quantity),

  UNIQUE (batch_item_id, color_name, size_name)
);

CREATE TABLE IF NOT EXISTS sales (
  id UUID PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  comment TEXT
);

CREATE TABLE IF NOT EXISTS sale_items (
  id UUID PRIMARY KEY,
  sale_id UUID NOT NULL REFERENCES sales(id),
  product_id UUID NOT NULL REFERENCES products(id),

  title_snapshot TEXT NOT NULL,
  color_name TEXT NOT NULL,
  size_name TEXT NOT NULL,

  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit_sale_price_tjs NUMERIC(14,2) NOT NULL CHECK (unit_sale_price_tjs >= 0),
  unit_cost_tjs NUMERIC(14,4) NOT NULL CHECK (unit_cost_tjs >= 0),

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS inventory_allocations (
  id BIGSERIAL PRIMARY KEY,
  sale_item_id UUID NOT NULL REFERENCES sale_items(id),
  variant_id UUID NOT NULL REFERENCES purchase_batch_item_variants(id),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit_cost_tjs NUMERIC(14,4) NOT NULL CHECK (unit_cost_tjs >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_purchase_batch_items_product
  ON purchase_batch_items(product_id);

CREATE INDEX IF NOT EXISTS idx_purchase_batches_date
  ON purchase_batches(purchased_at);

CREATE INDEX IF NOT EXISTS idx_inventory_variants_fifo
  ON purchase_batch_item_variants(batch_item_id, created_at);

CREATE INDEX IF NOT EXISTS idx_inventory_allocations_variant
  ON inventory_allocations(variant_id);


    CREATE INDEX IF NOT EXISTS idx_order_items_order_id
      ON order_items(order_id);

    CREATE INDEX IF NOT EXISTS idx_order_events_order_id
      ON order_events(order_id);
  `);

  console.log('PostgreSQL tables initialized successfully');
  await pool.query(`
    ALTER TABLE products
      ADD COLUMN IF NOT EXISTS current_wholesale_total_tjs NUMERIC(14,2) NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS current_cargo_total_tjs NUMERIC(14,2) NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS current_sale_price_tjs NUMERIC(14,2) NOT NULL DEFAULT 0
  `);

}

app.use(cors());

app.use(express.json({ limit: '25mb' }));

// Сообщения из чата поддержки Mekha Shop отправляются администратору в Telegram.
const SUPPORT_CHAT_ID = '907176273';
const supportRateLimits = new Map();

app.post('/api/support-message', async (req, res) => {
  const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
  const clientId = typeof req.body?.clientId === 'string' ? req.body.clientId : '';

  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(clientId)) {
    return res.status(400).json({ error: 'Некорректный идентификатор чата.' });
  }
  if (!message || message.length > 2000) {
    return res.status(400).json({ error: 'Сообщение должно содержать от 1 до 2000 символов.' });
  }

  const clientKey = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const recent = (supportRateLimits.get(clientKey) || []).filter(time => now - time < 60000);
  if (recent.length >= 5) return res.status(429).json({ error: 'Слишком много сообщений. Подождите минуту.' });
  recent.push(now);
  supportRateLimits.set(clientKey, recent);

  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const saved = await db.query(
      "INSERT INTO support_messages (client_id, sender, message) VALUES ($1, 'client', $2) RETURNING id",
      [clientId, message]
    );
    const telegramMessage = await bot.telegram.sendMessage(
      SUPPORT_CHAT_ID,
      '💬 Новое сообщение в службе поддержки Mekha Shop\\nЧат: ' + clientId +
      '\\n\\n' + message,
      { reply_markup: { inline_keyboard: [[
        { text: '✉️ Ответить клиенту', callback_data: 'support_reply:' + clientId },
        { text: '🗑 Удалить чат', callback_data: 'support_delete:' + clientId }
      ]] } }
    );
    await db.query(
      'INSERT INTO support_telegram_links (telegram_message_id, client_id) VALUES ($1, $2) ON CONFLICT (telegram_message_id) DO UPDATE SET client_id = EXCLUDED.client_id',
      [telegramMessage.message_id, clientId]
    );
    await db.query('COMMIT');
    return res.json({ success: true, messageId: saved.rows[0].id });
  } catch (error) {
    await db.query('ROLLBACK');
    console.error('Support message delivery failed:', error.message);
    return res.status(502).json({ error: 'Не удалось доставить сообщение в Telegram.' });
  } finally {
    db.release();
  }
});

app.get('/api/support-messages', async (req, res) => {
  const clientId = String(req.query.clientId || '');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(clientId)) {
    return res.status(400).json({ error: 'Некорректный идентификатор чата.' });
  }
  try {
    const result = await pool.query(
      'SELECT id, sender, message, is_read, created_at FROM support_messages WHERE client_id = $1 ORDER BY id ASC',
      [clientId]
    );
    res.json({ messages: result.rows });
  } catch (error) {
    console.error('Support history fetch failed:', error.message);
    res.status(500).json({ error: 'Не удалось загрузить сообщения.' });
  }
});

app.post('/api/support-read', async (req, res) => {
  const clientId = String(req.body?.clientId || '');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(clientId)) {
    return res.status(400).json({ error: 'Некорректный идентификатор чата.' });
  }
  try {
    await pool.query(
      "UPDATE support_messages SET is_read = TRUE WHERE client_id = $1 AND sender = 'support' AND is_read = FALSE",
      [clientId]
    );
    res.json({ success: true });
  } catch (error) {
    console.error('Support read acknowledgement failed:', error.message);
    res.status(500).json({ error: 'Не удалось отметить сообщения прочитанными.' });
  }
});


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

// =========================================
// MEKHA SHOP: GET PRODUCTS CATALOG
// =========================================

app.get('/api/products', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        p.id,
        p.legacy_id AS "legacyId",
        p.title,
        p.photo,

        COALESCE((
          SELECT SUM(
            v.initial_quantity
            - v.reserved_quantity
            - v.sold_quantity
          )
          FROM purchase_batch_items bi
          JOIN purchase_batch_item_variants v
            ON v.batch_item_id = bi.id
          WHERE bi.product_id = p.id
        ), 0)::INTEGER AS quantity,

        latest.unit_cost_tjs AS "unitCostTjs",
        COALESCE(latest.current_sale_price_tjs, p.current_sale_price_tjs, 0) AS "salePriceTjs",
        COALESCE(latest.wholesale_total_tjs, p.current_wholesale_total_tjs, 0) AS "totalWholesaleTjs",
        latest.wholesale_currency AS "wholesaleCurrency",
        COALESCE(latest.cargo_total_tjs, p.current_cargo_total_tjs, 0) AS "cargoCostTjs",
        latest.cargo_currency AS "cargoCurrency"

      FROM products p

      LEFT JOIN LATERAL (
        SELECT
          bi.unit_cost_tjs,
          bi.current_sale_price_tjs,
          bi.wholesale_total_tjs,
          bi.wholesale_currency,
          bi.cargo_total_tjs,
          bi.cargo_currency
        FROM purchase_batch_items bi
        WHERE bi.product_id = p.id
        ORDER BY bi.created_at DESC
        LIMIT 1
      ) latest ON TRUE

      WHERE p.is_active = TRUE
      ORDER BY p.created_at DESC
    `);

    return res.json({
      success: true,
      products: result.rows
    });

  } catch (error) {
    console.error('Products catalog error:', error.message);

    return res.status(500).json({
      error: 'Не удалось загрузить каталог товаров'
    });
  }
});

// =========================================
// MEKHA SHOP: UPDATE PRODUCT
// =========================================

app.put('/api/products/:id', async (req, res) => {
  const { id } = req.params;
  const { title, photo, totalWholesaleTjs, cargoCostTjs, salePriceTjs } = req.body;
  const prices = [totalWholesaleTjs, cargoCostTjs, salePriceTjs];
  if (typeof title !== 'string' || !title.trim() || title.length > 250) {
    return res.status(400).json({ success: false, error: 'Название товара обязательно (до 250 символов)' });
  }
  if (!prices.every(value => value !== undefined && Number.isFinite(Number(value)) && Number(value) >= 0)) {
    return res.status(400).json({ success: false, error: 'Проверьте закупочную стоимость, карго и цену продажи' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `UPDATE products
       SET title = $1, photo = $2,
           current_wholesale_total_tjs = $3,
           current_cargo_total_tjs = $4,
           current_sale_price_tjs = $5
       WHERE id = $6 AND is_active = TRUE
       RETURNING id, title, photo`,
      [title.trim(), photo || '', Number(totalWholesaleTjs), Number(cargoCostTjs), Number(salePriceTjs), id]
    );
    if (result.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, error: 'Товар не найден' });
    }
    const latest = await client.query(
      `SELECT id, initial_quantity FROM purchase_batch_items
       WHERE product_id = $1 ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
      [id]
    );
    if (latest.rowCount > 0) {
      const quantity = Number(latest.rows[0].initial_quantity) || 1;
      const wholesale = Number(totalWholesaleTjs);
      const cargo = Number(cargoCostTjs);
      await client.query(
        `UPDATE purchase_batch_items
         SET wholesale_total_tjs = $2, cargo_total_tjs = $3,
             unit_cost_tjs = $4, current_sale_price_tjs = $5
         WHERE id = $1`,
        [latest.rows[0].id, wholesale, cargo, (wholesale + cargo) / quantity, Number(salePriceTjs)]
      );
    }
    await client.query('COMMIT');
    return res.json({ success: true, product: result.rows[0] });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Update product error:', error);
    return res.status(500).json({ success: false, error: 'Не удалось обновить товар' });
  } finally {
    client.release();
  }
});

// =========================================
// MEKHA SHOP: DELETE PRODUCT (SOFT DELETE)
// =========================================

app.delete('/api/products/:id', async (req, res) => {
  const client = await pool.connect();

  try {
    const { id } = req.params;

    await client.query('BEGIN');

    // Lock the product so inventory and history cannot change mid-delete.
    const productResult = await client.query(
      `SELECT id
       FROM products
       WHERE id = $1 AND is_active = TRUE
       FOR UPDATE`,
      [id]
    );

    if (productResult.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({
        success: false,
        error: 'Товар не найден'
      });
    }

    // Keep order and sales snapshots for historical reports, but detach
    // them from the product that is being permanently removed.
    await client.query(
      `UPDATE order_items
       SET product_id = NULL
       WHERE product_id = $1`,
      [id]
    );

    await client.query(
      `UPDATE sale_items
       SET product_id = NULL
       WHERE product_id = $1`,
      [id]
    );

    // Remove stock allocations before deleting the stock variants.
    await client.query(
      `DELETE FROM inventory_allocations ia
       USING purchase_batch_item_variants v,
             purchase_batch_items bi
       WHERE ia.variant_id = v.id
         AND v.batch_item_id = bi.id
         AND bi.product_id = $1`,
      [id]
    );

    // Remove all variants and purchase records belonging to this product.
    await client.query(
      `DELETE FROM purchase_batch_item_variants v
       USING purchase_batch_items bi
       WHERE v.batch_item_id = bi.id
         AND bi.product_id = $1`,
      [id]
    );

    const deletedBatches = await client.query(
      `DELETE FROM purchase_batch_items
       WHERE product_id = $1
       RETURNING batch_id`,
      [id]
    );

    // Remove purchase batches only when they no longer contain any products.
    const batchIds = [...new Set(deletedBatches.rows.map(row => row.batch_id))];

    if (batchIds.length > 0) {
      await client.query(
        `DELETE FROM purchase_batches pb
         WHERE pb.id = ANY($1::uuid[])
           AND NOT EXISTS (
             SELECT 1
             FROM purchase_batch_items bi
             WHERE bi.batch_id = pb.id
           )`,
        [batchIds]
      );
    }

    await client.query(
      `DELETE FROM products
       WHERE id = $1`,
      [id]
    );

    await client.query('COMMIT');

    return res.json({
      success: true,
      message: 'Товар и его складские записи полностью удалены'
    });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Delete product error:', error);

    return res.status(500).json({
      success: false,
      error: 'Не удалось полностью удалить товар'
    });

  } finally {
    client.release();
  }
});

// =========================================
// MEKHA SHOP: CREATE PURCHASE BATCH
// =========================================

app.post('/api/purchase-batches', async (req, res) => {
  const { items, notes } = req.body;

  if (
    !Array.isArray(items) ||
    items.length === 0 ||
    items.length > 100
  ) {
    return res.status(400).json({
      error: 'Партия должна содержать от 1 до 100 позиций'
    });
  }

  if (notes != null && (
    typeof notes !== 'string' || notes.length > 1000
  )) {
    return res.status(400).json({
      error: 'Некорректное примечание'
    });
  }

  const allowedCurrencies = ['TJS', 'USD', 'CNY'];

  const round = (value, digits = 2) => {
    const factor = 10 ** digits;
    return Math.round((value + Number.EPSILON) * factor) / factor;
  };

  const seenProducts = new Set();

  for (const item of items) {
    if (
      !item ||
      typeof item.title !== 'string' ||
      !item.title.trim() ||
      item.title.length > 250
    ) {
      return res.status(400).json({
        error: 'У каждой позиции должно быть название'
      });
    }

    if (
      !Number.isInteger(Number(item.quantity)) ||
      Number(item.quantity) <= 0 ||
      Number(item.quantity) > 100000
    ) {
      return res.status(400).json({
        error: `Некорректное количество товара: ${item.title}`
      });
    }

    if (
      !allowedCurrencies.includes(item.wholesaleCurrency) ||
      !allowedCurrencies.includes(item.cargoCurrency)
    ) {
      return res.status(400).json({
        error: 'Поддерживаются валюты TJS, USD и CNY'
      });
    }

    const numericFields = [
      item.wholesaleAmount,
      item.wholesaleRateToTjs,
      item.cargoAmount,
      item.cargoRateToTjs,
      item.salePriceTjs
    ];

    if (!numericFields.every(value =>
      value !== null &&
      value !== undefined &&
      Number.isFinite(Number(value))
    )) {
      return res.status(400).json({
        error: `Некорректные финансовые данные: ${item.title}`
      });
    }

    if (
      Number(item.wholesaleAmount) < 0 ||
      Number(item.cargoAmount) < 0 ||
      Number(item.salePriceTjs) < 0 ||
      Number(item.wholesaleRateToTjs) <= 0 ||
      Number(item.cargoRateToTjs) <= 0
    ) {
      return res.status(400).json({
        error: `Недопустимые суммы или курсы: ${item.title}`
      });
    }

    if (
      !Array.isArray(item.variants) ||
      item.variants.length === 0
    ) {
      return res.status(400).json({
        error: `Укажите цвета и размеры: ${item.title}`
      });
    }

    let variantsTotal = 0;
    const seenVariants = new Set();

    for (const variant of item.variants) {
      const color = String(variant.color || '').trim();
      const size = String(variant.size || '').trim();
      const quantity = Number(variant.quantity);

      if (
        !color ||
        !size ||
        color.length > 80 ||
        size.length > 40 ||
        !Number.isInteger(quantity) ||
        quantity < 0
      ) {
        return res.status(400).json({
          error: `Некорректный вариант товара: ${item.title}`
        });
      }

      const variantKey = `${color.toLowerCase()}|${size.toLowerCase()}`;

      if (seenVariants.has(variantKey)) {
        return res.status(400).json({
          error: `Повторяется вариант ${color} / ${size}`
        });
      }

      seenVariants.add(variantKey);
      variantsTotal += quantity;
    }

    if (variantsTotal !== Number(item.quantity)) {
      return res.status(400).json({
        error: `Сумма вариантов товара "${item.title}" (${variantsTotal}) не совпадает с общим количеством (${item.quantity})`
      });
    }

    const legacyId = item.legacyId == null
      ? null
      : String(item.legacyId);

    if (legacyId && seenProducts.has(legacyId)) {
      return res.status(400).json({
        error: `Товар "${item.title}" повторяется в партии`
      });
    }

    if (legacyId) seenProducts.add(legacyId);
  }

  const client = await pool.connect();
  const batchId = randomUUID();

  try {
    await client.query('BEGIN');

    const batchResult = await client.query(
      `INSERT INTO purchase_batches (id, notes)
       VALUES ($1, $2)
       RETURNING batch_number, purchased_at`,
      [batchId, notes?.trim() || null]
    );

    const savedItems = [];

    for (const item of items) {
      const productId = randomUUID();
      const legacyId = item.legacyId == null
        ? null
        : String(item.legacyId);

      const productResult = await client.query(
        `INSERT INTO products (
          id, legacy_id, title, photo
        )
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (legacy_id)
        DO UPDATE SET
          title = EXCLUDED.title,
          photo = COALESCE(EXCLUDED.photo, products.photo)
        RETURNING id`,
        [
          productId,
          legacyId,
          item.title.trim(),
          item.photo || null
        ]
      );

      const actualProductId = productResult.rows[0].id;
      const batchItemId = randomUUID();

      const quantity = Number(item.quantity);

      const wholesaleTotalTjs = round(
        Number(item.wholesaleAmount) *
        Number(item.wholesaleRateToTjs)
      );

      const cargoTotalTjs = round(
        Number(item.cargoAmount) *
        Number(item.cargoRateToTjs)
      );

      const unitCostTjs = round(
        (wholesaleTotalTjs + cargoTotalTjs) / quantity,
        4
      );

      await client.query(
        `INSERT INTO purchase_batch_items (
          id,
          batch_id,
          product_id,
          initial_quantity,
          wholesale_amount,
          wholesale_currency,
          wholesale_rate_to_tjs,
          wholesale_total_tjs,
          cargo_amount,
          cargo_currency,
          cargo_rate_to_tjs,
          cargo_total_tjs,
          unit_cost_tjs,
          current_sale_price_tjs
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7,
          $8, $9, $10, $11, $12, $13, $14
        )`,
        [
          batchItemId,
          batchId,
          actualProductId,
          quantity,
          Number(item.wholesaleAmount),
          item.wholesaleCurrency,
          Number(item.wholesaleRateToTjs),
          wholesaleTotalTjs,
          Number(item.cargoAmount),
          item.cargoCurrency,
          Number(item.cargoRateToTjs),
          cargoTotalTjs,
          unitCostTjs,
          Number(item.salePriceTjs)
        ]
      );

      for (const variant of item.variants) {
        await client.query(
          `INSERT INTO purchase_batch_item_variants (
            id,
            batch_item_id,
            color_name,
            size_name,
            initial_quantity
          )
          VALUES ($1, $2, $3, $4, $5)`,
          [
            randomUUID(),
            batchItemId,
            String(variant.color).trim(),
            String(variant.size).trim(),
            Number(variant.quantity)
          ]
        );
      }

      savedItems.push({
        productId: actualProductId,
        title: item.title.trim(),
        quantity,
        wholesaleTotalTjs,
        cargoTotalTjs,
        totalCostTjs: round(
          wholesaleTotalTjs + cargoTotalTjs
        ),
        unitCostTjs,
        salePriceTjs: Number(item.salePriceTjs)
      });
    }

    await client.query('COMMIT');

    return res.status(201).json({
      success: true,
      batchId,
      batchNumber: batchResult.rows[0].batch_number,
      purchasedAt: batchResult.rows[0].purchased_at,
      items: savedItems
    });

  } catch (error) {
    await client.query('ROLLBACK');

    console.error('Purchase batch creation error:', error.message);

    return res.status(500).json({
      error: 'Не удалось сохранить закупочную партию'
    });

  } finally {
    client.release();
  }
});

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
const waitingForSupportReply = new Map();

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
    if (String(chatId) === SUPPORT_CHAT_ID && data.startsWith('support_reply:')) {
      const clientId = data.slice('support_reply:'.length);
      if (!/^[0-9a-f-]{36}$/i.test(clientId)) { await ctx.answerCbQuery('Некорректный чат'); return; }
      waitingForSupportReply.set(String(chatId), clientId);
      await ctx.answerCbQuery('Режим ответа включён');
      await ctx.reply('✉️ Напишите сообщение клиенту. Следующее текстовое сообщение будет отправлено в Mekha Shop.');
      return;
    }
    if (String(chatId) === SUPPORT_CHAT_ID && data.startsWith('support_delete:')) {
      const clientId = data.slice('support_delete:'.length);
      if (!/^[0-9a-f-]{36}$/i.test(clientId)) { await ctx.answerCbQuery('Некорректный чат'); return; }
      await ctx.answerCbQuery('Подтвердите удаление');
      await ctx.editMessageReplyMarkup({ inline_keyboard: [[
        { text: 'Да, удалить чат', callback_data: 'support_delete_confirm:' + clientId },
        { text: 'Отмена', callback_data: 'support_delete_cancel:' + clientId }
      ]] });
      return;
    }
    if (String(chatId) === SUPPORT_CHAT_ID && data.startsWith('support_delete_cancel:')) {
      const clientId = data.slice('support_delete_cancel:'.length);
      await ctx.answerCbQuery('Удаление отменено');
      await ctx.editMessageReplyMarkup({ inline_keyboard: [[
        { text: '✉️ Ответить клиенту', callback_data: 'support_reply:' + clientId },
        { text: '🗑 Удалить чат', callback_data: 'support_delete:' + clientId }
      ]] });
      return;
    }
    if (String(chatId) === SUPPORT_CHAT_ID && data.startsWith('support_delete_confirm:')) {
      const clientId = data.slice('support_delete_confirm:'.length);
      const db = await pool.connect();
      let messageIds = [];
      try {
        await db.query('BEGIN');
        const links = await db.query('SELECT telegram_message_id FROM support_telegram_links WHERE client_id = $1', [clientId]);
        messageIds = links.rows.map(row => Number(row.telegram_message_id));
        await db.query('DELETE FROM support_messages WHERE client_id = $1', [clientId]);
        await db.query('DELETE FROM support_telegram_links WHERE client_id = $1', [clientId]);
        await db.query('COMMIT');
      } catch (error) {
        await db.query('ROLLBACK');
        throw error;
      } finally { db.release(); }
      waitingForSupportReply.delete(String(chatId));
      for (const messageId of messageIds) {
        try { await ctx.telegram.deleteMessage(chatId, messageId); }
        catch (error) { console.warn('Could not delete Telegram support message:', messageId, error.message); }
      }
      try { await ctx.deleteMessage(); } catch (_) {}
      await ctx.answerCbQuery('Диалог удалён');
      await ctx.reply('🗑 Диалог удалён из Mekha Shop. История переписки очищена.');
      return;
    }
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

        // Lock the order and re-check ownership/status inside the transaction.
        const lockedOrder = await client.query(
          `SELECT id, status
           FROM orders
           WHERE id = $1 AND courier_chat_id = $2
           FOR UPDATE`,
          [orderId, String(chatId)]
        );

        if (lockedOrder.rowCount !== 1) {
          throw new Error('Заказ не найден или не принадлежит курьеру');
        }

        if (lockedOrder.rows[0].status !== 'pending') {
          throw new Error('Заказ уже обработан');
        }

        // Read the authoritative order lines from PostgreSQL.
        const orderItems = await client.query(
          `SELECT product_id, quantity
           FROM order_items
           WHERE order_id = $1
           ORDER BY id ASC`,
          [orderId]
        );

        for (const item of orderItems.rows) {
          // Free-text lines have no product_id and do not affect inventory.
          if (!item.product_id) continue;

          let remaining = Number(item.quantity);

          const variants = await client.query(
            `SELECT
               v.id,
               (v.initial_quantity - v.reserved_quantity - v.sold_quantity)::INTEGER AS available
             FROM purchase_batch_items bi
             JOIN purchase_batch_item_variants v ON v.batch_item_id = bi.id
             WHERE bi.product_id = $1
               AND v.initial_quantity - v.reserved_quantity - v.sold_quantity > 0
             ORDER BY bi.created_at ASC, v.created_at ASC, v.id ASC
             FOR UPDATE OF v`,
            [item.product_id]
          );

          for (const variant of variants.rows) {
            if (remaining <= 0) break;

            const available = Number(variant.available) || 0;
            const toSell = Math.min(remaining, available);

            if (toSell <= 0) continue;

            await client.query(
              `UPDATE purchase_batch_item_variants
               SET sold_quantity = sold_quantity + $2
               WHERE id = $1`,
              [variant.id, toSell]
            );

            remaining -= toSell;
          }

          if (remaining > 0) {
            throw new Error(
              `Недостаточно остатка на складе для товара "${item.product_id}". Не хватает: ${remaining}`
            );
          }
        }

        const event = await client.query(
          `INSERT INTO order_events (
            order_id, event_type, telegram_callback_id
          )
          VALUES ($1, 'DELIVERED', $2)
          ON CONFLICT (telegram_callback_id) DO NOTHING
          RETURNING id`,
          [orderId, String(ctx.callbackQuery.id)]
        );

        if (event.rowCount === 0) {
          throw new Error('Этот ответ уже обработан');
        }

        const updatedOrder = await client.query(
          `UPDATE orders
           SET status = 'delivered', updated_at = NOW()
           WHERE id = $1 AND status = 'pending'`,
          [orderId]
        );

        if (updatedOrder.rowCount !== 1) {
          throw new Error('Не удалось подтвердить доставку: заказ уже обработан');
        }

        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }

      await ctx.answerCbQuery('Доставка подтверждена');
      await ctx.editMessageText(
        '✅ Заказ доставлен.'
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
bot.on('text', async (ctx, next) => {
  if (String(ctx.chat.id) === SUPPORT_CHAT_ID && waitingForSupportReply.has(String(ctx.chat.id))) {
    const clientId = waitingForSupportReply.get(String(ctx.chat.id));
    const replyText = String(ctx.message.text || '').trim();
    if (!replyText || replyText.length > 2000) {
      await ctx.reply('Сообщение должно содержать от 1 до 2000 символов.');
      return;
    }
    try {
      await pool.query("INSERT INTO support_messages (client_id, sender, message, is_read) VALUES ($1, 'support', $2, FALSE)", [clientId, replyText]);
      waitingForSupportReply.delete(String(ctx.chat.id));
      await ctx.reply('✅ Сообщение отправлено клиенту в Mekha Shop.');
    } catch (error) {
      console.error('Support button reply failed:', error.message);
      await ctx.reply('Не удалось отправить сообщение. Попробуйте ещё раз.');
    }
    return;
  }

  // Администратор удаляет диалог командой /deletechat в Reply на сообщение клиента от бота.
  if (String(ctx.chat.id) === SUPPORT_CHAT_ID && /^\/deletechat(?:@\w+)?(?:\s|$)/i.test(ctx.message.text || '')) {
    const deleteReplyToId = ctx.message.reply_to_message?.message_id;
    if (!deleteReplyToId) {
      await ctx.reply('Для удаления диалога отправьте /deletechat ответом (Reply) на исходное сообщение клиента от бота.');
      return;
    }

    const link = await pool.query(
      'SELECT client_id FROM support_telegram_links WHERE telegram_message_id = $1',
      [deleteReplyToId]
    );
    if (!link.rows[0]) {
      await ctx.reply('Диалог не найден. Ответьте командой на исходное сообщение клиента от бота.');
      return;
    }

    const clientId = link.rows[0].client_id;
    const db = await pool.connect();
    let linkedMessageIds = [];
    try {
      await db.query('BEGIN');
      const links = await db.query(
        'SELECT telegram_message_id FROM support_telegram_links WHERE client_id = $1',
        [clientId]
      );
      linkedMessageIds = links.rows.map(row => Number(row.telegram_message_id));
      await db.query('DELETE FROM support_messages WHERE client_id = $1', [clientId]);
      await db.query('DELETE FROM support_telegram_links WHERE client_id = $1', [clientId]);
      await db.query('COMMIT');
    } catch (error) {
      await db.query('ROLLBACK');
      console.error('Support chat deletion failed:', error.message);
      await ctx.reply('Не удалось удалить диалог. Попробуйте позже.');
      return;
    } finally {
      db.release();
    }

    for (const messageId of linkedMessageIds) {
      try {
        await ctx.telegram.deleteMessage(ctx.chat.id, messageId);
      } catch (error) {
        console.warn('Could not delete Telegram support message:', messageId, error.message);
      }
    }
    try {
      await ctx.deleteMessage();
    } catch (error) {
      console.warn('Could not delete /deletechat command:', error.message);
    }
    await ctx.reply('🗑 Диалог удалён из Mekha Shop. История приложения и привязки Telegram очищены.');
    return;
  }

  const replyToId = ctx.message.reply_to_message?.message_id;
  if (String(ctx.chat.id) === SUPPORT_CHAT_ID && replyToId) {
    try {
      const link = await pool.query(
        'SELECT client_id FROM support_telegram_links WHERE telegram_message_id = $1',
        [replyToId]
      );
      if (link.rows[0]) {
        const replyText = String(ctx.message.text || '').trim();
        if (!replyText) {
          await ctx.reply('Для ответа клиенту отправьте текстовое сообщение.');
          return;
        }
        await pool.query(
          "INSERT INTO support_messages (client_id, sender, message, is_read) VALUES ($1, 'support', $2, FALSE)",
          [link.rows[0].client_id, replyText]
        );
        await ctx.reply('✅ Ответ отправлен клиенту в Mekha Shop.');
        return;
      }
    } catch (error) {
      console.error('Support reply routing failed:', error.message);
      await ctx.reply('Не удалось отправить ответ клиенту.');
      return;
    }
  }
  return next();
});

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
