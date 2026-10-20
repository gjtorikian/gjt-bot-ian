import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createPiObserver } from '../pi-events.js';

test('installed pi enforces foreground execution before the workflow tool runs', { timeout: 30_000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'bot-workflow-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'settings.json'), JSON.stringify({ offline: true }));
  const pi = spawn('pi', [
    '--print', '--mode', 'json', '--no-session', '--no-extensions', '--no-skills',
    '--no-prompt-templates', '--no-themes', '--no-builtin-tools',
    '--extension', fileURLToPath(new URL('./fixtures/workflow-runtime.js', import.meta.url)),
    '--extension', fileURLToPath(new URL('../pi-workflows.js', import.meta.url)),
    '--model', 'bot-test/fixture', '--thinking', 'off', '--', 'Run the test workflow',
  ], { cwd: dir, env: { ...process.env, PI_CODING_AGENT_DIR: dir, PI_OFFLINE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (pi.exitCode === null) pi.kill('SIGKILL'); });
  let stdout = '';
  let stderr = '';
  pi.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
  pi.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  const code = await new Promise((resolve, reject) => { pi.on('error', reject); pi.on('close', resolve); });
  assert.equal(code, 0, stderr);
  const events = stdout.trim().split('\n').map((line) => JSON.parse(line));
  assert.ok(events.some((event) => event.type === 'tool_execution_update'), 'the foreground tool must stream progress');
  const end = events.find((event) => event.type === 'tool_execution_end');
  assert.equal(end?.result?.details?.background, undefined);
  assert.equal(end?.result?.details?.agents[0].status, 'done');
  const observer = createPiObserver({ model: 'fixture' });
  for (const event of events) observer.handle(event);
  assert.equal(observer.result().text, 'Foreground workflow finished');
});
