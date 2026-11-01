import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

test('persistent research worker disables bytecode in the interpreter argv and environment',async()=>{
 const unit=await readFile(new URL('../.agents/skills/deep-research/deploy/deep-research.service.template',import.meta.url),'utf8');
 const lines=unit.split('\n');
 assert.deepEqual(lines.filter(line=>line.startsWith('ExecStart=')),[
  'ExecStart="__ROOT__/.venv/bin/python3" -B "__ROOT__/scripts/research_cli.py" --data-dir "__DATA__" worker --config "__CONFIG__" --watch'
 ]);
 assert.ok(lines.includes('Environment=PYTHONDONTWRITEBYTECODE=1'));
});
