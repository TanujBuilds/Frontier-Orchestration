"""Offline response fixtures for the existing DeepSeek HTTP adapter."""
import copy
import sys
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / '.agents/skills/deep-research/scripts'))
from research_providers import DeepSeek


class ProviderTests(unittest.TestCase):
    def complete(self, content, finish_reason='stop'):
        response = {'id':'fixture-response', 'created':1, 'model':'fixture-model',
                    'choices':[{'index':0, 'finish_reason':finish_reason,
                                'message':{'role':'assistant', 'content':content,
                                           'reasoning_content':'fixture evidence'}}],
                    'usage':{'completion_tokens':8192, 'total_tokens':8200}}
        model = DeepSeek('http://fixture.invalid/v1', 'fixture-model')
        model.verified = True
        calls = []
        def request(method, path, payload, timeout):
            calls.append((method, path, payload))
            return copy.deepcopy(response)
        model.request = request
        result = model.complete([{'role':'user','content':'fixture'}], 2)
        return result, response, calls

    def test_request_disables_thinking_without_changing_runtime(self):
        result, response, calls = self.complete('{"action":"search","query":"sqlite"}')
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0][0:2], ('POST','/chat/completions'))
        self.assertEqual(calls[0][2]['chat_template_kwargs'], {'enable_thinking':False})
        self.assertEqual(result['content'], response['choices'][0]['message']['content'])

    def test_blank_answer_preserves_metadata_and_explicit_failure(self):
        for content in ('', '  ', None):
            with self.subTest(content=content):
                result, response, calls = self.complete(content, 'length')
                self.assertEqual(result['content'], content)
                self.assertEqual(result['usage'], response['usage'])
                self.assertEqual(result['finish_reason'], 'length')
                self.assertEqual(result['raw_response'], response)
                self.assertEqual(result['error']['code'], 'empty_content')
                self.assertEqual(len(calls), 1)

    def test_truncated_answer_retains_content_and_rejects_even_valid_json(self):
        result, response, calls = self.complete('{"action":"search","query":"sqlite"}', 'length')
        self.assertEqual(result['raw_response'], response)
        self.assertEqual(result['finish_reason'], 'length')
        self.assertEqual(result['error']['code'], 'truncated_content')
        self.assertEqual(len(calls), 1)

if __name__ == '__main__': unittest.main()
