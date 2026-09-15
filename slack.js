const MAX_THREAD_PAGES = 10;
const MAX_CONTEXT_BYTES = 64_000;

// Fetch only this thread, through the current request. Keep other bots' posts:
// automated PR announcements are often the parent message we need.
export async function threadPrompt(client, event, body, botUserId) {
  const { channel, ts, thread_ts } = event;
  if (!thread_ts || thread_ts === ts) return body;

  const messages = new Map();
  const cursors = new Set();
  let cursor;
  let contextBytes = 0;
  for (let page = 0; page < MAX_THREAD_PAGES; page++) {
    let result;
    try {
      result = await client.conversations.replies({
        channel, ts: thread_ts, latest: ts, inclusive: false, limit: 100,
        ...(cursor ? { cursor } : {}),
      });
      if (!result.ok) throw new Error(result.error ?? 'unknown_error');
    } catch (err) {
      const reason = err.data?.error ?? err.code ?? err.message;
      throw new Error(`Couldn't read this Slack thread (${reason}). Check the app's history access or start a new @mention with the relevant link.`, { cause: err });
    }

    for (const message of result.messages ?? []) {
      if (!message.ts || Number(message.ts) >= Number(ts) || messages.has(message.ts)) continue;
      // Our earlier replies are already in pi's saved session. Preserve a
      // parent posted by us, but omit our intermediate progress updates.
      if (botUserId && message.user === botUserId && message.ts !== thread_ts) continue;
      const quoted = {
        ts: message.ts,
        author: message.user ?? message.bot_id ?? 'unknown',
        text: message.text ?? '',
        ...(message.blocks?.length ? { blocks: message.blocks } : {}),
        ...(message.attachments?.length ? { attachments: message.attachments } : {}),
      };
      contextBytes += Buffer.byteLength(JSON.stringify(quoted));
      if (contextBytes > MAX_CONTEXT_BYTES) {
        throw new Error('This Slack thread is too large to include. Start a new @mention with the relevant link or details.');
      }
      messages.set(message.ts, quoted);
    }

    cursor = result.response_metadata?.next_cursor?.trim();
    if (!cursor) {
      if (result.has_more) throw new Error('Slack returned an incomplete thread. Please try the @mention again.');
      if (!messages.has(thread_ts)) throw new Error("Slack didn't return the parent message. Start a new @mention with the relevant link.");
      const context = {
        channel,
        thread_ts,
        messages: [...messages.values()].sort((a, b) => Number(a.ts) - Number(b.ts)),
      };
      // Keep the request first so explicit /skill:name invocations still work.
      return `${body}\n\nQuoted Slack thread context (background for the current request above):\n${JSON.stringify(context)}`;
    }
    if (cursors.has(cursor)) throw new Error('Slack repeated a thread page. Please try the @mention again.');
    cursors.add(cursor);
  }
  throw new Error('This Slack thread has too many messages. Start a new @mention with the relevant link or details.');
}

function progressReporter(client, channel, ts) {
  let last = 0;
  return ({ tools }) => {
    const now = Date.now();
    if (now - last < 2000) return;
    last = now;
    const recent = tools.slice(-4).join(' → ');
    client.chat.update({ channel, ts, text: `_working… ${tools.length} tools_\n\`${recent}\`` })
      .catch((err) => console.error(`chat.update failed: ${err.data?.error ?? err.message}`));
  };
}

export function registerSlackHandlers(app, { allowedUsers, ask }) {
  async function respond(event, { say, client, context = {} }) {
    if (event.bot_id || event.user === context.botUserId) return;
    const { user, channel, ts, thread_ts } = event;
    if (!allowedUsers.has(user)) {
      try {
        await client.reactions.add({ channel, timestamp: ts, name: 'face_with_rolling_eyes' });
      } catch (err) {
        if (err.data?.error !== 'already_reacted') console.error(`reactions.add failed: ${err.data?.error ?? err.message}`);
      }
      return;
    }

    const thread = thread_ts ?? ts;
    const text = event.text ?? '';
    const body = (context.botUserId ? text.replaceAll(`<@${context.botUserId}>`, '') : text).trim();
    if (!body) {
      return say({ thread_ts: thread, text: 'Tell me what you need — I have access to the laptop and its skills through pi.' });
    }

    const placeholder = await say({ text: '_working…_', thread_ts: thread });
    try {
      const prompt = await threadPrompt(client, event, body, context.botUserId);
      const { text: reply, footer } = await ask(prompt, `${channel}:${thread}`,
        progressReporter(client, channel, placeholder.ts));
      await client.chat.update({ channel, ts: placeholder.ts, text: `${reply}\n\n${footer}` });
    } catch (err) {
      console.error(`Slack request failed: ${err.data?.error ?? err.message}`);
      await client.chat.update({ channel, ts: placeholder.ts, text: `:warning: ${err.message}` });
    }
  }

  app.event('app_mention', async (args) => {
    if (args.event.type === 'app_mention') await respond(args.event, args);
  });

  // Ordinary channel messages are ignored; direct messages need no @mention.
  app.message(async (args) => {
    if (args.message.channel_type !== 'im' || args.message.subtype) return;
    await respond(args.message, args);
  });
}
