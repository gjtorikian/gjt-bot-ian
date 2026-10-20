import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { webApi } from '@slack/bolt';

const HOST = '127.0.0.1';
const MAX_BODY_BYTES = 16_384;
const REQUEST_TIMEOUT_MS = 5_000;
const RATE_WINDOW_MS = 60_000;
const MAX_REQUESTS = 30;

export function localApiClient(token, { fetch } = {}) {
  return new webApi.WebClient(token, {
    timeout: 15_000,
    retryConfig: { retries: 0 },
    rejectRateLimitedCalls: true,
    allowAbsoluteUrls: false,
    ...(fetch ? { fetch } : {}),
    // The SDK can print raw server warnings and errors. Report only our fixed
    // delivery events below, including when the rest of the bot uses debug logs.
    logger: {
      debug() {}, info() {}, warn() {}, error() {},
      setLevel() {}, getLevel() { return 'error'; }, setName() {},
    },
  });
}

// No listener without explicit configuration. Never take a recipient from a
// request: possession of this token grants only permission to notify this user.
export function localApiConfig(env, allowedUsers) {
  const port = env.BOT_LOCAL_API_PORT;
  const token = env.BOT_LOCAL_API_TOKEN;
  const recipient = env.BOT_LOCAL_API_USER;
  if (!port && !token && !recipient) return null;
  if (!/^[1-9]\d{0,4}$/.test(port ?? '') || Number(port) > 65_535) {
    throw new Error('BOT_LOCAL_API_PORT must be a port from 1 to 65535.');
  }
  if (!/^[a-f0-9]{64}$/.test(token ?? '')) {
    throw new Error('BOT_LOCAL_API_TOKEN must be 32 random bytes encoded as 64 lowercase hex characters.');
  }
  const user = recipient || (allowedUsers.size === 1 ? [...allowedUsers][0] : undefined);
  if (!user || !allowedUsers.has(user) || !/^[UW][A-Z0-9]+$/.test(user)) {
    throw new Error('Set BOT_LOCAL_API_USER to one member of SLACK_ALLOWED_USERS (required when there are multiple users).');
  }
  return { port: Number(port), token, user };
}

class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function respond(res, status, body) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    Connection: 'close',
    ...(status === 429 ? { 'Retry-After': '60' } : {}),
  });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let finished = false;
    const chunks = [];
    const finish = (err, result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('aborted', onAborted);
      // Keep the error listener: an aborted request can emit error afterwards.
      req.pause();
      if (err) reject(err);
      else resolve(result);
    };
    const onData = (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        finish(new RequestError(413, 'Request body exceeds 16384 bytes.'));
      } else chunks.push(chunk);
    };
    const onEnd = () => {
      try {
        const body = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
        finish(null, JSON.parse(body));
      } catch {
        finish(new RequestError(400, 'Invalid UTF-8 JSON.'));
      }
    };
    const onAborted = () => finish(new RequestError(400, 'Request aborted.'));
    const onError = () => finish(new RequestError(400, 'Request failed.'));
    // An absolute deadline also catches clients that slowly drip bytes.
    const timer = setTimeout(() => finish(new RequestError(408, 'Request timed out.')), REQUEST_TIMEOUT_MS);
    req.on('data', onData);
    req.once('end', onEnd);
    req.once('aborted', onAborted);
    req.once('error', onError);
  });
}

