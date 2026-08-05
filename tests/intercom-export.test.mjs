/**
 * Tests for the Intercom export script. The interesting behaviour is the
 * unavoidable N+1 for message bodies: cursor paging in phase 1, per-id
 * journalled progress in phase 2, and detection of Intercom's silent 500-part
 * truncation.
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
  CANONICAL_AUTHOR_TYPES,
} from './helpers/mock-api.mjs';

const SCRIPT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../skills/intercom/intercom-export-conversations/scripts/export-conversations.mjs',
);

const env = (base, extra = {}) => ({
  INTERCOM_ACCESS_TOKEN: 'placeholder-not-a-real-token',
  INTERCOM_API_BASE: base,
  ...extra,
});

const listed = (id, extra = {}) => ({
  id,
  title: `Conversation ${id}`,
  state: 'closed',
  open: false,
  created_at: 1767225600,
  updated_at: 1767225900,
  admin_assignee_id: 55,
  team_assignee_id: 7,
  source: { type: 'conversation', delivered_as: 'email', id: `src${id}`, author: { id: '900', type: 'user' } },
  contacts: { contacts: [{ id: '900' }] },
  conversation_rating: { rating: 4 },
  tags: { tags: [{ name: 'billing' }] },
  ...extra,
});

/** A detail response: source message plus a mix of message and workflow parts. */
const detail = (id, parts, extra = {}) => ({
  ...listed(id),
  source: {
    type: 'conversation',
    delivered_as: 'email',
    id: `src${id}`,
    body: '<p>Original <b>question</b></p>',
    author: { id: '900', type: 'user' },
    attachments: [],
  },
  conversation_parts: {
    total_count: parts.length,
    conversation_parts: parts,
  },
  ...extra,
});

const part = (id, partType, extra = {}) => ({
  id,
  part_type: partType,
  body: '<p>a reply</p>',
  created_at: 1767225800,
  author: { id: '55', type: 'admin' },
  attachments: [],
  ...extra,
});

test('pages the search endpoint by starting_after and filters on updated_at', async () => {
  await withMockApi(
    (req, n) => {
      if (n === 1) {
        return { body: { conversations: [listed(1), listed(2)], pages: { next: { starting_after: 'cur2' } }, total_count: 3 } };
      }
      return { body: { conversations: [listed(3)], pages: {}, total_count: 3 } };
    },
    async ({ base, calls }) => {
      const out = tempOut('ic-');
      const { code, summary } = await runScript(
        SCRIPT,
        ['--start', '2026-01-01', '--only', 'conversations', '--out', out],
        env(base),
      );

      assert.equal(code, 0);
      assert.equal(summary.conversations, 3);
      assert.equal(summary.search_complete, true);

      assert.equal(calls[0].method, 'POST');
      assert.equal(calls[0].url, '/conversations/search');
      assert.equal(calls[0].body.query.field, 'updated_at');
      assert.equal(calls[0].body.query.operator, '>');
      assert.equal(calls[0].body.pagination.per_page, 150);
      assert.equal(calls[0].body.pagination.starting_after, undefined, 'no cursor on the first page');

      assert.equal(calls[1].body.pagination.starting_after, 'cur2', 'cursor carried to page 2');
    },
  );
});

test('pins the API version on every request', async () => {
  await withMockApi(
    () => ({ body: { conversations: [], pages: {} } }),
    async ({ base, calls }) => {
      const out = tempOut('ic-');
      await runScript(SCRIPT, ['--start', '2026-01-01', '--only', 'conversations', '--out', out], env(base));
      assert.equal(calls[0].headers['intercom-version'], '2.14', 'default version is pinned');
    },
  );

  await withMockApi(
    () => ({ body: { conversations: [], pages: {} } }),
    async ({ base, calls }) => {
      const out = tempOut('ic-');
      await runScript(
        SCRIPT,
        ['--start', '2026-01-01', '--only', 'conversations', '--out', out],
        env(base, { INTERCOM_API_VERSION: '2.11' }),
      );
      assert.equal(calls[0].headers['intercom-version'], '2.11', 'override respected');
    },
  );
});

