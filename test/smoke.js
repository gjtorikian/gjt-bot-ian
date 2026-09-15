// Offline checks by default — no Slack, no model call, no tokens spent.
// Set BOT_LIVE_TEST=1 to also run one real pi round-trip (costs a few cents).
import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ask } from "../brain.js";

const run = promisify(execFile);

test("pi is on PATH", async () => {
  const { stdout } = await run("pi", ["--version"]);
  assert.match(stdout.trim(), /^\d+\.\d+/);
});

test("pi holds a ready anthropic credential", async () => {
  const { stdout } = await run("pi", [
    "auth",
    "check",
    "--provider",
    "anthropic",
    "--json",
  ]);
  assert.equal(JSON.parse(stdout).status, "ready");
});

test("the configured model exists in pi's catalog", async () => {
  const [provider, model] = (
    process.env.BOT_MODEL ?? "anthropic/claude-opus-5"
  ).split("/");
  const { stdout } = await run("pi", ["--list-models", provider]);
  assert.ok(
    stdout.split("\n").some((l) => l.split(/\s+/)[1] === model),
    `${model} not in catalog`,
  );
});

// Regression guard: pi 0.84.4's anthropic provider hangs forever when stdin is
// an open pipe. brain.js spawns with stdin ignored; if that ever regresses,
// this test times out instead of silently wedging Slack threads.
test(
  "pi round-trip returns text and a cost",
  { skip: !process.env.BOT_LIVE_TEST },
  async () => {
    const { text, footer } = await ask(
      "Reply with exactly: pong",
      `smoke:${Date.now()}`,
    );
    assert.match(text, /pong/i);
    assert.match(footer, /\$\d/);
  },
);
