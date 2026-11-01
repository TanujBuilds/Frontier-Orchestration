"""Supervisor-owned structural heldouts; no entailment or live quality verdict.

Fictional subjects avoid domain answer keys. These checks protect exact evidence
boundaries and remove unsupported draft anchoring before model reconstruction.
"""
import copy
import hashlib
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / '.agents/skills/deep-research/scripts'))
import research_worker as worker


def offer(source, start, text, digest):
    return dict(source_id=source, start=start, end=start + len(text),
                text_sha256=digest, text=text)


def selection(p):
    return {k: p[k] for k in worker.SELECTOR_FIELDS}


class HeldoutReconstruction(unittest.TestCase):
    def reconstruct(self, report, offered):
        fn = getattr(worker, 'reconstruction_review', None)
        self.assertTrue(callable(fn), 'Final reconstruction lacks atomic evidence cards')
        return fn(report, offered)

    def test_irrigation_antecedent_and_configuration_are_visible_but_not_auto_selected(self):
        before = 'Only if the greenhouse valve loses power before closing. '
        after = 'In this case the reservoir remains connected until manual isolation.'
        digest = hashlib.sha256((before + after).encode()).hexdigest()
        antecedent = offer('S001', 0, before, digest)
        selected = offer('S001', len(before), after, digest)
        wrong_hash = offer('S001', 0, before, 'f' * 64)
        report = {'claims': [{'id': 'C1', 'kind': 'fact', 'text': after,
                             'evidence': [selection(selected)], 'verified': True}],
                  'comparisons': [], 'contradictions': [],
                  'recommendations': [{'text': 'All valves always remain connected.', 'claim_ids': ['C1']}],
                  'unanswered': []}
        original = copy.deepcopy(report)
        result = self.reconstruct(report, [antecedent, selected, wrong_hash])
        card = result['claims']['C1']
        self.assertEqual(card['selected_passages'], [selected])
        self.assertEqual(card['adjacent_offers'], [selection(antecedent)])
        self.assertEqual(card['text'], after)
        self.assertEqual(result['conclusions'], [])
        self.assertNotIn('All valves always', json.dumps(result))
        self.assertNotIn('verified', json.dumps(result))
        self.assertEqual(report, original)

    def test_retention_alternatives_remain_separate_including_uncited_atomic_claim(self):
        a = 'Archive A retains records only when retention mode is enabled.'
        b = 'Archive B does not retain discarded records.'
        pa = offer('S002', 0, a, hashlib.sha256(a.encode()).hexdigest())
        pb = offer('S003', 0, b, hashlib.sha256(b.encode()).hexdigest())
        report = {'claims': [
            {'id': 'C1', 'kind': 'fact', 'text': a, 'evidence': [selection(pa)]},
            {'id': 'C2', 'kind': 'fact', 'text': b, 'evidence': [selection(pb)]}],
            'comparisons': [{'text': 'Both archives retain everything cheaply.', 'claim_ids': ['C1']}],
            'recommendations': [], 'contradictions': [], 'unanswered': ['Cost is unmeasured.']}
        result = self.reconstruct(report, [pa, pb])
        self.assertEqual(set(result['claims']), {'C1', 'C2'})
        for name, text, passage in [('C1', a, pa), ('C2', b, pb)]:
            card = result['claims'][name]
            self.assertEqual(card['text'], text)
            self.assertEqual(card['selected_passages'], [passage])
            self.assertEqual(card['adjacent_offers'], [])
        self.assertNotIn('Both archives', json.dumps(result))
        self.assertEqual(result['omitted_claims'], 0)
        self.assertNotIn('verdict', result)

    def test_missing_selection_does_not_acquire_a_nearby_passage(self):
        text = 'A conditional proposal needs independent assessment.'
        p = offer('S001', 0, text, hashlib.sha256(text.encode()).hexdigest())
        missing = selection(p); missing['start'] = 1
        report = {'claims': [{'id': 'C1', 'kind': 'inference', 'text': text, 'evidence': [missing]}],
                  'comparisons': [], 'recommendations': [], 'contradictions': []}
        card = self.reconstruct(report, [p])['claims']['C1']
        self.assertEqual(card['selected_passages'], [])
        self.assertEqual(card['unavailable_selections'], 1)


if __name__ == '__main__':
    unittest.main()
