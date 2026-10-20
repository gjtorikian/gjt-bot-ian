// Loaded only by this bot's one-shot pi process. Background workflows are
// paused/aborted when print mode exits, even when the process exits with code 0.
export default function foregroundWorkflows(pi) {
  pi.on('tool_call', (event) => {
    if (event.toolName === 'workflow') {
      // The extension always resumes asynchronously, ignoring background:false.
      // Do not silently replace a resume with a fresh run: it could repeat work.
      if (event.input.resumeFromRunId) {
        return { block: true, reason: 'This Slack bot cannot resume background workflows. Report the paused run to the user; a fresh foreground workflow is required.' };
      }
      event.input.background = false;
    }
    if (event.toolName === 'workflow_control' && event.input.action === 'resume') {
      return { block: true, reason: 'This Slack bot cannot resume background workflows. Report the paused run to the user; a fresh foreground workflow is required.' };
    }
  });
}
