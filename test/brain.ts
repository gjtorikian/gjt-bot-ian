import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { access } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { isAbsolute, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

// brain.ts requires its model settings at import; these tests supply their own.
process.env.BOT_MODEL = 'test-provider/test-model';
process.env.BOT_THINKING = 'low';

// Just enough of a child process for brain.ts: two output streams and kill().
function fakeChild() {
  return Object.assign(new EventEmitter(), {
    stdout: new PassThrough(), stderr: new PassThrough(), kill: () => {},
  });
}

test('pi starts on demand with repository skills and retains the thread session', async (t) => {
  t.mock.method(console, 'log', () => {});
  const spawn = t.mock.method(childProcess, 'spawn', () => {
    const child = fakeChild();
    process.nextTick(() => {
      child.stdout.end(`${JSON.stringify({
        type: 'turn_end',
        message: { content: [{ type: 'text', text: 'pong' }] },
      })}\n`);
      child.emit('close', 0);
    });
    return child;
  });
  syncBuiltinESMExports();
  t.after(() => {
    spawn.mock.restore();
    syncBuiltinESMExports();
  });

  const { ask } = await import('../brain.ts');
  assert.equal(spawn.mock.callCount(), 0, 'importing the harness must not start pi');

  const first = await ask('status', 'test-channel:test-thread');
  const second = await ask('follow up', 'test-channel:test-thread');
  assert.equal(first.text, 'pong');
  assert.equal(second.text, 'pong');
  assert.equal(spawn.mock.callCount(), 2);

  const sessions: string[] = [];
  for (const [index, call] of spawn.mock.calls.entries()) {
    const [command, args, options] = call.arguments as [string, string[], { stdio: string[] }];
    assert.equal(command, 'pi');
    assert.ok(args.includes('--print'));
    assert.equal(options.stdio[0], 'ignore');
    assert.deepEqual(args.slice(args.indexOf('--') + 1), [index === 0 ? 'status' : 'follow up']);
    assert.equal(args[args.indexOf('--model') + 1], 'test-provider/test-model', 'the model must come from the environment');
    assert.equal(args[args.indexOf('--thinking') + 1], 'low', 'the thinking level must come from the environment');

    const skillFlag = args.indexOf('--skill');
    assert.ok(skillFlag >= 0, 'each request must load the repository skills');
    const skillDirectory = args[skillFlag + 1];
    assert.ok(isAbsolute(skillDirectory), 'skill discovery must not depend on the working directory');
    await access(join(skillDirectory, 'work', 'approve-merge-label', 'SKILL.md'));

    const extensionFlag = args.indexOf('--extension');
    assert.ok(extensionFlag >= 0, 'each request must enforce foreground workflows');
    assert.ok(isAbsolute(args[extensionFlag + 1]));
    await access(args[extensionFlag + 1]);

    sessions.push(args[args.indexOf('--session-id') + 1]);
  }
  assert.match(sessions[0], /^[a-f0-9-]{36}$/);
  assert.equal(sessions[0], sessions[1]);
});

for (const name of ['BOT_MODEL', 'BOT_THINKING']) {
  test(`the harness refuses to load when ${name} is missing or empty`, async () => {
    const harness = fileURLToPath(new URL('../brain.ts', import.meta.url));
    for (const value of [undefined, '']) {
      await assert.rejects(
        promisify(childProcess.execFile)(process.execPath, [harness], { env: { ...process.env, [name]: value } }),
        new RegExp(`${name} is not set`),
      );
    }
  });
}

test('a normal pi exit cannot turn a background workflow acknowledgment into success', async (t) => {
  const logs: string[] = [];
  t.mock.method(console, 'log', (line: string) => logs.push(line));
  const spawn = t.mock.method(childProcess, 'spawn', () => {
    const child = fakeChild();
    process.nextTick(() => {
      for (const event of [
        { type: 'tool_execution_start', toolName: 'workflow', toolCallId: 'call-1' },
        { type: 'tool_execution_end', toolName: 'workflow', toolCallId: 'call-1', isError: false,
          result: { content: [{ type: 'text', text: 'Started in the background' }],
            details: { runId: 'radar-triage', background: true } } },
        { type: 'turn_end', message: { role: 'assistant',
          content: [{ type: 'text', text: "It'll post back here on its own." }] } },
      ]) child.stdout.write(`${JSON.stringify(event)}\n`);
      child.stdout.end();
      child.emit('close', 0);
    });
    return child;
  });
  syncBuiltinESMExports();
  t.after(() => { spawn.mock.restore(); syncBuiltinESMExports(); });
  const { ask } = await import('../brain.ts');
  await assert.rejects(ask('Review it', 'test-channel:aborted-workflow'), /radar-triage.*background/);
  assert.ok(logs.some((line) => line.includes('workflow.error')));
});

test('the harness delivers a late background report without a trailing newline', async (t) => {
  t.mock.method(console, 'log', () => {});
  const spawn = t.mock.method(childProcess, 'spawn', () => {
    const child = fakeChild();
    process.nextTick(() => {
      child.stdout.write(`${JSON.stringify({ type: 'turn_end', message: {
        role: 'assistant', content: [{ type: 'text', text: 'Review started.' }],
      } })}\n`);
      const result = JSON.stringify({ type: 'message_end', message: {
        role: 'custom', customType: 'subagent-notify', display: false, content: 'Astra review: fix looks good ✓',
      } });
      const bytes = Buffer.from(result);
      const split = bytes.indexOf(Buffer.from('✓')) + 1;
      child.stdout.write(bytes.subarray(0, split));
      child.stdout.end(bytes.subarray(split));
      child.emit('close', 0);
    });
    return child;
  });
  syncBuiltinESMExports();
  t.after(() => { spawn.mock.restore(); syncBuiltinESMExports(); });
  const { ask } = await import('../brain.ts');
  const result = await ask('Review with Astra', 'test-channel:background-thread');
  assert.equal(result.text, 'Astra review: fix looks good ✓');
});

// Lets ask() start pi, and lets written events reach the harness.
const settle = () => new Promise((resolve) => setImmediate(resolve));
const MINUTE = 60_000;

test('a run that keeps reporting events is never cut off for taking long', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const child = Object.assign(fakeChild(), { kill: t.mock.fn() });
  const spawn = t.mock.method(childProcess, 'spawn', () => child);
  syncBuiltinESMExports();
  t.after(() => { spawn.mock.restore(); syncBuiltinESMExports(); });
  const { ask } = await import('../brain.ts');

  let outcome: string | undefined;
  const answer = ask('Babysit the PR', 'test-channel:long-run');
  answer.then(() => { outcome = 'resolved'; }, () => { outcome = 'rejected'; });
  await settle();

  // Two hours of work, with nine quiet minutes between events.
  for (let elapsed = 0; elapsed < 120 * MINUTE; elapsed += 9 * MINUTE) {
    child.stdout.write(`${JSON.stringify({ type: 'tool_execution_update', toolName: 'bash', toolCallId: 'call-1',
      partialResult: { content: [{ type: 'text', text: 'in_progress' }] } })}\n`);
    await settle();
    t.mock.timers.tick(9 * MINUTE);
  }
  await settle();
  assert.equal(outcome, undefined, 'the run must still be going');
  assert.equal(child.kill.mock.callCount(), 0);

  child.stdout.end(`${JSON.stringify({ type: 'turn_end', message: { content: [{ type: 'text', text: 'merged' }] } })}\n`);
  await settle();
  child.emit('close', 0);
  assert.equal((await answer).text, 'merged');

  // The finished run leaves no timer behind to fire later.
  t.mock.timers.tick(60 * MINUTE);
  assert.equal(child.kill.mock.callCount(), 0);
});