function escapeSlack(text) {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

export async function startLocalApi({ config, client, log = console.log }) {
  if (!config) return null;
  const expectedToken = Buffer.from(config.token, 'hex');
  let busy = false;
  let windowStart = Date.now();
  let requests = 0;

  const handle = async (req, res) => {
    let acquired = false;
    try {
      // Ignore forwarded headers. Exact Host checking also blocks DNS rebinding.
      if (req.socket.remoteAddress !== HOST
        || req.headersDistinct.host?.length !== 1
        || req.headers.host !== `${HOST}:${server.address().port}`
        || req.headers.origin !== undefined
        // Node's fetch sends Sec-Fetch-Mode too. Browsers additionally send
        // Origin and/or fetch metadata such as Sec-Fetch-Site and -Dest.
        || Object.keys(req.headers).some((name) => name.startsWith('sec-fetch-') && name !== 'sec-fetch-mode')) {
        throw new RequestError(403, 'Local non-browser requests only.');
      }
      const authorization = req.headers.authorization ?? '';
      const match = /^Bearer ([a-f0-9]{64})$/.exec(authorization);
      if (req.headersDistinct.authorization?.length !== 1 || !match
        || !timingSafeEqual(Buffer.from(match[1], 'hex'), expectedToken)) {
        throw new RequestError(401, 'Unauthorized.');
      }
      if (req.url !== '/notify') throw new RequestError(404, 'Not found.');
      if (req.method !== 'POST') throw new RequestError(405, 'Use POST.');
      if (req.headersDistinct['content-type']?.length !== 1
        || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'])
        || req.headers['content-encoding'] !== undefined) {
        throw new RequestError(415, 'Use uncompressed application/json.');
      }
      if (Number(req.headers['content-length'] ?? 0) > MAX_BODY_BYTES) {
        throw new RequestError(413, 'Request body exceeds 16384 bytes.');
      }
      if (Date.now() - windowStart >= RATE_WINDOW_MS) {
        windowStart = Date.now();
        requests = 0;
      }
      if (busy || requests >= MAX_REQUESTS) throw new RequestError(429, 'Notification limit reached.');
      requests++;
      busy = true;
      acquired = true;

      if (req.headers.expect === '100-continue') res.writeContinue();
      const body = await readBody(req);
      if (!body || Array.isArray(body) || typeof body !== 'object'
        || Object.keys(body).length !== 1 || typeof body.text !== 'string'
        || !body.text.trim() || body.text.length > 3000 || !body.text.isWellFormed()) {
        throw new RequestError(400, 'Send only a text field containing 1–3000 characters.');
      }
      // No pi call, commands, URLs to fetch, or user-supplied Slack arguments.
      // Use a client with retries disabled: a lost response may still mean sent.
      const dm = await client.conversations.open({ users: config.user });
      if (!dm.ok || !/^D[A-Z0-9]+$/.test(dm.channel?.id ?? '')) throw new Error('DM unavailable');
      const message = await client.chat.postMessage({
        channel: dm.channel.id,
        text: escapeSlack(body.text),
        blocks: [{ type: 'section', text: { type: 'plain_text', text: body.text, emoji: false } }],
        mrkdwn: false,
        parse: 'none',
        link_names: false,
        unfurl_links: false,
        unfurl_media: false,
      });
      if (!message.ok || !message.ts) throw new Error('Delivery not confirmed');
      log('[local-api] notification.sent');
      respond(res, 200, { ok: true, ts: message.ts });
    } catch (err) {
      if (err instanceof RequestError) {
        respond(res, err.status, { ok: false, error: err.message });
      } else {
        // SDK errors can contain request data. Never log or return raw errors,
        // authorization headers, or notification contents.
        log('[local-api] notification.error');
        respond(res, 502, { ok: false, error: 'Slack delivery could not be confirmed. Check your DM before retrying.' });
      }
    } finally {
      if (acquired) busy = false;
    }
  };

  const server = createServer({
    maxHeaderSize: 8192,
    headersTimeout: REQUEST_TIMEOUT_MS,
    requestTimeout: REQUEST_TIMEOUT_MS,
    connectionsCheckingInterval: 1000,
    keepAliveTimeout: 1000,
  }, handle);
  server.maxConnections = 16;
  server.maxRequestsPerSocket = 1;
  // Authenticate in the normal handler before reading an Expect: 100-continue body.
  server.on('checkContinue', handle);
  server.on('connect', (req, socket) => socket.destroy());
  server.on('upgrade', (req, socket) => socket.destroy());
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, HOST, () => {
      server.off('error', reject);
      resolve();
    });
  });
  return server;
}
