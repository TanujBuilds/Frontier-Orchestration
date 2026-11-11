import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Coordinator } from '../coordinator.mjs';
import { Dispatcher } from '../tools.mjs';
import { Worker } from '../worker.mjs';

export async function backlogDemo(output) {
  const destination = path.resolve(output);
  await mkdir(destination, { recursive: true, mode: 0o700 });
  const root = await mkdtemp(path.join(destination, 'backlog-demo-'));
  const config = { environment: 'fixture' };
  const providerInvocations = {};
  let calls = 0;
  const provider = { async complete() {
    calls++;
    return { content: 'Saved response from the disposable fixture', model: 'fixture-no-model' };
  } };
  let c, worker, dispatcher, owner;
  function open() {
    c = new Coordinator({ root });
    owner = randomUUID();
    c.acquireWorker(owner);
    worker = new Worker({ c, owner, config, provider });
    dispatcher = new Dispatcher({ c, worker, config });
  }
  function close() {
    if (!c) return;
    try {
      worker?.overnight.close();
      if (c.workerLease) c.releaseWorker(owner);
    } finally {
      c.close();
      c = undefined;
    }
  }

  try {
    open();
    const goal = await dispatcher.invoke('legacy_goal_prepare', {
      idempotencyKey: 'demo-prepare',
      manifest: {
        submissionId: 'demo-goal', objective: 'Inspect an example and then check its follow-up',
        acceptance: ['Retain the fixture answers'], mode: 'collaborative', environment: 'fixture',
      },
    });
    await dispatcher.invoke('goal_activate', { goalId: goal.id, hash: goal.hash, idempotencyKey: 'demo-activate' });
    const item = (key, objective, dependsOnKeys = []) => ({
      key, dependsOnKeys, task: { kind: 'consult', objective, acceptance: ['Save the fixture answer'] },
    });
    const input = {
      goalId: goal.id, expectedGoalHash: goal.hash, expectedGoalVersion: goal.version, submissionId: 'demo-group',
      items: [
        item('inspect', 'Inspect the example'),
        item('follow-up', 'Check the inspected example', ['inspect']),
        item('independent', 'Describe a separate example'),
      ],
    };
    const preview = await dispatcher.invoke('backlog_preview', input);
    if (!preview.valid) throw Error('Fixture preview rejected the demo group');
    const submission = { ...input, idempotencyKey: 'demo-submit' };
    const group = await dispatcher.invoke('backlog_submit', submission);
    const inspect = () => dispatcher.invoke('backlog_inspect', { goalId: goal.id, groupId: group.id });
    const before = await inspect();
    providerInvocations.before = calls;

    const first = await worker.executeTick();
    const reviewWait = await inspect();
    providerInvocations.reviewWait = calls;
    if (first?.status !== 'awaiting_review') throw Error('Demo did not reach the saved review boundary');

    close();
    open();
    const replay = await dispatcher.invoke('backlog_submit', submission);
    if (replay.id !== group.id) throw Error('Demo group replay changed identity');
    const reopened = await inspect();
    providerInvocations.reopened = calls;

    const accept = task => dispatcher.invoke('task_review', {
      taskId: task.id, decision: 'accept', feedback: 'Simulated operator accepted the saved fixture answer',
      idempotencyKey: 'demo-review-' + task.id,
    });
    await accept(first);
    for (let i = 0; i < 2; i++) {
      const task = await worker.executeTick();
      if (task?.status !== 'awaiting_review') throw Error('Demo did not reach the next saved review boundary');
      await accept(task);
    }
    const completed = await inspect();
    providerInvocations.completed = calls;
    const transcript = path.join(root, 'transcript.json');
    await writeFile(transcript, JSON.stringify({
      schemaVersion: 1, generatedAt: new Date().toISOString(), sourceRevision: completed.sourceRevision,
      evidence: 'Real disposable SQLite and Worker with simulated provider responses and operator decisions.',
      groupId: group.id, preview, before, reviewWait, reopened, completed, providerInvocations,
    }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    return { groupId: group.id, transcript };
  } finally {
    close();
  }
}
