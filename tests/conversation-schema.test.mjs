/**
 * Tests for the canonical export validator, plus cross-skill integration:
 * output from the platform exporters is fed straight into the validator, which
 * is the only real proof that the canonical schema actually holds across skills.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withMockApi, runScript, tempOut } from './helpers/mock-api.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const VALIDATOR = resolve(HERE, '../skills/data-and-integration/cx-conversation-schema/scripts/validate-export.mjs');

const conversation = (extra = {}) => ({
  source: 'test',
  source_id: '1',
  subject: 'Hello',
  status: 'closed',
  status_raw: 'closed',
  channel: 'email',
  channel_raw: 'email',
  customer_id: 'u1',
  assignee_id: 'a1',
  team_id: null,
  account_id: null,
  created_at: '2026-03-01T10:00:00.000Z',
  updated_at: '2026-03-01T10:10:00.000Z',
  resolved_at: '2026-03-01T10:10:00.000Z',
  csat: 1,
  csat_raw: 'good',
  priority: null,
  tags: [],
  is_deleted: false,
  ...extra,
});

const message = (extra = {}) => ({
  source: 'test',
  conversation_source_id: '1',
  source_id: 'm1',
  created_at: '2026-03-01T10:01:00.000Z',
  author_id: 'u1',
  author_type: 'customer',
  visibility: 'public',
  channel: 'email',
  attachment_count: 0,
  body: 'hello',
  ...extra,
});

function fixture(conversations, messages) {
  const dir = tempOut('schema-');
  writeFileSync(join(dir, 'conversations.jsonl'), conversations.map((c) => JSON.stringify(c)).join('\n') + '\n');
  if (messages !== null) {
    writeFileSync(join(dir, 'messages.jsonl'), messages.map((m) => JSON.stringify(m)).join('\n') + '\n');
  }
  return dir;
}

const validate = (dir, args = []) => runScript(VALIDATOR, [dir, '--json', ...args], {});

test('passes a clean export', async () => {
  const dir = fixture([conversation()], [message()]);
  const { code, summary } = await validate(dir);

  assert.equal(code, 0);
  assert.equal(summary.ok, true);
  assert.deepEqual(summary.errors, []);
  assert.equal(summary.stats.conversations.total, 1);
  assert.equal(summary.stats.messages.total, 1);
});

test('flags an orphaned message', async () => {
  const dir = fixture([conversation()], [message({ conversation_source_id: '999' })]);
  const { code, summary } = await validate(dir);

  assert.equal(code, 1);
  const issues = summary.errors.map((e) => e.issue);
  assert.ok(issues.some((i) => i.includes('orphaned')), `expected orphan error, got ${issues}`);
});

test('rejects values outside the canonical vocabulary', async () => {
  const dir = fixture(
    [conversation({ status: 'solved', channel: 'phone' })],
    [message({ author_type: 'requester', visibility: 'private' })],
  );
  const { code, summary } = await validate(dir);

  assert.equal(code, 1);
  const issues = summary.errors.map((e) => e.issue).join(' | ');
  assert.match(issues, /status outside the canonical vocabulary/);
  assert.match(issues, /channel outside the canonical vocabulary/);
  assert.match(issues, /author_type outside the canonical vocabulary/);
  assert.match(issues, /visibility outside the canonical vocabulary/);
});

test('rejects a csat outside 0-1 and non-ISO timestamps', async () => {
  const dir = fixture(
    [conversation({ csat: 4, created_at: '2026/03/01 10:00' })],
    [message()],
  );
  const { code, summary } = await validate(dir);

  assert.equal(code, 1);
  const issues = summary.errors.map((e) => e.issue).join(' | ');
  assert.match(issues, /csat is not a 0-1 fraction/, 'a raw 1-5 rating left in csat is an error');
  assert.match(issues, /created_at is not an ISO 8601 timestamp/);
});

test('catches duplicate ids in both files', async () => {
  const dir = fixture(
    [conversation({ source_id: '1' }), conversation({ source_id: '1' })],
    [message({ source_id: 'm1' }), message({ source_id: 'm1' })],
  );
  const { code, summary } = await validate(dir);

  assert.equal(code, 1);
  const issues = summary.errors.map((e) => e.issue).join(' | ');
  assert.match(issues, /conversations: duplicate source_id/);
  assert.match(issues, /messages: duplicate source_id/);
});

test('errors when no message is attributed to a customer', async () => {
  const dir = fixture([conversation()], [message({ author_type: 'agent' })]);
  const { code, summary } = await validate(dir);

  assert.equal(code, 1);
  assert.ok(
    summary.errors.some((e) => e.issue.includes('no customer messages')),
    'an inverted author mapping is an error, not a warning',
  );
});

test('warns when the unresolved-author share is high', async () => {
  const messages = [
    message({ source_id: 'm1', author_type: 'customer' }),
    message({ source_id: 'm2', author_type: 'unknown' }),
    message({ source_id: 'm3', author_type: 'unknown' }),
  ];
  const { code, summary } = await validate(fixture([conversation()], messages));

  assert.equal(code, 0, 'unresolved authors are a warning, not a failure');
  assert.ok(
    summary.warnings.some((w) => w.issue.includes('unresolved author types')),
    'names the metrics it invalidates',
  );
});

test('warns when many conversations have no messages', async () => {
  const conversations = Array.from({ length: 10 }, (_, i) =>
    conversation({ source_id: String(i + 1), customer_id: `u${i + 1}` }),
  );
  const { summary } = await validate(fixture(conversations, [message()]));

  assert.ok(summary.warnings.some((w) => w.issue.includes('no messages')));
  assert.ok(summary.notes.some((n) => n.includes('have no messages')));
});

test('warns when a message predates its conversation', async () => {
  const dir = fixture(
    [conversation({ created_at: '2026-03-01T12:00:00.000Z' })],
    [message({ created_at: '2026-03-01T09:00:00.000Z' })],
  );
  const { summary } = await validate(dir);

  assert.ok(
    summary.warnings.some((w) => w.issue.includes('created before the conversation started')),
    'the usual symptom of a timezone or epoch bug',
  );
});

test('warns when conversations lack a customer_id', async () => {
  const conversations = Array.from({ length: 5 }, (_, i) =>
    conversation({ source_id: String(i + 1), customer_id: null }),
  );
  const { summary } = await validate(fixture(conversations, [message()]));

  assert.ok(
    summary.warnings.some((w) => w.issue.includes('without a customer_id')),
    'flags rows that cannot join for repeat-contact work',
  );
});

test('--no-messages supports voice-only exports', async () => {
  const dir = fixture([conversation({ channel: 'voice' })], null);

  const withoutFlag = await validate(dir);
  assert.equal(withoutFlag.code, 1, 'missing messages.jsonl fails by default');
  assert.match(withoutFlag.stderr, /--no-messages/, 'names the flag');

  const withFlag = await validate(dir, ['--no-messages']);
  assert.equal(withFlag.code, 0);
  assert.equal(withFlag.summary.stats.messages, null);
});

test('reports unparseable lines rather than skipping them silently', async () => {
  const dir = tempOut('schema-');
  writeFileSync(
    join(dir, 'conversations.jsonl'),
    JSON.stringify(conversation()) + '\n{ broken\n',
  );
  writeFileSync(join(dir, 'messages.jsonl'), JSON.stringify(message()) + '\n');

  const { code, summary } = await validate(dir);
  assert.equal(code, 1);
  assert.ok(summary.errors.some((e) => e.issue.includes('unparseable JSON line')));
});

// --- cross-skill integration: exporter output must satisfy the schema ---








