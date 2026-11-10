import {ResearchMissions} from './service.mjs';

const string = {type: 'string'};
const hash = {...string, maxLength: 64, pattern: '^[a-f0-9]{64}$'};
const fields = {
  taskId: {...string, maxLength: 120},
  candidateHash: hash,
  offset: {type: 'integer', minimum: 0, maximum: 10000},
  limit: {type: 'integer', minimum: 1, maximum: 20}
};
const briefProperties = {
  question: {...string, maxLength: 2000},
  scope: {...string, maxLength: 2000},
  outputShape: {...string, maxLength: 1000},
  asOf: {...string, maxLength: 10}
};

export function registerResearchMissionTools({add, c, artifacts}) {
  const missions = new ResearchMissions({c, artifacts});
  add('research_mission_inspect', 'Inspect a bounded page of saved research evidence and exact review bindings.',
    fields, ['taskId'], false, input => missions.inspect(input));
  add('research_mission_export', 'Export one bounded page of a research mission in JSON or Markdown.',
    {...fields, format: {...string, enum: ['json', 'markdown']}}, ['taskId', 'format'], false, input => missions.export(input));
  add('research_mission_prepare', 'Save a bounded research brief as draft metadata. Launches no work and grants no execution authority.',
    {goalId: {...string, maxLength: 120}, expectedGoalHash: hash,
      brief: {type: 'object', properties: briefProperties, required: Object.keys(briefProperties), additionalProperties: false}},
    ['goalId', 'expectedGoalHash', 'brief'], true, (input, key) => missions.prepare(input, key));
}
