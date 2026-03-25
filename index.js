const { Telegraf } = require('telegraf');
const { spawn } = require('child_process');

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
    const child = spawn('claude', ['--print', '--dangerously-skip-permissions'], {
      env: { ...process.env },
    });

    let stdout = '';
    let stderr = '';

    // 偵測互動提示，自動回應 y 確認
    const AUTO_CONFIRM = /\(y\/n\)|\[y\/n\]|\(yes\/no\)|press enter|continue\?/i;
    child.stdout.on('data', (data) => {
      stdout += data;
      if (AUTO_CONFIRM.test(data.toString())) {
        child.stdin.write('y\n');
      }
    });
    child.stderr.on('data', (data) => {
      stderr += data;
      if (AUTO_CONFIRM.test(data.toString())) {
        child.stdin.write('y\n');
      }
    });

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('逾時（120秒）'));
    }, 120000);

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(stderr.trim() || `exit code ${code}`));
      resolve(stdout.trim());
    });

    child.stdin.write(prompt);
    child.stdin.end();
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
