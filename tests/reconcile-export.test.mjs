/**
 * Tests for export reconciliation.
 *
 * The load-bearing case is `a clean export with no source count is unverified,
 * not reconciled` — the whole point of the script is that internal consistency
 * is not completeness, and a pass on the inferred checks is compatible with
 * missing a third of the account behind a permission scope.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runScript, tempOut } from './helpers/mock-api.mjs';

const SCRIPT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../skills/data-and-integration/cx-export-reconciliation/scripts/reconcile-export.mjs',
);

const conv = (id, day, over = {}) => ({
  source: 'zendesk',
  source_id: String(id),
  status: 'closed',
  channel: 'email',
  customer_id: `c${id}`,
  subject: `Subject ${id}`,
  created_at: `${day}T10:00:00Z`,
  ...over,
});

const msg = (id, convId, over = {}) => ({
  source: 'zendesk',
  conversation_source_id: String(convId),
  source_id: String(id),
  created_at: '2026-07-01T10:05:00Z',
  author_type: 'customer',
  visibility: 'public',
  body: 'text',
  ...over,
});

function exportDir(conversations, messages, expected) {
  const dir = tempOut('recon-');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'conversations.jsonl'), conversations.map((c) => JSON.stringify(c)).join('\n'));
  if (messages !== null) {
    writeFileSync(join(dir, 'messages.jsonl'), messages.map((m) => JSON.stringify(m)).join('\n'));
  }
  let expectedPath = null;
  if (expected) {
    expectedPath = join(dir, 'expected.json');
    writeFileSync(expectedPath, JSON.stringify(expected));
  }
  return { dir, expectedPath };
}

const run = (conversations, messages, expected, extra = []) => {
  const { dir, expectedPath } = exportDir(conversations, messages, expected);
  const args = ['--dir', dir, ...(expectedPath ? ['--expected', expectedPath] : []), ...extra];
  return runScript(SCRIPT, args, {});
};

/** Every weekday in July 2026 gets one conversation. */
function fullMonth(startId = 1) {
  const out = [];
  let id = startId;
  for (let d = 1; d <= 31; d++) {
    const day = `2026-07-${String(d).padStart(2, '0')}`;
    const dow = new Date(`${day}T00:00:00Z`).getUTCDay();
    if (dow === 0 || dow === 6) continue;
    out.push(conv(id++, day));
  }
  return out;
}

const check = (res, name) => res.summary.checks.find((c) => c.check === name);
const WINDOW = { from: '2026-07-01', to: '2026-07-31' };

test('a clean export with no source count is unverified, not reconciled', async () => {
  const convs = fullMonth();
  const res = await run(convs, convs.map((c, i) => msg(i + 1, c.source_id)), { window: WINDOW });

  assert.equal(res.code, 0);
  assert.equal(res.summary.verdict, 'unverified');
  assert.equal(check(res, 'total_conversations').status, 'skip');
  assert.match(res.stderr, /completeness is unknown/);
});

test('reconciles when the source count matches', async () => {
  const convs = fullMonth();
  const res = await run(convs, convs.map((c, i) => msg(i + 1, c.source_id)), {
    window: WINDOW,
    total_conversations: convs.length,
    source_count_method: 'Zendesk Explore, all statuses',
  });

  assert.equal(res.summary.verdict, 'reconciled');
  assert.equal(check(res, 'total_conversations').status, 'pass');
  assert.equal(res.summary.sourceCountMethod, 'Zendesk Explore, all statuses');
});

test('fails when the export is short of the source count', async () => {
  const convs = fullMonth();
  const res = await run(convs, convs.map((c, i) => msg(i + 1, c.source_id)), {
    window: WINDOW,
    total_conversations: convs.length + 400,
  });

  assert.equal(res.code, 1);
  assert.equal(res.summary.verdict, 'not_reconciled');
  assert.equal(check(res, 'total_conversations').difference, -400);
});

test('--tolerance allows a stated relative difference', async () => {
  const convs = fullMonth();
  // One short of source: a relative difference of 1/(n+1).
  const source = convs.length + 1;
  const relative = 1 / source;
  assert.ok(relative > 0.02 && relative < 0.08, `fixture should sit between the two tolerances, got ${relative}`);

  const strict = await run(convs, null, { window: WINDOW, total_conversations: source, expect_messages: false });
  assert.equal(strict.summary.verdict, 'not_reconciled');

  const lenient = await run(
    convs,
    null,
    { window: WINDOW, total_conversations: source, expect_messages: false },
    ['--tolerance', '0.08'],
  );
  assert.equal(lenient.summary.verdict, 'reconciled');
});

test('catches a per-segment shortfall, which is how a permission scope shows up', async () => {
  const convs = [...fullMonth(), conv(900, '2026-07-15', { channel: 'chat' })];
  const res = await run(convs, null, {
    window: WINDOW,
    expect_messages: false,
    total_conversations: convs.length,
    by_segment: { field: 'channel', counts: { email: convs.length - 1, chat: 500 } },
  });

  assert.equal(res.summary.verdict, 'not_reconciled');
  const seg = check(res, 'by_segment');
  assert.equal(seg.status, 'fail');
  assert.deepEqual(seg.gaps.map((g) => g.segment), ['chat']);
  assert.equal(seg.gaps[0].difference, 1 - 500);
  assert.match(res.stderr, /permission scope is the usual cause/);
});

