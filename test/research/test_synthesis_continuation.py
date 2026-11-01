"""Actual saved-input context regressions, not an automated entailment test."""
import copy
import hashlib
import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / '.agents/skills/deep-research/scripts'))
import research_worker as worker
from research_protocol import completion_payload
import test_support_quality as fixtures

FIXTURE = Path(__file__).parent / 'fixtures/synthesis-continuation.json'

class ReconstructionTests(unittest.TestCase):
    def setUp(self):
        self.actual = json.loads(FIXTURE.read_text())
        self.report = self.actual['candidate']
        self.offers = self.actual['citation_passages']

    def review(self, report=None, offers=None):
        fn = getattr(worker, 'reconstruction_review', None)
        self.assertTrue(callable(fn), 'Evidence-first reconstruction presentation is missing')
        return fn(self.report if report is None else report, self.offers if offers is None else offers)

    def test_actual_p4_r2_old_conclusions_are_not_repeated_as_reconstruction_inputs(self):
        # Removing only the old prose from candidate but retaining it in the join
        # would fail: the projection itself must no longer anchor reconstruction.
        prior = worker.synthesis_review(self.report, self.offers)
        self.assertIn('heavier workflow platform', json.dumps(prior))
        self.assertIn('RQ or Celery', json.dumps(prior))
        review = self.review()
        self.assertEqual(review['conclusions'], [])
        self.assertNotIn('heavier workflow platform', json.dumps(review))
        self.assertNotIn('RQ or Celery', json.dumps(review))
        self.assertEqual(set(review['claims']), {c['id'] for c in self.report['claims']})
        self.assertEqual(review['omitted_claims'], 0)

    def test_actual_c9_missing_antecedent_is_adjacent_unselected_current_offer(self):
        review = self.review(); c9 = review['claims']['C9']
        selected = ''.join(p['text'] for p in c9['selected_passages'])
        needle = 'Worker crashes just before it notifies the Temporal Service'
        self.assertNotIn(needle, selected)
        antecedent = next(p for p in self.offers if p['source_id'] == 'S004' and p['start'] == 5062)
        self.assertIn(needle, antecedent['text'])
        self.assertIn(fixtures.selector(antecedent), c9['adjacent_offers'])
        self.assertNotIn(fixtures.selector(antecedent), [fixtures.selector(p) for p in c9['selected_passages']])
        self.assertIn('unselected', review['interpretation'])

    def test_actual_p1_redis_example_remains_adjacent_not_promoted_into_c4_support(self):
        c4 = self.review()['claims']['C4']
        self.assertEqual([(p['start'], p['end']) for p in c4['selected_passages']], [(0, 674)])
        after = next(p for p in self.offers if p['source_id'] == 'S006' and p['start'] == 674)
        self.assertIn('Redis', after['text'])
        self.assertIn(fixtures.selector(after), c4['adjacent_offers'])
        self.assertNotIn('Redis', ''.join(p['text'] for p in c4['selected_passages']))

    def test_uncited_atomic_claim_and_unknown_evidence_remain_visible_without_review_flags(self):
        r = copy.deepcopy(self.report)
        r['claims'].append({'id':'C99', 'kind':'inference', 'text':'Untested conditional proposal.',
                            'evidence':[], 'verified':True})
        r['claims'][0]['evidence'].append({'source_id':'S999', 'text_sha256':'a'*64, 'start':0, 'end':100})
        r['recommendations'].append({'text':'Not retained.', 'claim_ids':['C404']})
        offers = copy.deepcopy(self.offers);offers[0]['verified'] = True
        review = self.review(r, offers)
        self.assertEqual(review['claims']['C99']['text'], 'Untested conditional proposal.')
        self.assertEqual(review['claims']['C1']['unavailable_selections'], 1)
        self.assertEqual(review['unavailable_claim_ids'], ['C404'])
        self.assertNotIn('verified', json.dumps(review))
        self.assertNotIn('verdict', review)

    def test_adjacent_context_must_touch_same_source_hash_and_not_selected(self):
        p = self.offers[0]; selected = fixtures.selector(p)
        forged = [{**p,'text_sha256':'b'*64,'start':p['end'],'end':p['end']+50},
                  {**p,'source_id':'S999','start':p['end'],'end':p['end']+50},
                  {**p,'start':p['end']+10,'end':p['end']+50}]
        r = {'claims':[{'id':'C1','kind':'fact','text':'Data only.', 'evidence':[selected]}]}
        card = self.review(r, [p]+forged)['claims']['C1']
        self.assertEqual(card['adjacent_offers'], [])

    def test_whole_atomic_cards_are_bounded_with_explicit_omission(self):
        r = {'claims':[{'id':f'C{i}', 'kind':'fact', 'text':'🔥'*6000,'evidence':[]} for i in range(100)]}
        review = self.review(r, [])
        self.assertLessEqual(len(json.dumps(review).encode()),32768)
        self.assertEqual(len(review['claims'])+review['omitted_claims'],100)
        self.assertGreater(review['omitted_claims'],0)
        self.assertTrue(all(c['text']=='🔥'*6000 for c in review['claims'].values()))

