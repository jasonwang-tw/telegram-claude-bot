import TelegramBot from 'node-telegram-bot-api';
import { query } from '@anthropic-ai/claude-code';

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });

// 每個 user 的對話歷史
const conversations = new Map();

// 白名單（留空則所有人可用）
const ALLOWED_IDS = process.env.ALLOWED_USER_IDS
  ? process.env.ALLOWED_USER_IDS.split(',').map(Number)
  : [];

function buildPrompt(history, newMessage) {
  if (history.length === 0) return newMessage;
  const ctx = history.map(h => `${h.role}: ${h.content}`).join('\n');
  return `以下是對話歷史：\n${ctx}\n\nHuman: ${newMessage}`;
}

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text = msg.text?.trim();

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

  const history = conversations.get(userId) ?? [];
  const prompt = buildPrompt(history, text);

  bot.sendChatAction(chatId, 'typing');

  try {
    let response = '';

    for await (const message of query({
      prompt,
      options: { maxTurns: 1 },
    })) {
      if (message.type === 'result' && message.subtype === 'success') {
        response = message.result ?? '';
      }
      // fallback：從 assistant message 取文字
      if (!response && message.type === 'assistant') {
        for (const block of message.message?.content ?? []) {
          if (block.type === 'text') response += block.text;
        }
      }
    }

    if (!response) response = '（無回應）';

    history.push({ role: 'Human', content: text });
    history.push({ role: 'Assistant', content: response });

    // 保留最近 20 則
    if (history.length > 20) history.splice(0, history.length - 20);
    conversations.set(userId, history);

    // Markdown 解析失敗時退回純文字
    await bot.sendMessage(chatId, response, { parse_mode: 'Markdown' })
      .catch(() => bot.sendMessage(chatId, response));

  } catch (err) {
    console.error('Error:', err);
    await bot.sendMessage(chatId, `錯誤：${err.message}`);
  }
});

console.log('Telegram Claude Bot 啟動中...');
