/**
 * Tests for the Freshdesk export script. The load-bearing behaviour is the
 * moving-watermark walk that escapes the 300-page ceiling, so that gets the
 * most attention. PAGE_SIZE and MAX_PAGE are overridden via env so the ceiling
 * can be reached in a handful of mocked pages.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
  CANONICAL_AUTHOR_TYPES,
} from './helpers/mock-api.mjs';

const SCRIPT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../skills/freshdesk/freshdesk-export-conversations/scripts/export-conversations.mjs',
);

const env = (base, extra = {}) => ({
  FRESHDESK_DOMAIN: 'mock',
  FRESHDESK_API_KEY: 'placeholder-not-a-real-key',
  FRESHDESK_API_BASE: base,
  FRESHDESK_PAGE_SIZE: '2',
  FRESHDESK_MAX_PAGE: '3',
  ...extra,
});

const ticket = (id, updatedAt, extra = {}) => ({
  id,
  subject: `Ticket ${id}`,
  status: 4,
  source: 1,
  priority: 2,
  requester_id: 1000 + id,
  responder_id: 55,
  group_id: 7,
  company_id: 9,
  created_at: '2026-03-01T10:00:00Z',
  updated_at: updatedAt,
  tags: ['billing'],
  ...extra,
});

const reply = (id, ticketId, extra = {}) => ({
  id,
  ticket_id: ticketId,
  user_id: 77,
  body: '<p>Hello <b>there</b></p>',
  body_text: 'Hello there',
  private: false,
  incoming: true,
  created_at: '2026-03-01T10:01:00Z',
  attachments: [],
  ...extra,
});

const parseQuery = (url) => Object.fromEntries(new URL(`http://x${url}`).searchParams);

test('requests ascending order and updated_since, which is what makes the walk safe', async () => {
  await withMockApi(
    () => ({ body: [] }),
    async ({ base, urls }) => {
      const out = tempOut('fd-');
      await runScript(SCRIPT, ['--start', '2026-01-01', '--only', 'conversations', '--out', out], env(base));

      const q = parseQuery(urls()[0]);
      assert.equal(q.order_by, 'updated_at');
      assert.equal(q.order_type, 'asc', 'descending order would make the ceiling inescapable');
      assert.ok(q.updated_since.startsWith('2026-01-01'), 'updated_since is set');
      assert.equal(q.per_page, '2');
    },
  );
});

test('rolls the watermark forward at the page ceiling and keeps going', async () => {
  // MAX_PAGE=3, PAGE_SIZE=2. Pages 1-3 of the first window are full, forcing a
  // watermark roll; the second window returns a short page and finishes.
  const windows = {
    '2026-01-01T00:00:00.000Z': [
      [ticket(1, '2026-01-02T00:00:00Z'), ticket(2, '2026-01-03T00:00:00Z')],
      [ticket(3, '2026-01-04T00:00:00Z'), ticket(4, '2026-01-05T00:00:00Z')],
      [ticket(5, '2026-01-06T00:00:00Z'), ticket(6, '2026-01-07T00:00:00Z')],
    ],
    '2026-01-07T00:00:00Z': [[ticket(7, '2026-01-08T00:00:00Z')]],
  };

  await withMockApi(
    (req) => {
      const q = parseQuery(req.url);
      const pages = windows[q.updated_since];
      if (!pages) return { body: [] };
      return { body: pages[Number(q.page) - 1] ?? [] };
    },
    async ({ base, urls }) => {
      const out = tempOut('fd-');
      const { code, summary, stderr } = await runScript(
        SCRIPT,
        ['--start', '2026-01-01', '--only', 'conversations', '--out', out],
        env(base),
      );

      assert.equal(code, 0);
      assert.match(stderr, /advancing watermark to 2026-01-07/);

      const ids = readJsonl(join(out, 'conversations.jsonl')).map((c) => Number(c.source_id));
      assert.deepEqual(ids, [1, 2, 3, 4, 5, 6, 7], 'all tickets exported across both windows');
      assert.equal(summary.list_complete, true);
      assert.equal(summary.final_watermark, '2026-01-07T00:00:00Z');

      // Page counter must reset to 1 for the new window.
      const secondWindow = urls().filter((u) => u.includes('2026-01-07'));
      assert.ok(secondWindow.length > 0);
      assert.equal(parseQuery(secondWindow[0]).page, '1', 'paging restarts in the new window');
    },
  );
});

test('fails loudly when the watermark cannot advance at the ceiling', async () => {
  // Every ticket shares one updated_at, so rolling the watermark would loop.
  await withMockApi(
    () => ({
      body: [ticket(1, '2026-01-01T00:00:00.000Z'), ticket(2, '2026-01-01T00:00:00.000Z')],
    }),
    async ({ base, calls }) => {
      const out = tempOut('fd-');
      const { code, stderr } = await runScript(
        SCRIPT,
        ['--start', '2026-01-01', '--only', 'conversations', '--out', out],
        env(base),
      );

      assert.equal(code, 1, 'exits rather than spinning on the same window');
      assert.match(stderr, /watermark did not advance/);
      assert.ok(calls.length <= 4, `bailed at the ceiling, made ${calls.length} calls`);
    },
  );
});

test('stops on a short page without needing the ceiling', async () => {
  await withMockApi(
    (req) => {
      const q = parseQuery(req.url);
      if (q.page === '1') return { body: [ticket(1, '2026-01-02T00:00:00Z')] };
      return { body: [] };
    },
    async ({ base, calls }) => {
      const out = tempOut('fd-');
      const { summary } = await runScript(
        SCRIPT,
        ['--start', '2026-01-01', '--only', 'conversations', '--out', out],
        env(base),
      );
      assert.equal(summary.list_complete, true);
      assert.equal(calls.length, 1, 'a short page ends the walk immediately');
    },
  );
});

test('maps Freshdesk numeric codes to the canonical vocabulary', async () => {
  await withMockApi(
    (req) =>
      parseQuery(req.url).page === '1'
        ? {
            body: [
              ticket(1, '2026-01-02T00:00:00Z', { status: 2, source: 3, priority: 4 }),
              ticket(2, '2026-01-03T00:00:00Z', { status: 5, source: 7, priority: 1, deleted: true }),
            ],
          }
        : { body: [] },
    async ({ base }) => {
      const out = tempOut('fd-');
      await runScript(SCRIPT, ['--start', '2026-01-01', '--only', 'conversations', '--out', out], env(base));

      const [a, b] = readJsonl(join(out, 'conversations.jsonl'));

      assert.equal(a.status, 'open');
      assert.equal(a.status_raw, 2, 'raw code retained');
      assert.equal(a.channel, 'voice');
      assert.equal(a.priority, 'urgent');
      assert.equal(a.source, 'freshdesk');
      assert.equal(a.customer_id, '1001', 'ids are stringified');

      assert.equal(b.status, 'closed');
      assert.equal(b.channel, 'chat');
      assert.equal(b.priority, 'low');
      assert.equal(b.is_deleted, true);

      for (const field of CANONICAL_CONVERSATION_FIELDS) {
        assert.ok(field in a, `canonical field ${field} present`);
      }
      assert.ok(CANONICAL_STATUSES.includes(a.status));
      assert.ok(CANONICAL_CHANNELS.includes(a.channel));
    },
  );
});

test('treats an unknown custom status as open rather than dropping the ticket', async () => {
  await withMockApi(
    (req) =>
      parseQuery(req.url).page === '1'
        ? { body: [ticket(1, '2026-01-02T00:00:00Z', { status: 42 })] }
        : { body: [] },
    async ({ base }) => {
      const out = tempOut('fd-');
      await runScript(SCRIPT, ['--start', '2026-01-01', '--only', 'conversations', '--out', out], env(base));

      const [t] = readJsonl(join(out, 'conversations.jsonl'));
      assert.equal(t.status, 'open');
      assert.equal(t.status_raw, 42, 'the custom code is preserved for auditing');
    },
  );
});

test('normalises replies, distinguishing internal notes and customer messages', async () => {
  await withMockApi(
    (req) => {
      if (req.url.includes('/conversations?')) {
        const q = parseQuery(req.url);
        if (q.page !== '1') return { body: [] };
        return {
          body: [
            reply(10, 1),
            reply(11, 1, { private: true, incoming: false, user_id: 55, body_text: 'internal note' }),
            reply(12, 1, { incoming: false, user_id: 55, body_text: 'agent reply' }),
          ],
        };
      }
      const q = parseQuery(req.url);
      return q.page === '1' ? { body: [ticket(1, '2026-01-02T00:00:00Z')] } : { body: [] };
    },
    async ({ base }) => {
      const out = tempOut('fd-');
      await runScript(SCRIPT, ['--start', '2026-01-01', '--out', out], env(base));

      const messages = readJsonl(join(out, 'messages.jsonl'));
      assert.equal(messages.length, 3);

      const [incoming, note, agent] = messages;
      assert.equal(incoming.author_type, 'customer', 'incoming=true means the customer');
      assert.equal(incoming.visibility, 'public');
      assert.equal(incoming.body, 'Hello there', 'prefers body_text over HTML body');

      assert.equal(note.visibility, 'internal', 'private=true is an internal note');
      assert.equal(note.author_type, 'agent');

      assert.equal(agent.visibility, 'public');
      assert.equal(agent.author_type, 'agent');

      for (const field of CANONICAL_MESSAGE_FIELDS) {
        assert.ok(field in incoming, `canonical field ${field} present`);
      }
      assert.ok(CANONICAL_AUTHOR_TYPES.includes(incoming.author_type));
      assert.equal(incoming.conversation_source_id, '1', 'joins to conversations.source_id');
    },
  );
});

test('falls back to HTML stripping when body_text is absent', async () => {
  await withMockApi(
    (req) => {
      if (req.url.includes('/conversations?')) {
        return parseQuery(req.url).page === '1'
          ? { body: [reply(10, 1, { body_text: undefined, body: '<p>Line one</p><p>Line two</p>' })] }
          : { body: [] };
      }
      return parseQuery(req.url).page === '1'
        ? { body: [ticket(1, '2026-01-02T00:00:00Z')] }
        : { body: [] };
    },
    async ({ base }) => {
      const out = tempOut('fd-');
      await runScript(SCRIPT, ['--start', '2026-01-01', '--out', out], env(base));

      const [message] = readJsonl(join(out, 'messages.jsonl'));
      assert.equal(message.body, 'Line one\n\nLine two');
      assert.ok(!message.body.includes('<'), 'no markup survives');
    },
  );
});

test('--no-bodies keeps message structure but drops text', async () => {
  await withMockApi(
    (req) => {
      if (req.url.includes('/conversations?')) {
        return parseQuery(req.url).page === '1' ? { body: [reply(10, 1)] } : { body: [] };
      }
      return parseQuery(req.url).page === '1'
        ? { body: [ticket(1, '2026-01-02T00:00:00Z')] }
        : { body: [] };
    },
    async ({ base }) => {
      const out = tempOut('fd-');
      const { summary } = await runScript(
        SCRIPT,
        ['--start', '2026-01-01', '--no-bodies', '--out', out],
        env(base),
      );

      const [message] = readJsonl(join(out, 'messages.jsonl'));
      assert.equal(message.body, null);
      assert.equal(message.author_type, 'customer', 'metadata retained');
      assert.equal(summary.bodies_included, false);
    },
  );
});

test('resume skips tickets whose text was already fetched', async () => {
  let conversationCalls = 0;
  await withMockApi(
    (req) => {
      if (req.url.includes('/conversations?')) {
        conversationCalls++;
        return parseQuery(req.url).page === '1'
          ? { body: [reply(100 + conversationCalls, Number(req.url.match(/tickets\/(\d+)/)[1]))] }
          : { body: [] };
      }
      const q = parseQuery(req.url);
      return q.page === '1'
        ? { body: [ticket(1, '2026-01-02T00:00:00Z'), ticket(2, '2026-01-03T00:00:00Z')] }
        : { body: [] };
    },
    async ({ base }) => {
      const out = tempOut('fd-');
      const e = env(base);

      await runScript(SCRIPT, ['--start', '2026-01-01', '--out', out], e);
      const firstPass = conversationCalls;
      assert.equal(firstPass, 2, 'both tickets fetched on the first run');

      const fetched = readFileSync(join(out, 'fetched-ids.txt'), 'utf8').trim().split('\n');
      assert.deepEqual(fetched.sort(), ['1', '2']);

      await runScript(SCRIPT, ['--resume', '--out', out], e);
      assert.equal(conversationCalls, firstPass, 'resume re-fetched nothing');
    },
  );
});

test('honours Retry-After on 429', async () => {
  await withMockApi(
    (req, n) => {
      if (n === 1) return { status: 429, headers: { 'retry-after': '0' }, body: { error: 'throttled' } };
      return parseQuery(req.url).page === '1'
        ? { body: [ticket(1, '2026-01-02T00:00:00Z')] }
        : { body: [] };
    },
    async ({ base }) => {
      const out = tempOut('fd-');
      const { code, stderr } = await runScript(
        SCRIPT,
        ['--start', '2026-01-01', '--only', 'conversations', '--out', out],
        env(base),
      );
      assert.equal(code, 0);
      assert.match(stderr, /429 from Freshdesk/);
      assert.equal(readJsonl(join(out, 'conversations.jsonl')).length, 1);
    },
  );
});

test('401 names the scoped-agent trap, not just the credentials', async () => {
  await withMockApi(
    () => ({ status: 401, body: { message: 'nope' } }),
    async ({ base }) => {
      const out = tempOut('fd-');
      const { code, stderr } = await runScript(
        SCRIPT,
        ['--start', '2026-01-01', '--only', 'conversations', '--out', out],
        env(base),
      );
      assert.equal(code, 1);
      assert.match(stderr, /FRESHDESK_API_KEY/);
      assert.match(stderr, /silently exports a subset/, 'warns about agent ticket scope');
    },
  );
});
