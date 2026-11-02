const { Telegraf } = require('telegraf');
const express = require('express');
const cors = require('cors');
const webpush = require('web-push');

const TOKEN = process.env.BOT_TOKEN || "ВАШ_ТОКЕН_БОТА_СЮДА";
const bot = new Telegraf(TOKEN);
const app = express();

app.use(cors());
app.use(express.json());

// VAPID keys for Web Push (Render environment variables-raas fudhachuu dandeessa)
const publicVapidKey = process.env.VAPID_PUBLIC_KEY || 'YOUR_PUBLIC_VAPID_KEY';
const privateVapidKey = process.env.VAPID_PRIVATE_KEY || 'YOUR_PRIVATE_KEY';

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

bot.launch().then(() => console.log('🤖 Бот запущен!'));

app.get('/api/updates', (req, res) => {
  res.json(latestUpdates);
  latestUpdates = []; 
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🌐 Сервер работает на порту ${PORT}`));
