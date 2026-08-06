/**
 * Tests for the response-bias diagnostic. The key properties: it must detect
 * injected bias, stay quiet on a genuinely random sample, and refuse to run on
 * respondents alone — which is the mistake it exists to prevent.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runScript, tempOut } from './helpers/mock-api.mjs';

const SCRIPT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../skills/cx-operations/cx-survey-design/scripts/response-bias.mjs',
);

function fixture(records) {
  const dir = tempOut('bias-');
  const path = join(dir, 'contacts.jsonl');
  writeFileSync(path, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return path;
}

const run = (path, args = []) => runScript(SCRIPT, [path, '--json', ...args], {});

/**
 * Fixtures are constructed rather than randomised. Response status is `i % 4`
 * and covariates key off `floor(i / 4)`, so the two are exactly independent by
 * construction — no PRNG, and no chance of a flaky balance test.
 */
test('detects an imbalanced numeric covariate', async () => {
  const records = [];
  for (let i = 0; i < 400; i++) {
    // Respondents systematically have longer handle times, with spread inside
    // each group so the pooled standard deviation is non-zero.
    const responded = i % 4 === 0;
    records.push({
      id: `c${i}`,
      responded,
      handle_time_seconds: (responded ? 500 : 250) + (Math.floor(i / 4) % 5) * 15,
    });
  }

  const { code, summary } = await run(fixture(records));

  assert.equal(code, 0);
  const covariate = summary.covariates.find((c) => c.covariate === 'handle_time_seconds');
  assert.equal(covariate.kind, 'numeric');
  assert.ok(covariate.imbalanced, 'a 250s mean difference must be flagged');
  assert.ok(Math.abs(covariate.smd) > 1, `expected a large SMD, got ${covariate.smd}`);
  assert.ok(covariate.respondent_mean > covariate.non_respondent_mean);
  assert.equal(summary.representative, false);
});

test('stays quiet on a representative sample', async () => {
  const records = [];
  for (let i = 0; i < 600; i++) {
    // `i % 4` decides response; covariates depend only on `floor(i / 4)`, so both
    // groups get identical covariate distributions.
    const bucket = Math.floor(i / 4);
    records.push({
      id: `c${i}`,
      responded: i % 4 === 0,
      handle_time_seconds: 200 + (bucket % 5) * 60,
      channel: bucket % 2 === 0 ? 'email' : 'chat',
    });
  }

  const { code, summary } = await run(fixture(records));

  assert.equal(code, 0);
  assert.equal(summary.representative, true, 'no imbalance on independent covariates');
  assert.ok(
    summary.findings.some((f) => f.includes('not proof of representativeness')),
    'still warns that balance is not proof',
  );
});

test('detects categorical imbalance and reports response rate per level', async () => {
  const records = [];
  // Email responds far more often than chat.
  for (let i = 0; i < 200; i++) records.push({ id: `e${i}`, responded: i < 100, channel: 'email' });
  for (let i = 0; i < 200; i++) records.push({ id: `c${i}`, responded: i < 20, channel: 'chat' });

  const { summary } = await run(fixture(records));

  const channel = summary.covariates.find((c) => c.covariate === 'channel');
  assert.equal(channel.kind, 'categorical');
  assert.ok(channel.imbalanced);

  const email = channel.levels.find((l) => l.level === 'email');
  const chat = channel.levels.find((l) => l.level === 'chat');
  assert.equal(email.response_rate, 0.5);
  assert.equal(chat.response_rate, 0.1);
  assert.ok(email.reliable && chat.reliable);
});

test('flags a low response rate as the dominant uncertainty', async () => {
  const records = Array.from({ length: 500 }, (_, i) => ({
    id: `c${i}`,
    responded: i < 40, // 8%
    channel: 'email',
  }));

  const { summary } = await run(fixture(records));

  assert.equal(summary.response_rate, 0.08);
  assert.ok(
    summary.findings.some(
      (f) => f.includes('self-selected minority') && f.includes('larger sample will not reduce it'),
    ),
    'explains that sample size does not fix non-response bias',
  );
});

