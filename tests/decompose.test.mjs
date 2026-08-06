/**
 * Tests for the metric movement decomposition.
 *
 * The load-bearing tests are `rate and mix sum exactly to the aggregate change`
 * and the Simpson's paradox case: if the arithmetic doesn't close, every driver
 * narrative built on it is wrong, and the paradox case is the whole reason the
 * skill exists.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runScript, tempOut } from './helpers/mock-api.mjs';

const SCRIPT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../skills/cx-ops/cx-metric-movement-decomposition/scripts/decompose.mjs',
);

function inputFile(data, name = 'segments.json') {
  const dir = tempOut('decompose-');
  const path = join(dir, name);
  writeFileSync(path, typeof data === 'string' ? data : JSON.stringify(data));
  return path;
}

const close = (a, b, tol = 1e-9) => Math.abs(a - b) < tol;

// The worked example from references/input-format.md. Every segment improves by
// half a point; the aggregate falls 2.54 points because voice triples its share.
const SIMPSONS = [
  { segment: 'email', n0: 1500, r0: 0.91, n1: 1300, r1: 0.915 },
  { segment: 'chat', n0: 800, r0: 0.88, n1: 900, r1: 0.885 },
  { segment: 'voice', n0: 200, r0: 0.72, n1: 700, r1: 0.725 },
];

test('rate and mix sum exactly to the aggregate change', async () => {
  const res = await runScript(SCRIPT, ['--input', inputFile(SIMPSONS)], {});
  assert.equal(res.code, 0);

  const { effects, aggregate } = res.summary;
  assert.ok(
    close(effects.rate + effects.mix, aggregate.delta),
    `rate ${effects.rate} + mix ${effects.mix} != delta ${aggregate.delta}`,
  );
  assert.ok(close(effects.unreconciled, 0), 'no residual expected when segments span both periods');
});

test("reproduces the documented Simpson's paradox example", async () => {
  const res = await runScript(SCRIPT, ['--input', inputFile(SIMPSONS)], {});
  const { aggregate, effects, segments } = res.summary;

  assert.ok(close(aggregate.r0, 2213 / 2500, 1e-12));
  assert.ok(close(aggregate.r1, 2493.5 / 2900, 1e-12));

  // Every segment improved...
  assert.ok(segments.every((s) => s.rateChange > 0), 'all segment rates should rise');
  // ...yet the aggregate fell.
  assert.ok(aggregate.delta < 0, 'aggregate should fall');

  // A uniform +0.005 everywhere makes the rate effect exactly +0.005, because
  // the average weights sum to 1.
  assert.ok(close(effects.rate, 0.005, 1e-12), `expected rate effect 0.005, got ${effects.rate}`);
  assert.ok(close(effects.mix, aggregate.delta - 0.005, 1e-12));
  assert.ok(effects.mix < effects.rate, 'mix should dominate in this example');
});

test('flags a movement inside the noise interval and says not to explain it', async () => {
  // Small n, tiny movement: the classic "why did our score drop two points".
  const res = await runScript(
    SCRIPT,
    ['--input', inputFile([{ segment: 'all', n0: 40, k0: 36, n1: 40, k1: 35 }])],
    {},
  );

  assert.equal(res.summary.noise.withinNoise, true);
  assert.match(res.stderr, /not distinguishable from sampling error/);
  assert.match(res.stderr, /Do not explain it/);
});

test('does not flag a large movement on large n as noise', async () => {
  const res = await runScript(
    SCRIPT,
    ['--input', inputFile([{ segment: 'all', n0: 5000, k0: 4500, n1: 5000, k1: 4000 }])],
    {},
  );

  assert.equal(res.summary.noise.withinNoise, false);
  assert.match(res.stderr, /treat as real/);
});

test('prefers counts over rates and derives r from k/n', async () => {
  const res = await runScript(
    SCRIPT,
    ['--input', inputFile([{ segment: 'a', n0: 200, k0: 180, r0: 0.5, n1: 200, k1: 190, r1: 0.5 }])],
    {},
  );
  // The supplied (wrong) r values must be ignored in favour of k/n.
  assert.ok(close(res.summary.aggregate.r0, 0.9));
  assert.ok(close(res.summary.aggregate.r1, 0.95));
});

test('reports entrants and exits separately instead of dropping them', async () => {
  const res = await runScript(
    SCRIPT,
    [
      '--input',
      inputFile([
        { segment: 'core', n0: 1000, r0: 0.9, n1: 1000, r1: 0.9 },
        { segment: 'new-hires', n1: 200, r1: 0.6 },
        { segment: 'closed-site', n0: 300, r0: 0.95 },
      ]),
    ],
    {},
  );

  assert.equal(res.summary.entrants.length, 1);
  assert.equal(res.summary.entrants[0].segment, 'new-hires');
  assert.equal(res.summary.exits.length, 1);
  assert.equal(res.summary.exits[0].segment, 'closed-site');
  assert.match(res.stderr, /1 entrant\(s\), 1 exit\(s\)/);
});

test('rejects percentages in rate mode rather than silently misreading them', async () => {
  const res = await runScript(
    SCRIPT,
    ['--input', inputFile([{ segment: 'a', n0: 10, r0: 91, n1: 10, r1: 90 }])],
    {},
  );
  assert.equal(res.code, 2);
  assert.match(res.stderr, /expects proportions, not percentages/);
});

test('mean mode accepts values above 1 and uses sd for the interval', async () => {
  const res = await runScript(
    SCRIPT,
    [
      '--input',
      inputFile([
        { segment: 'a', n0: 500, r0: 88.0, sd0: 12, n1: 500, r1: 84.0, sd1: 12 },
      ]),
      '--metric',
      'mean',
    ],
    {},
  );

  assert.equal(res.code, 0);
  assert.ok(close(res.summary.aggregate.delta, -4, 1e-9));
  assert.equal(res.summary.noise.withinNoise, false);
});

test('mean mode without sd says the noise check could not run', async () => {
  const res = await runScript(
    SCRIPT,
    ['--input', inputFile([{ segment: 'a', n0: 50, r0: 88, n1: 50, r1: 84 }]), '--metric', 'mean'],
    {},
  );
  assert.equal(res.summary.noise.withinNoise, null);
  assert.match(res.stderr, /not run/);
});

test('ranks by contribution, not by segment rate', async () => {
  // `tiny` is by far the worst performer and got worse, but it is 1% of volume.
  // `big` moved slightly and is 99%. Contribution must rank big first.
  const res = await runScript(
    SCRIPT,
    [
      '--input',
      inputFile([
        { segment: 'big', n0: 9900, r0: 0.9, n1: 9900, r1: 0.87 },
        { segment: 'tiny', n0: 100, r0: 0.5, n1: 100, r1: 0.3 },
      ]),
    ],
    {},
  );

  const lines = res.stderr.split('\n');
  const start = lines.findIndex((l) => l.includes('top contributors'));
  assert.ok(lines[start + 1].includes('big'), 'largest contributor should rank first');
});

test('accepts csv input with the same column names', async () => {
  const csv = 'segment,n0,r0,n1,r1\nemail,1500,0.910,1300,0.915\nvoice,200,0.720,700,0.725\n';
  const res = await runScript(SCRIPT, ['--input', inputFile(csv, 'segments.csv')], {});
  assert.equal(res.code, 0);
  assert.equal(res.summary.segments.length, 2);
});

test('refuses input with no overlapping segment', async () => {
  const res = await runScript(
    SCRIPT,
    ['--input', inputFile([{ segment: 'a', n0: 10, r0: 0.5 }, { segment: 'b', n1: 10, r1: 0.5 }])],
    {},
  );
  assert.equal(res.code, 2);
  assert.match(res.stderr, /nothing to decompose/);
});

test('rejects duplicate segment labels', async () => {
  const res = await runScript(
    SCRIPT,
    [
      '--input',
      inputFile([
        { segment: 'a', n0: 10, r0: 0.5, n1: 10, r1: 0.5 },
        { segment: 'a', n0: 10, r0: 0.5, n1: 10, r1: 0.5 },
      ]),
    ],
    {},
  );
  assert.equal(res.code, 2);
  assert.match(res.stderr, /duplicate segment label/);
});

test('states that it cannot see a coverage change', async () => {
  const res = await runScript(SCRIPT, ['--input', inputFile(SIMPSONS)], {});
  assert.ok(
    res.summary.notes.some((n) => /coverage change/i.test(n)),
    'output must warn that a sampling shift is invisible to this method',
  );
});
