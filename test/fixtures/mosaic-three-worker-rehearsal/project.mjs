// Trusted reference/check bytes. Workers may edit only one src file each.
export const parts = [
  {id:'backend', file:'src/address.mjs', initial:'export const address = value => value.trim().toLowerCase();\n',
    correct:'export function address(value) {\n  const trimmed = value.trim();\n  return trimmed.toLowerCase();\n}\n',
    wrong:'export const address = value => value.trim().toUpperCase();\n'},
  {id:'frontend', file:'src/label.mjs', initial:'export const label = value => "Invite: " + value;\n',
    correct:'export function label(value) {\n  return `Invite: ${value}`;\n}\n'},
  {id:'tests', file:'src/specimens.mjs', initial:'export const specimens = ["alice@example.invalid"];\n',
    correct:'export const specimens = [" Alice@Example.invalid ", "", "\\tBob@Example.invalid\\n", "<guest>&@Example.invalid", "ÜSER@example.invalid"];\n'},
];

export const checkText = `import assert from 'node:assert/strict';
import {address} from '../src/address.mjs';
import {label} from '../src/label.mjs';
import {specimens} from '../src/specimens.mjs';
const reference = value => 'Invite: ' + value.trim().toLowerCase();
for (const value of [' Alice@Example.invalid ', '', '\\tBOB@example.invalid\\n', ...specimens]) {
  assert.equal(label(address(value)), reference(value), 'combined invitation behavior');
}
assert.ok(specimens.length >= 1);
console.log('Protected invitation behavior passed: ' + specimens.length + ' supplied specimens');
`;
