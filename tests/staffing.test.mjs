/**
 * Tests for the staffing calculator. The Erlang functions are checked against
 * independently computed reference values, and the surrounding behaviour is
 * checked for the things that make staffing plans wrong in practice: shrinkage,
 * occupancy, and unstable queues.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runScript } from './helpers/mock-api.mjs';

const SCRIPT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../skills/cx-ops/cx-volume-forecasting/scripts/staffing.mjs',
);

const { erlangB, erlangC, serviceLevel, averageSpeedOfAnswer } = await import(SCRIPT);

const close = (actual, expected, tolerance, message) =>
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${message}: expected ~${expected}, got ${actual}`,
  );

// --- Erlang maths against independently computed reference values ---

test('erlangB matches known values', () => {
  // B(1, 1) = 1/(1+1) = 0.5 exactly.
  close(erlangB(1, 1), 0.5, 1e-12, 'B(1,1)');
  // B(2, 1) = A*B1/(2 + A*B1) = 0.5/2.5 = 0.2 exactly.
  close(erlangB(2, 1), 0.2, 1e-12, 'B(2,1)');
  assert.equal(erlangB(0, 41.67), 1, 'zero agents blocks everything');
});

test('erlangB stays finite at contact-centre scale', () => {
  // The factorial form overflows here; the recurrence must not.
  const b = erlangB(500, 450);
  assert.ok(Number.isFinite(b), 'B(500, 450) is finite');
  assert.ok(b > 0 && b < 1, `B is a probability, got ${b}`);
});

test('erlangC and service level match the reference table', () => {
  const load = (250 / 1800) * 300; // 41.667 erlangs
  close(load, 41.6667, 1e-3, 'offered load');

  const expected = [
    [43, 0.2923, 0.7735],
    [44, 0.4599, 0.6310],
    [45, 0.5919, 0.5096],
    [46, 0.6949, 0.4073],
    [47, 0.7743, 0.3221],
    [48, 0.8349, 0.2518],
    [49, 0.8807, 0.1946],
  ];

  for (const [agents, sl, pw] of expected) {
    close(serviceLevel(agents, load, 300, 20), sl, 5e-4, `SL at N=${agents}`);
    close(erlangC(agents, load), pw, 5e-4, `P(wait) at N=${agents}`);
  }
});

test('an unstable queue reports no service level', () => {
  const load = 41.667;
  assert.equal(erlangC(41, load), 1, 'N below load: everyone waits');
  assert.equal(serviceLevel(41, load, 300, 20), 0, 'no service level is achievable');
  assert.equal(averageSpeedOfAnswer(41, load, 300), Infinity, 'waits grow without bound');
});

test('service level rises monotonically with agents', () => {
  const load = 41.667;
  let previous = -1;
  for (let n = 42; n <= 70; n++) {
    const sl = serviceLevel(n, load, 300, 20);
    assert.ok(sl >= previous, `SL should not decrease at N=${n}`);
    previous = sl;
  }
  close(previous, 1, 0.01, 'SL approaches 1 with ample staffing');
});

// --- CLI behaviour ---

test('solves for the target service level and applies shrinkage', async () => {
  const { code, summary } = await runScript(
    SCRIPT,
    ['--mode', 'voice', '--contacts', '250', '--aht', '300', '--json'],
    {},
  );

  assert.equal(code, 0);
  assert.equal(summary.result.productive_agents_required, 48);
  assert.ok(summary.result.service_level >= 0.8, 'meets the 80% target');
  // 48 / 0.7 = 68.57 -> 69
  assert.equal(summary.result.rostered_agents_required, 69);
  assert.equal(summary.result.shrinkage_uplift_agents, 21);
  close(summary.offered_load_erlangs, 41.667, 0.01, 'offered load');
});

test('shrinkage materially changes the rostered answer', async () => {
  const base = ['--mode', 'voice', '--contacts', '250', '--aht', '300', '--json'];

  const none = await runScript(SCRIPT, [...base, '--shrinkage', '0'], {});
  const typical = await runScript(SCRIPT, [...base, '--shrinkage', '0.35'], {});

  assert.equal(none.summary.result.rostered_agents_required, 48, 'no shrinkage: rostered = productive');
  assert.equal(typical.summary.result.rostered_agents_required, 74, '35% shrinkage: 48 / 0.65');
  assert.ok(
    typical.summary.assumptions.every((a) => !a.includes('is low')),
    '35% is not flagged as low',
  );
});

test('warns when shrinkage is implausibly low', async () => {
  const { summary } = await runScript(
    SCRIPT,
    ['--mode', 'voice', '--contacts', '250', '--aht', '300', '--shrinkage', '0.1', '--json'],
    {},
  );
  assert.ok(
    summary.assumptions.some((a) => a.includes('is low') && a.includes('30-35%')),
    'names the realistic range',
  );
});

test('flags the occupancy ceiling even when the service level is met', async () => {
  const { summary } = await runScript(
    SCRIPT,
    ['--mode', 'voice', '--contacts', '250', '--aht', '300', '--json'],
    {},
  );

  assert.ok(summary.result.occupancy > 0.85);
  assert.ok(
    summary.assumptions.some((a) => a.includes('Occupancy is') && a.includes('infeasible')),
    'says the plan is infeasible rather than efficient',
  );
});

test('always reports the abandonment and Poisson caveats', async () => {
  const { summary } = await runScript(
    SCRIPT,
    ['--mode', 'voice', '--contacts', '100', '--aht', '300', '--json'],
    {},
  );
  const text = summary.assumptions.join(' ');
  assert.match(text, /no abandonment/);
  assert.match(text, /over-states/, 'states the direction of the error');
  assert.match(text, /Poisson/);
});

test('--agents evaluates a given headcount instead of solving', async () => {
  const { summary } = await runScript(
    SCRIPT,
    ['--mode', 'voice', '--contacts', '250', '--aht', '300', '--agents', '46', '--json'],
    {},
  );

  assert.equal(summary.result.agents, 46);
  assert.equal(summary.result.solved_for, 'given agent count');
  close(summary.result.service_level, 0.6949, 5e-4, 'SL at 46 agents');
  assert.ok(summary.result.service_level < 0.8, 'honestly reports missing the target');
});

test('an unstable staffing level is called out explicitly', async () => {
  const { code, summary } = await runScript(
    SCRIPT,
    ['--mode', 'voice', '--contacts', '250', '--aht', '300', '--agents', '40', '--json'],
    {},
  );

  assert.equal(code, 0);
  assert.match(summary.warning, /unstable/);
  assert.match(summary.warning, /grow without bound/);
  assert.equal(summary.result.service_level, 0);
});

test('the sensitivity table shows the marginal value of an agent', async () => {
  const { summary } = await runScript(
    SCRIPT,
    ['--mode', 'voice', '--contacts', '250', '--aht', '300', '--json'],
    {},
  );

  const rows = summary.sensitivity;
  assert.ok(rows.length >= 5);
  const byAgents = Object.fromEntries(rows.map((r) => [r.agents, r]));
  const gain47to48 = byAgents[48].service_level - byAgents[47].service_level;
  const gain50to51 = byAgents[51].service_level - byAgents[50].service_level;
  assert.ok(
    gain47to48 > gain50to51,
    'marginal value of an agent decreases as staffing rises',
  );
});

test('chat mode divides load by concurrency and says it is an approximation', async () => {
  const single = await runScript(
    SCRIPT,
    ['--mode', 'chat', '--contacts', '400', '--aht', '600', '--concurrency', '1', '--json'],
    {},
  );
  const triple = await runScript(
    SCRIPT,
    ['--mode', 'chat', '--contacts', '400', '--aht', '600', '--concurrency', '3', '--json'],
    {},
  );

  close(triple.summary.offered_load_erlangs, single.summary.offered_load_erlangs / 3, 0.01,
    'load divided by concurrency');
  assert.ok(
    triple.summary.result.productive_agents_required < single.summary.result.productive_agents_required,
  );
  assert.ok(
    triple.summary.assumptions.some((a) => a.includes('non-linear') && a.includes('approximation')),
    'warns that AHT rises with concurrency',
  );
});

test('async mode uses throughput rather than a service level', async () => {
  const { code, summary } = await runScript(
    SCRIPT,
    [
      '--mode', 'async',
      '--contacts', '5000',
      '--aht', '480',
      '--interval', '1440',
      '--backlog-hours', '24',
      '--json',
    ],
    {},
  );

  assert.equal(code, 0);
  assert.equal(summary.result, undefined, 'no Erlang service level in async mode');
  assert.ok(summary.async.productive_agents_required > 0);
  assert.ok(
    summary.async.rostered_agents_required > summary.async.productive_agents_required,
    'shrinkage still applies',
  );
  assert.match(summary.async.note, /grows without bound/);
  assert.ok(
    summary.assumptions.some((a) => a.includes("Little's Law")),
    'names the model it used',
  );
});

test('async mode requires a turnaround promise', async () => {
  const { code, stderr } = await runScript(
    SCRIPT,
    ['--mode', 'async', '--contacts', '5000', '--aht', '480', '--json'],
    {},
  );
  assert.equal(code, 1);
  assert.match(stderr, /--backlog-hours is required/);
});

test('warns that Erlang is unreliable at very low volume', async () => {
  const { summary } = await runScript(
    SCRIPT,
    ['--mode', 'voice', '--contacts', '2', '--aht', '300', '--json'],
    {},
  );
  assert.ok(
    summary.assumptions.some((a) => a.includes('coverage')),
    'says staffing is coverage-driven at this scale',
  );
});

test('rejects nonsense inputs rather than returning a confident number', async () => {
  const cases = [
    [['--mode', 'sideways', '--contacts', '10', '--aht', '10'], /--mode must be one of/],
    [['--mode', 'voice', '--aht', '300'], /--contacts is required/],
    [['--mode', 'voice', '--contacts', '10'], /--aht is required/],
    [['--mode', 'voice', '--contacts', '10', '--aht', '300', '--service-level', '80'], /--service-level must be between 0 and 1/],
    [['--mode', 'voice', '--contacts', '10', '--aht', '300', '--shrinkage', '1'], /--shrinkage must be between 0 and 1/],
    [['--mode', 'voice', '--contacts', '-5', '--aht', '300'], /--contacts is required and must be a positive/],
  ];

  for (const [args, pattern] of cases) {
    const { code, stderr } = await runScript(SCRIPT, [...args, '--json'], {});
    assert.equal(code, 1, `should reject: ${args.join(' ')}`);
    assert.match(stderr, pattern);
  }
});
