// pi's `--mode json` events are an external format. These types name only the
// fields this bot reads; everything else passes through the index signatures.
interface ContentBlock {
  type: string;
  text?: string;
  id?: string;
  [field: string]: unknown;
}

type Content = string | ContentBlock[] | null;

interface WorkflowAgent {
  id?: string | number;
  label?: string;
  status?: string;
  error?: string;
  history?: { kind?: string; toolName?: string; [field: string]: unknown }[];
  [field: string]: unknown;
}

interface WorkflowSnapshot {
  runId?: string;
  name?: string;
  currentPhase?: string;
  background?: boolean;
  agents?: WorkflowAgent[];
  [field: string]: unknown;
}

interface ToolResult {
  content?: Content;
  // Only the workflow tool's details are read.
  details?: WorkflowSnapshot;
  [field: string]: unknown;
}

interface PiMessage {
  role?: string;
  customType?: string;
  content?: Content;
  timestamp?: number;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
  usage?: { cost?: { total?: number } };
  [field: string]: unknown;
}

export interface PiEvent {
  type: string;
  toolCallId?: string;
  toolName?: string;
  partialResult?: ToolResult;
  result?: ToolResult;
  isError?: boolean;
  message?: PiMessage;
  toolResults?: { toolCallId?: string; toolName?: string; name?: string }[];
  [field: string]: unknown;
}

export interface WorkflowProgress {
  done: number;
  total: number;
  running: number;
  errors: number;
}

export interface ProgressUpdate {
  tools: string[];
  cost: number;
  workflow?: WorkflowProgress;
}

export type ProgressHandler = (update: ProgressUpdate) => void;

export interface PiResult {
  text: string;
  footer: string;
}

export type PiLogger = (event: string, details?: Record<string, unknown>, debug?: boolean) => void;

export interface PiLoggerOptions {
  level?: string;
  write?: (line: string) => void;
  env?: Record<string, string | undefined>;
  isTTY?: boolean;
}

export interface PiObserver {
  handle(event: PiEvent): void;
  result(): PiResult;
}

function textContent(content: Content | undefined): string {
  if (typeof content === 'string') return content;
  return (content ?? []).filter((block) => block.type === 'text').map((block) => block.text).join('');
}

const EVENT_COLORS: Partial<Record<string, string>> = {
  start: '1;36',
  session: '2',
  agent_start: '2',
  agent_end: '2',
  agent_settled: '2',
  'tool.start': '1;94',
  'tool.output': '2',
  'tool.end': '1;32',
  'workflow.progress': '36',
  'workflow.complete': '1;32',
  assistant: '1;35',
  'background.complete': '1;32',
  stderr: '1;33',
  auto_retry_start: '1;33',
  auto_retry_end: '1;32',
  exit: '1;32',
};

export function createPiLogger(key: string, { level = process.env.BOT_LOG_LEVEL ?? 'info', write = console.log, env = process.env, isTTY = process.stdout.isTTY }: PiLoggerOptions = {}): PiLogger {
  const color = env.NO_COLOR === undefined && env.FORCE_COLOR !== '0'
    && (env.FORCE_COLOR !== undefined || (isTTY && env.TERM !== 'dumb'));
  const paint = (code: string, text: string) => color ? `\u001b[${code}m${text}\u001b[0m` : text;
  const secrets = Object.entries(env)
    .flatMap(([name, value]) => /token|key|secret|password|credential/i.test(name) && value && value.length >= 8 ? [value] : [])
    .sort((a, b) => b.length - a.length);
  return (event, details = {}, debug = false) => {
    if (level === 'silent' || (debug && level !== 'debug')) return;
    let rendered = JSON.stringify(details, (name, value) => /token|api.?key|secret|password|credential/i.test(name) ? '[redacted]' : value);
    for (const secret of secrets) rendered = rendered.replaceAll(secret, '[redacted]');
    rendered = rendered.replace(/\bxox[baprs]-[A-Za-z0-9-]+/g, '[redacted]')
      .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [redacted]');
    if (level !== 'debug' && rendered.length > 1200) rendered = `${rendered.slice(0, 1200)}…`;
    const failed = event === 'error' || event.endsWith('.error') || details.isError
      || (event === 'exit' && (details.code !== 0 || details.signal))
      || (event === 'auto_retry_end' && details.success === false);
    const eventColor = failed ? '1;31' : EVENT_COLORS[event] ?? '36';
    write(`${paint('2', new Date().toISOString())} ${paint('36', `[pi ${key}]`)} ${paint(eventColor, event)} ${rendered}`);
  };
}

