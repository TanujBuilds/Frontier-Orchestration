"""Opt-in research review data. Hashes prove binding, never semantic truth."""
import copy
import hashlib
import json
import re


def encoded(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False, allow_nan=False)


def digest(value):
    return hashlib.sha256(encoded(value).encode()).hexdigest()


def closed(value, fields):
    if not isinstance(value, dict) or set(value) != set(fields):
        raise ValueError('invalid closed review fields')


def normalize_review_policy(policy):
    closed(policy, ('version', 'finish', 'discovery', 'review'))
    if type(policy['version']) is not int or policy['version'] != 3 or policy['finish'] != 'selectors_only' or policy['discovery'] != 'search_required':
        raise ValueError('unsupported reviewed research policy')
    r = policy['review']
    closed(r, ('version', 'role', 'maxRounds', 'maxRevisions', 'maxCorrectionModelCalls', 'rubricSha256'))
    for field, expected in [('version', 1), ('maxRounds', 2), ('maxRevisions', 1), ('maxCorrectionModelCalls', 2)]:
        if type(r[field]) is not int or r[field] != expected:
            raise ValueError('unsupported review limits')
    if r['role'] != 'independent_operator' or not isinstance(r['rubricSha256'], str) or not re.fullmatch('[a-f0-9]{64}', r['rubricSha256']):
        raise ValueError('invalid reviewer role or rubric hash')
    return copy.deepcopy(policy)


def policy_parameters(policy):
    version = policy.get('version') if isinstance(policy, dict) else None
    if version == 3:
        normalize_review_policy(policy)
    return {'strict': policy is not None, 'support': version in (2, 3),
            'catalog_version': 2 if version in (2, 3) else 1, 'requires_review': version == 3}
