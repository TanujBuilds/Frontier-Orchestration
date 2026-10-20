import { randomUUID } from 'node:crypto';

const validReviewDecisions = new Set(['accept', 'revise', 'blocked']);

function requireText(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value.trim();
}

function validatePlan(plan) {
  requireText(plan?.summary, 'plan.summary');
  if (!Array.isArray(plan.steps) || plan.steps.length !== 1) {
    throw new Error('The first MVP requires exactly one plan step');
  }
  const step = plan.steps[0];
  requireText(step?.id, 'step.id');
  requireText(step?.objective, 'step.objective');
  requireText(step?.expectedResult, 'step.expectedResult');
  return plan;
}

export async function runJob({ goal, frontier, local, store, approvePlan, maxLocalAttempts = 2 }) {
  const cleanGoal = requireText(goal, 'goal');
  if (maxLocalAttempts < 1 || !Number.isInteger(maxLocalAttempts)) {
    throw new Error('maxLocalAttempts must be a positive integer');
  }
  if (typeof approvePlan !== 'function') {
    throw new Error('An explicit approvePlan callback is required');
  }

  const jobId = randomUUID();
  let sequence = 0;
  const record = async (type, data = {}) => {
    const event = { jobId, sequence: ++sequence, at: new Date().toISOString(), type, data };
    await store.append(jobId, event);
    return event;
  };

  await record('job.created', { goal: cleanGoal });
  try {
    const plan = validatePlan(await frontier.plan({ jobId, goal: cleanGoal }));
    const planVersion = 1;
    await record('plan.proposed', { planVersion, plan });

    if (!(await approvePlan(plan))) {
      await record('job.paused', { reason: 'Plan was not accepted' });
      return { jobId, status: 'paused', plan };
    }
    await record('plan.accepted', { planVersion });

    const step = plan.steps[0];
    let feedback = null;
    for (let attempt = 1; attempt <= maxLocalAttempts; attempt += 1) {
      const assignment = { jobId, planVersion, step, attempt, feedback };
      await record('assignment.sent', assignment);

      const result = await local.execute(assignment);
      if (!result || !['completed', 'blocked', 'failed'].includes(result.status)) {
        throw new Error('Local worker returned an invalid status');
      }
      await record('local.result', { attempt, result });

      if (result.status !== 'completed') {
        await record('job.finished', { status: result.status, reason: result.summary ?? '' });
        return { jobId, status: result.status, plan, result };
      }

      const review = await frontier.review({ jobId, goal: cleanGoal, planVersion, plan, result, attempt });
      if (!validReviewDecisions.has(review?.decision)) {
        throw new Error('Frontier reviewer returned an invalid decision');
      }
      await record('frontier.review', { attempt, review });

      if (review.decision === 'accept') {
        await record('job.finished', { status: 'accepted' });
        return { jobId, status: 'accepted', plan, result, review };
      }
      if (review.decision === 'blocked') {
        await record('job.finished', { status: 'blocked', reason: review.feedback ?? '' });
        return { jobId, status: 'blocked', plan, result, review };
      }
      feedback = requireText(review.feedback, 'review.feedback');
    }

    await record('job.finished', { status: 'needs_review', reason: 'Local attempt limit reached' });
    return { jobId, status: 'needs_review', plan };
  } catch (error) {
    await record('job.finished', { status: 'failed', reason: error.message });
    throw error;
  }
}
