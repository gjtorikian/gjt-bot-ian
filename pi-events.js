function textContent(content) {
  if (typeof content === 'string') return content;
  return (content ?? []).filter((block) => block.type === 'text').map((block) => block.text).join('');
}

const EVENT_COLORS = {
  start: '1;36',
  session: '2',
  agent_start: '2',
  agent_end: '2',
  agent_settled: '2',
  'tool.start': '1;94',
  'tool.output': '2',
  'tool.end': '1;32',
  assistant: '1;35',
  'background.complete': '1;32',
  stderr: '1;33',
  auto_retry_start: '1;33',
  auto_retry_end: '1;32',
  exit: '1;32',
};

export function createPiLogger(key, { level = process.env.BOT_LOG_LEVEL ?? 'info', write = console.log, env = process.env, isTTY = process.stdout.isTTY } = {}) {
  const color = env.NO_COLOR === undefined && env.FORCE_COLOR !== '0'
    && (env.FORCE_COLOR !== undefined || (isTTY && env.TERM !== 'dumb'));
  const paint = (code, text) => color ? `\u001b[${code}m${text}\u001b[0m` : text;
  const secrets = Object.entries(env)
    .filter(([name, value]) => /token|key|secret|password|credential/i.test(name) && value?.length >= 8)
    .map(([, value]) => value).sort((a, b) => b.length - a.length);
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

// Pi emits extension results as custom message_end events, which may arrive
// after the assistant's last turn_end while print mode drains background work.
export function createPiObserver({ model: initialModel, onProgress = () => {}, log = () => {} }) {
  let model = initialModel;
  let cost = 0;
  let error;
  let lastAssistant = '';
  let completions = [];
  const seenMessages = new Set();
  const toolIds = new Set();
  const tools = [];
  const partials = new Map();

  const progress = () => onProgress({ tools: [...tools], cost });
  const recordTool = (id, name) => {
    if (!name || (id && toolIds.has(id))) return;
    if (id) toolIds.add(id);
    tools.push(name);
    progress();
  };
  const recordAssistant = (message) => {
    const text = textContent(message.content).trim();
    // message_end and turn_end carry the same completed assistant message.
    const signature = JSON.stringify([message.timestamp, message.model, message.stopReason, text,
      message.usage, message.content?.filter?.((block) => block.type === 'toolCall').map((block) => block.id)]);
    if (seenMessages.has(signature)) return;
    seenMessages.add(signature);
    cost += message.usage?.cost?.total ?? 0;
    if (message.model) model = message.model;
    error = ['error', 'aborted'].includes(message.stopReason)
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
          recordTool(event.toolCallId, event.toolName);
          log('tool.start', { name: event.toolName, id: event.toolCallId, args: event.args });
          break;
        case 'tool_execution_update': {
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
      return {
        text: completions.length ? completions.join('\n\n') : lastAssistant || '(pi returned no text)',
        footer: `_${model.split('/').pop()} · ${tools.length} tool${tools.length === 1 ? '' : 's'} · $${cost.toFixed(4)}_`,
      };
    },
  };
}
