import assert from 'node:assert/strict';
import { encodeCsv } from '../src/csv.mjs';

assert.equal(encodeCsv([['North, West', 'A "quoted" value'], ['Line\nbreak', '12.50']]),
  '"North, West","A ""quoted"" value"\r\n"Line\nbreak",12.50\r\n');
console.log('CSV encoding unit assertions passed');
