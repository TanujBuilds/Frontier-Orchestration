import {keys, text} from '../contracts.mjs';

const fields = {question:2000, scope:2000, outputShape:1000, asOf:10};

export function validateMissionBrief(raw) {
  keys(raw, Object.keys(fields), 'mission brief');
  const brief = Object.fromEntries(Object.entries(fields).map(([key, limit]) => [
    key, text(raw[key], 'mission brief ' + key, limit).trim(),
  ]));
  const {asOf} = brief;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf) || asOf.startsWith('0000')) {
    throw Error('Mission brief asOf must be a YYYY-MM-DD date');
  }
  const date = new Date(asOf);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== asOf) {
    throw Error('Mission brief asOf must be a valid calendar date');
  }
  return brief;
}
