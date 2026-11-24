import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { NotifyClient } from './local-api.ts';

// The board is asked; it never tells. It lists the cards that need a person
// (GET /api/attention) to whoever asks, and knows nothing about this bot. This
// watcher asks on a timer and sends a DM when a card newly needs the user.

// One card that needs a person, as the board lists it.
export interface BoardItem {
  projectId: string;
  project: string;
  id: string;
  title: string;
  kind: string;
  next: string;
  detail: string | null;
  pullRequest: string | null;
  path: string;
}

export interface BoardWatchConfig {
  url: string;
  pollMs: number;
  user: string;
  stateFile: string;
}

export interface BoardWatchOptions {
  config: BoardWatchConfig;
  client: NotifyClient;
  fetch?: typeof fetch;
  log?: (line: string) => void;
}

const DEFAULT_URL = 'http://127.0.0.1:4517';
const DEFAULT_POLL_MS = 60_000;
const FETCH_TIMEOUT_MS = 10_000;
// Slack refuses a plain-text section longer than this.
const MAX_TEXT = 2_900;
const MAX_DETAIL = 700;

// What is worth a message, and what to call it. The kinds left out are not
// news: a draft or a halt is the user's own doing, and a card with no review
// yet is about to get one.
const LABELS: Record<string, string> = {
  decision: 'Needs your decision',
  plan: 'Plan ready for approval',
  escalated: 'Escalated',
  interrupted: 'Interrupted',
  'review-ready': 'Review ready',
  'review-failed': 'Review did not finish',
  delivered: 'Delivered',
};

// Polling is on unless BOT_BOARD_POLL_MS is 0. Returns null when it is off.
// With several allowed users there is no way to guess who the board's owner
// is, so BOT_BOARD_USER has to say.
export function boardWatchConfig(
  env: Record<string, string | undefined>,
  allowedUsers: ReadonlySet<string>,
): BoardWatchConfig | null {
  const raw = env.BOT_BOARD_POLL_MS;
  if (raw !== undefined && raw.trim() !== '' && !/^\d+$/.test(raw.trim())) {
    throw new Error('BOT_BOARD_POLL_MS must be a whole number of milliseconds (0 turns the board watch off).');
  }
  const pollMs = raw === undefined || raw.trim() === '' ? DEFAULT_POLL_MS : Number(raw);
  if (pollMs === 0) return null;
  if (pollMs < 5_000) throw new Error('BOT_BOARD_POLL_MS must be at least 5000, or 0 to turn the board watch off.');

  const url = (env.PWUI_URL || DEFAULT_URL).replace(/\/+$/, '');
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error('PWUI_URL must be the address of the board, such as http://127.0.0.1:4517.'); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('PWUI_URL must start with http:// or https://.');
  }

  const user = env.BOT_BOARD_USER || (allowedUsers.size === 1 ? [...allowedUsers][0] : undefined);
  if (!user || !allowedUsers.has(user) || !/^[UW][A-Z0-9]+$/.test(user)) {
    throw new Error('Set BOT_BOARD_USER to the member of SLACK_ALLOWED_USERS who should hear from the board, or BOT_BOARD_POLL_MS=0 to turn the board watch off.');
  }
  const stateFile = env.BOT_BOARD_STATE || `${env.HOME ?? '.'}/.gjt-bot-ian/board-seen.json`;
  return { url, pollMs, user, stateFile };
}

const keyOf = (item: BoardItem) => `${item.projectId}/${item.id}:${item.kind}`;

function isItem(value: unknown): value is BoardItem {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return ['projectId', 'project', 'id', 'title', 'kind', 'next', 'path'].every((key) => typeof item[key] === 'string')
    && (item.detail === null || typeof item.detail === 'string')
    && (item.pullRequest === null || typeof item.pullRequest === 'string');
}

// The cards in `items` that were not waiting on the user the last time the
// board was asked. A card that stopped needing them and needs them again (a
// second review, say) is new again.
export function newItems(seen: ReadonlySet<string>, items: readonly BoardItem[]): BoardItem[] {
  return items.filter((item) => item.kind in LABELS && !seen.has(keyOf(item)));
}

function clip(text: string, max: number) {
  const flat = text.trim();
  return flat.length > max ? `${flat.slice(0, max).trimEnd()}…` : flat;
}

