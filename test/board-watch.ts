import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Mock, TestContext } from 'node:test';
import { boardWatchConfig, createBoardWatch, formatItems, newItems } from '../board-watch.ts';
import type { BoardItem } from '../board-watch.ts';

// Slack payloads are inspected loosely here; board-watch.ts checks them against the SDK's types.
type SlackCall = (args: any) => Promise<any>;
interface FakeClient {
  conversations: { open: Mock<SlackCall> };
  chat: { postMessage: Mock<SlackCall> };
}

const ALLOWED = new Set(['UALLOWED']);
const BOARD = 'http://127.0.0.1:4517';

function card(overrides: Partial<BoardItem> = {}): BoardItem {
  return {
    projectId: 'proj-1',
    project: 'emulate',
    id: 'emulate-9xc',
    title: 'Review PR #206: fix(audit-logs)',
    kind: 'review-ready',
    next: 'Read the review in Activity, then leave your verdict.',
    detail: '[MEDIUM] Backward pagination skips the previous page.',
    pullRequest: 'https://github.com/acme/emulate/pull/206',
    path: '#/issue/proj-1/emulate-9xc',
    ...overrides,
  };
}

// A board whose answer the test sets, and a Slack that records what it is sent.
function fixture(t: TestContext, overrides: Partial<FakeClient> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'board-watch-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const stateFile = join(dir, 'board-seen.json');
  const client: FakeClient = {
    conversations: { open: t.mock.fn<SlackCall>(async () => ({ ok: true, channel: { id: 'DDIRECT' } })) },
    chat: { postMessage: t.mock.fn<SlackCall>(async () => ({ ok: true, ts: '123.456' })) },
    ...overrides,
  };
  const board: { items: unknown; down: boolean; asked: string[] } = { items: [], down: false, asked: [] };
  const fetchFn = (async (url: string | URL | Request) => {
    board.asked.push(String(url));
    if (board.down) throw new Error('connect ECONNREFUSED');
    return new Response(JSON.stringify(board.items), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const logs: string[] = [];
  const watch = () => createBoardWatch({
    config: { url: BOARD, pollMs: 60_000, user: 'UALLOWED', stateFile },
    client, fetch: fetchFn, log: (line) => logs.push(line),
  });
  const sent = () => client.chat.postMessage.mock.calls.map((call) => call.arguments[0].blocks[0].text.text as string);
  return { board, client, logs, sent, stateFile, watch };
}

test('the board watch is on by default, and its configuration fails closed', () => {
  assert.deepEqual(boardWatchConfig({ HOME: '/home/me' }, ALLOWED), {
    url: BOARD, pollMs: 60_000, user: 'UALLOWED', stateFile: '/home/me/.gjt-bot-ian/board-seen.json',
  });
  assert.equal(boardWatchConfig({ BOT_BOARD_POLL_MS: '0' }, ALLOWED), null);
  assert.equal(boardWatchConfig({ PWUI_URL: 'http://board.internal:9000/', BOT_BOARD_POLL_MS: '30000' }, ALLOWED)?.url,
    'http://board.internal:9000');
  for (const env of [
    { BOT_BOARD_POLL_MS: 'soon' }, { BOT_BOARD_POLL_MS: '1000' },
    { PWUI_URL: 'not a url' }, { PWUI_URL: 'file:///etc/passwd' },
    { BOT_BOARD_USER: 'USTRANGER' },
  ]) assert.throws(() => boardWatchConfig(env, ALLOWED));
  // Two people could own the board; the bot must be told which.
  const two = new Set(['UONE', 'UTWO']);
  assert.throws(() => boardWatchConfig({}, two));
  assert.equal(boardWatchConfig({ BOT_BOARD_USER: 'UTWO' }, two)?.user, 'UTWO');
});

test('the first look only takes stock, so starting the bot announces nothing old', async (t) => {
  const f = fixture(t);
  f.board.items = [card()];
  assert.equal(await f.watch().poll(), 0);
  assert.deepEqual(f.sent(), []);
  assert.deepEqual(f.board.asked, [`${BOARD}/api/attention`]);
  assert.deepEqual(JSON.parse(readFileSync(f.stateFile, 'utf8')), { keys: ['proj-1/emulate-9xc:review-ready'] });
});

test('a card that newly needs the user is sent once, as plain text in their DM', async (t) => {
  const f = fixture(t);
  const watch = f.watch();
  await watch.poll();
  f.board.items = [card()];
  assert.equal(await watch.poll(), 1);
  assert.equal(await watch.poll(), 0);

  assert.deepEqual(f.client.conversations.open.mock.calls[0]?.arguments[0], { users: 'UALLOWED' });
  const message = f.client.chat.postMessage.mock.calls[0]?.arguments[0];
  assert.equal(f.client.chat.postMessage.mock.callCount(), 1);
  assert.equal(message.channel, 'DDIRECT');
  assert.equal(message.mrkdwn, false);
  assert.equal(message.parse, 'none');
  assert.equal(message.blocks[0].text.type, 'plain_text');
  assert.equal(message.blocks[0].text.text, [
    'The board needs you:',
    '',
    'Review ready · emulate · Review PR #206: fix(audit-logs)',
    'Read the review in Activity, then leave your verdict.',
    '[MEDIUM] Backward pagination skips the previous page.',
    `${BOARD}/#/issue/proj-1/emulate-9xc`,
  ].join('\n'));
});

test('only news is announced: drafts, halts, and cards about to be reviewed are not', async (t) => {
  const f = fixture(t);
  const watch = f.watch();
  await watch.poll();
  f.board.items = [
    card({ id: 'a', kind: 'draft' }), card({ id: 'b', kind: 'halted' }), card({ id: 'c', kind: 'unreviewed' }),
    card({ id: 'd', kind: 'decision', next: 'Break compatibility?', detail: 'Break compatibility?' }),
    { nonsense: true },
  ];
  assert.equal(await watch.poll(), 1);
  assert.match(f.sent()[0] ?? '', /^The board needs you:\n\nNeeds your decision · emulate/);
});

test('a card that stopped needing the user and needs them again is announced again', async (t) => {
  const f = fixture(t);
  const watch = f.watch();
  await watch.poll();
  f.board.items = [card()];
  await watch.poll();
  // A second review is asked for: the card is busy, then ready once more.
  f.board.items = [];
  await watch.poll();
  f.board.items = [card()];
  assert.equal(await watch.poll(), 1);
  assert.equal(f.sent().length, 2);
});

test('what was seen survives a restart of the bot', async (t) => {
  const f = fixture(t);
  f.board.items = [card()];
  await f.watch().poll();
  f.board.items = [card(), card({ id: 'emulate-new', kind: 'escalated', detail: null })];
  // A new process: it reads the file the last one wrote.
  assert.equal(await f.watch().poll(), 1);
  assert.match(f.sent()[0] ?? '', /Escalated · emulate/);
  assert.doesNotMatch(f.sent()[0] ?? '', /Review ready/);
});

test('a board that is down changes nothing, and is mentioned once', async (t) => {
  const f = fixture(t);
  const watch = f.watch();
  f.board.items = [card()];
  await watch.poll();
  f.board.down = true;
  await watch.poll();
  await watch.poll();
  f.board.down = false;
  assert.equal(await watch.poll(), 0);
  assert.deepEqual(f.sent(), []);
  assert.deepEqual(f.logs.filter((line) => /reachable/.test(line)), [
    `[board] unreachable at ${BOARD}`, `[board] reachable again at ${BOARD}`,
  ]);
});

test('a message Slack did not take is sent again at the next look', async (t) => {
  let fail = true;
  const f = fixture(t, {
    chat: { postMessage: t.mock.fn<SlackCall>(async () => {
      if (fail) throw new Error('slack is down: xoxb-secret');
      return { ok: true, ts: '1.2' };
    }) },
  });
  const watch = f.watch();
  await watch.poll();
  f.board.items = [card()];
  assert.equal(await watch.poll(), 0);
  fail = false;
  assert.equal(await watch.poll(), 1);
  // The raw error never reaches the log.
  assert.ok(f.logs.includes('[board] notification.error'));
  assert.equal(f.logs.some((line) => line.includes('xoxb')), false);
});

test('newItems and formatItems keep a long list inside one Slack message', () => {
  const many = Array.from({ length: 40 }, (_, i) => card({ id: `c${i}`, path: `#/issue/proj-1/c${i}`, detail: 'x'.repeat(2_000) }));
  assert.equal(newItems(new Set(['proj-1/c0:review-ready']), many).length, 39);
  const text = formatItems(many, BOARD);
  assert.ok(text.length <= 3_000, `message is ${text.length} characters`);
  assert.match(text, /^The board needs you \(40 cards\):/);
  assert.match(text, /…and \d+ more on the board: http:\/\/127\.0\.0\.1:4517$/);
});
