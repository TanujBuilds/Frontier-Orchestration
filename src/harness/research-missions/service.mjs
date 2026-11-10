import {Artifacts} from '../artifacts.mjs';
import {digest, identifier, integer, keys} from '../contracts.mjs';
import {validateMissionBrief} from './contract.mjs';
import {isHash, loadMissionEvidence, negativeReviews} from './evidence.mjs';
import {renderMissionMarkdown} from './render.mjs';
import {projectMission} from './view.mjs';

const sections = ['claims', 'summary', 'comparisons', 'recommendations', 'contradictions', 'unanswered', 'sources'];
const MAX_PAGE_BYTES = 256 * 1024;
const draftId = (goalId, goalHash, question) => digest({goalId, goalHash, question});
const iso = timestamp => new Date(timestamp).toISOString();

function paginate(view, offset, limit) {
  const units = sections.flatMap(section => (view[section] ?? []).map(unit => [section, unit]));
  const page = {...view, ...Object.fromEntries(sections.map(section => [section, []]))};
  let end = Math.min(offset + limit, units.length);
  for (const [section, unit] of units.slice(offset, end)) page[section].push(unit);
  // A smaller page still advances by exactly the number of returned units.
  const size = () => Buffer.byteLength(JSON.stringify(page));
  while (end > offset + 1 && size() > MAX_PAGE_BYTES - 1024) {
    end -= 1;
    page[units[end][0]].pop();
  }
  if (size() > MAX_PAGE_BYTES - 1024) throw Error('Mission page exceeds byte bound; use the saved artifact catalog');
  page.pagination = {offset, limit, returned: Math.max(0, end - offset), total: units.length,
    nextOffset: end < units.length ? end : null};
  return page;
}

function publicScope(scope) {
  if (!scope) return null;
  const sha256 = digest(scope);
  if (Buffer.byteLength(JSON.stringify(scope)) <= 4096) return {...scope, sha256};
  return {
    sha256,
    counts: Object.fromEntries(Object.entries(scope).map(([field, values]) => [field, values.length])),
    reason: 'Full approved source scope exceeds the inline bound. See the task specification.'
  };
}

export class ResearchMissions {
  constructor({c, artifacts = new Artifacts(c)}) {
    this.c = c;
    this.artifacts = artifacts;
  }

  prepare({goalId, expectedGoalHash, brief: raw}, key) {
    identifier(goalId, 'goal ID');
    if (!isHash(expectedGoalHash)) throw Error('Invalid expected goal hash');
    const brief = validateMissionBrief(raw);
    return this.c.store.command(key, {op: 'research.mission.prepare', goalId, expectedGoalHash, brief}, () => {
      const goal = this.c.store.get('goal', goalId);
      if (goal.hash !== expectedGoalHash || digest(goal.manifest) !== goal.hash) throw Error('Exact goal hash required');
      const id = draftId(goalId, expectedGoalHash, brief.question);
      const prior = this.c.store.maybe('research_mission', id);
      if (prior) {
        if (digest(prior.brief) !== digest(brief)) throw Error('Mission brief conflict for this goal version and question');
        return prior;
      }
      const draft = {
        id, schemaVersion: 1, missionId: id, goalId, goalHash: goal.hash, goalVersion: goal.version,
        status: 'drafted', taskId: null, brief, generatedAt: iso(this.c.now()),
        sourceRevision: goal.manifest.project?.baseCommit ?? null,
        evidenceExplanation: 'Saved brief metadata. Execution requires the existing approved research route and its readiness gates.'
      };
      this.c.store.put('research_mission', draft);
      return draft;
    });
  }

