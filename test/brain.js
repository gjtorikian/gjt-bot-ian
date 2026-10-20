import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { access } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { isAbsolute, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';

test('pi starts on demand with repository skills and retains the thread session', async (t) => {
  t.mock.method(console, 'log', () => {});
  const spawn = t.mock.method(childProcess, 'spawn', () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
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

  const { ask } = await import('../brain.js');
  assert.equal(spawn.mock.callCount(), 0, 'importing the harness must not start pi');

  const first = await ask('status', 'test-channel:test-thread');
  const second = await ask('follow up', 'test-channel:test-thread');
  assert.equal(first.text, 'pong');
  assert.equal(second.text, 'pong');
  assert.equal(spawn.mock.callCount(), 2);

  const sessions = [];
  for (const [index, call] of spawn.mock.calls.entries()) {
    const [command, args, options] = call.arguments;
    assert.equal(command, 'pi');
    assert.ok(args.includes('--print'));
    assert.equal(options.stdio[0], 'ignore');
    assert.deepEqual(args.slice(args.indexOf('--') + 1), [index === 0 ? 'status' : 'follow up']);

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

test('a normal pi exit cannot turn a background workflow acknowledgment into success', async (t) => {
  const logs = [];
  t.mock.method(console, 'log', (line) => logs.push(line));
  const spawn = t.mock.method(childProcess, 'spawn', () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
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
  const { ask } = await import('../brain.js');
  await assert.rejects(ask('Review it', 'test-channel:aborted-workflow'), /radar-triage.*background/);
  assert.ok(logs.some((line) => line.includes('workflow.error')));
});

test('the harness delivers a late background report without a trailing newline', async (t) => {
  t.mock.method(console, 'log', () => {});
  const spawn = t.mock.method(childProcess, 'spawn', () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
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
  const { ask } = await import('../brain.js');
  const result = await ask('Review with Astra', 'test-channel:background-thread');
  assert.equal(result.text, 'Astra review: fix looks good ✓');
});

test('a failed pi process rejects even after an interim assistant message', async (t) => {
  t.mock.method(console, 'log', () => {});
  const spawn = t.mock.method(childProcess, 'spawn', () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
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
  const { ask } = await import('../brain.js');
  await assert.rejects(ask('Review it', 'test-channel:failed-thread'), /Provider unavailable/);
});
