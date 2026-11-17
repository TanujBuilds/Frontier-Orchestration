import test from 'node:test';
import assert from 'node:assert/strict';
import {endpoint, profile} from './fixtures/mosaic-pb13/public-fixture.mjs';
import {OpenAIChatReviewer} from '../src/harness/review/transports/openai-chat.mjs';

test('shared completion fixture is accepted by the real API review transport', {timeout: 10000}, async t => {
  const api = await endpoint(t, 'reviewer');
  const verdict = {decision: 'accept', feedback: 'Scripted fixture verdict', findings: []};
  api.state.reply = JSON.stringify(verdict);
  const {credentialRef, ...reviewProfile} = profile('reviewer', api.baseUrl);
  const reviewer = OpenAIChatReviewer({
    profile: {...reviewProfile, roles: ['worker', 'reviewer']},
    apiKey: 'dummy-fixture-bearer'
  });
  let dispatched = 0;
  const result = await reviewer.review({
    evidence: {fixtureOnly: true, summary: 'A disposable review contract'},
    signal: AbortSignal.timeout(5000),
    beforeDispatch: () => {dispatched++;}
  });
  assert.deepEqual(JSON.parse(result.content), verdict);
  assert.equal(result.requestedModel, 'alias-reviewer');
  assert.equal(result.reportedModel, 'reported-reviewer');
  assert.equal(dispatched, 1);
  assert.equal(api.posts().length, 1);
  assert.equal(api.posts()[0].auth, 'Bearer dummy-fixture-bearer');
});
