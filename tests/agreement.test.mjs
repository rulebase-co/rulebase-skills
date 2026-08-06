/**
 * Tests for grader agreement.
 *
 * The load-bearing test is `reproduces the kappa paradox`: it pins the documented
 * worked example where the same data gives kappa = -0.05 and AC1 = 0.89. That
 * divergence is the entire reason this script reports both, so if the arithmetic
 * drifts the skill's central claim is wrong.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runScript, tempOut } from './helpers/mock-api.mjs';

const SCRIPT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../skills/quality-assurance/cx-calibration-agreement/scripts/agreement.mjs',
);

function inputFile(records, name = 'verdicts.jsonl') {
  const dir = tempOut('agreement-');
  const path = join(dir, name);
  writeFileSync(path, records.map((r) => JSON.stringify(r)).join('\n'));
  return path;
}

const v = (a, b, extra = {}) => ({ id: `${Math.random()}`, rater_a: a, rater_b: b, ...extra });
const rep = (n, rec) => Array.from({ length: n }, () => ({ ...rec, id: `${Math.random()}` }));
const close = (x, y, tol = 0.005) => Math.abs(x - y) < tol;

test('reproduces the kappa paradox from the reference doc', async () => {
  // Construct exactly p_o = 0.90 with both graders passing 95%.
  //   900 both pass, 50 both fail, 25 A-only pass, 25 B-only pass
  //   -> p_o = 950/1000 ... adjust: we need agreement 0.90 => 100 disagreements.
  //   880 pass/pass, 20 fail/fail, 50 pass/fail, 50 fail/pass
  //   A passes 880+50 = 930... we want 950. Use:
  //   900 pass/pass, 0 fail/fail, 50 pass/fail, 50 fail/pass:
  //     agreement = 900/1000 = 0.90  ✓
  //     A passes = 950/1000 = 0.95   ✓
  //     B passes = 950/1000 = 0.95   ✓
  const records = [
    ...rep(900, v('pass', 'pass')),
    ...rep(50, v('pass', 'fail')),
    ...rep(50, v('fail', 'pass')),
  ];

  const res = await runScript(SCRIPT, ['--input', inputFile(records), '--bootstrap', '0'], {});
  assert.equal(res.code, 0);

  const o = res.summary.overall;
  assert.ok(close(o.observedAgreement, 0.9), `p_o ${o.observedAgreement}`);
  // p_e(kappa) = 0.95^2 + 0.05^2 = 0.905 -> kappa = (0.90-0.905)/0.095 = -0.0526
  assert.ok(close(o.cohenKappa, -0.0526), `kappa ${o.cohenKappa}`);
  // p_e(AC1) = 2*0.95*0.05 = 0.095 -> AC1 = (0.90-0.095)/0.905 = 0.8895
  assert.ok(close(o.gwetAC1, 0.8895), `AC1 ${o.gwetAC1}`);

  assert.equal(o.diagnosis.verdict, 'kappa-paradox');
  assert.match(res.stderr, /kappa-paradox/);
});

test('detects bias when one grader is systematically harsher', async () => {
  // High agreement overall, but every disagreement runs the same direction.
  const records = [
    ...rep(600, v('met', 'met', { criterion: 'tone' })),
    ...rep(200, v('not_met', 'not_met', { criterion: 'tone' })),
    ...rep(140, v('met', 'not_met', { criterion: 'tone' })),
    ...rep(4, v('not_met', 'met', { criterion: 'tone' })),
  ];

  const res = await runScript(
    SCRIPT,
    ['--input', inputFile(records), '--ordinal', 'not_met,met', '--bootstrap', '0'],
    {},
  );

  const asym = res.summary.overall.asymmetry;
  assert.ok(asym.disagreements > 100);
  assert.ok(asym.pValue < 0.001, `expected a significant asymmetry, got p=${asym.pValue}`);
  assert.ok(['bias', 'bias-and-noise'].includes(res.summary.overall.diagnosis.verdict));
  assert.match(res.summary.overall.diagnosis.reading, /threshold is harsher/);
});

test('calls symmetric low agreement noise, not bias', async () => {
  // Disagreements split evenly in both directions: ambiguity, not severity.
  const records = [
    ...rep(300, v('met', 'met')),
    ...rep(200, v('not_met', 'not_met')),
    ...rep(250, v('met', 'not_met')),
    ...rep(250, v('not_met', 'met')),
  ];

  const res = await runScript(
    SCRIPT,
    ['--input', inputFile(records), '--ordinal', 'not_met,met', '--bootstrap', '0'],
    {},
  );

  assert.equal(res.summary.overall.diagnosis.verdict, 'noise');
  assert.match(res.summary.overall.diagnosis.reading, /specification bug/);
  assert.ok(res.summary.overall.asymmetry.pValue > 0.05);
});

test('perfect agreement gives coefficients of 1', async () => {
  const records = [...rep(50, v('met', 'met')), ...rep(50, v('not_met', 'not_met'))];
  const res = await runScript(SCRIPT, ['--input', inputFile(records), '--bootstrap', '0'], {});

  assert.ok(close(res.summary.overall.observedAgreement, 1));
  assert.ok(close(res.summary.overall.cohenKappa, 1));
  assert.ok(close(res.summary.overall.gwetAC1, 1));
  assert.equal(res.summary.overall.diagnosis.verdict, 'agreement-ok');
});

test('ordinal weighting counts an adjacent disagreement as partial credit', async () => {
  const records = [...rep(50, v('met', 'partial')), ...rep(50, v('met', 'met'))];

  const unweighted = await runScript(
    SCRIPT,
    ['--input', inputFile(records), '--ordinal', 'not_met,partial,met', '--weights', 'none', '--bootstrap', '0'],
    {},
  );
  const weighted = await runScript(
    SCRIPT,
    ['--input', inputFile(records), '--ordinal', 'not_met,partial,met', '--weights', 'linear', '--bootstrap', '0'],
    {},
  );

  assert.ok(close(unweighted.summary.overall.observedAgreement, 0.5));
  // linear weight for one step on a 3-point scale = 1 - 1/2 = 0.5
  assert.ok(close(weighted.summary.overall.observedAgreement, 0.75));
});

test('reports which grader was harsher on an ordinal scale', async () => {
  const records = [...rep(10, v('partial', 'met')), ...rep(2, v('met', 'partial'))];
  const res = await runScript(
    SCRIPT,
    [
      '--input',
      inputFile(records),
      '--ordinal',
      'not_met,partial,met',
      '--label-a',
      'AI',
      '--label-b',
      'human',
      '--bootstrap',
      '0',
    ],
    {},
  );

  const asym = res.summary.overall.asymmetry;
  assert.equal(asym.AI_harsher, 10);
  assert.equal(asym.human_harsher, 2);
});

test('flags differential reliability across segments as a fairness finding', async () => {
  const records = [
    // email: near-perfect agreement
    ...rep(100, v('met', 'met', { channel: 'email' })),
    ...rep(40, v('not_met', 'not_met', { channel: 'email' })),
    // voice: coin-flip agreement
    ...rep(35, v('met', 'met', { channel: 'voice' })),
    ...rep(35, v('not_met', 'not_met', { channel: 'voice' })),
    ...rep(35, v('met', 'not_met', { channel: 'voice' })),
    ...rep(35, v('not_met', 'met', { channel: 'voice' })),
  ];

  const res = await runScript(
    SCRIPT,
    ['--input', inputFile(records), '--by', 'channel', '--ordinal', 'not_met,met', '--bootstrap', '0'],
    {},
  );

  assert.equal(res.summary.differentialReliability.material, true);
  assert.equal(res.summary.differentialReliability.weakest, 'voice');
  assert.match(res.stderr, /FAIRNESS/);
  assert.match(res.stderr, /not comparable across them/);
});

test('sorts criteria worst-first and suppresses thin cells', async () => {
  const records = [
    ...rep(60, v('met', 'met', { criterion: 'easy' })),
    ...rep(30, v('met', 'not_met', { criterion: 'hard' })),
    ...rep(30, v('not_met', 'met', { criterion: 'hard' })),
    ...rep(5, v('met', 'met', { criterion: 'thin' })),
  ];

  const res = await runScript(SCRIPT, ['--input', inputFile(records), '--bootstrap', '0'], {});

  const names = res.summary.byCriterion.map((c) => c.criterion);
  assert.equal(names[0], 'hard', 'worst criterion should sort first');
  const thin = res.summary.byCriterion.find((c) => c.criterion === 'thin');
  assert.equal(thin.suppressed, true);
});

test('excludes and counts records with a missing verdict rather than imputing', async () => {
  const records = [...rep(30, v('met', 'met')), { id: 'x', rater_a: 'met' }, { id: 'y', rater_b: 'met' }];
  const res = await runScript(SCRIPT, ['--input', inputFile(records), '--bootstrap', '0'], {});

  assert.equal(res.summary.itemCount, 30);
  assert.equal(res.summary.excludedForMissingVerdict, 2);
});

test('rejects a verdict missing from the declared ordinal scale', async () => {
  const res = await runScript(
    SCRIPT,
    ['--input', inputFile([v('met', 'surprise')]), '--ordinal', 'not_met,met'],
    {},
  );
  assert.equal(res.code, 2);
  assert.match(res.stderr, /not in --ordinal/);
});

test('bootstrap intervals are reproducible under a fixed seed', async () => {
  const records = [...rep(40, v('met', 'met')), ...rep(20, v('met', 'not_met')), ...rep(20, v('not_met', 'not_met'))];
  const path = inputFile(records);

  const a = await runScript(SCRIPT, ['--input', path, '--bootstrap', '300', '--seed', '7'], {});
  const b = await runScript(SCRIPT, ['--input', path, '--bootstrap', '300', '--seed', '7'], {});

  assert.deepEqual(a.summary.overall.ci95, b.summary.overall.ci95);
  assert.ok(a.summary.overall.ci95.gwetAC1.low !== null, 'expected an interval');
});

test('refuses --weights without an ordinal scale', async () => {
  const res = await runScript(SCRIPT, ['--input', inputFile([v('met', 'met')]), '--weights', 'linear'], {});
  assert.equal(res.code, 2);
  assert.match(res.stderr, /requires --ordinal/);
});

test('states that agreement says nothing about who is right', async () => {
  const res = await runScript(SCRIPT, ['--input', inputFile(rep(30, v('met', 'met'))), '--bootstrap', '0'], {});
  assert.ok(res.summary.notes.some((n) => /which grader is correct/i.test(n)));
});
