import assert from 'node:assert/strict';
import { request } from 'node:http';
import { connect } from 'node:net';
import { test } from 'node:test';
import { localApiClient, localApiConfig, startLocalApi } from '../local-api.js';

const TOKEN = '0123456789abcdef'.repeat(4);
const ALLOWED = new Set(['UALLOWED']);
const ENV = { BOT_LOCAL_API_PORT: '3210', BOT_LOCAL_API_TOKEN: TOKEN };

async function fixture(t, overrides = {}) {
  const client = {
    conversations: { open: t.mock.fn(async () => ({ ok: true, channel: { id: 'DDIRECT' } })) },
    chat: { postMessage: t.mock.fn(async () => ({ ok: true, ts: '123.456' })) },
    ...overrides,
  };
  const logs = [];
  const server = await startLocalApi({
    config: { ...localApiConfig(ENV, ALLOWED), port: 0 }, client, log: (line) => logs.push(line),
  });
  t.after(async () => {
    const closed = new Promise((resolve) => server.close(resolve));
    server.closeAllConnections();
    await closed;
  });
  const port = server.address().port;
  const send = ({ body = JSON.stringify({ text: 'Build finished.' }), headers = {}, method = 'POST', path = '/notify' } = {}) => new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, agent: false, headers: {
      Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', ...headers,
    } }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(data) }));
    });
    req.on('error', reject);
    req.end(body);
  });
  return { server, port, send, client, logs };
}

test('local API is opt-in and rejects incomplete or unsafe configuration', async () => {
  assert.equal(localApiConfig({}, ALLOWED), null);
  assert.equal(await startLocalApi({ config: null }), null);
  assert.deepEqual(localApiConfig(ENV, ALLOWED), { port: 3210, token: TOKEN, user: 'UALLOWED' });
  for (const env of [
    { BOT_LOCAL_API_PORT: '3210' }, { BOT_LOCAL_API_TOKEN: TOKEN },
    { ...ENV, BOT_LOCAL_API_PORT: '0' }, { ...ENV, BOT_LOCAL_API_PORT: '65536' },
    { ...ENV, BOT_LOCAL_API_PORT: '3210junk' }, { ...ENV, BOT_LOCAL_API_TOKEN: 'password' },
    { ...ENV, BOT_LOCAL_API_USER: 'USTRANGER' },
  ]) assert.throws(() => localApiConfig(env, ALLOWED));
  assert.throws(() => localApiConfig(ENV, new Set()));
  assert.throws(() => localApiConfig(ENV, new Set(['UALLOWED', 'UOTHER'])));
  assert.equal(localApiConfig({ ...ENV, BOT_LOCAL_API_USER: 'UOTHER' }, new Set(['UALLOWED', 'UOTHER'])).user, 'UOTHER');
});

test('an authenticated notification is literal text in the configured user’s DM', async (t) => {
  const { server, send, client, logs } = await fixture(t);
  assert.equal(server.address().address, '127.0.0.1');
  const text = 'Approve and label; $(touch /tmp/nope) <@UALLOWED> <!channel> https://example.com & *bold*';
  const result = await send({ body: JSON.stringify({ text }) });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { ok: true, ts: '123.456' });
  assert.equal(result.headers['cache-control'], 'no-store');
  assert.equal(result.headers['access-control-allow-origin'], undefined);
  assert.deepEqual(client.conversations.open.mock.calls[0].arguments, [{ users: 'UALLOWED' }]);
  const message = client.chat.postMessage.mock.calls[0].arguments[0];
  assert.equal(message.channel, 'DDIRECT');
  assert.equal(message.blocks[0].text.type, 'plain_text');
  assert.equal(message.blocks[0].text.text, text);
  assert.ok(!message.text.includes('<@'));
  assert.equal(message.mrkdwn, false);
  assert.equal(message.unfurl_links, false);
  assert.equal(message.unfurl_media, false);
  assert.equal(message.link_names, false);
  assert.deepEqual(logs, ['[local-api] notification.sent']);
});

