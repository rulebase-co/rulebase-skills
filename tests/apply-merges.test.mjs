/**
 * Tests for the Zendesk merge mutation. These encode the mutation safety
 * contract: dry-run by default, live re-validation of a possibly-stale plan,
 * append-only audit, idempotent resume, and a bounded blast radius.
 *
 * The most important test in this file is the one proving a stale plan cannot
 * merge one customer's conversation into another's.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withMockApi, runScript, tempOut } from './helpers/mock-api.mjs';

const SCRIPT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../skills/zendesk/zendesk-apply-merges/scripts/apply-merges.mjs',
);

const env = (base, extra = {}) => ({
  ZENDESK_SUBDOMAIN: 'mock',
  ZENDESK_EMAIL: 'svc@example.com',
  ZENDESK_API_TOKEN: 'placeholder-not-a-real-token',
  ZENDESK_BASE_URL: base,
  ZENDESK_MIN_INTERVAL_MS: '1',
  ...extra,
});

const planEntry = (extra = {}) => ({
  source: 'zendesk',
  target_id: '1',
  source_ids: ['2', '3'],
  customer_id: '900',
  confidence: 'high',
  cluster_size: 3,
  channels: ['email'],
  evidence: [],
  ...extra,
});

function planFile(entries) {
  const dir = tempOut('plan-');
  const path = join(dir, 'merge-plan.jsonl');
  writeFileSync(path, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return path;
}

/** Serves tickets from a map; records merge calls. */
function zendeskMock(tickets, { mergeStatus = 200 } = {}) {
  const merges = [];
  const plan = (req, n, body) => {
    const mergeMatch = /\/api\/v2\/tickets\/(\d+)\/merge\.json/.exec(req.url);
    if (mergeMatch && req.method === 'POST') {
      merges.push({ target: mergeMatch[1], ids: body?.ids, body });
      if (mergeStatus !== 200) return { status: mergeStatus, body: { error: 'nope' } };
      // Zendesk closes the sources asynchronously; emulate success.
      for (const id of body.ids ?? []) {
        if (tickets[String(id)]) tickets[String(id)].status = 'closed';
      }
      return { body: { job_status: { id: 'job_1', status: 'queued' } } };
    }
    const getMatch = /\/api\/v2\/tickets\/(\d+)\.json/.exec(req.url);
    if (getMatch) {
      const ticket = tickets[getMatch[1]];
      if (!ticket) return { status: 404, body: { error: 'RecordNotFound' } };
      return { body: { ticket } };
    }
    return { status: 404, body: {} };
  };
  return { plan, merges };
}

const ticket = (id, requester, status = 'open') => ({
  id: Number(id),
  status,
  requester_id: Number(requester),
  subject: `Ticket ${id}`,
});

