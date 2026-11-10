import { execFileSync } from 'node:child_process';
import { copyFile, mkdir } from 'node:fs/promises';

const modules = ['csv.mjs', 'export.mjs'];
for (const file of modules) execFileSync(process.execPath, ['--check', `src/${file}`], { stdio: 'inherit' });
await mkdir('dist', { recursive: true });
for (const file of ['index.html', ...modules]) await copyFile(`src/${file}`, `dist/${file}`);
console.log('Build passed');
