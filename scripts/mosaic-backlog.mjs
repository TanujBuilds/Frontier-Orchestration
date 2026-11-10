#!/usr/bin/env node
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { main as harnessCli } from '../src/harness/cli.mjs';
import { isEntry } from '../src/harness/entry.mjs';
import { backlogDemo } from '../src/harness/backlog/demo.mjs';

const usage = `Mosaic approved backlog

preview --input FILE [--root STATE_DIR]
submit --input FILE --idempotency-key KEY [--root STATE_DIR]
inspect --goal ID [--group ID] [--limit N] [--cursor CURSOR] [--root STATE_DIR]
demo --output OWNED_TEMP_DIR

Use the running local coordinator's operator connection for preview, submit and inspect.
`;

const optionsByCommand = {
  preview: { allowed: ['input', 'root'], required: ['input'] },
  submit: { allowed: ['input', 'idempotency-key', 'root'], required: ['input', 'idempotency-key'] },
  inspect: { allowed: ['goal', 'group', 'limit', 'cursor', 'root'], required: ['goal'] },
  demo: { allowed: ['output'], required: ['output'] },
};

async function readInput(file) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    if (!(await handle.stat()).isFile()) throw Error('Backlog input must be a regular JSON file');
    const bytes = Buffer.alloc(1024 * 1024);
    let size = 0;
    while (size < bytes.length) {
      const { bytesRead } = await handle.read(bytes, size, bytes.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size === bytes.length) throw Error('Backlog input must be smaller than 1 MiB');
    const input = JSON.parse(bytes.subarray(0, size).toString('utf8'));
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('Backlog input must be a JSON object');
    if (Object.hasOwn(input, 'idempotencyKey')) throw Error('Supply the idempotency key using --idempotency-key');
    return input;
  } finally {
    await handle.close();
  }
}

async function main([command, ...args]) {
  if (!command || command === '--help' || (args.length === 1 && args[0] === '--help')) {
    process.stdout.write(usage);
    return;
  }
  if (!Object.hasOwn(optionsByCommand, command)) throw Error('Use preview, submit, inspect or demo');
  const { allowed, required } = optionsByCommand[command];
  const { values, tokens } = parseArgs({
    args, options: Object.fromEntries(allowed.map(name => [name, { type: 'string' }])), tokens: true,
  });
  if (tokens.length !== Object.keys(values).length) throw Error('Duplicate command option');
  for (const name of required) if (!values[name]) throw Error('Provide --' + name);

  if (command === 'demo') {
    process.stdout.write(JSON.stringify(await backlogDemo(values.output), null, 2) + '\n');
    return;
  }

  let input;
  if (command === 'inspect') {
    if (values.limit !== undefined && !/^[0-9]+$/.test(values.limit)) throw Error('Invalid --limit');
    input = {
      goalId: values.goal,
      ...(values.group === undefined ? {} : { groupId: values.group }),
      ...(values.limit === undefined ? {} : { limit: Number(values.limit) }),
      ...(values.cursor === undefined ? {} : { cursor: values.cursor }),
    };
  } else {
    input = await readInput(values.input);
    if (command === 'submit') input.idempotencyKey = values['idempotency-key'];
  }
  // Delegate to the established authenticated loopback client. No coordinator is
  // opened by the normal CLI path and no service is started on connection failure.
  const root = values.root === undefined ? [] : ['--root', path.resolve(values.root)];
  await harnessCli(['call', ...root, '--tool', 'backlog_' + command, '--input-json', JSON.stringify(input)]);
}

if (isEntry(import.meta.url)) main(process.argv.slice(2)).catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
