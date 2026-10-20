import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPiLogger, createPiObserver } from '../pi-events.js';

const assistant = (text, timestamp = 1) => ({
  role: 'assistant', timestamp, model: 'parent-model', stopReason: 'stop',
  content: [{ type: 'text', text }], usage: { cost: { total: 0.25 } },
});
const notification = (text) => ({
  type: 'message_end',
  message: { role: 'custom', customType: 'subagent-notify', display: false,
    content: `Background task completed: **reviewer**\n\n${text}\n\nRetention-managed async directory: /tmp/private-run\n\nSession file: /tmp/session.jsonl` },
});

test('a background result arriving after turn_end replaces the launch acknowledgment', () => {
  const observer = createPiObserver({ model: 'parent-model' });
  const message = assistant("Kicked off the review; I'll post the report later.");
  observer.handle({ type: 'message_end', message });
  observer.handle({ type: 'turn_end', message, toolResults: [] });
  observer.handle({ type: 'agent_end', messages: [message] });
  observer.handle(notification('The fix is sound; CI needs Node 22.'));
  const result = observer.result();
  assert.match(result.text, /The fix is sound; CI needs Node 22/);
  assert.doesNotMatch(result.text, /Kicked off|private-run|Session file|\*\*reviewer\*\*/);
  assert.match(result.footer, /\$0\.2500/, 'message_end and turn_end must not double-count cost');
});

test('all background reports are retained until the parent supplies a final answer', () => {
  const observer = createPiObserver({ model: 'parent-model' });
  observer.handle(notification('Report A'));
  observer.handle(notification('Report B'));
  assert.match(observer.result().text, /Report A[\s\S]*Report B/);
  observer.handle({ type: 'message_end', message: assistant('Combined final report', 2) });
  assert.equal(observer.result().text, 'Combined final report');
});

test('tool progress is immediate and tools are counted once across event types', () => {
  const updates = [];
  const observer = createPiObserver({ model: 'model', onProgress: (update) => updates.push(update) });
  observer.handle({ type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'subagent', args: { agent: 'reviewer' } });
  assert.deepEqual(updates[0].tools, ['subagent']);
  observer.handle({ type: 'tool_execution_end', toolCallId: 'call-1', toolName: 'subagent', result: { content: [] } });
  observer.handle({ type: 'turn_end', message: assistant('Finished'), toolResults: [{ toolCallId: 'call-1', toolName: 'subagent' }] });
  assert.match(observer.result().footer, /1 tool ·/);
});

test('debug logging shows input and output deltas while hiding credentials and thinking blocks', () => {
  const lines = [];
  const log = createPiLogger('test-thread', {
    level: 'debug', write: (line) => lines.push(line), env: { SLACK_BOT_TOKEN: 'secret-env-token' },
  });
  const observer = createPiObserver({ model: 'model', log });
  log('input', { prompt: 'Review the PR', nested: { api_key: 'another-secret' } });
  observer.handle({ type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'bash', args: { command: 'echo secret-env-token' } });
  for (const text of ['one', 'one two']) observer.handle({
    type: 'tool_execution_update', toolCallId: 'call-1', toolName: 'bash', partialResult: { content: [{ type: 'text', text }] },
  });
  observer.handle({ type: 'message_end', message: {
    ...assistant('Visible answer'), content: [{ type: 'thinking', thinking: 'private-thought' }, { type: 'text', text: 'Visible answer' }],
  } });
  observer.handle({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'private-delta' } });
  log('stderr', { text: 'Bearer unknown-bearer-token xoxb-123-456-abcdef' });
  const output = lines.join('\n');
  assert.match(output, /Review the PR/);
  assert.match(output, /tool\.start/);
  assert.match(output, /"text":" two"/);
  assert.match(output, /Visible answer/);
  assert.doesNotMatch(output, /secret-env-token|another-secret|unknown-bearer-token|xoxb-|private-thought|private-delta/);
});

