import { App } from '@slack/bolt';
import { ask } from './brain.js';
import { registerSlackHandlers } from './slack.js';

// Fail closed: with no allowlist configured, the bot answers nobody.
// Everyone on this list gets full tool access to this laptop through pi.
const ALLOWED = new Set(
  (process.env.SLACK_ALLOWED_USERS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
);
if (ALLOWED.size === 0) {
  console.error('SLACK_ALLOWED_USERS is empty — set it to your Slack member ID (U…) and restart.');
  process.exit(1);
}

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
  clientOptions: {
    timeout: 15_000,
    retryConfig: { retries: 1 },
    rejectRateLimitedCalls: true,
  },
});

registerSlackHandlers(app, { allowedUsers: ALLOWED, ask });

await app.start();
console.log(`⚡️ gjt-bot-ian connected — allowlist: ${[...ALLOWED].join(', ')}`);