test('a pi that stops reporting events is stopped', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const child = Object.assign(fakeChild(), { kill: t.mock.fn() });
  const spawn = t.mock.method(childProcess, 'spawn', () => child);
  syncBuiltinESMExports();
  t.after(() => { spawn.mock.restore(); syncBuiltinESMExports(); });
  const { ask } = await import('../brain.ts');

  const answer = ask('Review it', 'test-channel:silent-run');
  await settle();
  child.stdout.write(`${JSON.stringify({ type: 'agent_start' })}\n`);
  await settle();

  t.mock.timers.tick(10 * MINUTE - 1);
  assert.equal(child.kill.mock.callCount(), 0, 'ten quiet minutes are allowed');
  t.mock.timers.tick(1);
  await assert.rejects(answer, /reported nothing for 600s.*BOT_IDLE_TIMEOUT_MS/);
  assert.deepEqual(child.kill.mock.calls.map((call) => call.arguments), [['SIGTERM']]);
});

test('a pi that never reports an event is stopped early', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const child = Object.assign(fakeChild(), { kill: t.mock.fn() });
  const spawn = t.mock.method(childProcess, 'spawn', () => child);
  syncBuiltinESMExports();
  t.after(() => { spawn.mock.restore(); syncBuiltinESMExports(); });
  const { ask } = await import('../brain.ts');

  const answer = ask('Review it', 'test-channel:unreachable-model');
  await settle();
  t.mock.timers.tick(45_000);
  await assert.rejects(answer, /no output in 45s using model test-provider\/test-model/);
  assert.equal(child.kill.mock.callCount(), 1);
});

test('a failed pi process rejects even after an interim assistant message', async (t) => {
  t.mock.method(console, 'log', () => {});
  const spawn = t.mock.method(childProcess, 'spawn', () => {
    const child = fakeChild();
    process.nextTick(() => {
      child.stdout.end(`${JSON.stringify({ type: 'turn_end', message: {
        content: [{ type: 'text', text: 'Working on it.' }],
      } })}\n`);
      child.stderr.end('Provider unavailable\n');
      child.emit('close', 1);
    });
    return child;
  });
  syncBuiltinESMExports();
  t.after(() => { spawn.mock.restore(); syncBuiltinESMExports(); });
  const { ask } = await import('../brain.ts');
  await assert.rejects(ask('Review it', 'test-channel:failed-thread'), /Provider unavailable/);
});
