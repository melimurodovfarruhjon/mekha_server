const { Telegraf } = require('telegraf');
const express = require('express');
const cors = require('cors');

const TOKEN = process.env.BOT_TOKEN || "ВАШ_ТОКЕН_БОТА_СЮДА";
const bot = new Telegraf(TOKEN);
const app = express();

app.use(cors());
app.use(express.json());

const waitingForReason = new Map();
let latestUpdates = [];

bot.on('callback_query', async (ctx) => {
  const data = ctx.callbackQuery.data;
  const chatId = ctx.chat.id;

  if (data === 'delivered') {
    await ctx.answerCbQuery('Заказ отмечен как доставленный!');
    await ctx.editMessageText('✅ Заказ успешно доставлен клиенту.');
    latestUpdates.unshift({ type: 'DELIVERED', time: new Date().toLocaleTimeString() });
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
  }
});

bot.launch().then(() => console.log('🤖 Бот запущен!'));

app.get('/api/updates', (req, res) => {
  res.json(latestUpdates);
  latestUpdates = [];
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🌐 Сервер работает на порту ${PORT}`));