test('Node fetch can notify while browser Origin and fetch metadata remain blocked', async (t) => {
  const { port, client } = await fixture(t);
  for (const [extraHeaders, status] of [
    [{}, 200],
    [{ Origin: 'https://example.com' }, 403],
    [{ 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Dest': 'empty' }, 403],
  ]) {
    const response = await fetch(`http://127.0.0.1:${port}/notify`, {
      method: 'POST', redirect: 'error',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}`, ...extraHeaders },
      body: JSON.stringify({ text: 'From Node fetch.' }),
    });
    await response.arrayBuffer();
    assert.equal(response.status, status);
  }
  assert.equal(client.chat.postMessage.mock.callCount(), 1);
});

test('auth, browser, routing, and content checks reject requests before contacting Slack', async (t) => {
  const { send, client } = await fixture(t);
  for (const [options, status] of [
    [{ headers: { Authorization: '' } }, 401],
    [{ headers: { Authorization: `Bearer ${'f'.repeat(64)}` } }, 401],
    [{ headers: { Authorization: `Bearer ${TOKEN}x` } }, 401],
    [{ headers: { Authorization: [`Bearer ${TOKEN}`, `Bearer ${TOKEN}`] } }, 401],
    [{ headers: { Origin: 'https://example.com' } }, 403],
    [{ headers: { Origin: 'null' } }, 403],
    [{ headers: { 'Sec-Fetch-Site': 'same-origin' } }, 403],
    [{ headers: { Host: 'attacker.example', 'X-Forwarded-For': '127.0.0.1' } }, 403],
    [{ headers: { Host: 'localhost:3210' } }, 403],
    [{ path: `/notify?token=${TOKEN}`, headers: { Authorization: '' } }, 401],
    [{ path: '/notify?user=UOTHER' }, 404],
    [{ path: '/tasks' }, 404],
    [{ method: 'GET', body: '' }, 405],
    [{ method: 'OPTIONS', body: '' }, 405],
    [{ headers: { 'Content-Type': 'text/plain' } }, 415],
    [{ headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }, 415],
    [{ headers: { 'Content-Type': 'application/json; charset=latin1' } }, 415],
    [{ headers: { 'Content-Encoding': 'gzip' } }, 415],
    [{ headers: { 'Content-Length': '20000' }, body: '' }, 413],
  ]) assert.equal((await send(options)).status, status, JSON.stringify(options));
  assert.equal(client.conversations.open.mock.callCount(), 0);
  assert.equal(client.chat.postMessage.mock.callCount(), 0);
});

test('JSON schema and streamed size limits prevent arbitrary Slack arguments and oversized input', async (t) => {
  const { send, client } = await fixture(t);
  for (const body of [
    '', '{', 'null', '[]', '1', '"hello"', '{}', '{"text":3}', '{"text":" "}',
    JSON.stringify({ text: 'hello', user: 'UOTHER' }),
    JSON.stringify({ text: 'hello', channel: 'CCHANNEL' }),
    JSON.stringify({ text: 'hello', prompt: 'execute a command' }),
    JSON.stringify({ text: 'hello', blocks: [] }),
    JSON.stringify({ text: 'a'.repeat(3001) }),
    '{"text":"\\ud800"}', Buffer.from([0xff]),
  ]) assert.equal((await send({ body })).status, 400);
  // No Content-Length: enforce the cap as bytes arrive too.
  assert.equal((await send({ body: ' '.repeat(16_385), headers: { 'Transfer-Encoding': 'chunked' } })).status, 413);
  assert.equal(client.chat.postMessage.mock.callCount(), 0);
  assert.equal((await send({ body: JSON.stringify({ text: 'a'.repeat(3000) }) })).status, 200);
});

test('Slack failures return generic errors without leaking token or message data', async (t) => {
  const { send, logs } = await fixture(t, {
    chat: { postMessage: t.mock.fn(async () => { throw new Error(`private body ${TOKEN}`); }) },
  });
  const result = await send();
  assert.equal(result.status, 502);
  assert.match(result.body.error, /could not be confirmed/);
  assert.ok(!JSON.stringify([result, logs]).includes(TOKEN));
  assert.deepEqual(logs, ['[local-api] notification.error']);
});

test('the notification Slack client neither retries nor logs raw SDK errors', async (t) => {
  const logs = [];
  for (const method of ['log', 'warn', 'error', 'info', 'debug']) {
    t.mock.method(console, method, (...args) => logs.push(args));
  }
  const transport = t.mock.fn(async () => { throw new Error(`private body ${TOKEN}`); });
  const client = localApiClient('xoxb-test-token', { fetch: transport });
  await assert.rejects(client.chat.postMessage({ channel: 'DDIRECT', text: 'secret message' }));
  assert.equal(transport.mock.callCount(), 1);
  assert.ok(transport.mock.calls[0].arguments[1].signal instanceof AbortSignal);
  transport.mock.mockImplementation(async () => new Response(JSON.stringify({
    ok: false, error: 'invalid_auth',
    response_metadata: { warnings: [TOKEN], messages: [`[ERROR] ${TOKEN}`] },
  }), { headers: { 'Content-Type': 'application/json' } }));
  await assert.rejects(client.chat.postMessage({ channel: 'DDIRECT', text: 'secret message' }));
  assert.deepEqual(logs, []);
});

test('unexpected Slack responses cannot redirect delivery or claim success', async (t) => {
  const { send, client } = await fixture(t);
  client.conversations.open.mock.mockImplementation(async () => ({ ok: true, channel: { id: 'CCHANNEL' } }));
  assert.equal((await send()).status, 502);
  assert.equal(client.chat.postMessage.mock.callCount(), 0);
  client.conversations.open.mock.mockImplementation(async () => ({ ok: true, channel: { id: 'DDIRECT' } }));
  client.chat.postMessage.mock.mockImplementation(async () => ({ ok: false }));
  assert.equal((await send()).status, 502);
});

test('concurrent deliveries are bounded and the limit clears after failure', async (t) => {
  let release;
  let started;
  const pending = new Promise((resolve) => { release = resolve; });
  const active = new Promise((resolve) => { started = resolve; });
  const { send } = await fixture(t, {
    conversations: { open: async () => { started(); await pending; throw new Error('Slack unavailable'); } },
  });
  const first = send();
  await active;
  const busy = await send();
  assert.equal(busy.status, 429);
  assert.equal(busy.headers['retry-after'], '60');
  release();
  assert.equal((await first).status, 502);
  assert.equal((await send()).status, 502);
});

test('authenticated traffic has a bounded rate', async (t) => {
  const { send, client } = await fixture(t);
  for (let i = 0; i < 30; i++) assert.equal((await send({ body: '{}' })).status, 400);
  const result = await send();
  assert.equal(result.status, 429);
  assert.equal(result.headers['retry-after'], '60');
  assert.equal(client.chat.postMessage.mock.callCount(), 0);
  const now = Date.now();
  t.mock.method(Date, 'now', () => now + 60_001);
  assert.equal((await send()).status, 200);
});

test('Expect: 100-continue is accepted only after authentication', async (t) => {
  const { port, client } = await fixture(t);
  for (const authorized of [false, true]) {
    let continued = false;
    const status = await new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, method: 'POST', path: '/notify', agent: false, headers: {
        Expect: '100-continue', Authorization: `Bearer ${authorized ? TOKEN : 'f'.repeat(64)}`,
        'Content-Type': 'application/json',
      } }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      });
      req.on('continue', () => {
        continued = true;
        req.end(JSON.stringify({ text: 'Only after authentication.' }));
      });
      req.on('error', reject);
      req.flushHeaders();
    });
    assert.equal(status, authorized ? 200 : 401);
    assert.equal(continued, authorized);
  }
  assert.equal(client.chat.postMessage.mock.callCount(), 1);
});

test('aborted requests release the delivery slot without sending to Slack', { timeout: 3000 }, async (t) => {
  const { server, port, send, client } = await fixture(t);
  let started;
  const received = new Promise((resolve) => { started = resolve; });
  const aborted = new Promise((resolve) => server.once('request', (req) => {
    started();
    req.once('aborted', resolve);
  }));
  const socket = connect(port, '127.0.0.1', () => {
    socket.write(`POST /notify HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAuthorization: Bearer ${TOKEN}\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{`);
  });
  t.after(() => socket.destroy());
  await received;
  socket.destroy();
  await aborted;
  assert.equal(client.chat.postMessage.mock.callCount(), 0);
  assert.equal((await send()).status, 200);
});

test('slow bodies time out and release the single delivery slot', { timeout: 10_000 }, async (t) => {
  const { port, send, client } = await fixture(t);
  const response = await new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => {
      socket.write(`POST /notify HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAuthorization: Bearer ${TOKEN}\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{`);
    });
    t.after(() => socket.destroy());
    let data = '';
    socket.on('data', (chunk) => { data += chunk; });
    socket.on('end', () => resolve(data));
    socket.on('error', reject);
  });
  assert.match(response, /^HTTP\/1.1 408/);
  assert.equal(client.chat.postMessage.mock.callCount(), 0);
  assert.equal((await send()).status, 200);
});
