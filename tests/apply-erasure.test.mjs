/**
 * Tests for the Zendesk erasure mutation. The critical ones are the refusals:
 * it must never delete a conversation the subject only appears in, never touch a
 * legal-hold or manual-review entry, and never redact a ticket that has closed
 * since the plan was built.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withMockApi, runScript, tempOut } from './helpers/mock-api.mjs';

const SCRIPT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../skills/zendesk/zendesk-apply-erasure/scripts/apply-erasure.mjs',
);

const env = (base, extra = {}) => ({
  ZENDESK_SUBDOMAIN: 'mock',
  ZENDESK_EMAIL: 'svc@example.com',
  ZENDESK_API_TOKEN: 'placeholder-not-a-real-token',
  ZENDESK_BASE_URL: base,
  ZENDESK_MIN_INTERVAL_MS: '1',
  ...extra,
});

const redactEntry = (extra = {}) => ({
  source: 'zendesk',
  conversation_source_id: '100',
  action: 'redact_messages',
  subject_role: 'requester',
  status: 'open',
  reason: 'open and requester',
  blocked: false,
  redactions: [{ message_source_id: '900', literals: ['jo@example.com'] }],
  redaction_literal_count: 1,
  ...extra,
});

const deleteEntry = (extra = {}) => ({
  source: 'zendesk',
  conversation_source_id: '101',
  action: 'delete_conversation',
  subject_role: 'requester',
  status: 'closed',
  reason: 'closed and requester',
  blocked: false,
  redactions: [],
  redaction_literal_count: 0,
  ...extra,
});

function planFile(entries) {
  const dir = tempOut('eplan-');
  const path = join(dir, 'erasure-plan.jsonl');
  writeFileSync(path, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return path;
}

/** Mock Zendesk with tickets, comments, and recorded mutations. */
function zendeskMock(tickets, comments = {}) {
  const calls = { redactions: [], deletes: [], purges: [] };
  const plan = (req, n, body) => {
    const redactMatch = /\/api\/v2\/tickets\/(\d+)\/comments\/(\d+)\/redact\.json/.exec(req.url);
    if (redactMatch && req.method === 'PUT') {
      calls.redactions.push({ ticket: redactMatch[1], comment: redactMatch[2], text: body?.text });
      return { body: { comment: { id: Number(redactMatch[2]) } } };
    }
    const purgeMatch = /\/api\/v2\/deleted_tickets\/(\d+)\.json/.exec(req.url);
    if (purgeMatch && req.method === 'DELETE') {
      calls.purges.push(purgeMatch[1]);
      return { status: 204, body: '' };
    }
    const commentsMatch = /\/api\/v2\/tickets\/(\d+)\/comments\.json/.exec(req.url);
    if (commentsMatch) {
      return { body: { comments: comments[commentsMatch[1]] ?? [] } };
    }
    const ticketMatch = /\/api\/v2\/tickets\/(\d+)\.json/.exec(req.url);
    if (ticketMatch) {
      if (req.method === 'DELETE') {
        calls.deletes.push(ticketMatch[1]);
        return { status: 204, body: '' };
      }
      const ticket = tickets[ticketMatch[1]];
      return ticket ? { body: { ticket } } : { status: 404, body: {} };
    }
    return { status: 404, body: {} };
  };
  return { plan, calls };
}

