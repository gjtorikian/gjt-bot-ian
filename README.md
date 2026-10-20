# gjt-bot-ian

A Slack bot connected to pi on your laptop. Run with `npm start`. Channel requests
require an @mention; authorized users can also DM the bot directly.

## Workflows

Each Slack request runs pi in one-shot print mode. The bot loads
`pi-workflows.js` to force new `workflow` calls into the foreground, including
calls that explicitly request `background: true`. Parallel agents inside a
workflow can still run concurrently; the tool waits for their result before pi
replies and exits. Background resume calls are blocked because the workflow
extension cannot resume in the foreground. Existing paused runs are not retried
automatically, which could repeat actions they already performed.

At `BOT_LOG_LEVEL=info`, `workflow.progress` logs show the phase, agent states,
and tool activity; `workflow.complete` or `workflow.error` records the outcome.
Slack progress shows the completed/running agent counts. A background launch,
unfinished workflow, or failed agent produces an error even if pi exits with
code 0. Requests remain subject to `BOT_TIMEOUT_MS` (default: 15 minutes).
Restart `npm start` after changing the bot's code.

## Local notifications

A trusted process on the laptop can send `POST http://127.0.0.1:3210/notify` to
deliver a DM. The JSON body accepts exactly one field:

```json
{"text":"The build finished."}
```

These are plain-text notifications. They never invoke pi. You can reply to the
notification in Slack to ask pi to act on it.

### Enable

The HTTP listener is disabled until configured. From this repo, generate a
separate random token and append the configuration to your existing `.env`:

```sh
node --input-type=module <<'NODE'
import { appendFileSync, chmodSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { parseEnv } from 'node:util';

const env = parseEnv(readFileSync('.env', 'utf8'));
if (env.BOT_LOCAL_API_PORT || env.BOT_LOCAL_API_TOKEN) {
  throw new Error('Local API already configured; edit its existing settings instead.');
}
chmodSync('.env', 0o600);
appendFileSync('.env', `\nBOT_LOCAL_API_PORT=3210\nBOT_LOCAL_API_TOKEN=${randomBytes(32).toString('hex')}\n`);
NODE
```

The token is written to the ignored `.env` file without printing it. If
`SLACK_ALLOWED_USERS` contains multiple users, also set `BOT_LOCAL_API_USER` to
the one user who should receive notifications. The bot refuses to start if that
user is not allowlisted or if the local API configuration is incomplete.

Restart the bot with `npm start`. Its startup message includes the local URL.
The Slack installation needs `im:write` and `chat:write`, already requested by
`manifest.yaml`. Slack provides the DM via
[`conversations.open`](https://docs.slack.dev/reference/methods/conversations.open/).

### Send from another process

Give the sending process only `BOT_LOCAL_API_TOKEN` and `BOT_LOCAL_API_PORT`.
It does not need either Slack token. Use the token in an `Authorization: Bearer`
header, never in the URL. For example, this command uses this repo's `.env`
without putting the token into shell history or command-line arguments:

```sh
node --env-file=.env --input-type=module <<'NODE'
const response = await fetch(`http://127.0.0.1:${process.env.BOT_LOCAL_API_PORT}/notify`, {
  method: 'POST',
  redirect: 'error',
  signal: AbortSignal.timeout(40_000),
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${process.env.BOT_LOCAL_API_TOKEN}`,
  },
  body: JSON.stringify({ text: 'The build finished.' }),
});
console.log(response.status, await response.json());
if (!response.ok) process.exitCode = 1;
NODE
```

The bot returns `200 {"ok":true,"ts":"..."}` only after Slack confirms the post.

| Status | Meaning |
| --- | --- |
| 400 / 413 / 415 | Invalid JSON/schema, oversized body, or unsupported content type |
| 401 / 403 | Invalid token or a request that fails the local-client checks |
| 404 / 405 | Wrong path or method; only `POST /notify` exists |
| 408 | Request body took too long |
| 429 | Another notification is in progress, or 30 requests were admitted in a minute; wait 60 seconds |
| 502 | Slack delivery could not be confirmed; check your DM before retrying |

There is no persistent queue or automatic delivery retry. If the bot is stopped,
the connection fails. A lost HTTP response or Slack timeout can happen after a
message was posted, so blindly retrying may send duplicates.

### Security boundaries

- The listener binds only to IPv4 `127.0.0.1`. Use that exact address; it rejects
  other Host headers and browser-originated requests, and never trusts forwarded
  headers from proxies.
- Every request needs the separate 256-bit random token. Tokens are compared
  with `timingSafeEqual`. No CORS access is granted.
- The recipient is fixed in server configuration. Requests cannot choose users,
  channels, Slack blocks, commands, or pi prompts.
- Messages use Slack `plain_text` blocks, escaped fallback text, and disabled
  link previews. Mention-like text is treated as text.
- Bodies are limited to 16 KiB and text to 3,000 UTF-16 code units. Headers and
  bodies have five-second receive deadlines. Connections, concurrent deliveries,
  and authenticated request rates are bounded.
- Endpoint logs contain only success/failure event names, never tokens, message
  contents, or raw Slack errors.

Keep the token private and do not expose this endpoint through a tunnel or
reverse proxy. A process that can read your account's files can read `.env`;
this feature does not isolate malicious software running as your own OS user.
To rotate the token, replace it with another `randomBytes(32).toString('hex')`
value in `.env`, update trusted senders, and restart. Remove all `BOT_LOCAL_API_*`
settings and restart to disable the endpoint.

## Tests

`npm test` runs the suite without sending Slack messages. The optional live pi
test runs only when `BOT_LIVE_TEST=1` is set.
