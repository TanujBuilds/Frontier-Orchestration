import { randomUUID } from 'node:crypto';

const reviewDecisions = new Set(['accept', 'revise', 'blocked']);

function requireText(value, name) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${name} must be a non-empty string`);
  return value.trim();
}

function validatePlan(plan) {
  requireText(plan?.summary, 'plan.summary');
  if (!Array.isArray(plan.steps) || plan.steps.length !== 1) throw new Error('The first MVP requires exactly one plan step');
  const step = plan.steps[0];
  requireText(step?.id, 'step.id');
  requireText(step?.objective, 'step.objective');
  requireText(step?.context, 'step.context');
  requireText(step?.expectedResult, 'step.expectedResult');
  return plan;
}

function validateResult(result) {
  if (!result || !['completed', 'blocked', 'failed'].includes(result.status)) throw new Error('Local worker returned an invalid status');
  if (result.status === 'completed') requireText(result.answer, 'result.answer');
  return result;
}

function validateReview(review) {
  if (!reviewDecisions.has(review?.decision)) throw new Error('Frontier reviewer returned an invalid decision');
  if (review.decision !== 'accept') requireText(review.feedback, 'review.feedback');
  return review;
}

export async function runJob({ goal, frontier, local, store, approvePlan, onEvent = () => {}, maxLocalAttempts = 2, signal }) {
  const cleanGoal = requireText(goal, 'goal');
  if (!Number.isInteger(maxLocalAttempts) || maxLocalAttempts < 1 || maxLocalAttempts > 2) throw new Error('maxLocalAttempts must be 1 or 2');
  if (typeof approvePlan !== 'function') throw new Error('An explicit approvePlan callback is required');
  if (typeof onEvent !== 'function') throw new Error('onEvent must be a function');

  const jobId = randomUUID();
  let sequence = 0;
  let stage = 'planning';
  let plan;
  let result;
  let review;
  const record = async (type, data = {}) => {
    const event = { jobId, sequence: ++sequence, at: new Date().toISOString(), type, data };
    await store.append(jobId, event);
    await onEvent(event);
  };

  await record('job.created', { goal: cleanGoal });
  try {
    plan = validatePlan(await frontier.plan({ jobId, goal: cleanGoal, signal }));
    const planVersion = 1;
    await record('plan.proposed', { planVersion, plan, source: frontier.identity ?? 'frontier' });

    stage = 'approval';
    if (!(await approvePlan(plan, { signal }))) {
      await record('job.paused', { reason: 'Plan was not accepted' });
      return { jobId, status: 'paused', plan };
    }
    await record('plan.accepted', { planVersion });

    let feedback = null;
    let priorResult = null;
    for (let attempt = 1; attempt <= maxLocalAttempts; attempt += 1) {
      stage = 'local';
      const assignment = { jobId, planVersion, step: plan.steps[0], attempt, feedback, priorResult };
      await record('assignment.sent', assignment);
      result = validateResult(await local.execute({ ...assignment, signal }));
      await record('local.result', { attempt, result, source: local.identity ?? 'local' });

      if (result.status !== 'completed') {
        await record('job.finished', { status: result.status, reason: result.summary ?? '' });
        return { jobId, status: result.status, plan, result };
      }

      stage = 'review';
      review = validateReview(await frontier.review({ jobId, goal: cleanGoal, planVersion, plan, result, attempt, signal }));
      await record('frontier.review', { attempt, review, source: frontier.identity ?? 'frontier' });

      if (review.decision === 'accept' || review.decision === 'blocked') {
        const status = review.decision === 'accept' ? 'accepted' : 'blocked';
        await record('job.finished', { status, reason: review.feedback ?? '' });
        return { jobId, status, plan, result, review };
      }
      feedback = review.feedback;
      priorResult = result;
    }

    await record('job.finished', { status: 'needs_review', reason: 'Local attempt limit reached' });
    return { jobId, status: 'needs_review', plan, result, review };
  } catch (error) {
    const reason = signal?.aborted ? 'Interrupted by user' : error.message;
    if (stage !== 'approval') {
      const source = stage === 'local' ? local.identity ?? 'local' : frontier.identity ?? 'frontier';
      await record('provider.failed', { stage, source, reason });
    }
    await record('job.finished', { status: 'failed', stage, reason });
    return { jobId, status: 'failed', stage, reason, plan, result, review };
  }
}
