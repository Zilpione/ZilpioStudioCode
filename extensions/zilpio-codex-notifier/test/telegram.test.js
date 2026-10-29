const test = require('node:test');
const assert = require('node:assert/strict');

const credentials = { botToken: '123456:fake_token', chatId: '-100123456789' };

test('Telegram posts a plain text message to the configured chat with a bounded request', async (t) => {
  const { sendTelegramMessage } = require('../dist/telegram.js');
  let request;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    request = { url, options };
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }));
  });
  await sendTelegramMessage({ botToken: ' 123456:fake_token ', chatId: ' -100123456789 ' }, 'Task complete');
  assert.equal(request.url, 'https://api.telegram.org/bot123456:fake_token/sendMessage');
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(request.options.body), { chat_id: '-100123456789', text: 'Task complete' });
  assert.equal(request.options.redirect, 'error');
  assert.ok(request.options.signal instanceof AbortSignal);
});

test('Telegram rejects missing or malformed credentials before a network request', async (t) => {
  const { sendTelegramMessage } = require('../dist/telegram.js');
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => { requests++; });
  for (const config of [
    { ...credentials, botToken: '' },
    { ...credentials, botToken: '123:token/other' },
    { ...credentials, chatId: ' ' }
  ]) {
    await assert.rejects(sendTelegramMessage(config, 'Done'), /token|Chat ID/i);
  }
  assert.equal(requests, 0);
});

test('Telegram reports API, network and malformed response failures without exposing credentials', async (t) => {
  const { sendTelegramMessage } = require('../dist/telegram.js');
  for (const response of [
    async () => new Response(JSON.stringify({ ok: false, description: credentials.botToken }), { status: 401 }),
    async () => new Response(JSON.stringify({ ok: false, description: credentials.botToken })),
    async () => new Response('not json'),
    async () => new Response('null'),
    async () => { throw new Error(`failed https://api.telegram.org/bot${credentials.botToken}/sendMessage`); },
    async () => { throw new DOMException('Timed out', 'TimeoutError'); }
  ]) {
    t.mock.method(globalThis, 'fetch', response);
    await assert.rejects(sendTelegramMessage(credentials, 'Done'), (error) => {
      assert.match(error.message, /Telegram/);
      assert.ok(!error.message.includes(credentials.botToken));
      return true;
    });
  }
});
