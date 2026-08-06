/**
 * Tests for the SLA threshold simulation.
 *
 * The censoring tests are the reason this script exists. Dropping open
 * conversations biases attainment upward — being slow is why they are still
 * open — so `counts an open conversation past the threshold as a certain breach`
 * and `bounds only the genuinely unknown conversations` are the load-bearing
 * cases.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runScript, tempOut } from './helpers/mock-api.mjs';

const SCRIPT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../skills/cx-operations/cx-sla-threshold-simulation/scripts/simulate-sla.mjs',
);

function inputFile(records, name = 'clocks.jsonl') {
  const dir = tempOut('sla-');
  const path = join(dir, name);
  const body =
    typeof records === 'string'
      ? records
      : name.endsWith('.json')
        ? JSON.stringify(records)
        : records.map((r) => JSON.stringify(r)).join('\n');
  writeFileSync(path, body);
  return path;
}

const clock = (id, elapsed, resolved, extra = {}) => ({ id, elapsed_minutes: elapsed, resolved, ...extra });
const close = (a, b, tol = 1e-9) => Math.abs(a - b) < tol;
const at = (summary, T) => summary.thresholds.find((r) => r.thresholdMinutes === T);

test('classifies resolved conversations either side of the threshold', async () => {
  const res = await runScript(
    SCRIPT,
    ['--input', inputFile([clock('a', 50, true), clock('b', 200, true)]), '--thresholds', '120'],
    {},
  );

  assert.equal(res.code, 0);
  const r = at(res.summary, 120);
  assert.equal(r.met, 1);
  assert.equal(r.breach, 1);
  assert.equal(r.unknown, 0);
  assert.ok(close(r.attainmentDecided, 0.5));
});

test('counts an open conversation past the threshold as a certain breach', async () => {
  // The row everyone misses. This ticket is unresolved, but it has already run
  // past 120 minutes, so its verdict is known without waiting for it to close.
  const res = await runScript(
    SCRIPT,
    ['--input', inputFile([clock('slow-open', 500, false)]), '--thresholds', '120'],
    {},
  );

  const r = at(res.summary, 120);
  assert.equal(r.breach, 1);
  assert.equal(r.unknown, 0);
  assert.ok(close(r.attainmentDecided, 0), 'a certain breach must count against attainment');
});

test('bounds only the genuinely unknown conversations', async () => {
  // One met, one still open and still inside the threshold.
  const res = await runScript(
    SCRIPT,
    ['--input', inputFile([clock('met', 30, true), clock('young-open', 45, false)]), '--thresholds', '120'],
    {},
  );

  const r = at(res.summary, 120);
  assert.equal(r.met, 1);
  assert.equal(r.unknown, 1);
  assert.equal(r.decided, 1);
  assert.ok(close(r.attainmentLower, 0.5), 'pessimistic: the unknown breaches');
  assert.ok(close(r.attainmentUpper, 1.0), 'optimistic: the unknown makes it');
  assert.ok(close(r.attainmentDecided, 1.0), 'among decided, the one decided case was met');
});

test('warns when the bounds are wide because too much is undecided', async () => {
  const records = Array.from({ length: 20 }, (_, i) => clock(`o${i}`, 10, false));
  records.push(clock('r1', 10, true));

  const res = await runScript(SCRIPT, ['--input', inputFile(records), '--thresholds', '120'], {});

  assert.match(res.stderr, /WARNING/);
  assert.match(res.stderr, /old enough that nearly everything has resolved/);
});

test('does not warn when almost everything is decided', async () => {
  const records = Array.from({ length: 200 }, (_, i) => clock(`r${i}`, i < 180 ? 30 : 300, true));
  const res = await runScript(SCRIPT, ['--input', inputFile(records), '--thresholds', '120'], {});
  assert.ok(!/WARNING/.test(res.stderr));
});

test('attainment is monotonically non-decreasing as the threshold relaxes', async () => {
  const records = [10, 40, 90, 130, 200, 400, 900].map((m, i) => clock(`r${i}`, m, true));
  const res = await runScript(SCRIPT, ['--input', inputFile(records), '--sweep', '30:960:30'], {});

  const series = res.summary.thresholds.map((r) => r.attainmentDecided);
  for (let i = 1; i < series.length; i++) {
    assert.ok(series[i] >= series[i - 1], `attainment fell from ${series[i - 1]} to ${series[i]}`);
  }
});

test('percentiles use resolved conversations only', async () => {
  // The open conversation has the largest elapsed value. If it leaked into the
  // percentiles it would inflate p95 — but an open clock is only a lower bound.
  const records = [clock('a', 10, true), clock('b', 20, true), clock('c', 30, true), clock('d', 10000, false)];
  const res = await runScript(SCRIPT, ['--input', inputFile(records), '--thresholds', '60'], {});

  assert.equal(res.summary.distribution.resolvedOnly.n, 3);
  assert.ok(res.summary.distribution.resolvedOnly.p95 <= 30, 'open clock must not enter the percentiles');
  assert.equal(res.summary.distribution.censored, 1);
});

test('refuses a record without an explicit resolved flag', async () => {
  const res = await runScript(
    SCRIPT,
    ['--input', inputFile([{ id: 'x', elapsed_minutes: 50 }]), '--thresholds', '120'],
    {},
  );

  assert.equal(res.code, 2);
  assert.match(res.stderr, /must be true or false/);
  assert.match(res.stderr, /silently drop censored/);
});

test('segments independently with --by', async () => {
  const records = [
    clock('p1a', 50, true, { priority: 'P1' }),
    clock('p1b', 500, true, { priority: 'P1' }),
    clock('p2a', 50, true, { priority: 'P2' }),
    clock('p2b', 50, true, { priority: 'P2' }),
  ];
  const res = await runScript(SCRIPT, ['--input', inputFile(records), '--thresholds', '120', '--by', 'priority'], {});

  assert.equal(res.summary.segmentedBy, 'priority');
  const p1 = res.summary.segments.find((s) => s.segment === 'P1');
  const p2 = res.summary.segments.find((s) => s.segment === 'P2');
  assert.ok(close(p1.thresholds[0].attainmentDecided, 0.5));
  assert.ok(close(p2.thresholds[0].attainmentDecided, 1.0));
});

test('--unit hours scales the thresholds', async () => {
  const res = await runScript(
    SCRIPT,
    ['--input', inputFile([clock('a', 90, true)]), '--thresholds', '2', '--unit', 'hours'],
    {},
  );
  // 2 hours = 120 minutes, so a 90-minute clock is met.
  assert.equal(at(res.summary, 120).met, 1);
});

test('--target reports how many tickets must be faster', async () => {
  const records = Array.from({ length: 10 }, (_, i) => clock(`r${i}`, i < 6 ? 30 : 300, true));
  const res = await runScript(
    SCRIPT,
    ['--input', inputFile(records), '--thresholds', '120', '--target', '0.9'],
    {},
  );

  const r = at(res.summary, 120);
  assert.equal(r.met, 6);
  // ceil(0.9 * 10) - 6 = 3
  assert.equal(r.toReachTarget.additionalWithinThreshold, 3);
});

test('lists breaching ids so the marginal tickets can be inspected', async () => {
  const res = await runScript(
    SCRIPT,
    ['--input', inputFile([clock('good', 10, true), clock('bad', 900, true)]), '--thresholds', '120'],
    {},
  );
  const r = at(res.summary, 120);
  assert.deepEqual(r.marginalBreaches.map((m) => m.id), ['bad']);
});

test('caps the marginal list and reports how many were truncated', async () => {
  const records = Array.from({ length: 30 }, (_, i) => clock(`b${i}`, 900, true));
  const res = await runScript(
    SCRIPT,
    ['--input', inputFile(records), '--thresholds', '120', '--max-marginal', '5'],
    {},
  );
  const r = at(res.summary, 120);
  assert.equal(r.marginalBreaches.length, 5);
  assert.equal(r.marginalTruncated, 25);
});

test('accepts a JSON array as well as JSONL', async () => {
  const res = await runScript(
    SCRIPT,
    ['--input', inputFile([clock('a', 10, true), clock('b', 900, true)], 'clocks.json'), '--thresholds', '120'],
    {},
  );
  assert.equal(res.code, 0);
  assert.equal(at(res.summary, 120).n, 2);
});

test('states that it does not model behaviour change', async () => {
  const res = await runScript(SCRIPT, ['--input', inputFile([clock('a', 10, true)]), '--thresholds', '120'], {});
  assert.ok(
    res.summary.notes.some((n) => /changes behaviour/i.test(n)),
    'output must state that a real target changes behaviour',
  );
});

test('requires a threshold specification', async () => {
  const res = await runScript(SCRIPT, ['--input', inputFile([clock('a', 10, true)])], {});
  assert.equal(res.code, 2);
  assert.match(res.stderr, /--thresholds|--sweep/);
});