  async inspect(input) {
    keys(input, ['taskId', 'candidateHash', 'offset', 'limit'], 'mission inspection');
    const taskId = identifier(input.taskId, 'task ID');
    const offset = integer(input.offset ?? 0, 'offset', 0, 10000);
    const limit = integer(input.limit ?? 10, 'limit', 1, 20);
    const requested = input.candidateHash;
    if (requested !== undefined && !isHash(requested)) throw Error('Invalid candidate hash');

    const {c, artifacts} = this;
    const task = c.store.get('task', taskId);
    if (task.spec.kind !== 'research') throw Error('A saved research task is required');
    const currentGoal = c.store.get('goal', task.goalId);
    const goal = currentGoal.version === task.goalVersion
      ? currentGoal : c.store.maybe('goal_history', task.goalId + '-' + task.goalVersion);
    const sourceRevision = goal?.manifest.project?.baseCommit ?? null;
    const draft = goal && c.store.maybe('research_mission', draftId(task.goalId, goal.hash, task.spec.objective.trim()));
    const negatives = negativeReviews(c, task);
    const currentCandidate = (task.result?.reviewBinding ?? (task.result?.proposalFile && task.checkpoint.reviewCandidate))?.candidateHash;
    const historical = requested && requested !== currentCandidate
      ? negatives.find(review => review.descriptor.candidateHash === requested) : null;
    if (requested && requested !== currentCandidate && !historical) throw Error('Unknown candidate for this research task');
    const evidence = await loadMissionEvidence({c, artifacts, task, historical, negatives});
    if (digest(c.store.get('task', taskId)) !== digest(task)) throw Error('Research task changed during inspection; read the current snapshot again');

    const {descriptor, report, sources, diagnostics, reportHash, sourcesHash} = evidence;
    const bound = evidence.verified && descriptor?.reportSha256 === reportHash && descriptor.sourcesSha256 === sourcesHash;
    const negative = bound && negatives.find(review => review.descriptor.candidateHash === descriptor.candidateHash);
    const acceptance = bound && !historical && task.status === 'accepted' && task.result?.reviewBinding
      ? task.researchReviewAcceptance : null;
    const history = negatives.map(({ticketId, descriptor, decision, findings}) => ({
      ticketId, candidateHash: descriptor.candidateHash, reportHash: descriptor.reportSha256,
      sourcesHash: descriptor.sourcesSha256, decision, affectedUnits: [...new Set(findings.map(f => f.unit))]
    }));
    const view = projectMission({task, report, sources, authority: {
      descriptor, reportHash, sourcesHash, diagnostics, artifacts: evidence.artifacts,
      decision: acceptance?.input.decision ?? negative?.decision ?? null,
      coverage: acceptance?.input.coverage ?? negative?.coverage ?? [],
      findings: negative?.findings ?? [], ticketId: acceptance?.ticketId ?? negative?.ticketId ?? null,
      brief: draft?.brief ?? null, sourceRevision, generatedAt: iso(c.now()), history, historical: !!historical,
    }});
    return paginate({
      ...view, missionId: draft?.missionId ?? taskId, goalHash: goal?.hash ?? null, goalVersion: task.goalVersion,
      sourceRevision, sourceRevisionReason: sourceRevision ? null : 'No repository revision was recorded for this research task.',
      taskHash: task.hash, approvedSourceScope: publicScope(task.spec.scope), historical: !!historical,
      repair: evidence.repair ?? null, collectionReason: evidence.collectionReason ?? null,
      environment: goal?.manifest.environment ?? null
    }, offset, limit);
  }

  async export(input) {
    keys(input, ['taskId', 'candidateHash', 'offset', 'limit', 'format'], 'mission export');
    const {format, ...read} = input;
    if (!['json', 'markdown'].includes(format)) throw Error('Invalid mission export format');
    const view = await this.inspect(read);
    if (format === 'json') return view;
    const content = renderMissionMarkdown(view);
    if (Buffer.byteLength(content) > 4 * MAX_PAGE_BYTES) throw Error('Markdown export exceeds byte bound; request a smaller page');
    return {
      schemaVersion: 1, generatedAt: view.generatedAt, sourceRevision: view.sourceRevision,
      sourceRevisionReason: view.sourceRevisionReason, evidenceExplanation: view.evidenceExplanation,
      taskId: view.taskId, format, content, pagination: view.pagination
    };
  }
}
