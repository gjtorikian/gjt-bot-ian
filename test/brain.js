import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { access } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { isAbsolute, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';

test('pi starts on demand with repository skills and retains the thread session', async (t) => {
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

    sessions.push(args[args.indexOf('--session-id') + 1]);
  }
  assert.match(sessions[0], /^[a-f0-9-]{36}$/);
  assert.equal(sessions[0], sessions[1]);
});
