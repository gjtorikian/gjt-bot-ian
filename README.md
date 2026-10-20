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

## Tests

`npm test` runs the suite without sending Slack messages. The optional live pi
test runs only when `BOT_LIVE_TEST=1` is set.
