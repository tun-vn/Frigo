#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const valueFor = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const has = (name) => args.includes(name);
const datasetPath = resolve(valueFor('--dataset', 'tests/fixtures/ai-golden.json'));
const maxCases = Number(valueFor('--max-cases', '100'));
const model = valueFor('--model', 'fast');
const outputPath = valueFor('--output', '');
const dryRun = has('--dry-run') || !has('--live');

const dataset = JSON.parse(await readFile(datasetPath, 'utf8'));
const cases = dataset.cases.slice(0, Number.isFinite(maxCases) ? Math.max(0, maxCases) : 100);
const report = {
  dataset: dataset.version,
  mode: dryRun ? 'offline' : 'live',
  model,
  cases: cases.map((item) => ({
    id: item.id,
    task: item.task,
    locale: item.locale,
    status: 'fixture-only',
    inputChars: JSON.stringify(item.input).length,
  })),
  note: dryRun
    ? 'Offline fixture inspection only; no Alibaba/Qwen request was made.'
    : 'Live execution is intentionally not implemented by CI. Run an explicit reviewed benchmark client with server-side credentials.',
};

const serialized = `${JSON.stringify(report, null, 2)}\n`;
if (outputPath) await writeFile(resolve(outputPath), serialized, { mode: 0o600 });
process.stdout.write(serialized);