// Plain text, so nothing a card holds is read as Slack markup. Each card ends
// with its address on the board: replying in the thread is how the user asks
// for something to be done about it.
export function formatItems(items: readonly BoardItem[], boardUrl: string): string {
  const head = items.length === 1 ? 'The board needs you:' : `The board needs you (${items.length} cards):`;
  const blocks: string[] = [];
  let used = head.length;
  let left = items.length;
  for (const item of items) {
    const lines = [
      `${LABELS[item.kind] ?? item.kind} · ${item.project} · ${clip(item.title, 160)}`,
      clip(item.next, 300),
      ...(item.detail ? [clip(item.detail, MAX_DETAIL)] : []),
      `${boardUrl}/${item.path}`,
    ];
    const block = lines.join('\n');
    // Always room for the "and N more" line.
    if (used + block.length + 2 > MAX_TEXT - 60 && blocks.length > 0) break;
    blocks.push(clip(block, MAX_TEXT - 200));
    used += block.length + 2;
    left -= 1;
  }
  const tail = left > 0 ? [`…and ${left} more on the board: ${boardUrl}`] : [];
  return [head, ...blocks, ...tail].join('\n\n');
}

function escapeSlack(text: string) {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function loadSeen(file: string): Set<string> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    const keys = parsed && typeof parsed === 'object' ? (parsed as { keys?: unknown }).keys : undefined;
    return Array.isArray(keys) ? new Set(keys.filter((key): key is string => typeof key === 'string')) : null;
  } catch {
    return null;
  }
}

function saveSeen(file: string, seen: ReadonlySet<string>) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ keys: [...seen].sort() }, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

// One watcher. `poll` asks the board once; `start` keeps asking.
export function createBoardWatch({ config, client, fetch: fetchFn = fetch, log = console.log }: BoardWatchOptions) {
  // What already needed the user at the last look. Null until there has been
  // a first look ever: that one only takes stock, or starting the bot would
  // announce everything the user has known about for days.
  let seen = loadSeen(config.stateFile);
  let reachable: boolean | null = null;
  let timer: NodeJS.Timeout | null = null;
  let busy = false;

  async function ask(): Promise<BoardItem[]> {
    const res = await fetchFn(`${config.url}/api/attention`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body: unknown = await res.json();
    if (!Array.isArray(body)) throw new Error('unexpected reply');
    return body.filter(isItem);
  }

  async function send(text: string) {
    const dm = await client.conversations.open({ users: config.user });
    const channel = dm.channel?.id ?? '';
    if (!dm.ok || !/^D[A-Z0-9]+$/.test(channel)) throw new Error('DM unavailable');
    const message = await client.chat.postMessage({
      channel,
      text: escapeSlack(text),
      blocks: [{ type: 'section', text: { type: 'plain_text', text, emoji: false } }],
      mrkdwn: false,
      parse: 'none',
      link_names: false,
      unfurl_links: false,
      unfurl_media: false,
    });
    if (!message.ok || !message.ts) throw new Error('Delivery not confirmed');
  }

  // Returns how many cards were announced.
  async function poll(): Promise<number> {
    if (busy) return 0;
    busy = true;
    try {
      let items: BoardItem[];
      try {
        items = await ask();
      } catch {
        // A board that is down says nothing about its cards: keep what was
        // seen, and say so once rather than every minute.
        if (reachable !== false) log(`[board] unreachable at ${config.url}`);
        reachable = false;
        return 0;
      }
      if (reachable === false) log(`[board] reachable again at ${config.url}`);
      reachable = true;

      const current = new Set(items.filter((item) => item.kind in LABELS).map(keyOf));
      if (seen === null) {
        seen = current;
        saveSeen(config.stateFile, seen);
        log(`[board] watching ${config.url}; ${current.size} card(s) already need attention`);
        return 0;
      }
      const fresh = newItems(seen, items);
      if (fresh.length > 0) {
        try {
          await send(formatItems(fresh, config.url));
        } catch {
          // Not marked as seen, so the next look tries again. Never log the
          // error itself: SDK errors can carry request data.
          log('[board] notification.error');
          return 0;
        }
        log(`[board] notification.sent (${fresh.length})`);
      }
      seen = current;
      saveSeen(config.stateFile, seen);
      return fresh.length;
    } finally {
      busy = false;
    }
  }

  return {
    poll,
    start() {
      if (timer) return;
      void poll();
      timer = setInterval(() => void poll(), config.pollMs);
      timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
