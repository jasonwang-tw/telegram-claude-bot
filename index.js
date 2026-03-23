const TelegramBot = require('node-telegram-bot-api');
const { execFile } = require('child_process');

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });

const conversations = new Map();

const ALLOWED_IDS = process.env.ALLOWED_USER_IDS
  ? process.env.ALLOWED_USER_IDS.split(',').map(Number)
  : [];

function buildPrompt(history, newMessage) {
  if (history.length === 0) return newMessage;
  const ctx = history.map(h => `${h.role}: ${h.content}`).join('\n');
  return `以下是對話歷史：\n${ctx}\n\nHuman: ${newMessage}`;
}

function askClaude(prompt) {
  return new Promise((resolve, reject) => {
    execFile('claude', ['--print', prompt], {
      env: { ...process.env, HOME: '/root' },
      timeout: 120000,
      maxBuffer: 1024 * 1024 * 10,
    }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve(stdout.trim());
    });
  });
}

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text = msg.text && msg.text.trim();

  if (!text) return;

  if (ALLOWED_IDS.length && !ALLOWED_IDS.includes(userId)) {
    return bot.sendMessage(chatId, '無存取權限。');
  }

  if (text === '/start') {
    return bot.sendMessage(chatId, '你好！我是 Claude Bot。\n\n指令：\n/clear — 清除對話記憶');
  }

  if (text === '/clear') {
    conversations.delete(userId);
    return bot.sendMessage(chatId, '對話記憶已清除。');
  }

  const history = conversations.get(userId) || [];
  const prompt = buildPrompt(history, text);

  bot.sendChatAction(chatId, 'typing');

  try {
    const response = await askClaude(prompt);

    history.push({ role: 'Human', content: text });
    history.push({ role: 'Assistant', content: response });

    if (history.length > 20) history.splice(0, history.length - 20);
    conversations.set(userId, history);

    bot.sendMessage(chatId, response, { parse_mode: 'Markdown' })
      .catch(() => bot.sendMessage(chatId, response));

  } catch (err) {
    console.error('Error:', err.message);
    bot.sendMessage(chatId, `錯誤：${err.message}`);
  }
});

console.log('Telegram Claude Bot 啟動中...');