test('normalises conversations to the canonical shape, including 1-5 CSAT', async () => {
  await withMockApi(
    () => ({ body: { conversations: [listed(1), listed(2, { state: 'snoozed', open: true, conversation_rating: { rating: 1 } })], pages: {} } }),
    async ({ base }) => {
      const out = tempOut('ic-');
      await runScript(SCRIPT, ['--start', '2026-01-01', '--only', 'conversations', '--out', out], env(base));

      const [a, b] = readJsonl(join(out, 'conversations.jsonl'));

      assert.equal(a.source, 'intercom');
      assert.equal(a.source_id, '1');
      assert.equal(a.status, 'closed');
      assert.equal(a.channel, 'email');
      assert.equal(a.channel_raw, 'email');
      assert.equal(a.customer_id, '900');
      assert.equal(a.assignee_id, '55');
      assert.deepEqual(a.tags, ['billing']);
      assert.equal(a.created_at, new Date(1767225600 * 1000).toISOString(), 'epoch converted to ISO');
      // Rating 4 of 5 -> 0.75 on the canonical 0-1 scale, raw preserved.
      assert.equal(a.csat, 0.75);
      assert.equal(a.csat_raw, 4);

      assert.equal(b.status, 'snoozed');
      assert.equal(b.csat, 0, 'rating 1 is the floor, not null');
      assert.equal(b.csat_raw, 1);

      for (const field of CANONICAL_CONVERSATION_FIELDS) {
        assert.ok(field in a, `canonical field ${field} present`);
      }
    },
  );
});

test('extracts the source message plus comments, ignoring workflow parts', async () => {
  await withMockApi(
    (req) => {
      if (req.url === '/conversations/search') {
        return { body: { conversations: [listed(1)], pages: {} } };
      }
      return {
        body: detail(1, [
          part(10, 'assignment'),
          part(11, 'comment'),
          part(12, 'close'),
          part(13, 'note', { body: '<p>internal thought</p>' }),
        ]),
      };
    },
    async ({ base }) => {
      const out = tempOut('ic-');
      await runScript(SCRIPT, ['--start', '2026-01-01', '--out', out], env(base));

      const messages = readJsonl(join(out, 'messages.jsonl'));
      // source message + comment + note = 3; assignment and close are dropped.
      assert.equal(messages.length, 3);

      const [source, comment, note] = messages;
      assert.equal(source.author_type, 'customer', 'source author type "user" maps to customer');
      assert.equal(source.body, 'Original question', 'HTML stripped');
      assert.equal(source.visibility, 'public');

      assert.equal(comment.author_type, 'agent', '"admin" maps to agent');
      assert.equal(comment.visibility, 'public');

      assert.equal(note.visibility, 'internal', 'note is an internal message');

      for (const field of CANONICAL_MESSAGE_FIELDS) {
        assert.ok(field in comment, `canonical field ${field} present`);
      }
      assert.ok(CANONICAL_AUTHOR_TYPES.includes(comment.author_type));
      assert.equal(comment.conversation_source_id, '1');
    },
  );
});

test('maps bot and operator authors to the bot author type', async () => {
  await withMockApi(
    (req) => {
      if (req.url === '/conversations/search') return { body: { conversations: [listed(1)], pages: {} } };
      return {
        body: detail(1, [
          part(10, 'comment', { author: { id: 'fin', type: 'bot' } }),
          part(11, 'comment', { author: { id: 'op', type: 'operator' } }),
          part(12, 'comment', { author: { id: 'zzz', type: 'something_new' } }),
        ]),
      };
    },
    async ({ base }) => {
      const out = tempOut('ic-');
      await runScript(SCRIPT, ['--start', '2026-01-01', '--out', out], env(base));

      const types = readJsonl(join(out, 'messages.jsonl')).map((m) => m.author_type);
      assert.deepEqual(types, ['customer', 'bot', 'bot', 'unknown']);
      assert.ok(
        !types.includes(undefined),
        'an unrecognised author type degrades to "unknown", never undefined',
      );
    },
  );
});

test('falls back to the contact id when the author type is unrecognised', async () => {
  await withMockApi(
    (req) => {
      if (req.url === '/conversations/search') return { body: { conversations: [listed(1)], pages: {} } };
      return {
        body: detail(1, [part(10, 'comment', { author: { id: '900', type: 'mystery' } })]),
      };
    },
    async ({ base }) => {
      const out = tempOut('ic-');
      await runScript(SCRIPT, ['--start', '2026-01-01', '--out', out], env(base));

      const messages = readJsonl(join(out, 'messages.jsonl'));
      const reply = messages.find((m) => m.source_id === '10');
      assert.equal(
        reply.author_type,
        'customer',
        'author id matching the conversation contact resolves the type',
      );
    },
  );
});