class ReconstructionPayloadTests(unittest.TestCase):
    setUp = fixtures.SupportWorkerTests.setUp
    worker = fixtures.SupportWorkerTests.worker
    submit_v2 = fixtures.SupportWorkerTests.submit_v2
    seed_v2 = fixtures.SupportWorkerTests.seed_v2

    def test_actual_final_inputs_reconstruct_all_claims_without_old_synthesis_shadow(self):
        actual = json.loads(FIXTURE.read_text()); j = self.seed_v2(); w = self.worker(lambda c,n:{})
        for phase in ('draft','audit','repair'):
            c = copy.deepcopy(j['checkpoint']); c['phase']=phase;c['draft']=actual['candidate']
            c['history']=[{'role':'assistant','content':{'action':'finish','report':actual['candidate']}}]
            with patch('research_worker.make_passages', return_value=copy.deepcopy(actual['citation_passages'])):
                payload=w.model_payload(j,c)
            body=json.loads(payload['messages'][-1]['content'])
            self.assertEqual(set(body['candidate']),{'claims','unanswered'})
            self.assertEqual(body['prior_messages'],[])
            self.assertEqual(body['synthesis_review']['omitted_claims'],0)
            self.assertEqual(len(body['synthesis_review']['claims']),9)
            self.assertNotIn('heavier workflow platform',json.dumps(payload))
            self.assertNotIn('RQ or Celery',json.dumps(payload))
            self.assertEqual(len(body['citation_passages']),93)
            self.assertEqual(body['budget']['reserved_final_calls'],3)
            self.assertLessEqual(len(json.dumps(completion_payload('unreported',payload['messages'])).encode()),196608)
        self.assertEqual(self.store.get(j['id'])['counters']['model'],0)

    def test_pressure_never_leaves_stale_projection_or_exceeds_wire_limit(self):
        j=self.seed_v2();w=self.worker(lambda c,n:{})
        c=copy.deepcopy(j['checkpoint']);c['phase']='audit'
        c['draft']={'claims':[{'id':f'C{i}','kind':'fact','text':'🔥'*6000,'evidence':[]} for i in range(100)],
                    'unanswered':[],'recommendations':[{'text':'OLD_SYNTHESIS_CANARY','claim_ids':[]}]}
        body_payload=w.model_payload(j,c);body=json.loads(body_payload['messages'][-1]['content'])
        self.assertNotIn('OLD_SYNTHESIS_CANARY',json.dumps(body_payload))
        self.assertLessEqual(len(json.dumps(completion_payload('unreported',body_payload['messages'])).encode()),196608)
        if body['candidate'] is None:self.assertIsNone(body['synthesis_review'])

if __name__ == '__main__':unittest.main()
