/**
 * Tests for the complaint deadline clock.
 *
 * The business-day and month-clamping arithmetic is the load-bearing part: every
 * error in these lands in the optimistic direction, making a firm look compliant
 * when it is not. The tests also pin the two deliberately inconvenient defaults
 * (clock starts at receipt, pauses off) and the warnings that fire when they are
 * overridden.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runScript, tempOut } from './helpers/mock-api.mjs';

const SCRIPT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../skills/cx-ops/cx-complaints-sla/scripts/complaint-clock.mjs',
);

function files(complaints, config) {
  const dir = tempOut('clock-');
  const cp = join(dir, 'complaints.jsonl');
  const cf = join(dir, 'config.json');
  writeFileSync(cp, complaints.map((c) => JSON.stringify(c)).join('\n'));
  writeFileSync(cf, JSON.stringify(config));
  return { cp, cf };
}

const baseConfig = (over = {}) => ({
  timezone_offset_minutes: 0,
  working_days: [1, 2, 3, 4, 5],
  holidays: { default: [] },
  clock_start: 'received_at',
  count_from: 'next_working_day',
  allow_pauses: false,
  deadlines: [
    {
      name: 'acknowledgement',
      length: 5,
      unit: 'working_days',
      from: 'received_at',
      satisfied_by: 'acknowledged_at',
      source: 'placeholder policy reference',
      warn_at_days_remaining: 2,
    },
  ],
  ...over,
});

const run = (complaints, config, extra = []) => {
  const { cp, cf } = files(complaints, config);
  return runScript(SCRIPT, ['--input', cp, '--config', cf, ...extra], {});
};

test('counts working days from the next working day, skipping the weekend', async () => {
  // Received Wednesday 2026-07-01. Five working days from the next working day
  // (Thu 2) = Thu 2, Fri 3, Mon 6, Tue 7, Wed 8 -> due 2026-07-08.
  const res = await run(
    [{ id: 'C1', received_at: '2026-07-01T09:00:00Z', acknowledged_at: '2026-07-08T09:00:00Z' }],
    baseConfig(),
    ['--as-of', '2026-07-20'],
  );
  assert.equal(res.code, 0, res.stderr);
  assert.equal(res.summary.byDeadlineStatus.acknowledgement.met, 1);
});

test('one day later is a breach', async () => {
  const res = await run(
    [{ id: 'C1', received_at: '2026-07-01T09:00:00Z', acknowledged_at: '2026-07-09T09:00:00Z' }],
    baseConfig(),
    ['--as-of', '2026-07-20'],
  );
  assert.equal(res.code, 1, 'a breach must exit non-zero');
  assert.equal(res.summary.byDeadlineStatus.acknowledgement.breached, 1);
  assert.equal(res.summary.breached[0].id, 'C1');
});

test('count_from same_day shifts every deadline by one day', async () => {
  // Same receipt, same_day counting: Wed 1 counts as day one, so due 2026-07-07.
  const met = await run(
    [{ id: 'C1', received_at: '2026-07-01T09:00:00Z', acknowledged_at: '2026-07-07T09:00:00Z' }],
    baseConfig({ count_from: 'same_day' }),
    ['--as-of', '2026-07-20'],
  );
  assert.equal(met.summary.byDeadlineStatus.acknowledgement.met, 1);

  const breach = await run(
    [{ id: 'C1', received_at: '2026-07-01T09:00:00Z', acknowledged_at: '2026-07-08T09:00:00Z' }],
    baseConfig({ count_from: 'same_day' }),
    ['--as-of', '2026-07-20'],
  );
  assert.equal(breach.summary.byDeadlineStatus.acknowledgement.breached, 1);
});

test('holidays extend a working-day deadline, per market', async () => {
  const config = baseConfig({ holidays: { default: [], uk: ['2026-07-06', '2026-07-07'] } });

  const uk = await run(
    [{ id: 'C1', market: 'uk', received_at: '2026-07-01T09:00:00Z', acknowledged_at: '2026-07-10T09:00:00Z' }],
    config,
    ['--as-of', '2026-07-20'],
  );
  // Two holidays push the due date from Wed 8 to Fri 10.
  assert.equal(uk.summary.byDeadlineStatus.acknowledgement.met, 1);

  const other = await run(
    [{ id: 'C1', market: 'de', received_at: '2026-07-01T09:00:00Z', acknowledged_at: '2026-07-10T09:00:00Z' }],
    config,
    ['--as-of', '2026-07-20'],
  );
  // No holidays for this market: due Wed 8, so the 10th is late.
  assert.equal(other.summary.byDeadlineStatus.acknowledgement.breached, 1);
});

test('calendar_days ignores weekends and holidays', async () => {
  const config = baseConfig({
    holidays: { default: ['2026-07-06'] },
    deadlines: [
      { name: 'ack', length: 5, unit: 'calendar_days', from: 'received_at', satisfied_by: 'acknowledged_at', source: 'x' },
    ],
  });
  const res = await run(
    [{ id: 'C1', received_at: '2026-07-01T09:00:00Z', acknowledged_at: '2026-07-06T09:00:00Z' }],
    config,
    ['--as-of', '2026-07-20'],
  );
  assert.equal(res.summary.byDeadlineStatus.ack.met, 1);
});

test('weeks are calendar weeks even when working_days is set', async () => {
  const config = baseConfig({
    deadlines: [
      { name: 'final', length: 8, unit: 'weeks', from: 'received_at', satisfied_by: 'final_response_at', source: 'x' },
    ],
  });
  // 8 weeks from 2026-07-01 = 2026-08-26.
  const met = await run(
    [{ id: 'C1', received_at: '2026-07-01T09:00:00Z', final_response_at: '2026-08-26T09:00:00Z' }],
    config,
    ['--as-of', '2026-09-30'],
  );
  assert.equal(met.summary.byDeadlineStatus.final.met, 1);

  const late = await run(
    [{ id: 'C1', received_at: '2026-07-01T09:00:00Z', final_response_at: '2026-08-27T09:00:00Z' }],
    config,
    ['--as-of', '2026-09-30'],
  );
  assert.equal(late.summary.byDeadlineStatus.final.breached, 1);
});

test('months clamp to month end: one month from 31 January is 28 February', async () => {
  const config = baseConfig({
    deadlines: [
      { name: 'final', length: 1, unit: 'months', from: 'received_at', satisfied_by: 'final_response_at', source: 'x' },
    ],
  });
  // 2026 is not a leap year, so 31 Jan + 1 month clamps to 28 Feb.
  const met = await run(
    [{ id: 'C1', received_at: '2026-01-31T09:00:00Z', final_response_at: '2026-02-28T09:00:00Z' }],
    config,
    ['--as-of', '2026-04-01'],
  );
  assert.equal(met.summary.byDeadlineStatus.final.met, 1);

  const late = await run(
    [{ id: 'C1', received_at: '2026-01-31T09:00:00Z', final_response_at: '2026-03-01T09:00:00Z' }],
    config,
    ['--as-of', '2026-04-01'],
  );
  assert.equal(late.summary.byDeadlineStatus.final.breached, 1);
});

test('an unsatisfied deadline past its due date is a certain breach, reported separately', async () => {
  const res = await run(
    [{ id: 'C1', received_at: '2026-07-01T09:00:00Z' }],
    baseConfig(),
    ['--as-of', '2026-07-20'],
  );
  assert.equal(res.code, 1);
  assert.equal(res.summary.byDeadlineStatus.acknowledgement.breached_open, 1);
  assert.equal(res.summary.byDeadlineStatus.acknowledgement.breached, 0);
});

test('at-risk cases are bucketed and sorted soonest-first', async () => {
  const res = await run(
    [
      { id: 'C1', received_at: '2026-07-06T09:00:00Z', owner: 'a' },
      { id: 'C2', received_at: '2026-07-07T09:00:00Z', owner: null },
    ],
    baseConfig(),
    ['--as-of', '2026-07-10'],
  );
  // C1 due 2026-07-13, C2 due 2026-07-14; warn_at 2 working days.
  assert.ok(res.summary.atRisk.length >= 1);
  const remaining = res.summary.atRisk.map((a) => a.remaining_days);
  assert.deepEqual(remaining, [...remaining].sort((a, b) => a - b));
  assert.deepEqual(res.summary.unownedComplaints, ['C2']);
});

test('warns when the clock is started at identification rather than receipt', async () => {
  const res = await run(
    [{ id: 'C1', received_at: '2026-07-01T09:00:00Z', identified_at: '2026-07-09T09:00:00Z', acknowledged_at: '2026-07-14T09:00:00Z' }],
    baseConfig({ clock_start: 'identified_at' }),
    ['--as-of', '2026-07-30'],
  );
  assert.ok(res.summary.warnings.some((w) => /clock starts when the complaint reaches the firm/.test(w)));
  assert.match(res.stderr, /WARNING/);
});

test('reports identification lag, which is where hidden breaches concentrate', async () => {
  const res = await run(
    [
      { id: 'C1', received_at: '2026-07-01T09:00:00Z', identified_at: '2026-07-09T09:00:00Z', acknowledged_at: '2026-07-08T09:00:00Z' },
      { id: 'C2', received_at: '2026-07-01T09:00:00Z', identified_at: '2026-07-02T09:00:00Z', acknowledged_at: '2026-07-08T09:00:00Z' },
    ],
    baseConfig(),
    ['--as-of', '2026-07-30'],
  );
  assert.equal(res.summary.identificationLag.n, 2);
  assert.equal(res.summary.identificationLag.max, 6, 'Wed 1 Jul to Thu 9 Jul is 6 working days');
});

test('pauses are ignored by default and warned about when enabled', async () => {
  const complaint = {
    id: 'C1',
    received_at: '2026-07-01T09:00:00Z',
    pauses: [{ from: '2026-07-02T09:00:00Z', to: '2026-07-07T09:00:00Z' }],
    acknowledged_at: '2026-07-10T09:00:00Z',
  };

  const off = await run([complaint], baseConfig(), ['--as-of', '2026-07-30']);
  assert.equal(off.summary.byDeadlineStatus.acknowledgement.breached, 1, 'pauses must not extend the deadline by default');

  const on = await run([complaint], baseConfig({ allow_pauses: true }), ['--as-of', '2026-07-30']);
  assert.equal(on.summary.byDeadlineStatus.acknowledgement.met, 1);
  assert.ok(on.summary.warnings.some((w) => /do not permit the clock to stop/.test(w)));
});

test('flags complaints closed with no final response recorded', async () => {
  const config = baseConfig({
    deadlines: [
      { name: 'final_response', length: 8, unit: 'weeks', from: 'received_at', satisfied_by: 'final_response_at', source: 'x' },
    ],
  });
  const res = await run(
    [{ id: 'C1', received_at: '2026-07-01T09:00:00Z', closed_at: '2026-07-20T09:00:00Z' }],
    config,
    ['--as-of', '2026-07-25'],
  );
  assert.deepEqual(res.summary.closedWithoutFinalResponse, ['C1']);
  assert.equal(res.code, 1);
  assert.match(res.stderr, /look like successes in a status report/);
});

test('warns when a deadline has no source recorded', async () => {
  const config = baseConfig({
    deadlines: [{ name: 'ack', length: 5, unit: 'working_days', from: 'received_at', satisfied_by: 'acknowledged_at' }],
  });
  const res = await run([{ id: 'C1', received_at: '2026-07-01T09:00:00Z', acknowledged_at: '2026-07-08T09:00:00Z' }], config, ['--as-of', '2026-07-20']);
  assert.ok(res.summary.warnings.some((w) => /has no `source`/.test(w)));
});

test('echoes the configured deadlines and their sources into the output', async () => {
  const res = await run(
    [{ id: 'C1', received_at: '2026-07-01T09:00:00Z', acknowledged_at: '2026-07-08T09:00:00Z' }],
    baseConfig(),
    ['--as-of', '2026-07-20'],
  );
  assert.equal(res.summary.config.deadlines[0].source, 'placeholder policy reference');
  assert.equal(res.summary.config.clock_start, 'received_at');
});

test('rejects duplicate complaint ids rather than understating ageing', async () => {
  const res = await run(
    [
      { id: 'C1', received_at: '2026-07-01T09:00:00Z' },
      { id: 'C1', received_at: '2026-07-05T09:00:00Z' },
    ],
    baseConfig(),
  );
  assert.equal(res.code, 2);
  assert.match(res.stderr, /One record per complaint/);
});

test('rejects an unknown unit rather than guessing', async () => {
  const res = await run(
    [{ id: 'C1', received_at: '2026-07-01T09:00:00Z' }],
    baseConfig({ deadlines: [{ name: 'x', length: 3, unit: 'fortnights', from: 'received_at', satisfied_by: 'acknowledged_at' }] }),
  );
  assert.equal(res.code, 2);
  assert.match(res.stderr, /unit must be one of/);
});

test('refuses a config with no deadlines', async () => {
  const res = await run([{ id: 'C1', received_at: '2026-07-01T09:00:00Z' }], baseConfig({ deadlines: [] }));
  assert.equal(res.code, 2);
  assert.match(res.stderr, /no deadlines/);
});

test('states that reportability is not its determination', async () => {
  const res = await run(
    [{ id: 'C1', received_at: '2026-07-01T09:00:00Z', acknowledged_at: '2026-07-08T09:00:00Z' }],
    baseConfig(),
    ['--as-of', '2026-07-20'],
  );
  assert.ok(res.summary.notes.some((n) => /compliance and legal determination/.test(n)));
  assert.ok(res.summary.notes.some((n) => /Absolute counts matter more than rates/.test(n)));
});
