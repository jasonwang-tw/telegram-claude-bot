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

// usage cache
let usageCache = null;
let usageCacheAt = 0;
let usageRateLimitUntil = 0;
const USAGE_CACHE_TTL = 60 * 1000;
const USAGE_RATELIMIT_COOLDOWN = 5 * 60 * 1000; // 429 後等 5 分鐘

bot.command('usage', async (ctx) => {
  ctx.sendChatAction('typing');
  const fs = require('fs');

  try {
    const cred = JSON.parse(fs.readFileSync('/root/.claude/.credentials.json', 'utf8'));
    const oauth = cred.claudeAiOauth || cred;
    const token = oauth.accessToken;
    if (!token) return ctx.reply('錯誤：找不到 access token');

    let data;
    const now = Date.now();

    if (usageCache && (now - usageCacheAt) < USAGE_CACHE_TTL) {
      // cache 未過期
      data = usageCache;
    } else if (now < usageRateLimitUntil) {
      // 冷卻中
      const remaining = Math.ceil((usageRateLimitUntil - now) / 1000);
      if (usageCache) {
        data = usageCache;
        await ctx.reply(`（Rate limited，${remaining}s 後可重新整理，顯示快取資料）`);
      } else {
        return ctx.reply(`Rate limited，請等待 ${remaining} 秒後再試`);
      }
    } else {
      const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'anthropic-beta': 'oauth-2025-04-20',
          'User-Agent': 'claude-code/2.1.34',
        },
      });

      if (!res.ok) {
        const text = await res.text();
        if (res.status === 429) {
          usageRateLimitUntil = now + USAGE_RATELIMIT_COOLDOWN;
          if (usageCache) {
            data = usageCache;
            await ctx.reply('（Rate limited，5 分鐘後可重新整理，顯示快取資料）');
          } else {
            return ctx.reply('Rate limited，請等待 5 分鐘後再試');
          }
        } else {
          return ctx.reply(`API ${res.status}：${text.slice(0, 300)}`);
        }
      } else {
        data = await res.json();
        usageCache = data;
        usageCacheAt = now;
        usageRateLimitUntil = 0;
      }
    }

    const data2 = data;
    const lines = [];

    // 訂閱資訊
    if (oauth.subscriptionType) lines.push(`訂閱：${oauth.subscriptionType.toUpperCase()}\n`);

    const renderBar = (pct, width = 10) => {
      const p = Math.min(100, Math.max(0, Math.round(pct)));
      const filled = Math.round(p * width / 100);
      return '●'.repeat(filled) + '○'.repeat(width - filled);
    };

    const formatReset = (iso) => {
      if (!iso) return '';
      return new Date(iso).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    };

    if (data2.five_hour) {
      const pct = Math.round((data2.five_hour.utilization || 0));
      const reset = formatReset(data2.five_hour.resets_at);
      lines.push(`current ${renderBar(pct)} ${String(pct).padStart(3)}% ⟳ ${reset}`);
    }
    if (data2.seven_day) {
      const pct = Math.round((data2.seven_day.utilization || 0));
      const reset = formatReset(data2.seven_day.resets_at);
      lines.push(`weekly  ${renderBar(pct)} ${String(pct).padStart(3)}% ⟳ ${reset}`);
    }
    if (data2.extra_usage?.is_enabled) {
      const pct = Math.round(data2.extra_usage.utilization || 0);
      const used = (data2.extra_usage.used_credits / 100).toFixed(2);
      const limit = (data2.extra_usage.monthly_limit / 100).toFixed(2);
      lines.push(`extra   ${renderBar(pct)}  $${used}/$${limit}`);
    }

    if (lines.length <= 1) lines.push(JSON.stringify(data2, null, 2).slice(0, 500));

    ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' })
      .catch(() => ctx.reply(lines.join('\n')));

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
