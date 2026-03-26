const { Telegraf } = require('telegraf');
const { spawn } = require('child_process');

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

const conversations = new Map();
const pendingPermissions = new Map(); // permId -> { child, resolve }

const ALLOWED_IDS = process.env.ALLOWED_USER_IDS
  ? process.env.ALLOWED_USER_IDS.split(',').map(Number)
  : [];

// 所有需要授權的模式（y/n 類）
const PERMISSION_PATTERN = /\(y\)es\s*\/\s*\(n\)o|\(y\/n\)|\[y\/n\]|\(yes\/no\)|press enter|continue\?|Allow\s+.+\?|Do you want to allow|bash command:|wants to (read|write|run|execute|edit)/i;

// 直接執行 CLI 指令（不經 Claude），回傳 stdout
function runCLI(cmd, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(stderr.trim() || `exit code ${code}`));
      else resolve(stdout.trim());
    });
  });
}

function buildPrompt(history, newMessage) {
  if (history.length === 0) return newMessage;
  const ctx = history.map(h => `${h.role}: ${h.content}`).join('\n');
  return `以下是對話歷史：\n${ctx}\n\nHuman: ${newMessage}`;
}

function askClaude(prompt, onPermissionRequest) {
  return new Promise((resolve, reject) => {
    const child = spawn('claude', ['--print', '--add-dir', '/root'], {
      env: { ...process.env },
    });

    let stdout = '';
    let stderr = '';
    let waitingForPermission = false;

    const handleData = async (data, isStderr) => {
      const text = data.toString();
      if (isStderr) stderr += text; else stdout += text;

      if (waitingForPermission) return;

      if (PERMISSION_PATTERN.test(text)) {
        waitingForPermission = true;
        // 擷取最近幾行作為提示文字
        const context = (stdout + (isStderr ? stderr : '')).split('\n').slice(-8).join('\n').trim();
        try {
          const allowed = await onPermissionRequest(context, child);
          child.stdin.write(allowed ? 'y\n' : 'n\n');
        } catch {
          child.stdin.write('n\n');
        }
        waitingForPermission = false;
      }
    };

    child.stdout.on('data', (data) => handleData(data, false));
    child.stderr.on('data', (data) => handleData(data, true));

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

// 處理授權按鈕回調
bot.action(/^perm_(allow|deny)_(.+)$/, async (ctx) => {
  const [, action, permId] = ctx.match;
  const pending = pendingPermissions.get(permId);

  if (!pending) {
    return ctx.answerCbQuery('此授權請求已過期');
  }

  pendingPermissions.delete(permId);
  const allowed = action === 'allow';

  await ctx.editMessageText(allowed ? '✅ 已允許' : '❌ 已拒絕');
  await ctx.answerCbQuery();
  pending.resolve(allowed);
});

const BOT_COMMANDS = [
  { command: 'start',   description: '啟動 Bot' },
  { command: 'help',    description: '顯示所有指令' },
  { command: 'clear',   description: '清除對話記憶' },
  { command: 'usage',   description: '查看 Claude 用量' },
  { command: 'model',   description: '目前使用的模型' },
  { command: 'status',  description: 'Bot 狀態' },
  { command: 'version', description: 'Claude CLI 版本' },
];

bot.start((ctx) => ctx.reply(
  '你好！我是 Claude Bot。\n\n可用指令：\n' +
  '/help — 顯示所有指令\n' +
  '/clear — 清除對話記憶\n' +
  '/usage — 查看 Claude 用量\n' +
  '/model — 目前使用的模型\n' +
  '/status — Bot 狀態\n' +
  '/version — Claude CLI 版本'
));

bot.command('help', (ctx) => {
  ctx.reply(
    '可用指令：\n\n' +
    '/clear — 清除對話記憶\n' +
    '/usage — 查看 Claude token 用量\n' +
    '/model — 目前使用的模型\n' +
    '/status — Bot 運作狀態\n' +
    '/version — Claude CLI 版本\n\n' +
    '直接輸入文字即可與 Claude 對話。'
  );
});

bot.command('clear', (ctx) => {
  conversations.delete(ctx.from.id);
  ctx.reply('對話記憶已清除。');
});

bot.command('usage', async (ctx) => {
  ctx.sendChatAction('typing');
  try {
    const result = await askClaude(
      '請查看 /root/.claude/ 目錄下所有檔案，找出 Claude Code 使用量統計（current session 百分比、weekly 百分比、重置時間），並以純文字格式回報。若找不到用量檔案，請列出 /root/.claude/ 的檔案清單。',
      async () => false
    );
    ctx.reply(result || '無用量資訊');
  } catch (err) {
    ctx.reply(`錯誤：${err.message}`);
  }
});

bot.command('model', async (ctx) => {
  ctx.sendChatAction('typing');
  try {
    const ver = await runCLI('claude', ['--version']);
    ctx.reply(ver || '無法取得模型資訊');
  } catch (err) {
    ctx.reply(`錯誤：${err.message}`);
  }
});

bot.command('status', (ctx) => {
  const uptime = process.uptime();
  const h = Math.floor(uptime / 3600);
  const m = Math.floor((uptime % 3600) / 60);
  const s = Math.floor(uptime % 60);
  ctx.reply(
    `✅ Bot 正常運作中\n\n` +
    `運行時間：${h}h ${m}m ${s}s\n` +
    `對話中的用戶：${conversations.size}`
  );
});

bot.command('version', async (ctx) => {
  ctx.sendChatAction('typing');
  try {
    const result = await runCLI('claude', ['--version']);
    ctx.reply(result || '無法取得版本');
  } catch (err) {
    ctx.reply(`錯誤：${err.message}`);
  }
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
    const response = await askClaude(prompt, async (permissionText, child) => {
      const permId = `${userId}_${Date.now()}`;

      await ctx.reply(
        `🔐 *需要授權*\n\`\`\`\n${permissionText.slice(0, 500)}\n\`\`\``,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [[
              { text: '✅ Allow', callback_data: `perm_allow_${permId}` },
              { text: '❌ Deny', callback_data: `perm_deny_${permId}` },
            ]],
          },
        }
      );

      return new Promise((resolve) => {
        pendingPermissions.set(permId, { child, resolve });
        // 60 秒無回應自動拒絕
        setTimeout(() => {
          if (pendingPermissions.has(permId)) {
            pendingPermissions.delete(permId);
            child.stdin.write('n\n');
            resolve(false);
          }
        }, 60000);
      });
    });

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
bot.launch().then(async () => {
  console.log('Bot 已啟動，正在註冊指令選單...');
  try {
    await bot.telegram.setMyCommands(BOT_COMMANDS);
    console.log('指令選單註冊完成');
  } catch (err) {
    console.error('指令選單註冊失敗：', err.message);
  }
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