const ticket = (id, status = 'open', requester = 900) => ({
  id: Number(id),
  status,
  requester_id: requester,
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

test('dry run redacts nothing', async () => {
  const { plan, calls } = zendeskMock(
    { 100: ticket(100) },
    { 100: [{ id: 900, plain_body: 'contact jo@example.com please' }] },
  );

  await withMockApi(plan, async ({ base }) => {
    const out = tempOut('er-');
    const { code, summary, stderr } = await runScript(
      SCRIPT,
      [planFile([redactEntry()]), '--out', out, '--json'],
      env(base),
    );

    assert.equal(code, 0);
    assert.equal(summary.mode, 'dry-run');
    assert.equal(summary.would_redact_literals, 1);
    assert.equal(calls.redactions.length, 0);
    assert.match(stderr, /Nothing was changed/);
  });
});

test('--apply redacts the exact literal from the plan', async () => {
  const { plan, calls } = zendeskMock(
    { 100: ticket(100) },
    { 100: [{ id: 900, plain_body: 'contact jo@example.com please' }] },
  );

  await withMockApi(plan, async ({ base }) => {
    const out = tempOut('er-');
    const { summary } = await runScript(
      SCRIPT,
      [planFile([redactEntry()]), '--apply', '--out', out, '--json'],
      env(base),
    );

    assert.equal(summary.redacted_literals, 1);
    assert.equal(calls.redactions.length, 1);
    assert.deepEqual(calls.redactions[0], { ticket: '100', comment: '900', text: 'jo@example.com' });
    assert.equal(summary.reversible, false);
  });
});

test('the audit log records the redaction without recording the redacted value', async () => {
  const { plan } = zendeskMock(
    { 100: ticket(100) },
    { 100: [{ id: 900, plain_body: 'contact jo@example.com please' }] },
  );

  await withMockApi(plan, async ({ base }) => {
    const out = tempOut('er-');
    await runScript(SCRIPT, [planFile([redactEntry()]), '--apply', '--out', out, '--json'], env(base));

    const audit = readAudit(out);
    const record = audit.find((a) => a.action === 'redact' && a.outcome === 'applied');
    assert.ok(record, 'the redaction is audited');
    assert.equal(record.literal_length, 'jo@example.com'.length);
    const serialised = JSON.stringify(audit);
    assert.ok(
      !serialised.includes('jo@example.com'),
      'the audit log must not contain the erased value — that would defeat the erasure',
    );
  });
});

test('refuses to delete a conversation the subject only appears in', async () => {
  // A hand-edited plan asking to delete someone else's ticket.
  const malicious = deleteEntry({ conversation_source_id: '200', subject_role: 'mentioned' });
  const { plan, calls } = zendeskMock({ 200: ticket(200, 'closed', 555) });

  await withMockApi(plan, async ({ base }) => {
    const out = tempOut('er-');
    const { summary } = await runScript(
      SCRIPT,
      [planFile([malicious]), '--apply', '--out', out, '--json'],
      env(base),
    );

    assert.equal(summary.deleted, 0);
    assert.equal(summary.skipped, 1);
    assert.equal(calls.deletes.length, 0, 'no delete was issued');
    assert.match(summary.skipped_detail[0].reason, /not the.*requester/s);
    assert.match(summary.skipped_detail[0].reason, /another data subject's record/);
  });
});

test('never touches manual_review or legal-hold entries', async () => {
  const entries = [
    { conversation_source_id: '201', action: 'manual_review', subject_role: 'mentioned', status: 'closed', reason: 'dead end' },
    { conversation_source_id: '300', action: 'blocked_legal_hold', subject_role: 'requester', status: 'open', reason: 'held' },
    redactEntry(),
  ];
  const { plan, calls } = zendeskMock(
    { 100: ticket(100), 201: ticket(201, 'closed'), 300: ticket(300) },
    { 100: [{ id: 900, plain_body: 'jo@example.com' }] },
  );

  await withMockApi(plan, async ({ base }) => {
    const out = tempOut('er-');
    const { summary, stderr } = await runScript(
      SCRIPT,
      [planFile(entries), '--apply', '--out', out, '--json'],
      env(base),
    );

    assert.equal(summary.refused_needing_human_decision, 2);
    assert.equal(summary.redacted_literals, 1, 'the actionable entry still ran');
    assert.equal(calls.deletes.length, 0);
    assert.match(stderr, /need a human decision and were not touched/);

    const audit = readAudit(out);
    const refusals = audit.filter((a) => a.outcome === 'refused');
    assert.equal(refusals.length, 2, 'refusals are audited too');
  });
});

test('skips redaction when the ticket closed since the plan was built', async () => {
  // Plan says open; live Zendesk says closed.
  const { plan, calls } = zendeskMock(
    { 100: ticket(100, 'closed') },
    { 100: [{ id: 900, plain_body: 'jo@example.com' }] },
  );

  await withMockApi(plan, async ({ base }) => {
    const out = tempOut('er-');
    const { summary } = await runScript(
      SCRIPT,
      [planFile([redactEntry()]), '--apply', '--out', out, '--json'],
      env(base),
    );

    assert.equal(summary.redacted_literals, 0);
    assert.equal(summary.skipped, 1);
    assert.equal(calls.redactions.length, 0);
    assert.match(summary.skipped_detail[0].reason, /closed since the plan was built/);
    assert.match(summary.skipped_detail[0].reason, /remedy for a closed ticket is different/);
  });
});

test('deletes a closed conversation owned by the subject, purging only with --permanent', async () => {
  const withoutPurge = zendeskMock({ 101: ticket(101, 'closed') });
  await withMockApi(withoutPurge.plan, async ({ base }) => {
    const out = tempOut('er-');
    const { summary, stderr } = await runScript(
      SCRIPT,
      [planFile([deleteEntry()]), '--apply', '--out', out, '--json'],
      env(base),
    );
    assert.equal(summary.deleted, 1);
    assert.equal(summary.purged, 0);
    assert.deepEqual(withoutPurge.calls.deletes, ['101']);
    assert.equal(withoutPurge.calls.purges.length, 0);
    assert.match(stderr, /Deleted Tickets for 30 days/);
  });

  const withPurge = zendeskMock({ 101: ticket(101, 'closed') });
  await withMockApi(withPurge.plan, async ({ base }) => {
    const out = tempOut('er-');
    const { summary } = await runScript(
      SCRIPT,
      [planFile([deleteEntry()]), '--apply', '--permanent', '--out', out, '--json'],
      env(base),
    );
    assert.equal(summary.deleted, 1);
    assert.equal(summary.purged, 1);
    assert.deepEqual(withPurge.calls.purges, ['101']);
    assert.equal(summary.permanent_purge, true);
  });
});

test('does not report a literal as redacted when it is no longer present', async () => {
  const { plan, calls } = zendeskMock(
    { 100: ticket(100) },
    { 100: [{ id: 900, plain_body: 'this comment no longer mentions the address' }] },
  );

  await withMockApi(plan, async ({ base }) => {
    const out = tempOut('er-');
    const { summary, stderr } = await runScript(
      SCRIPT,
      [planFile([redactEntry()]), '--apply', '--out', out, '--json'],
      env(base),
    );

    assert.equal(summary.redacted_literals, 0, 'nothing to redact is not a redaction');
    assert.equal(calls.redactions.length, 0);
    assert.match(stderr, /no longer present/);
  });
});

test('--only separates redaction from deletion', async () => {
  const entries = [redactEntry(), deleteEntry()];
  const mocks = () =>
    zendeskMock(
      { 100: ticket(100), 101: ticket(101, 'closed') },
      { 100: [{ id: 900, plain_body: 'jo@example.com' }] },
    );

  const redactOnly = mocks();
  await withMockApi(redactOnly.plan, async ({ base }) => {
    const out = tempOut('er-');
    const { summary } = await runScript(
      SCRIPT,
      [planFile(entries), '--apply', '--only', 'redact', '--out', out, '--json'],
      env(base),
    );
    assert.equal(summary.redacted_literals, 1);
    assert.equal(summary.deleted, 0);
    assert.equal(redactOnly.calls.deletes.length, 0);
  });

  const deleteOnly = mocks();
  await withMockApi(deleteOnly.plan, async ({ base }) => {
    const out = tempOut('er-');
    const { summary } = await runScript(
      SCRIPT,
      [planFile(entries), '--apply', '--only', 'delete', '--out', out, '--json'],
      env(base),
    );
    assert.equal(summary.deleted, 1);
    assert.equal(summary.redacted_literals, 0);
    assert.equal(deleteOnly.calls.redactions.length, 0);
  });
});

test('--max-changes bounds the run and defaults to 10', async () => {
  const tickets = {};
  const comments = {};
  const entries = [];
  for (let i = 1; i <= 25; i++) {
    const id = String(1000 + i);
    tickets[id] = ticket(id);
    comments[id] = [{ id: 900 + i, plain_body: 'jo@example.com' }];
    entries.push(
      redactEntry({
        conversation_source_id: id,
        redactions: [{ message_source_id: String(900 + i), literals: ['jo@example.com'] }],
      }),
    );
  }
  const { plan, calls } = zendeskMock(tickets, comments);

  await withMockApi(plan, async ({ base }) => {
    const out = tempOut('er-');
    const { summary, stderr } = await runScript(
      SCRIPT,
      [planFile(entries), '--apply', '--out', out, '--json'],
      env(base),
    );
    assert.equal(summary.processed, 10, 'default max-changes is 10');
    assert.equal(calls.redactions.length, 10);
    assert.equal(summary.remaining, 15);
    assert.match(stderr, /--max-changes is 10/);
  });
});

test('resume skips completed conversations', async () => {
  const tickets = { 100: ticket(100), 101: ticket(101, 'closed') };
  const comments = { 100: [{ id: 900, plain_body: 'jo@example.com' }] };
  const { plan, calls } = zendeskMock(tickets, comments);
  const path = planFile([redactEntry(), deleteEntry()]);

  await withMockApi(plan, async ({ base }) => {
    const out = tempOut('er-');
    const e = env(base);

    await runScript(SCRIPT, [path, '--apply', '--max-changes', '1', '--out', out, '--json'], e);
    assert.equal(calls.redactions.length, 1);

    const second = await runScript(SCRIPT, [path, '--apply', '--out', out, '--json'], e);
    assert.equal(calls.redactions.length, 1, 'the completed redaction was not repeated');
    assert.equal(second.summary.deleted, 1, 'the remaining entry ran');
  });
});

test('refuses a malformed plan', async () => {
  const dir = tempOut('eplan-');
  const path = join(dir, 'bad.jsonl');
  writeFileSync(path, JSON.stringify(redactEntry()) + '\n{ nope\n');
  const { code, stderr } = await runScript(SCRIPT, [path, '--apply', '--json'], env('http://127.0.0.1:1'));
  assert.equal(code, 1);
  assert.match(stderr, /Refusing to act on a malformed plan/);
});

test('403 names the Zendesk setting that must be enabled', async () => {
  await withMockApi(
    () => ({ status: 403, body: {} }),
    async ({ base }) => {
      const out = tempOut('er-');
      const { code, stderr } = await runScript(
        SCRIPT,
        [planFile([redactEntry()]), '--apply', '--out', out, '--json'],
        env(base),
      );
      assert.equal(code, 1);
      assert.match(stderr, /Agents can delete tickets/);
    },
  );
});
