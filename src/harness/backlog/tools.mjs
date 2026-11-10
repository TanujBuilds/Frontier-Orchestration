import { taskDispatchInputSchema } from '../contracts.mjs';
import { MAX_BACKLOG_ITEMS } from './contract.mjs';
import { Backlog } from './service.mjs';

const id = { type: 'string', maxLength: 120 };
const groupFields = ['goalId', 'expectedGoalHash', 'expectedGoalVersion', 'submissionId', 'items'];

export function registerBacklogTools({ add, c, worker, beta = c.beta }) {
  const backlog = new Backlog({ c, worker });
  const { submissionId, dependsOn, ...taskProperties } = taskDispatchInputSchema.properties;
  if (beta) {
    delete taskProperties.researchPolicy;
    taskProperties.kind = { ...taskProperties.kind, enum: ['coding', 'consult', 'learning'] };
  }
  const task = {
    ...taskDispatchInputSchema,
    properties: taskProperties,
    required: taskDispatchInputSchema.required.filter(key => key !== 'submissionId'),
  };
  const group = {
    goalId: id,
    expectedGoalHash: { type: 'string', maxLength: 64, pattern: '^[a-f0-9]{64}$' },
    expectedGoalVersion: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
    submissionId: id,
    items: {
      type: 'array', minItems: 1, maxItems: MAX_BACKLOG_ITEMS,
      items: {
        type: 'object', additionalProperties: false, required: ['key', 'task', 'dependsOnKeys'],
        properties: { key: id, task, dependsOnKeys: { type: 'array', items: id, maxItems: MAX_BACKLOG_ITEMS - 1 } },
      },
    },
  };
  add('backlog_preview', 'Validate a task group against an exact approved goal without saving tasks or dispatching work.',
    group, groupFields, false, input => backlog.preview(input));
  add('backlog_submit', 'Atomically submit a bounded task group into an exact active approved goal.',
    group, groupFields, true, (input, key) => backlog.submit(input, key));
  add('backlog_inspect', 'Explain saved task group status using the existing coordinator and its task evidence.',
    { goalId: id, groupId: id, limit: { type: 'integer', minimum: 1, maximum: 100 }, cursor: { type: 'string', maxLength: 1024 } },
    [], false, input => backlog.inspect(input));
}
