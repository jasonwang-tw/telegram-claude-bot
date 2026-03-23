const { Telegraf } = require('telegraf');
const { execFile } = require('child_process');

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

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

bot.start((ctx) => ctx.reply('你好！我是 Claude Bot。\n\n指令：\n/clear — 清除對話記憶'));

bot.command('clear', (ctx) => {
  conversations.delete(ctx.from.id);
  ctx.reply('對話記憶已清除。');
});

bot.on('text', async (ctx) => {
  const userId = ctx.from.id;
  const text = ctx.message.text.trim();

  if (ALLOWED_IDS.length && !ALLOWED_IDS.includes(userId)) {
    return ctx.reply('無存取權限。');
  }

  const history = conversations.get(userId) || [];
  const prompt = buildPrompt(history, text);

  ctx.sendChatAction('typing');

  try {
    const response = await askClaude(prompt);

    history.push({ role: 'Human', content: text });
    history.push({ role: 'Assistant', content: response });

    if (history.length > 20) history.splice(0, history.length - 20);
    conversations.set(userId, history);

    ctx.reply(response, { parse_mode: 'Markdown' })
      .catch(() => ctx.reply(response));

  } catch (err) {
    console.error('Error:', err.message);
    ctx.reply(`錯誤：${err.message}`);
  }
});

console.log('Telegram Claude Bot 啟動中...');
bot.launch();

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
