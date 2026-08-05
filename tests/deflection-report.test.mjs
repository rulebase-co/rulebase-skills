/**
 * Tests for the deflection classifier. The bucket logic is the whole product of
 * that skill, so it is tested against hand-computed expectations.
 *
 *   node --test "tests/*.test.mjs"
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../skills/cx-ops/cx-deflection-analysis/scripts/deflection-report.mjs',
);

function run(records, args = []) {
  const dir = mkdtempSync(join(tmpdir(), 'defl-'));
  const path = join(dir, 'contacts.jsonl');
  writeFileSync(path, records.map((r) => JSON.stringify(r)).join('\n') + '\n');

  return new Promise((resolvePromise) => {
    execFile(process.execPath, [SCRIPT, path, '--json', ...args], (err, stdout, stderr) => {
      resolvePromise({
        code: err?.code ?? 0,
        report: stdout.trim() ? JSON.parse(stdout) : null,
        stderr,
      });
    });
  });
}

const bot = (id, customer, extra = {}) => ({
  id,
  customer_id: customer,
  started_at: '2026-03-01T10:00:00Z',
  ended_at: '2026-03-01T10:05:00Z',
  handled_by: 'bot',
  channel: 'chat',
  handed_off: false,
  ...extra,
});

const human = (id, customer, startedAt, extra = {}) => ({
  id,
  customer_id: customer,
  started_at: startedAt,
  handled_by: 'human',
  channel: 'voice',
  ...extra,
});

test('classifies all four buckets and computes the overstatement', async () => {
  const { code, report } = await run([
    // handoff
    bot('b1', 'u1', { handed_off: true, intent: 'refund' }),
    human('h1', 'u1', '2026-03-01T10:03:00Z', { intent: 'refund' }),
    // leaked: returned on another channel two days later
    bot('b2', 'u2', { intent: 'refund', resolved: true }),
    human('h2', 'u2', '2026-03-03T09:00:00Z', { intent: 'refund' }),
    // contained
    bot('b3', 'u3', { intent: 'tracking', resolved: true }),
    // abandoned
    bot('b4', 'u4', { intent: 'tracking', resolved: false }),
  ]);

  assert.equal(code, 0);
  assert.deepEqual(report.summary.counts, {
    handoff: 1,
    leaked: 1,
    abandoned: 1,
    contained: 1,
    unknown: 0,
  });
  assert.equal(report.summary.naive_containment_rate, 0.75, '3 of 4 had no handoff');
  assert.equal(report.summary.true_containment_rate, 0.25, 'only 1 of 4 truly contained');
  assert.equal(report.summary.overstatement_pp, 50);
});

test('a resolved=true session that returns is leaked, not contained', async () => {
  const { report } = await run([
    bot('b1', 'u1', { resolved: true }),
    human('h1', 'u1', '2026-03-02T10:00:00Z'),
  ]);

  assert.equal(report.summary.counts.leaked, 1);
  assert.equal(report.summary.counts.contained, 0, 'a return overrides the resolution signal');
});

test('detects cross-channel leakage and reports the destination', async () => {
  const { report } = await run([
    bot('b1', 'u1', { resolved: true }),
    human('h1', 'u1', '2026-03-02T10:00:00Z', { channel: 'voice' }),
    bot('b2', 'u2', { resolved: true }),
    human('h2', 'u2', '2026-03-02T10:00:00Z', { channel: 'email' }),
  ]);

  assert.equal(report.summary.counts.leaked, 2);
  assert.deepEqual(report.leak_channels, { voice: 1, email: 1 });
});

test("does not count a handoff's own human contact as leakage", async () => {
  const { report } = await run([
    bot('b1', 'u1', { handed_off: true }),
    // Starts during the session, and also after it ends — neither may leak.
    human('h1', 'u1', '2026-03-01T10:03:00Z'),
    human('h2', 'u1', '2026-03-01T10:30:00Z'),
  ]);

  assert.equal(report.summary.counts.handoff, 1);
  assert.equal(report.summary.counts.leaked, 0, 'handoff is classified first and exclusively');
});

test('a human contact during the session is the same episode, not a return', async () => {
  const { report } = await run([
    bot('b1', 'u1', { resolved: true }),
    human('h1', 'u1', '2026-03-01T10:02:00Z'), // inside 10:00–10:05
  ]);

  assert.equal(report.summary.counts.contained, 1);
  assert.equal(report.summary.counts.leaked, 0);
});

test('the return window is respected', async () => {
  const inside = await run([
    bot('b1', 'u1', { resolved: true }),
    human('h1', 'u1', '2026-03-06T10:00:00Z'), // 5 days later
  ]);
  assert.equal(inside.report.summary.counts.leaked, 1);

  const outside = await run([
    bot('b1', 'u1', { resolved: true }),
    human('h1', 'u1', '2026-03-20T10:00:00Z'), // 19 days later
  ]);
  assert.equal(outside.report.summary.counts.leaked, 0);

  const widened = await run(
    [bot('b1', 'u1', { resolved: true }), human('h1', 'u1', '2026-03-20T10:00:00Z')],
    ['--window-days', '30'],
  );
  assert.equal(widened.report.summary.counts.leaked, 1, '--window-days widens detection');
});

test('--strict-intent produces the lower bound on leakage', async () => {
  const records = [
    bot('b1', 'u1', { intent: 'refund', resolved: true }),
    human('h1', 'u1', '2026-03-02T10:00:00Z', { intent: 'password_reset' }),
  ];

  const loose = await run(records);
  assert.equal(loose.report.summary.counts.leaked, 1, 'any contact counts by default');

  const strict = await run(records, ['--strict-intent']);
  assert.equal(strict.report.summary.counts.leaked, 0, 'mismatched intent is not leakage');
  assert.equal(strict.report.summary.counts.contained, 1);
  assert.ok(
    strict.report.caveats.some((c) => c.includes('lower bound')),
    'caveat explains the bound',
  );
});

test('missing resolved becomes unknown rather than a guess', async () => {
  const { report } = await run([
    bot('b1', 'u1'), // no resolved field
    bot('b2', 'u2'),
    human('h1', 'u9', '2026-03-02T10:00:00Z'), // unrelated customer
  ]);

  assert.equal(report.summary.counts.unknown, 2);
  assert.equal(report.summary.counts.contained, 0, 'absence of data is not success');
  assert.equal(report.summary.counts.abandoned, 0, 'nor is it failure');
  assert.equal(report.summary.true_containment_rate, 0);
  assert.ok(
    report.caveats.some((c) => c.includes('No `resolved` field')),
    'caveat names the missing field',
  );
  assert.ok(report.caveats.some((c) => c.includes('floor')), 'caveat states the result is a floor');
});

test('refuses to run without human contacts, which would just restate the naive rate', async () => {
  const { code, stderr } = await run([bot('b1', 'u1', { resolved: true })]);
  assert.equal(code, 1);
  assert.match(stderr, /no records with handled_by="human"/);
});

test('reports dropped rows instead of failing silently', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'defl-'));
  const path = join(dir, 'contacts.jsonl');
  writeFileSync(
    path,
    [
      JSON.stringify(bot('b1', 'u1', { resolved: true })),
      '{ not json',
      JSON.stringify({ id: 'b2', handled_by: 'bot' }), // missing required fields
      JSON.stringify({ ...bot('b3', 'u3'), started_at: 'never' }),
      JSON.stringify(human('h1', 'u9', '2026-03-02T10:00:00Z')),
    ].join('\n') + '\n',
  );

  const { code, report } = await new Promise((r) =>
    execFile(process.execPath, [SCRIPT, path, '--json'], (err, stdout) =>
      r({ code: err?.code ?? 0, report: JSON.parse(stdout) }),
    ),
  );

  assert.equal(code, 0);
  assert.deepEqual(report.input.dropped_rows, { badJson: 1, missingFields: 1, badDate: 1 });
  assert.ok(
    report.caveats.some((c) => c.includes('3 input rows were dropped')),
    'dropped rows surface in the caveats',
  );
});

test('suppresses per-intent rows below the sample floor', async () => {
  const records = [human('h0', 'u999', '2026-03-02T10:00:00Z')];
  for (let i = 0; i < 40; i++) records.push(bot(`big${i}`, `u${i}`, { intent: 'refund', resolved: true }));
  for (let i = 0; i < 5; i++) records.push(bot(`small${i}`, `v${i}`, { intent: 'rare', resolved: true }));

  const { report } = await run(records);

  const intents = report.by_intent.rows.map((r) => r.intent);
  assert.deepEqual(intents, ['refund'], 'the 5-session intent is withheld');
  assert.equal(report.by_intent.suppressed_sessions, 5);
});

test('always warns that containment is not a causal claim', async () => {
  const { report } = await run([
    bot('b1', 'u1', { resolved: true, intent: 'x' }),
    human('h1', 'u9', '2026-03-02T10:00:00Z', { intent: 'x' }),
  ]);

  assert.ok(
    report.caveats.some((c) => c.includes('randomised holdout')),
    'the causal caveat is unconditional',
  );
});
