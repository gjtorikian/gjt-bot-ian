// Deterministic provider/tool for exercising the real pi tool-call hook. No
// network, credentials, or model calls; the workflow models the extension's
// background-by-default behavior.
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';

export default function workflowFixture(pi) {
  pi.registerProvider('bot-test', {
    baseUrl: 'http://127.0.0.1:1', apiKey: 'test-only', api: 'bot-test-api',
    models: [{ id: 'fixture', name: 'Fixture', reasoning: false, input: ['text'],
      contextWindow: 32000, maxTokens: 1024,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple(model, context) {
      const result = context.messages.findLast((message) => message.role === 'toolResult');
      const output = {
        role: 'assistant', api: model.api, provider: model.provider, model: model.id,
        timestamp: Date.now(), stopReason: result ? 'stop' : 'toolUse',
        content: result ? [{ type: 'text', text: result.content[0].text }] : [{
          type: 'toolCall', id: 'workflow-call', name: 'workflow', arguments: { background: true },
        }],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: 'start', partial: output });
      stream.push({ type: 'done', reason: output.stopReason, message: output });
      stream.end();
      return stream;
    },
  });
  pi.registerTool({
    name: 'workflow', label: 'Workflow', description: 'Test workflow',
    parameters: { type: 'object', properties: { background: { type: 'boolean' } } },
    async execute(_id, input, _signal, onUpdate) {
      if (input.background ?? true) return {
        content: [{ type: 'text', text: 'Started in the background' }],
        details: { background: true, runId: 'fixture-run' },
      };
      const snapshot = { name: 'fixture', runId: 'fixture-run',
        agents: [{ id: 1, label: 'Test worker', status: 'running' }] };
      onUpdate({ content: [{ type: 'text', text: 'Working' }], details: snapshot });
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { content: [{ type: 'text', text: 'Foreground workflow finished' }],
        details: { ...snapshot, agents: [{ ...snapshot.agents[0], status: 'done' }] } };
    },
  });
}