test('info logs are bounded; debug-only content and silent logs stay out of the console', () => {
  const lines = [];
  const log = createPiLogger('test-thread', { level: 'info', write: (line) => lines.push(line), env: {} });
  log('input', { text: 'full-context' }, true);
  log('tool.end', { text: 'x'.repeat(5000) });
  createPiLogger('test-thread', { level: 'silent', write: (line) => lines.push(line) })('start');
  assert.equal(lines.length, 1);
  assert.ok(lines[0].length < 1400);
  assert.doesNotMatch(lines[0], /full-context/);
});

test('unrelated hidden extension messages do not become Slack replies', () => {
  const observer = createPiObserver({ model: 'model' });
  observer.handle({ type: 'message_end', message: assistant('Public answer') });
  observer.handle({ type: 'message_end', message: { role: 'custom', customType: 'internal-state', display: false, content: 'Internal instructions' } });
  assert.equal(observer.result().text, 'Public answer');
});

test('model errors cannot be mistaken for completed answers', () => {
  const observer = createPiObserver({ model: 'model' });
  observer.handle({ type: 'message_end', message: { ...assistant('Working on it'), stopReason: 'error', errorMessage: 'Provider unavailable' } });
  assert.throws(() => observer.result(), /Provider unavailable/);
});

const workflowSnapshot = (status = 'running', history = []) => ({
  name: 'review', runId: 'review-123', currentPhase: 'Investigate',
  agents: [{ id: 1, label: 'PR reviewer', status, history }],
});

test('workflow activity is logged at info level and reaches progress without repeating snapshots', () => {
  const logs = [];
  const updates = [];
  const observer = createPiObserver({ model: 'model', onProgress: (update) => updates.push(update),
    log: createPiLogger('thread', { level: 'info', env: {}, write: (line) => logs.push(line) }) });
  observer.handle({ type: 'tool_execution_start', toolName: 'workflow', toolCallId: 'call-1' });
  const snapshot = workflowSnapshot('running', [{ kind: 'toolCall', toolName: 'bash', text: 'private args' }]);
  const update = { type: 'tool_execution_update', toolName: 'workflow', toolCallId: 'call-1', partialResult: { details: snapshot } };
  observer.handle(update);
  observer.handle(update);
  observer.handle({ ...update, partialResult: { details: workflowSnapshot('done') } });
  assert.equal(logs.filter((line) => line.includes('workflow.progress')).length, 2);
  assert.match(logs.join('\n'), /PR reviewer.*running.*toolCall.*bash/);
  assert.doesNotMatch(logs.join('\n'), /private args/);
  assert.deepEqual(updates.at(-1).workflow, { done: 1, total: 1, running: 0, errors: 0 });
  observer.handle({ type: 'tool_execution_end', toolName: 'workflow', toolCallId: 'call-1',
    result: { details: workflowSnapshot('done') } });
  observer.handle({ type: 'message_end', message: assistant('Completed review') });
  assert.equal(observer.result().text, 'Completed review');
  assert.match(logs.join('\n'), /workflow.complete/);
});

for (const [name, end] of [
  ['missing completion', undefined],
  ['tool error', { isError: true, result: { content: [{ type: 'text', text: 'Request aborted' }] } }],
  ['unfinished agents', { result: { details: workflowSnapshot() } }],
  ['aborted agents', { result: { details: workflowSnapshot('skipped') } }],
]) {
  test(`workflow ${name} cannot be hidden by a successful assistant message`, () => {
    const observer = createPiObserver({ model: 'model' });
    observer.handle({ type: 'tool_execution_start', toolName: 'workflow', toolCallId: 'call-1' });
    observer.handle({ type: 'tool_execution_update', toolName: 'workflow', toolCallId: 'call-1',
      partialResult: { details: workflowSnapshot() } });
    if (end) observer.handle({ type: 'tool_execution_end', toolName: 'workflow', toolCallId: 'call-1', ...end });
    observer.handle({ type: 'message_end', message: assistant('Everything is fine') });
    assert.throws(() => observer.result(), /workflow/i);
  });
}