// Extension results can arrive after the assistant's last turn_end. Print mode
// does not guarantee that background work finishes before it shuts down.
export function createPiObserver({ model: initialModel, onProgress = () => {}, log = () => {} }: {
  model: string;
  onProgress?: ProgressHandler;
  log?: PiLogger;
}): PiObserver {
  let model = initialModel;
  let cost = 0;
  let error: string | undefined;
  let lastAssistant = '';
  let completions: string[] = [];
  const seenMessages = new Set<string>();
  const toolIds = new Set<string>();
  const tools: string[] = [];
  const partials = new Map<string | undefined, string>();
  const workflows = new Map<string | undefined, { signature?: string; failure?: string }>();
  let workflowProgress: WorkflowProgress | undefined;

  const progress = () => onProgress({ tools: [...tools], cost, workflow: workflowProgress });
  const workflowUpdate = (id: string | undefined, snapshot: WorkflowSnapshot | undefined) => {
    if (!snapshot || !Array.isArray(snapshot.agents)) return;
    const state = workflows.get(id) ?? {};
    const agents = snapshot.agents.map((agent) => {
      const last = agent.history?.at(-1);
      return { id: agent.id, label: agent.label, status: agent.status,
        error: agent.error, activity: last?.kind, tool: last?.toolName, step: agent.history?.length };
    });
    const details = { id, runId: snapshot.runId, name: snapshot.name, phase: snapshot.currentPhase,
      done: agents.filter((agent) => agent.status === 'done').length,
      running: agents.filter((agent) => agent.status === 'running').length,
      errors: agents.filter((agent) => agent.status === 'error' || agent.status === 'skipped').length,
      total: agents.length, agents };
    const signature = JSON.stringify(details);
    if (signature === state.signature) return;
    workflows.set(id, { ...state, signature });
    workflowProgress = { done: details.done, total: details.total, running: details.running, errors: details.errors };
    log('workflow.progress', details);
    progress();
  };
  const workflowEnd = (event: PiEvent) => {
    const details = event.result?.details;
    workflowUpdate(event.toolCallId, details);
    const runId = details?.runId ?? event.toolCallId;
    let failure: string | undefined;
    if (event.isError) failure = `Workflow ${runId} failed: ${textContent(event.result?.content)}`;
    else if (details?.background) failure = `Workflow ${runId} was left in the background. This one-shot pi process cannot complete or deliver it after exiting.`;
    else if (details?.agents?.some((agent) => agent.status !== 'done')) {
      failure = `Workflow ${runId} ended with unfinished or failed agents.`;
    }
    workflows.set(event.toolCallId, { failure });
    log(failure ? 'workflow.error' : 'workflow.complete', { id: event.toolCallId, runId, message: failure });
  };
  const recordTool = (id: string | undefined, name: string | undefined) => {
    if (!name || (id && toolIds.has(id))) return;
    if (id) toolIds.add(id);
    tools.push(name);
    progress();
  };
  const recordAssistant = (message: PiMessage) => {
    const text = textContent(message.content).trim();
    // message_end and turn_end carry the same completed assistant message.
    const toolCalls = Array.isArray(message.content)
      ? message.content.filter((block) => block.type === 'toolCall').map((block) => block.id) : undefined;
    const signature = JSON.stringify([message.timestamp, message.model, message.stopReason, text,
      message.usage, toolCalls]);
    if (seenMessages.has(signature)) return;
    seenMessages.add(signature);
    cost += message.usage?.cost?.total ?? 0;
    if (message.model) model = message.model;
    error = message.stopReason === 'error' || message.stopReason === 'aborted'
      ? message.errorMessage || `Pi response ${message.stopReason}` : undefined;
    if (error) log('assistant.error', { error });
    if (text) {
      lastAssistant = text;
      completions = [];
      log('assistant', { text });
    }
  };

  return {
    handle(event) {
      switch (event.type) {
        case 'session':
          log('session', { id: event.id, timestamp: event.timestamp, cwd: event.cwd });
          break;
        case 'agent_start':
        case 'agent_end':
        case 'agent_settled':
          log(event.type, { willRetry: event.willRetry });
          break;
        case 'tool_execution_start':
          if (event.toolName === 'workflow') {
            workflows.set(event.toolCallId, { failure: `pi exited before workflow ${event.toolCallId} finished.` });
          }
          recordTool(event.toolCallId, event.toolName);
          log('tool.start', { name: event.toolName, id: event.toolCallId, args: event.args });
          break;
        case 'tool_execution_update': {
          if (event.toolName === 'workflow') workflowUpdate(event.toolCallId, event.partialResult?.details);
          const output = textContent(event.partialResult?.content);
          const previous = partials.get(event.toolCallId) ?? '';
          const delta = output.startsWith(previous) ? output.slice(previous.length) : output;
          partials.set(event.toolCallId, output);
          if (delta) log('tool.output', { name: event.toolName, id: event.toolCallId, text: delta }, true);
          break;
        }
        case 'tool_execution_end':
          recordTool(event.toolCallId, event.toolName);
          partials.delete(event.toolCallId);
          log('tool.end', { name: event.toolName, id: event.toolCallId, isError: event.isError,
            text: textContent(event.result?.content) });
          if (event.toolName === 'workflow') workflowEnd(event);
          progress();
          break;
        case 'message_end': {
          const message = event.message;
          if (message?.role === 'assistant') recordAssistant(message);
          else if (message?.role === 'custom') {
            log('custom', { type: message.customType });
            if (message.customType === 'subagent-notify') {
              const text = textContent(message.content)
                .split(/\n\n(?:Retention-managed async directory|Session file):/)[0]
                .replace(/\*\*(.+?)\*\*/g, '*$1*').trim();
              if (text && !completions.includes(text)) {
                completions.push(text);
                log('background.complete', { text });
              }
            }
          }
          break;
        }
        case 'turn_end':
          if (event.message && (!event.message.role || event.message.role === 'assistant')) recordAssistant(event.message);
          for (const tool of event.toolResults ?? []) recordTool(tool.toolCallId, tool.toolName ?? tool.name);
          break;
        case 'auto_retry_start':
        case 'auto_retry_end':
          log(event.type, { attempt: event.attempt, error: event.errorMessage, success: event.success });
          break;
      }
    },
    result() {
      if (error) throw new Error(error);
      const failedWorkflow = [...workflows.values()].find((workflow) => workflow.failure);
      if (failedWorkflow) throw new Error(failedWorkflow.failure);
      return {
        text: completions.length ? completions.join('\n\n') : lastAssistant || '(pi returned no text)',
        footer: `_${model.split('/').pop()} · ${tools.length} tool${tools.length === 1 ? '' : 's'} · $${cost.toFixed(4)}_`,
      };
    },
  };
}
