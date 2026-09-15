import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerSlackHandlers, threadPrompt } from '../slack.js';

const ROOT_TS = '1789478070.249629';
const REQUEST_TS = '1789478072.000000';
const PR_URL = 'https://github.com/example/project/pull/42';
const ROOT = {
  ts: ROOT_TS, user: 'UANNOUNCER', bot_id: 'BANNOUNCER',
  text: `README sync: <${PR_URL}|#42>`,
};

function fixture(t, pages = [{ ok: true, messages: [ROOT], has_more: false }]) {
  const handlers = new Map();
  const app = {
    event: (type, handler) => handlers.set(type, handler),
    message: (handler) => handlers.set('message', handler),
  };
  let page = 0;
  const client = {
    conversations: { replies: t.mock.fn(async () => {
      const result = pages[page++];
      if (result instanceof Error) throw result;
      return result;
    }) },
    chat: { update: t.mock.fn(async () => ({})) },
    reactions: { add: t.mock.fn(async () => ({})) },
  };
  const say = t.mock.fn(async () => ({ ts: '1789478073.000000' }));
  const ask = t.mock.fn(async () => ({ text: 'reply', footer: 'usage' }));
  registerSlackHandlers(app, { allowedUsers: new Set(['UALLOWED']), ask });
  return {
    client, say, ask,
    async send(event) {
      const handler = handlers.get(event.type);
      if (handler) await handler({
        event, message: event, client, say, context: { botUserId: 'UBOT' },
      });
    },
  };
}

function mention(text, overrides = {}) {
  return {
    type: 'app_mention', channel: 'CCHANNEL', user: 'UALLOWED',
    ts: REQUEST_TS, thread_ts: ROOT_TS, text: `<@UBOT> ${text}`,
    ...overrides,
  };
}

function quotedContext(prompt) {
  return JSON.parse(prompt.slice(prompt.lastIndexOf('\n') + 1));
}

for (const request of ['approve and label', 'label and approve']) {
  test(`a threaded "${request}" mention sends the parent PR link to pi`, async (t) => {
    const { send, client, ask, say } = fixture(t);
    await send(mention(request));
    assert.equal(ask.mock.callCount(), 1);
    const [prompt, session] = ask.mock.calls[0].arguments;
    assert.ok(prompt.startsWith(`${request}\n`));
    const context = quotedContext(prompt);
    assert.equal(context.channel, 'CCHANNEL');
    assert.equal(context.thread_ts, ROOT_TS);
    assert.ok(context.messages[0].text.includes(PR_URL));
    assert.equal(context.messages[0].author, ROOT.user);
    assert.equal(session, `CCHANNEL:${ROOT_TS}`);
    assert.equal(say.mock.calls[0].arguments[0].thread_ts, ROOT_TS);
    assert.deepEqual(client.conversations.replies.mock.calls[0].arguments[0], {
      channel: 'CCHANNEL', ts: ROOT_TS, latest: REQUEST_TS, inclusive: false, limit: 100,
    });
    assert.equal(client.chat.update.mock.calls.at(-1).arguments[0].text, 'reply\n\nusage');
  });
}

test('ordinary channel messages and unmentioned thread replies are ignored', async (t) => {
  const { send, client, ask, say } = fixture(t);
  await send({ ...mention('approve'), type: 'message', channel_type: 'channel', text: 'approve' });
  await send({ ...mention('approve'), type: 'message', channel_type: 'channel', thread_ts: undefined, text: 'approve' });
  assert.equal(ask.mock.callCount(), 0);
  assert.equal(say.mock.callCount(), 0);
  assert.equal(client.conversations.replies.mock.callCount(), 0);
});

test('DMs still work without mentions, and preserve mentions of other users', async (t) => {
  const { send, ask, client } = fixture(t);
  await send({ type: 'message', channel_type: 'im', channel: 'DDIRECT', user: 'UALLOWED', ts: REQUEST_TS, text: 'Find the PR from <@UOTHER>' });
  assert.equal(ask.mock.calls[0].arguments[0], 'Find the PR from <@UOTHER>');
  assert.equal(ask.mock.calls[0].arguments[1], `DDIRECT:${REQUEST_TS}`);
  assert.equal(client.conversations.replies.mock.callCount(), 0);
});

test('threaded DMs receive the parent context too', async (t) => {
  const { send, ask } = fixture(t);
  await send({ ...mention(''), type: 'message', channel_type: 'im', channel: 'DDIRECT', text: 'label and approve' });
  assert.ok(quotedContext(ask.mock.calls[0].arguments[0]).messages[0].text.includes(PR_URL));
});

test('unauthorized users and bot messages cannot fetch thread history or invoke pi', async (t) => {
  const { send, client, ask } = fixture(t);
  await send(mention('approve', { user: 'USTRANGER' }));
  await send(mention('approve', { bot_id: 'BOTHER' }));
  await send({ type: 'message', channel_type: 'im', channel: 'DDIRECT', user: 'UBOT', bot_id: 'BBOT', ts: REQUEST_TS, text: 'reply' });
  assert.equal(client.conversations.replies.mock.callCount(), 0);
  assert.equal(ask.mock.callCount(), 0);
  assert.equal(client.reactions.add.mock.callCount(), 1);
});

test('pagination includes other participants, but excludes the request, future messages, and our progress', async (t) => {
  const earlier = { ts: '1789478071.000000', user: 'UOTHER', text: 'The README link is correct.' };
  const { client } = fixture(t, [
    { ok: true, messages: [ROOT], has_more: true, response_metadata: { next_cursor: 'page-two' } },
    { ok: true, messages: [
      ROOT, earlier,
      { ts: '1789478071.500000', user: 'UBOT', text: '_working…_' },
      { ts: REQUEST_TS, user: 'UALLOWED', text: 'label and approve' },
      { ts: '1789478074.000000', user: 'UOTHER', text: 'A later message' },
    ], has_more: false },
  ]);
  const prompt = await threadPrompt(client, mention('label and approve'), 'label and approve', 'UBOT');
  assert.deepEqual(quotedContext(prompt).messages.map(message => message.ts), [ROOT_TS, earlier.ts]);
  assert.equal(client.conversations.replies.mock.calls[1].arguments[0].cursor, 'page-two');
});

test('PR links in block-only announcements survive, and explicit skill requests stay first', async (t) => {
  const { client } = fixture(t, [{ ok: true, messages: [{
    ts: ROOT_TS, bot_id: 'BANNOUNCER', blocks: [{ type: 'actions', elements: [{ type: 'button', url: PR_URL }] }],
  }] }]);
  const request = '/skill:approve-merge-label label and approve';
  const prompt = await threadPrompt(client, mention(request), request, 'UBOT');
  assert.ok(prompt.startsWith(`${request}\n`));
  assert.equal(quotedContext(prompt).messages[0].blocks[0].elements[0].url, PR_URL);
});

for (const [name, response] of [
  ['history access denied', Object.assign(new Error('Slack API error'), { data: { error: 'missing_scope' } })],
  ['parent message missing', { ok: true, messages: [] }],
  ['pagination incomplete', { ok: true, messages: [ROOT], has_more: true }],
  ['thread too large', { ok: true, messages: [{ ...ROOT, text: 'a'.repeat(64_001) }] }],
]) {
  test(`${name} reports a problem without asking pi to guess`, async (t) => {
    t.mock.method(console, 'error', () => {});
    const { send, client, ask } = fixture(t, [response]);
    await send(mention('approve and label'));
    assert.equal(ask.mock.callCount(), 0);
    assert.match(client.chat.update.mock.calls.at(-1).arguments[0].text, /^:warning:/);
  });
}