test('detects a bimodal score distribution', async () => {
  const records = [];
  for (let i = 0; i < 300; i++) {
    const responded = i < 120;
    const record = { id: `c${i}`, responded, channel: 'email' };
    // Respondents are almost all 1s and 5s.
    if (responded) record.score = i % 10 === 0 ? 3 : i % 2 === 0 ? 1 : 5;
    records.push(record);
  }

  const { summary } = await run(fixture(records));

  assert.ok(summary.score.extreme_share > 0.7);
  assert.ok(
    summary.findings.some((f) => f.includes('bimodality') && f.includes('top-box')),
    'recommends the distribution over the mean',
  );
  assert.equal(summary.score.mean > 1 && summary.score.mean < 5, true);
});

test('refuses to run on respondents alone', async () => {
  const records = Array.from({ length: 50 }, (_, i) => ({ id: `c${i}`, responded: true, score: 5 }));
  const { code, stderr } = await run(fixture(records));

  assert.equal(code, 1);
  assert.match(stderr, /every record is a respondent/);
  assert.match(stderr, /non-respondents are the comparison group/, 'explains what is needed');
});

test('requires a response flag', async () => {
  const records = [{ id: 'c1', channel: 'email' }];
  const { code, stderr } = await run(fixture(records));
  assert.equal(code, 1);
  assert.match(stderr, /needs a response flag/);
});

test('accepts alternative response-flag field names', async () => {
  for (const key of ['responded', 'survey_responded', 'has_response', 'answered']) {
    const records = Array.from({ length: 100 }, (_, i) => ({
      id: `c${i}`,
      [key]: i < 25,
      channel: 'email',
    }));
    const { code, summary } = await run(fixture(records));
    assert.equal(code, 0, `should accept ${key}`);
    assert.equal(summary.response_flag_field, key);
    assert.equal(summary.response_rate, 0.25);
  }
});

test('treats truthy string flags as responses', async () => {
  const records = Array.from({ length: 100 }, (_, i) => ({
    id: `c${i}`,
    responded: i < 30 ? 'true' : 'false',
    channel: 'email',
  }));
  const { summary } = await run(fixture(records));
  assert.equal(summary.response_rate, 0.3);
});

test('--covariates restricts the tested fields', async () => {
  const records = Array.from({ length: 200 }, (_, i) => ({
    id: `c${i}`,
    responded: i < 50,
    channel: 'email',
    handle_time_seconds: 300,
    agent_id: `a${i % 5}`,
  }));

  const { summary } = await run(fixture(records), ['--covariates', 'channel']);
  assert.deepEqual(summary.covariates.map((c) => c.covariate), ['channel']);
});

test('marks small levels as unreliable rather than reporting them as findings', async () => {
  const records = [];
  for (let i = 0; i < 200; i++) records.push({ id: `e${i}`, responded: i < 50, channel: 'email' });
  // A tiny channel with a wildly different rate must not drive the verdict.
  for (let i = 0; i < 4; i++) records.push({ id: `s${i}`, responded: true, channel: 'carrier_pigeon' });

  const { summary } = await run(fixture(records));
  const channel = summary.covariates.find((c) => c.covariate === 'channel');
  const pigeon = channel.levels.find((l) => l.level === 'carrier_pigeon');

  assert.equal(pigeon.reliable, false, 'n=4 is not reliable');
  assert.ok(
    !channel.levels.filter((l) => l.reliable).some((l) => Math.abs(l.difference) > 0.1),
    'the verdict ignores the tiny level',
  );
});

test('reports unparseable rows instead of silently dropping them', async () => {
  const dir = tempOut('bias-');
  const path = join(dir, 'contacts.jsonl');
  writeFileSync(
    path,
    [
      ...Array.from({ length: 60 }, (_, i) =>
        JSON.stringify({ id: `c${i}`, responded: i < 15, channel: 'email' }),
      ),
      '{ not json',
    ].join('\n') + '\n',
  );

  const { code, summary } = await run(path);
  assert.equal(code, 0);
  assert.equal(summary.counts.dropped_rows.badJson, 1);
});

test('always warns that covariate balance cannot rule out sentiment bias', async () => {
  const records = Array.from({ length: 200 }, (_, i) => ({
    id: `c${i}`,
    responded: i % 4 === 0,
    channel: 'email',
  }));
  const { summary } = await run(fixture(records));
  assert.ok(
    summary.findings.some((f) => f.includes('unobservable by construction')),
    'the irreducible caveat is unconditional',
  );
});