const readAudit = (dir) =>
  existsSync(join(dir, 'audit-log.jsonl'))
    ? readFileSync(join(dir, 'audit-log.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];

test('dry run is the default and writes nothing', async () => {
  const tickets = { 1: ticket(1, 900), 2: ticket(2, 900), 3: ticket(3, 900) };
  const { plan, merges } = zendeskMock(tickets);

  await withMockApi(plan, async ({ base }) => {
    const out = tempOut('merge-');
    const { code, summary, stderr } = await runScript(
      SCRIPT,
      [planFile([planEntry()]), '--out', out, '--json'],
      env(base),
    );

    assert.equal(code, 0);
    assert.equal(summary.mode, 'dry-run');
    assert.equal(summary.would_merge, 1);
    assert.equal(summary.merged, 0);
    assert.equal(merges.length, 0, 'no merge request was issued');
    assert.match(stderr, /dry run \(no changes will be made\)/);
    assert.match(stderr, /Nothing was changed/);
  });
});

test('--apply performs the merge and verifies the sources closed', async () => {
  const tickets = { 1: ticket(1, 900), 2: ticket(2, 900), 3: ticket(3, 900) };
  const { plan, merges } = zendeskMock(tickets);

  await withMockApi(plan, async ({ base }) => {
    const out = tempOut('merge-');
    const { code, summary, stderr } = await runScript(
      SCRIPT,
      [planFile([planEntry()]), '--apply', '--out', out, '--json'],
      env(base),
    );

    assert.equal(code, 0);
    assert.equal(summary.mode, 'apply');
    assert.equal(summary.merged, 1);
    assert.equal(merges.length, 1);
    assert.equal(merges[0].target, '1');
    assert.deepEqual(merges[0].ids, [2, 3]);
    assert.match(stderr, /APPLY MODE — merges are irreversible/);

    const audit = readAudit(out);
    const applied = audit.find((a) => a.outcome === 'applied');
    assert.ok(applied, 'audit records the applied merge');
    assert.ok(applied.before.target, 'before-state captured');
    assert.ok(applied.after.sources.every((s) => s.status === 'closed'), 'verified after applying');
    assert.equal(summary.reversible, false);
  });
});

test('refuses to merge when the live requester differs from the plan — the stale-plan guard', async () => {
  // The plan says customer 900, but ticket 1 now belongs to 999.
  const tickets = { 1: ticket(1, 999), 2: ticket(2, 900), 3: ticket(3, 900) };
  const { plan, merges } = zendeskMock(tickets);

  await withMockApi(plan, async ({ base }) => {
    const out = tempOut('merge-');
    const { code, summary, stderr } = await runScript(
      SCRIPT,
      [planFile([planEntry()]), '--apply', '--out', out, '--json'],
      env(base),
    );

    assert.equal(code, 0);
    assert.equal(summary.merged, 0, 'nothing was merged');
    assert.equal(summary.skipped, 1);
    assert.equal(merges.length, 0);
    assert.match(summary.skipped_detail[0].reason, /plan expected 900/);
    assert.match(summary.skipped_detail[0].reason, /plan is stale/);
    assert.match(stderr, /skip {2}1:/);
  });
});

test('refuses to merge tickets belonging to different customers', async () => {
  // Target and source 2 share requester 900; source 3 belongs to someone else.
  const tickets = { 1: ticket(1, 900), 2: ticket(2, 900), 3: ticket(3, 555) };
  const { plan, merges } = zendeskMock(tickets);

  await withMockApi(plan, async ({ base }) => {
    const out = tempOut('merge-');
    const { summary } = await runScript(
      SCRIPT,
      [planFile([planEntry()]), '--apply', '--out', out, '--json'],
      env(base),
    );

    assert.equal(summary.merged, 0);
    assert.equal(summary.skipped, 1);
    assert.equal(merges.length, 0, 'the whole entry is refused, not partially applied');
    assert.match(summary.skipped_detail[0].reason, /would disclose/);
  });
});

test('skips closed tickets, which Zendesk cannot merge', async () => {
  const closedTarget = { 1: ticket(1, 900, 'closed'), 2: ticket(2, 900), 3: ticket(3, 900) };
  const mockA = zendeskMock(closedTarget);
  await withMockApi(mockA.plan, async ({ base }) => {
    const out = tempOut('merge-');
    const { summary } = await runScript(
      SCRIPT,
      [planFile([planEntry()]), '--apply', '--out', out, '--json'],
      env(base),
    );
    assert.equal(summary.skipped, 1);
    assert.match(summary.skipped_detail[0].reason, /target 1 is closed/);
    assert.equal(mockA.merges.length, 0);
  });

  const closedSource = { 1: ticket(1, 900), 2: ticket(2, 900, 'closed'), 3: ticket(3, 900) };
  const mockB = zendeskMock(closedSource);
  await withMockApi(mockB.plan, async ({ base }) => {
    const out = tempOut('merge-');
    const { summary } = await runScript(
      SCRIPT,
      [planFile([planEntry()]), '--apply', '--out', out, '--json'],
      env(base),
    );
    assert.equal(summary.skipped, 1);
    assert.match(summary.skipped_detail[0].reason, /source 2 is closed/);
    assert.equal(mockB.merges.length, 0);
  });
});

test('skips an entry whose source has already been merged away', async () => {
  const tickets = { 1: ticket(1, 900), 2: ticket(2, 900) }; // 3 is gone
  const { plan, merges } = zendeskMock(tickets);

  await withMockApi(plan, async ({ base }) => {
    const out = tempOut('merge-');
    const { summary } = await runScript(
      SCRIPT,
      [planFile([planEntry()]), '--apply', '--out', out, '--json'],
      env(base),
    );
    assert.equal(summary.skipped, 1);
    assert.match(summary.skipped_detail[0].reason, /source 3 not found/);
    assert.equal(merges.length, 0);
  });
});

test('--max-changes bounds the blast radius and defaults low', async () => {
  const tickets = {};
  const entries = [];
  for (let i = 1; i <= 60; i++) {
    const target = i * 10;
    const source = i * 10 + 1;
    tickets[target] = ticket(target, 900 + i);
    tickets[source] = ticket(source, 900 + i);
    entries.push(planEntry({ target_id: String(target), source_ids: [String(source)], customer_id: String(900 + i) }));
  }
  const { plan, merges } = zendeskMock(tickets);

  await withMockApi(plan, async ({ base }) => {
    const out = tempOut('merge-');
    const { summary, stderr } = await runScript(
      SCRIPT,
      [planFile(entries), '--apply', '--out', out, '--json'],
      env(base),
    );

    assert.equal(summary.processed, 25, 'default max-changes is 25');
    assert.equal(merges.length, 25);
    assert.equal(summary.remaining, 35);
    assert.match(stderr, /--max-changes is 25/);
    assert.match(stderr, /Raise it deliberately/);
  });
});

test('resume skips already-applied targets without re-merging', async () => {
  const tickets = {
    1: ticket(1, 900), 2: ticket(2, 900),
    10: ticket(10, 901), 11: ticket(11, 901),
  };
  const entries = [
    planEntry({ target_id: '1', source_ids: ['2'], customer_id: '900' }),
    planEntry({ target_id: '10', source_ids: ['11'], customer_id: '901' }),
  ];
  const { plan, merges } = zendeskMock(tickets);
  const path = planFile(entries);

  await withMockApi(plan, async ({ base }) => {
    const out = tempOut('merge-');
    const e = env(base);

    const first = await runScript(SCRIPT, [path, '--apply', '--max-changes', '1', '--out', out, '--json'], e);
    assert.equal(first.summary.merged, 1);
    assert.equal(merges.length, 1);

    // Re-open the merged sources so a repeat merge would be possible if attempted.
    tickets[2].status = 'open';

    const second = await runScript(SCRIPT, [path, '--apply', '--out', out, '--json'], e);
    assert.equal(second.summary.already_applied, 1, 'first target recognised as done');
    assert.equal(second.summary.merged, 1, 'only the second entry merged');
    assert.equal(merges.length, 2, 'the first merge was not repeated');
    assert.deepEqual(merges[1].ids, [11]);
  });
});

test('--min-confidence filters the plan and defaults to high', async () => {
  const tickets = {
    1: ticket(1, 900), 2: ticket(2, 900),
    10: ticket(10, 901), 11: ticket(11, 901),
  };
  const entries = [
    planEntry({ target_id: '1', source_ids: ['2'], customer_id: '900', confidence: 'high' }),
    planEntry({ target_id: '10', source_ids: ['11'], customer_id: '901', confidence: 'medium' }),
  ];
  const path = planFile(entries);

  const strict = zendeskMock({ ...tickets });
  await withMockApi(strict.plan, async ({ base }) => {
    const out = tempOut('merge-');
    const { summary } = await runScript(SCRIPT, [path, '--out', out, '--json'], env(base));
    assert.equal(summary.below_confidence, 1, 'medium excluded by the default');
    assert.equal(summary.would_merge, 1);
  });

  const loose = zendeskMock({ ...tickets });
  await withMockApi(loose.plan, async ({ base }) => {
    const out = tempOut('merge-');
    const { summary } = await runScript(
      SCRIPT,
      [path, '--min-confidence', 'medium', '--out', out, '--json'],
      env(base),
    );
    assert.equal(summary.below_confidence, 0);
    assert.equal(summary.would_merge, 2);
  });
});

test('the audit log is append-only across runs', async () => {
  const tickets = { 1: ticket(1, 900), 2: ticket(2, 900) };
  const { plan } = zendeskMock(tickets);
  const path = planFile([planEntry({ target_id: '1', source_ids: ['2'], customer_id: '900' })]);

  await withMockApi(plan, async ({ base }) => {
    const out = tempOut('merge-');
    const e = env(base);

    await runScript(SCRIPT, [path, '--out', out, '--json'], e);
    const afterDryRun = readAudit(out).length;
    assert.ok(afterDryRun > 0, 'dry runs are audited too');

    await runScript(SCRIPT, [path, '--out', out, '--json'], e);
    assert.ok(readAudit(out).length > afterDryRun, 'the second run appended rather than replaced');
  });
});

test('a merge failure is recorded and does not abort the run', async () => {
  const tickets = {
    1: ticket(1, 900), 2: ticket(2, 900),
    10: ticket(10, 901), 11: ticket(11, 901),
  };
  const { plan, merges } = zendeskMock(tickets, { mergeStatus: 422 });
  const entries = [
    planEntry({ target_id: '1', source_ids: ['2'], customer_id: '900' }),
    planEntry({ target_id: '10', source_ids: ['11'], customer_id: '901' }),
  ];

  await withMockApi(plan, async ({ base }) => {
    const out = tempOut('merge-');
    const { code, summary } = await runScript(
      SCRIPT,
      [planFile(entries), '--apply', '--out', out, '--json'],
      env(base),
    );

    assert.equal(code, 0);
    assert.equal(summary.failed, 2, 'both attempted; one failure did not stop the other');
    assert.equal(summary.merged, 0);
    assert.equal(merges.length, 2);

    const audit = readAudit(out);
    const errors = audit.filter((a) => a.outcome === 'error');
    assert.equal(errors.length, 2);
    assert.ok(errors[0].before, 'before-state is recorded even on failure');
  });
});

test('refuses a malformed plan rather than acting on part of it', async () => {
  const dir = tempOut('plan-');
  const path = join(dir, 'bad.jsonl');
  writeFileSync(path, JSON.stringify(planEntry()) + '\n{ not json\n');

  const { code, stderr } = await runScript(SCRIPT, [path, '--apply', '--json'], env('http://127.0.0.1:1'));
  assert.equal(code, 1);
  assert.match(stderr, /not valid JSON/);
  assert.match(stderr, /Refusing to act on a malformed plan/);
});

test('refuses a plan entry missing source_ids', async () => {
  const path = planFile([{ target_id: '1', confidence: 'high' }]);
  const { code, stderr } = await runScript(SCRIPT, [path, '--apply', '--json'], env('http://127.0.0.1:1'));
  assert.equal(code, 1);
  assert.match(stderr, /missing target_id or source_ids/);
});

test('403 explains that a read-only token cannot merge', async () => {
  await withMockApi(
    () => ({ status: 403, body: {} }),
    async ({ base }) => {
      const out = tempOut('merge-');
      const { code, stderr } = await runScript(
        SCRIPT,
        [planFile([planEntry()]), '--apply', '--out', out, '--json'],
        env(base),
      );
      assert.equal(code, 1);
      assert.match(stderr, /read-only token cannot do this/);
    },
  );
});

test('warns when a merge applied but sources are not yet closed', async () => {
  const tickets = { 1: ticket(1, 900), 2: ticket(2, 900) };
  // Merge succeeds but does not close the source — Zendesk merges asynchronously.
  const plan = (req, n, body) => {
    if (/\/merge\.json/.test(req.url) && req.method === 'POST') {
      return { body: { job_status: { id: 'job_1', status: 'queued' } } };
    }
    const getMatch = /\/api\/v2\/tickets\/(\d+)\.json/.exec(req.url);
    if (getMatch) {
      const t = tickets[getMatch[1]];
      return t ? { body: { ticket: t } } : { status: 404, body: {} };
    }
    return { status: 404, body: {} };
  };

  await withMockApi(plan, async ({ base }) => {
    const out = tempOut('merge-');
    const { summary, stderr } = await runScript(
      SCRIPT,
      [planFile([planEntry({ source_ids: ['2'] })]), '--apply', '--out', out, '--json'],
      env(base),
    );

    assert.equal(summary.merged, 1);
    assert.match(stderr, /not yet closed/);
    const audit = readAudit(out);
    assert.ok(audit.some((a) => a.outcome === 'applied_unverified'));
  });
});
