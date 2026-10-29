export interface TelegramCredentials {
  botToken: string;
  chatId: string;
}

export async function sendTelegramMessage(config: TelegramCredentials, text: string): Promise<void> {
  const botToken = config.botToken.trim();
  const chatId = config.chatId.trim();
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(botToken)) {
    throw new Error('Telegram: enter a valid bot token from BotFather.');
  }
  if (!chatId) {
    throw new Error('Telegram: enter a Chat ID.');
  }

  let response: Response;
  let data: unknown;
  try {
    response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
      signal: AbortSignal.timeout(10000),
      redirect: 'error'
    });
    data = await response.json();
  } catch {
    // Network errors can include the URL (and therefore the token).
    throw new Error('Telegram: request failed or timed out. Check your connection and try again.');
  }

  if (!response.ok || !data || typeof data !== 'object' || !('ok' in data) || data.ok !== true) {
    // Do not echo remote descriptions, URLs or credentials into VS Code logs.
    throw new Error(`Telegram: message rejected (HTTP ${response.status}). Check the bot token, Chat ID and bot permissions.`);
  }
}
