import assert from 'node:assert/strict';
import { test } from 'node:test';
import foregroundWorkflows from '../pi-workflows.js';

function guard() {
  let hook;
  foregroundWorkflows({ on(event, handler) {
    assert.equal(event, 'tool_call');
    hook = handler;
  } });
  return hook;
}

test('workflows run in the foreground even when the model requests background execution', () => {
  const hook = guard();
  for (const background of [undefined, true, false]) {
    const input = { script: 'return await agent("review");', background };
    assert.equal(hook({ toolName: 'workflow', input }), undefined);
    assert.equal(input.background, false);
  }
});

test('both asynchronous resume routes are blocked without silently starting fresh work', () => {
  const hook = guard();
  for (const event of [
    { toolName: 'workflow', input: { script: 'review', resumeFromRunId: 'paused-run', background: false } },
    { toolName: 'workflow_control', input: { action: 'resume', runId: 'paused-run' } },
  ]) {
    const original = structuredClone(event);
    const result = hook(event);
    assert.equal(result.block, true);
    assert.match(result.reason, /cannot resume background workflows/);
    assert.deepEqual(event, original);
  }
  assert.equal(hook({ toolName: 'workflow_control', input: { action: 'status', runId: 'paused-run' } }), undefined);
  assert.equal(hook({ toolName: 'bash', input: { command: 'true' } }), undefined);
});
