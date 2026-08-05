/**
 * Tests for the migration fidelity checker. Each test encodes a real way
 * migrations lose data silently.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runScript, tempOut } from './helpers/mock-api.mjs';

const SCRIPT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../skills/cx-ops/cx-helpdesk-migration/scripts/migration-fidelity.mjs',
);

const conversation = (id, createdAt, extra = {}) => ({
  source: 'zendesk',
  source_id: String(id),
  subject: `Ticket ${id}`,
  status: 'closed',
  status_raw: 'closed',
  channel: 'email',
  channel_raw: 'email',
  customer_id: `u${id}`,
  assignee_id: 'a1',
  team_id: null,
  account_id: null,
  created_at: createdAt,
  updated_at: createdAt,
  resolved_at: createdAt,
  csat: 1,
  csat_raw: 'good',
  priority: 'normal',
  tags: ['billing'],
  is_deleted: false,
  ...extra,
});

const message = (id, conversationId, extra = {}) => ({
  source: 'zendesk',
  conversation_source_id: String(conversationId),
  source_id: String(id),
  created_at: '2026-03-01T10:05:00.000Z',
  author_id: `u${conversationId}`,
  author_type: 'customer',
  visibility: 'public',
  channel: 'email',
  attachment_count: 0,
  body: 'hello',
  ...extra,
});

function exportDir(conversations, messages = null) {
  const dir = tempOut('mig-');
  writeFileSync(
    join(dir, 'conversations.jsonl'),
    conversations.map((c) => JSON.stringify(c)).join('\n') + '\n',
  );
  if (messages !== null) {
    writeFileSync(
      join(dir, 'messages.jsonl'),
      messages.map((m) => JSON.stringify(m)).join('\n') + '\n',
    );
  }
  return dir;
}

const run = (source, target, args = []) =>
  runScript(SCRIPT, ['--source', source, '--target', target, '--json', ...args], {});

const issues = (summary) => summary.findings.map((f) => f.issue);
const criticals = (summary) =>
  summary.findings.filter((f) => f.severity === 'critical').map((f) => f.issue);

test('passes a faithful migration', async () => {
  const conversations = [
    conversation(1, '2026-01-15T10:00:00.000Z'),
    conversation(2, '2026-02-20T10:00:00.000Z'),
  ];
  const messages = [message(10, 1), message(11, 2)];

  const { code, summary } = await run(
    exportDir(conversations, messages),
    exportDir(conversations, messages),
  );

  assert.equal(code, 0);
  assert.equal(summary.ok, true);
  assert.deepEqual(summary.findings, []);
  assert.equal(summary.counts.matched, 2);
});

test('detects conversations missing from the target', async () => {
  const source = [
    conversation(1, '2026-01-15T10:00:00.000Z'),
    conversation(2, '2026-02-20T10:00:00.000Z'),
    conversation(3, '2026-03-05T10:00:00.000Z'),
  ];
  const target = [source[0]];

  const { code, summary } = await run(exportDir(source), exportDir(target));

  assert.equal(code, 1, 'missing conversations are a critical failure');
  assert.ok(criticals(summary).includes('conversations missing from the target'));
  assert.equal(summary.counts.missing, 2);
});

test('detects created_at collapsed to the import date — the unrecoverable loss', async () => {
  const source = Array.from({ length: 20 }, (_, i) =>
    conversation(i + 1, `2026-0${(i % 3) + 1}-${String((i % 27) + 1).padStart(2, '0')}T10:00:00.000Z`),
  );
  // Every ticket stamped with the import date.
  const target = source.map((c) => ({ ...c, created_at: '2026-06-01T09:00:00.000Z' }));

  const { code, summary } = await run(exportDir(source), exportDir(target));

  assert.equal(code, 1);
  const found = criticals(summary);
  assert.ok(found.includes('created_at collapsed to the import date'), `got ${found}`);
  assert.ok(found.includes('created_at drifted'));

  const collapse = summary.findings.find((f) => f.issue.includes('collapsed'));
  assert.match(collapse.detail, /unrecoverable/, 'states the stakes');
});

test('tolerates sub-tolerance timestamp rounding', async () => {
  const source = [conversation(1, '2026-01-15T10:00:00.000Z')];
  const target = [conversation(1, '2026-01-15T10:00:30.000Z')]; // 30s

  const { code, summary } = await run(exportDir(source), exportDir(target));
  assert.equal(code, 0);
  assert.ok(!issues(summary).includes('created_at drifted'), 'rounding is not drift');

  const strict = await run(exportDir(source), exportDir(target), ['--drift-seconds', '10']);
  assert.equal(strict.code, 1, 'a tighter tolerance catches it');
});

test('distinguishes critical field loss from cosmetic field loss', async () => {
  const source = [conversation(1, '2026-01-15T10:00:00.000Z')];

  const criticalLoss = await run(
    exportDir(source),
    exportDir([{ ...source[0], customer_id: null }]),
  );
  assert.equal(criticalLoss.code, 1);
  assert.ok(criticals(criticalLoss.summary).includes('customer_id lost'));

  const softLoss = await run(exportDir(source), exportDir([{ ...source[0], csat: null, tags: [] }]));
  assert.equal(softLoss.code, 0, 'csat and tags are warnings, not failures');
  const warned = softLoss.summary.findings.map((f) => f.issue);
  assert.ok(warned.includes('csat lost'));
  assert.ok(warned.includes('tags lost'));
});

test('detects total message loss — conversations moved without their contents', async () => {
  const conversations = [conversation(1, '2026-01-15T10:00:00.000Z')];
  const { code, summary } = await run(
    exportDir(conversations, [message(10, 1)]),
    exportDir(conversations, []),
  );

  assert.equal(code, 1);
  const found = criticals(summary);
  assert.ok(found.includes('all messages lost'), `got ${found}`);
});

test('detects partial message loss per conversation', async () => {
  const conversations = [conversation(1, '2026-01-15T10:00:00.000Z'), conversation(2, '2026-01-16T10:00:00.000Z')];
  const sourceMessages = [message(10, 1), message(11, 1), message(12, 1), message(13, 2)];
  const targetMessages = [message(10, 1), message(13, 2)];

  const { code, summary } = await run(
    exportDir(conversations, sourceMessages),
    exportDir(conversations, targetMessages),
  );

  assert.equal(code, 1);
  assert.ok(criticals(summary).includes('messages lost'));
  assert.equal(summary.messages.messages_lost, 2);
  assert.equal(summary.messages.conversations_short, 1);
});

test('treats losing the internal-note flag as a disclosure risk', async () => {
  const conversations = [conversation(1, '2026-01-15T10:00:00.000Z')];
  const sourceMessages = [message(10, 1), message(11, 1, { visibility: 'internal' })];
  // Same message count, but the note is now customer-visible.
  const targetMessages = [message(10, 1), message(11, 1, { visibility: 'public' })];

  const { code, summary } = await run(
    exportDir(conversations, sourceMessages),
    exportDir(conversations, targetMessages),
  );

  assert.equal(code, 1, 'not caught by counts alone, but still critical');
  const finding = summary.findings.find((f) => f.issue.includes('internal notes lost'));
  assert.ok(finding, `expected a visibility finding, got ${issues(summary)}`);
  assert.match(finding.detail, /customer-visible/);
  assert.match(finding.detail, /before anyone contacts a customer/);
});

test('warns when author attribution degrades', async () => {
  const conversations = [conversation(1, '2026-01-15T10:00:00.000Z')];
  const sourceMessages = Array.from({ length: 10 }, (_, i) => message(100 + i, 1));
  const targetMessages = sourceMessages.map((m, i) =>
    i < 5 ? { ...m, author_type: 'unknown', author_id: null } : m,
  );

  const { code, summary } = await run(
    exportDir(conversations, sourceMessages),
    exportDir(conversations, targetMessages),
  );

  assert.equal(code, 0, 'degraded attribution is a warning, not a failure');
  const finding = summary.findings.find((f) => f.issue.includes('author attribution degraded'));
  assert.ok(finding);
  assert.match(finding.detail, /agents who left/, 'names the usual cause');
  assert.match(finding.detail, /per-agent metrics on migrated data will be wrong/);
});

test('--id-map matches across systems that reassign ids', async () => {
  const source = [conversation(1, '2026-01-15T10:00:00.000Z'), conversation(2, '2026-02-20T10:00:00.000Z')];
  const target = [
    { ...source[0], source: 'freshdesk', source_id: '9001' },
    { ...source[1], source: 'freshdesk', source_id: '9002' },
  ];

  const withoutMap = await run(exportDir(source), exportDir(target));
  assert.equal(withoutMap.code, 1, 'without a map, nothing matches');
  assert.equal(withoutMap.summary.counts.missing, 2);

  const dir = tempOut('idmap-');
  const mapPath = join(dir, 'map.csv');
  writeFileSync(mapPath, 'source_id,target_id\n1,9001\n2,9002\n');

  const withMap = await run(exportDir(source), exportDir(target), ['--id-map', mapPath]);
  assert.equal(withMap.code, 0);
  assert.equal(withMap.summary.counts.matched, 2);
  assert.equal(withMap.summary.counts.missing, 0);
  assert.match(withMap.summary.id_matching, /id-map \(2 entries\)/);
});

test('reports per-month count deltas for reconciliation', async () => {
  const source = [
    conversation(1, '2026-01-15T10:00:00.000Z'),
    conversation(2, '2026-01-20T10:00:00.000Z'),
    conversation(3, '2026-02-10T10:00:00.000Z'),
  ];
  const target = [source[0], source[2]];

  const { summary } = await run(exportDir(source), exportDir(target));

  const january = summary.by_month.find((r) => r.key === '2026-01');
  assert.equal(january.source, 2);
  assert.equal(january.target, 1);
  assert.equal(january.delta, -1);
});

test('flags unexpected extra conversations in the target', async () => {
  const source = [conversation(1, '2026-01-15T10:00:00.000Z')];
  const target = [source[0], conversation(99, '2026-04-01T10:00:00.000Z')];

  const { code, summary } = await run(exportDir(source), exportDir(target));
  assert.equal(code, 0, 'extras are a warning — usually new activity');
  const finding = summary.findings.find((f) => f.issue.includes('no source'));
  assert.ok(finding);
  assert.match(finding.detail, /duplicated import/);
});

test('refuses to compare when the target is empty', async () => {
  const dir = tempOut('mig-empty-');
  writeFileSync(join(dir, 'conversations.jsonl'), '');
  const { code, stderr } = await run(
    exportDir([conversation(1, '2026-01-15T10:00:00.000Z')]),
    dir,
  );
  assert.equal(code, 1);
  assert.match(stderr, /no conversations found/);
  assert.match(stderr, /nothing to compare/);
});

test('the verdict tells you not to decommission the source', async () => {
  const source = [conversation(1, '2026-01-15T10:00:00.000Z')];
  const { stderr } = await runScript(
    SCRIPT,
    ['--source', exportDir(source), '--target', exportDir([{ ...source[0], customer_id: null }])],
    {},
  );
  assert.match(stderr, /Do not decommission the source system/);
});
