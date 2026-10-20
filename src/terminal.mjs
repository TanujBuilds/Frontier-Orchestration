import { createInterface } from 'node:readline/promises';

export function printEvent(event, output = process.stdout) {
  const { type, data } = event;
  if (type === 'local.result') {
    output.write(`\nDeepSeek answer (attempt ${data.attempt}; ${data.source}):\n${data.result.answer ?? data.result.summary ?? ''}\n`);
  } else if (type === 'frontier.review') {
    output.write(`\nCodex review (attempt ${data.attempt}; ${data.source}): ${data.review.decision}\n${data.review.feedback ?? ''}\n`);
  }
}

export async function promptForApproval(plan, { input = process.stdin, output = process.stdout, signal } = {}) {
  output.write(`\nProposed plan:\n${plan.summary}\n\nFocused assignment:\n`);
  const step = plan.steps[0];
  output.write(`Objective: ${step.objective}\nContext: ${step.context}\nExpected result: ${step.expectedResult}\n`);
  const terminal = createInterface({ input, output });
  try {
    const answer = await terminal.question('\nAccept this plan and send the assignment to DeepSeek? [y/N] ', { signal });
    return answer.trim().toLowerCase() === 'y';
  } finally {
    terminal.close();
  }
}

export function printFinal(outcome, eventPath, output = process.stdout) {
  output.write(`\nFinal status: ${outcome.status}\nJob ID: ${outcome.jobId}\n`);
  if (outcome.reason) output.write(`Reason: ${outcome.reason}\n`);
  output.write(`Events: ${eventPath}\n`);
}

export function exitCodeFor(status) {
  return status === 'accepted' ? 0 : status === 'failed' ? 1 : 2;
}
