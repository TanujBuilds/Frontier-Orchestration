import {readOutcomeSnapshotFromDatabase} from './snapshot.mjs';
import {summarizeOutcomes} from './aggregate.mjs';
import {renderOutcomeMarkdown} from './render.mjs';

export function registerOutcomeTools({add, c}) {
  const identifier = {type: 'string', maxLength: 200};
  const date = {type: 'string', maxLength: 30};
  add('outcomes_report',
    'Summarize saved task outcomes and recorded usage for a bounded page. Omitted evidence is reported explicitly.', {
      goalId: identifier,
      projectKey: {type: 'string', maxLength: 4096},
      from: date,
      to: date,
      limit: {type: 'integer', minimum: 1, maximum: 500},
      cursor: {type: 'string', maxLength: 2048},
      format: {type: 'string', enum: ['json', 'markdown']},
    }, [], false, ({format = 'json', ...scope}) => {
      const report = summarizeOutcomes(readOutcomeSnapshotFromDatabase(c.store.db, scope));
      return format === 'markdown' ? {markdown: renderOutcomeMarkdown(report)} : report;
    });
}