test('finds days in the window with no conversations at all', async () => {
  // Drop 2026-07-15 (a Wednesday) from an otherwise complete month.
  const convs = fullMonth().filter((c) => !c.created_at.startsWith('2026-07-15'));
  const res = await run(convs, null, { window: WINDOW, expect_messages: false });

  const cov = check(res, 'daily_coverage');
  assert.equal(cov.status, 'fail');
  assert.ok(cov.zeroDays.includes('2026-07-15'));
  // Weekends must not be reported as gaps.
  assert.ok(!cov.zeroDays.includes('2026-07-04'), 'Saturday should not be a gap');
  assert.match(res.stderr, /re-run these days/);
});

test('does not report a declared holiday as a gap', async () => {
  const convs = fullMonth().filter((c) => !c.created_at.startsWith('2026-07-15'));
  const res = await run(convs, null, { window: WINDOW, expect_messages: false, holidays: ['2026-07-15'] });

  const cov = check(res, 'daily_coverage');
  assert.deepEqual(cov.zeroDays, []);
  assert.equal(cov.status, 'pass');
});

test('detects duplicate source_ids', async () => {
  const convs = fullMonth();
  convs.push({ ...convs[0] });
  const res = await run(convs, null, { window: WINDOW, expect_messages: false });

  assert.equal(res.summary.verdict, 'not_reconciled');
  const dup = check(res, 'duplicates');
  assert.equal(dup.count, 1);
  assert.match(dup.detail, /upsert key/);
});

test('flags records outside the requested window', async () => {
  const convs = [...fullMonth(), conv(999, '2026-06-15')];
  const res = await run(convs, null, { window: WINDOW, expect_messages: false });

  const w = check(res, 'window');
  assert.equal(w.status, 'fail');
  assert.equal(w.count, 1);
  assert.match(w.detail, /window filter may not have applied/);
});

test('detects orphaned messages', async () => {
  const convs = fullMonth();
  const msgs = [msg(1, convs[0].source_id), msg(2, 'does-not-exist')];
  const res = await run(convs, msgs, { window: WINDOW });

  assert.equal(res.summary.verdict, 'not_reconciled');
  const o = check(res, 'orphan_messages');
  assert.equal(o.count, 1);
  assert.equal(o.sample[0].conversation_source_id, 'does-not-exist');
});

test('empty conversations warn for a text source and pass for a voice-only one', async () => {
  const convs = fullMonth();
  const msgs = [msg(1, convs[0].source_id)];

  const text = await run(convs, msgs, { window: WINDOW, expect_messages: true });
  assert.equal(check(text, 'empty_conversations').status, 'warn');

  const voice = await run(convs, msgs, { window: WINDOW, expect_messages: false });
  assert.equal(check(voice, 'empty_conversations').status, 'pass');
});

test('a missing messages.jsonl fails for a text source and passes for voice-only', async () => {
  const convs = fullMonth();
  const text = await run(convs, null, { window: WINDOW });
  assert.equal(check(text, 'messages_file').status, 'fail');

  const voice = await run(convs, null, { window: WINDOW, expect_messages: false });
  assert.equal(check(voice, 'messages_file').status, 'pass');
});

test('warns above a 5% unresolved author_type share', async () => {
  const convs = fullMonth();
  const msgs = convs.map((c, i) => msg(i + 1, c.source_id, { author_type: i % 4 === 0 ? 'unknown' : 'customer' }));
  const res = await run(convs, msgs, { window: WINDOW });

  const a = check(res, 'author_type_unknown');
  assert.equal(a.status, 'warn');
  assert.ok(a.share > 0.2);
  assert.match(a.detail, /not trustworthy/);
});

test('catches a field-population shortfall from a skipped hydration step', async () => {
  const convs = fullMonth().map((c, i) => (i % 2 ? { ...c, subject: null } : c));
  const res = await run(convs, null, {
    window: WINDOW,
    expect_messages: false,
    min_population: { subject: 0.9 },
  });

  assert.equal(res.summary.verdict, 'not_reconciled');
  const p = check(res, 'field_population');
  assert.equal(p.shortfalls[0].field, 'subject');
  assert.match(p.detail, /skipped a hydration step/);
});

test('states in its own output that consistency is not completeness', async () => {
  const convs = fullMonth();
  const res = await run(convs, null, { window: WINDOW, expect_messages: false });
  assert.ok(res.summary.notes.some((n) => /not completeness/.test(n)));
  assert.ok(res.summary.notes.some((n) => /definition difference/.test(n)));
});

test('refuses a directory with no conversations.jsonl', async () => {
  const dir = tempOut('recon-empty-');
  const res = await runScript(SCRIPT, ['--dir', dir], {});
  assert.equal(res.code, 2);
  assert.match(res.stderr, /conversations\.jsonl not found/);
});
