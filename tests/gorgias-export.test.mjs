/**
 * Tests for the Gorgias export script. The load-bearing behaviour is the
 * newest-first walk with an early stop, because Gorgias offers no time filter
 * at all — order_by plus a watermark stop is the only incremental mechanism.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  withMockApi,
  runScript,
  tempOut,
  readJsonl,
  CANONICAL_CONVERSATION_FIELDS,
  CANONICAL_MESSAGE_FIELDS,
  CANONICAL_STATUSES,
  CANONICAL_CHANNELS,
} from './helpers/mock-api.mjs';

const SCRIPT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../skills/gorgias/gorgias-export-conversations/scripts/export-conversations.mjs',
);

const env = (base, extra = {}) => ({
  GORGIAS_DOMAIN: 'mock',
  GORGIAS_EMAIL: 'svc@example.com',
  GORGIAS_API_KEY: 'placeholder-not-a-real-key',
  GORGIAS_API_BASE: base,
  GORGIAS_RATE_PER_20S: '2000',
  ...extra,
});

const ticket = (id, updated, extra = {}) => ({
  id,
  subject: `Ticket ${id}`,
  status: 'closed',
  channel: 'email',
  customer: { id: 900 + id },
  assignee_user: { id: 55 },
  created_datetime: '2026-03-01T10:00:00Z',
  updated_datetime: updated,
  tags: [{ name: 'billing' }],
  ...extra,
});

const message = (id, ticketId, extra = {}) => ({
  id,
  ticket_id: ticketId,
  sender: { id: 901 },
  from_agent: false,
  public: true,
  channel: 'email',
  body_text: 'where is my refund',
  created_datetime: '2026-03-01T10:01:00Z',
  attachments: [],
  ...extra,
});

test('orders newest-first, since Gorgias has no time filter', async () => {
  await withMockApi(
    () => ({ body: { data: [], meta: {} } }),
    async ({ base, urls }) => {
      const out = tempOut('gg-');
      await runScript(SCRIPT, ['--start', '2026-01-01', '--only', 'conversations', '--out', out], env(base));

      assert.match(urls()[0], /order_by=updated_datetime%3Adesc/);
      assert.ok(
        !urls()[0].includes('updated_since') && !urls()[0].includes('created_after'),
        'no time filter is sent because none exists',
      );
    },
  );
});

test('stops at the watermark instead of walking all history', async () => {
  await withMockApi(
    (req) => {
      if (req.url.includes('cursor=p2')) {
        return {
          body: {
            // Page 2 crosses the watermark.
            data: [ticket(3, '2026-03-02T00:00:00Z'), ticket(4, '2025-01-01T00:00:00Z')],
            meta: { next_cursor: 'p3' },
          },
        };
      }
      return {
        body: {
          data: [ticket(1, '2026-03-05T00:00:00Z'), ticket(2, '2026-03-04T00:00:00Z')],
          meta: { next_cursor: 'p2' },
        },
      };
    },
    async ({ base, calls }) => {
      const out = tempOut('gg-');
      const { code, summary, stderr } = await runScript(
        SCRIPT,
        ['--start', '2026-03-01', '--only', 'conversations', '--out', out],
        env(base),
      );

      assert.equal(code, 0);
      assert.match(stderr, /reached the watermark/);
      assert.equal(summary.list_complete, true);
      assert.equal(summary.skipped_older_than_watermark, 1);

      const ids = readJsonl(join(out, 'conversations.jsonl')).map((c) => c.source_id);
      assert.deepEqual(ids, ['1', '2', '3'], 'the pre-watermark ticket is excluded');
      assert.equal(calls.length, 2, 'stops paging rather than continuing to p3');
    },
  );
});

test('normalises tickets and messages to the canonical shape', async () => {
  await withMockApi(
    (req) => {
      if (req.url.includes('/messages')) {
        return {
          body: {
            data: [
              message(10, 1),
              message(11, 1, { from_agent: true, sender: { id: 55 }, body_text: 'checking now' }),
              message(12, 1, { from_agent: true, public: false, body_text: 'internal note' }),
            ],
            meta: {},
          },
        };
      }
      return { body: { data: [ticket(1, '2026-03-05T00:00:00Z')], meta: {} } };
    },
    async ({ base }) => {
      const out = tempOut('gg-');
      await runScript(SCRIPT, ['--start', '2026-03-01', '--out', out], env(base));

      const [c] = readJsonl(join(out, 'conversations.jsonl'));
      assert.equal(c.source, 'gorgias');
      assert.equal(c.source_id, '1');
      assert.equal(c.status, 'closed');
      assert.equal(c.channel, 'email');
      assert.equal(c.customer_id, '901');
      assert.deepEqual(c.tags, ['billing']);
      for (const field of CANONICAL_CONVERSATION_FIELDS) assert.ok(field in c, `has ${field}`);
      assert.ok(CANONICAL_STATUSES.includes(c.status));
      assert.ok(CANONICAL_CHANNELS.includes(c.channel));

      const messages = readJsonl(join(out, 'messages.jsonl'));
      assert.equal(messages.length, 3);
      assert.equal(messages[0].author_type, 'customer', 'from_agent false means the customer');
      assert.equal(messages[1].author_type, 'agent', 'from_agent true means an agent');
      assert.equal(messages[2].visibility, 'internal', 'public false is an internal note');
      assert.equal(messages[0].conversation_source_id, '1');
      for (const field of CANONICAL_MESSAGE_FIELDS) assert.ok(field in messages[0], `has ${field}`);
    },
  );
});

test('falls back to sender comparison when from_agent is absent', async () => {
  await withMockApi(
    (req) => {
      if (req.url.includes('/messages')) {
        return {
          body: {
            data: [
              message(10, 1, { from_agent: undefined, sender: { id: 901 } }),
              message(11, 1, { from_agent: undefined, sender: { id: 55 } }),
            ],
            meta: {},
          },
        };
      }
      return { body: { data: [ticket(1, '2026-03-05T00:00:00Z')], meta: {} } };
    },
    async ({ base }) => {
      const out = tempOut('gg-');
      await runScript(SCRIPT, ['--start', '2026-03-01', '--out', out], env(base));

      const messages = readJsonl(join(out, 'messages.jsonl'));
      assert.equal(messages[0].author_type, 'customer', 'sender matches the ticket customer');
      assert.equal(messages[1].author_type, 'agent');
    },
  );
});

test('resume skips tickets whose messages were already fetched', async () => {
  let messageCalls = 0;
  await withMockApi(
    (req) => {
      if (req.url.includes('/messages')) {
        messageCalls++;
        return { body: { data: [message(100 + messageCalls, 1)], meta: {} } };
      }
      return {
        body: { data: [ticket(1, '2026-03-05T00:00:00Z'), ticket(2, '2026-03-04T00:00:00Z')], meta: {} },
      };
    },
    async ({ base }) => {
      const out = tempOut('gg-');
      const e = env(base);
      await runScript(SCRIPT, ['--start', '2026-03-01', '--out', out], e);
      assert.equal(messageCalls, 2);

      await runScript(SCRIPT, ['--resume', '--out', out], e);
      assert.equal(messageCalls, 2, 'resume re-fetched nothing');
    },
  );
});

test('401 explains the Basic auth username/password split', async () => {
  await withMockApi(
    () => ({ status: 401, body: { error: 'unauthorized' } }),
    async ({ base }) => {
      const out = tempOut('gg-');
      const { code, stderr } = await runScript(
        SCRIPT,
        ['--start', '2026-03-01', '--only', 'conversations', '--out', out],
        env(base),
      );
      assert.equal(code, 1);
      assert.match(stderr, /GORGIAS_API_KEY/);
      assert.match(stderr, /not the key alone/);
    },
  );
});