test('detects and warns about the silent 500-part truncation', async () => {
  await withMockApi(
    (req) => {
      if (req.url === '/conversations/search') return { body: { conversations: [listed(1)], pages: {} } };
      return {
        body: detail(1, [part(10, 'comment')], {
          conversation_parts: { total_count: 900, conversation_parts: [part(10, 'comment')] },
        }),
      };
    },
    async ({ base }) => {
      const out = tempOut('ic-');
      const { stderr, summary } = await runScript(SCRIPT, ['--start', '2026-01-01', '--out', out], env(base));

      assert.equal(summary.truncated_conversations, 1);
      assert.match(stderr, /500-part cap/);
      assert.match(stderr, /not retrievable/, 'states the data is unrecoverable');
    },
  );
});

test('journals each fetched id so resume does not repeat the N+1', async () => {
  let detailCalls = 0;
  await withMockApi(
    (req) => {
      if (req.url === '/conversations/search') {
        return { body: { conversations: [listed(1), listed(2)], pages: {} } };
      }
      detailCalls++;
      const id = Number(req.url.split('/').pop());
      return { body: detail(id, [part(id * 10, 'comment')]) };
    },
    async ({ base }) => {
      const out = tempOut('ic-');
      const e = env(base);

      await runScript(SCRIPT, ['--start', '2026-01-01', '--out', out], e);
      assert.equal(detailCalls, 2, 'both conversations fetched');

      const fetched = readFileSync(join(out, 'fetched-ids.txt'), 'utf8').trim().split('\n');
      assert.deepEqual(fetched.sort(), ['1', '2']);

      await runScript(SCRIPT, ['--resume', '--out', out], e);
      assert.equal(detailCalls, 2, 'resume re-fetched nothing');
    },
  );
});

test('waits when the rate-limit window is nearly exhausted', async () => {
  await withMockApi(
    (req, n) => {
      const headers = {
        'content-type': 'application/json',
        // Drive the limiter to its floor on the first response. The reset is set
        // two seconds out: because the header is whole seconds, a +1 reset can
        // land almost immediately and makes the timing assertion below flaky.
        'x-ratelimit-remaining': n === 1 ? '1' : '5000',
        'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 2),
      };
      if (n === 1) {
        return { headers, body: { conversations: [listed(1)], pages: { next: { starting_after: 'c2' } } } };
      }
      return { headers, body: { conversations: [], pages: {} } };
    },
    async ({ base }) => {
      const out = tempOut('ic-');
      const started = Date.now();
      const { code, stderr } = await runScript(
        SCRIPT,
        ['--start', '2026-01-01', '--only', 'conversations', '--out', out],
        env(base),
      );

      assert.equal(code, 0);
      assert.match(stderr, /rate-limit window nearly exhausted/);
      // Reset is 2s out on a whole-second boundary, so the wait is 1-2s.
      assert.ok(
        Date.now() - started >= 1000,
        `actually paused for the window to roll over (waited ${Date.now() - started}ms)`,
      );
    },
  );
});

test('honours Retry-After on 429', async () => {
  await withMockApi(
    (req, n) => {
      if (n === 1) return { status: 429, headers: { 'retry-after': '0' }, body: { errors: [] } };
      return { body: { conversations: [listed(1)], pages: {} } };
    },
    async ({ base }) => {
      const out = tempOut('ic-');
      const { code, stderr } = await runScript(
        SCRIPT,
        ['--start', '2026-01-01', '--only', 'conversations', '--out', out],
        env(base),
      );
      assert.equal(code, 0);
      assert.match(stderr, /429 from Intercom/);
      assert.equal(readJsonl(join(out, 'conversations.jsonl')).length, 1);
    },
  );
});

test('401 names the scope the token needs', async () => {
  await withMockApi(
    () => ({ status: 401, body: { errors: [{ code: 'unauthorized' }] } }),
    async ({ base }) => {
      const out = tempOut('ic-');
      const { code, stderr } = await runScript(
        SCRIPT,
        ['--start', '2026-01-01', '--only', 'conversations', '--out', out],
        env(base),
      );
      assert.equal(code, 1);
      assert.match(stderr, /INTERCOM_ACCESS_TOKEN/);
      assert.match(stderr, /Read conversations/);
    },
  );
});

test('rejects an out-of-range concurrency instead of hammering the API', async () => {
  const out = tempOut('ic-');
  const { code, stderr } = await runScript(
    SCRIPT,
    ['--start', '2026-01-01', '--concurrency', '50', '--out', out],
    env('http://127.0.0.1:1'),
  );
  assert.equal(code, 1);
  assert.match(stderr, /--concurrency must be an integer between 1 and 20/);
});
