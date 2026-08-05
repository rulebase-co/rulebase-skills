/**
 * Integration test for the Zendesk export script, run against an in-process
 * mock of the Incremental Exports API.
 *
 * Covers the paths that break in production and never get exercised by a
 * happy-path manual run: cursor pagination, comment extraction from mixed
 * child_events, author attribution across two independent streams, 429 +
 * Retry-After backoff, checkpoint/resume, and the non-advancing end_time guard.
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
} from './helpers/mock-api.mjs';

const SCRIPT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../skills/zendesk/zendesk-export-conversations/scripts/export-conversations.mjs',
);

const env = (base, extra = {}) => ({
  ZENDESK_SUBDOMAIN: 'mock',
  ZENDESK_EMAIL: 'svc@example.com',
  ZENDESK_API_TOKEN: 'placeholder-not-a-real-token',
  ZENDESK_MIN_INTERVAL_MS: '1',
  ZENDESK_BASE_URL: base,
  ...extra,
});

function ticket(id, extra = {}) {
  return {
    id,
    subject: `Ticket ${id}`,
    status: id % 7 === 0 ? 'deleted' : 'solved',
    via: { channel: 'email' },
    requester_id: 1000 + id,
    assignee_id: 55,
    group_id: 3,
    organization_id: 9,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-02T00:00:00Z',
    tags: ['billing'],
    satisfaction_rating: { score: 'good' },
    ...extra,
  };
}

/** An event carrying one real comment plus noise children, as Zendesk does. */
function event(id, ticketId, timestamp, commentExtra = {}) {
  return {
    id,
    ticket_id: ticketId,
    timestamp,
    updater_id: 55,
    via: { channel: 'email' },
    child_events: [
      { id: id * 10 + 1, event_type: 'Change', field_name: 'status', value: 'solved' },
      {
        id: id * 10 + 2,
        event_type: 'Comment',
        author_id: 77,
        public: true,
        body: 'quoted history and earlier message',
        plain_body: 'the actual message',
        html_body: '<p>the actual message</p>',
        attachments: [{ id: 9 }],
        ...commentExtra,
      },
      { id: id * 10 + 3, event_type: 'Notification', recipients: [1] },
    ],
  };
}

test('paginates tickets by cursor until end_of_stream', async () => {
  await withMockApi(
    (req) => {
      if (req.url.includes('cursor=page2')) {
        return { body: { tickets: [ticket(3)], after_cursor: null, end_of_stream: true } };
      }
      return {
        body: { tickets: [ticket(1), ticket(2)], after_cursor: 'page2', end_of_stream: false },
      };
    },
    async ({ base, urls }) => {
      const out = tempOut('zd-');
      const { code, summary } = await runScript(
        SCRIPT,
        ['--start', '2026-01-01', '--only', 'conversations', '--out', out],
        env(base),
      );

      assert.equal(code, 0);
      const conversations = readJsonl(join(out, 'conversations.jsonl'));
      assert.equal(conversations.length, 3, 'follows the cursor to the second page');
      assert.deepEqual(conversations.map((c) => c.source_id), ['1', '2', '3']);
      assert.equal(summary.conversations_complete, true);

      assert.match(urls()[1], /cursor=page2/);
      assert.ok(!urls()[1].includes('start_time'), 'cursor request drops start_time');
    },
  );
});

test('normalises tickets to the canonical conversation shape', async () => {
  await withMockApi(
    () => ({ body: { tickets: [ticket(7), ticket(8)], end_of_stream: true } }),
    async ({ base }) => {
      const out = tempOut('zd-');
      await runScript(
        SCRIPT,
        ['--start', '2026-01-01', '--only', 'conversations', '--out', out],
        env(base),
      );

      const [deleted, kept] = readJsonl(join(out, 'conversations.jsonl'));

      assert.equal(deleted.source, 'zendesk');
      assert.equal(deleted.source_id, '7', 'ids are stringified');
      assert.equal(typeof deleted.source_id, 'string');
      assert.equal(deleted.status, 'deleted');
      assert.equal(deleted.is_deleted, true);
      assert.equal(deleted.channel, 'email', 'via.channel flattened and mapped');
      assert.equal(deleted.channel_raw, 'email');
      assert.equal(deleted.customer_id, '1007');
      assert.equal(deleted.team_id, '3');
      assert.equal(deleted.account_id, '9');

      assert.equal(kept.status, 'resolved', 'zendesk "solved" maps to canonical "resolved"');
      assert.equal(kept.status_raw, 'solved', 'the distinction is preserved');
      assert.equal(kept.is_deleted, false);
      assert.equal(kept.csat, 1, 'satisfaction "good" normalises to 1');
      assert.equal(kept.csat_raw, 'good');

      for (const field of CANONICAL_CONVERSATION_FIELDS) {
        assert.ok(field in kept, `canonical field ${field} present`);
      }
      assert.ok(CANONICAL_STATUSES.includes(kept.status));
      assert.ok(CANONICAL_CHANNELS.includes(kept.channel));
    },
  );
});

test('maps hold to pending and keeps the raw status', async () => {
  await withMockApi(
    () => ({
      body: {
        tickets: [ticket(1, { status: 'hold' }), ticket(2, { status: 'pending' })],
        end_of_stream: true,
      },
    }),
    async ({ base }) => {
      const out = tempOut('zd-');
      await runScript(
        SCRIPT,
        ['--start', '2026-01-01', '--only', 'conversations', '--out', out],
        env(base),
      );

      const [hold, pending] = readJsonl(join(out, 'conversations.jsonl'));
      assert.equal(hold.status, 'pending');
      assert.equal(hold.status_raw, 'hold', 'agent-blocked vs customer-blocked stays recoverable');
      assert.equal(pending.status, 'pending');
      assert.equal(pending.status_raw, 'pending');
    },
  );
});

test('does not turn "offered"/"unoffered" survey states into a zero score', async () => {
  await withMockApi(
    () => ({
      body: {
        tickets: [
          ticket(1, { satisfaction_rating: { score: 'offered' } }),
          ticket(2, { satisfaction_rating: { score: 'bad' } }),
        ],
        end_of_stream: true,
      },
    }),
    async ({ base }) => {
      const out = tempOut('zd-');
      await runScript(
        SCRIPT,
        ['--start', '2026-01-01', '--only', 'conversations', '--out', out],
        env(base),
      );

      const [offered, bad] = readJsonl(join(out, 'conversations.jsonl'));
      assert.equal(offered.csat, null, '"offered" means a survey was sent, not a bad score');
      assert.equal(offered.csat_raw, 'offered');
      assert.equal(bad.csat, 0, '"bad" is a real zero');
    },
  );
});

test('extracts only Comment children and prefers plain_body', async () => {
  await withMockApi(
    (req) => {
      if (req.url.includes('/incremental/tickets/')) {
        return { body: { tickets: [ticket(4242)], end_of_stream: true } };
      }
      return {
        body: {
          ticket_events: [event(1, 4242, 1767225600), event(2, 4242, 1767225601)],
          end_time: 1767225601,
          end_of_stream: true,
        },
      };
    },
    async ({ base, urls }) => {
      const out = tempOut('zd-');
      await runScript(SCRIPT, ['--start', '2026-01-01', '--out', out], env(base));

      const messages = readJsonl(join(out, 'messages.jsonl'));
      assert.equal(messages.length, 2, 'Change and Notification children are ignored');

      const [first] = messages;
      assert.equal(first.source, 'zendesk');
      assert.equal(first.conversation_source_id, '4242', 'joins to conversations.source_id');
      assert.equal(first.body, 'the actual message', 'uses plain_body, not body');
      assert.equal(first.author_id, '77');
      assert.equal(first.visibility, 'public');
      assert.equal(first.attachment_count, 1);
      assert.equal(
        first.created_at,
        new Date(1767225600 * 1000).toISOString(),
        'event Unix timestamp converted to ISO',
      );

      for (const field of CANONICAL_MESSAGE_FIELDS) {
        assert.ok(field in first, `canonical field ${field} present`);
      }
      assert.ok(urls().some((u) => u.includes('include=comment_events')), 'requests the sideload');
    },
  );
});

test('attributes authors by comparing against the ticket requester', async () => {
  await withMockApi(
    (req) => {
      if (req.url.includes('/incremental/tickets/')) {
        // requester_id is 1001 for ticket 1.
        return { body: { tickets: [ticket(1)], end_of_stream: true } };
      }
      return {
        body: {
          ticket_events: [
            event(1, 1, 1767225600, { author_id: 1001 }), // the customer
            event(2, 1, 1767225601, { author_id: 55 }), // an agent
          ],
          end_time: 1767225601,
          end_of_stream: true,
        },
      };
    },
    async ({ base }) => {
      const out = tempOut('zd-');
      await runScript(SCRIPT, ['--start', '2026-01-01', '--out', out], env(base));

      const messages = readJsonl(join(out, 'messages.jsonl'));
      assert.equal(messages[0].author_type, 'customer', 'author matching requester_id');
      assert.equal(messages[1].author_type, 'agent', 'anyone else is an agent');
    },
  );
});

test('marks author_type unknown and warns when the ticket index is missing', async () => {
  await withMockApi(
    () => ({
      body: {
        ticket_events: [event(1, 999, 1767225600)],
        end_time: 1767225600,
        end_of_stream: true,
      },
    }),
    async ({ base }) => {
      const out = tempOut('zd-');
      const { stderr } = await runScript(
        SCRIPT,
        ['--start', '2026-01-01', '--only', 'messages', '--out', out],
        env(base),
      );

      const [message] = readJsonl(join(out, 'messages.jsonl'));
      assert.equal(
        message.author_type,
        'unknown',
        'without the conversation index, attribution is not guessed',
      );
      assert.match(stderr, /no conversations\.jsonl to index/);
      assert.match(stderr, /Run the tickets stream first/, 'tells the user how to fix it');
    },
  );
});

test('a non-public comment becomes an internal message', async () => {
  await withMockApi(
    (req) => {
      if (req.url.includes('/incremental/tickets/')) {
        return { body: { tickets: [ticket(1)], end_of_stream: true } };
      }
      return {
        body: {
          ticket_events: [event(1, 1, 1767225600, { public: false })],
          end_time: 1767225600,
          end_of_stream: true,
        },
      };
    },
    async ({ base }) => {
      const out = tempOut('zd-');
      await runScript(SCRIPT, ['--start', '2026-01-01', '--out', out], env(base));

      const [message] = readJsonl(join(out, 'messages.jsonl'));
      assert.equal(message.visibility, 'internal');
    },
  );
});

test('--no-bodies keeps structure but drops message text', async () => {
  await withMockApi(
    (req) => {
      if (req.url.includes('/incremental/tickets/')) {
        return { body: { tickets: [ticket(1)], end_of_stream: true } };
      }
      return {
        body: { ticket_events: [event(1, 1, 1767225600)], end_time: 1767225600, end_of_stream: true },
      };
    },
    async ({ base }) => {
      const out = tempOut('zd-');
      const { summary } = await runScript(
        SCRIPT,
        ['--start', '2026-01-01', '--no-bodies', '--out', out],
        env(base),
      );

      const [message] = readJsonl(join(out, 'messages.jsonl'));
      assert.equal(message.body, null);
      assert.equal(message.visibility, 'public', 'metadata is retained');
      assert.equal(summary.bodies_included, false);
    },
  );
});

test('honours Retry-After on 429 and then succeeds', async () => {
  await withMockApi(
    (req, n) => {
      if (n === 1) {
        return { status: 429, headers: { 'retry-after': '0' }, body: { error: 'rate limited' } };
      }
      return { body: { tickets: [ticket(1)], end_of_stream: true } };
    },
    async ({ base, calls }) => {
      const out = tempOut('zd-');
      const { code, stderr } = await runScript(
        SCRIPT,
        ['--start', '2026-01-01', '--only', 'conversations', '--out', out],
        env(base),
      );

      assert.equal(code, 0, 'a 429 is retried, not fatal');
      assert.match(stderr, /rate limited/);
      assert.equal(calls.length, 2, 'retries the same page once');
      assert.equal(readJsonl(join(out, 'conversations.jsonl')).length, 1);
    },
  );
});

test('fails fast on 401 with an actionable message', async () => {
  await withMockApi(
    () => ({ status: 401, body: { error: 'could not authenticate' } }),
    async ({ base }) => {
      const out = tempOut('zd-');
      const { code, stderr } = await runScript(
        SCRIPT,
        ['--start', '2026-01-01', '--only', 'conversations', '--out', out],
        env(base),
      );

      assert.equal(code, 1);
      assert.match(stderr, /ZENDESK_API_TOKEN/, 'names the fix');
      assert.match(stderr, /token access/);
    },
  );
});

test('checkpoints each page and resumes from the stored cursor', async () => {
  await withMockApi(
    (req) => {
      if (req.url.includes('cursor=page2')) {
        return { body: { tickets: [ticket(2)], after_cursor: null, end_of_stream: true } };
      }
      return { body: { tickets: [ticket(1)], after_cursor: 'page2', end_of_stream: false } };
    },
    async ({ base }) => {
      const out = tempOut('zd-');
      const e = env(base);

      await runScript(
        SCRIPT,
        ['--start', '2026-01-01', '--only', 'conversations', '--max-pages', '1', '--out', out],
        e,
      );

      const checkpoint = JSON.parse(readFileSync(join(out, 'checkpoint.json'), 'utf8'));
      assert.equal(checkpoint.ticketCursor, 'page2', 'cursor persisted after page 1');
      assert.notEqual(checkpoint.ticketsDone, true);
      assert.equal(readJsonl(join(out, 'conversations.jsonl')).length, 1);

      const { code, summary } = await runScript(
        SCRIPT,
        ['--resume', '--only', 'conversations', '--out', out],
        e,
      );

      assert.equal(code, 0);
      assert.equal(summary.conversations_complete, true);
      assert.deepEqual(
        readJsonl(join(out, 'conversations.jsonl')).map((c) => c.source_id),
        ['1', '2'],
        'resume appends page 2 without re-fetching page 1',
      );
    },
  );
});

test('refuses to loop when time-based end_time cannot advance', async () => {
  await withMockApi(
    () => ({
      body: { ticket_events: [event(1, 1, 1767225600)], end_time: 1767225600, end_of_stream: false },
    }),
    async ({ base, calls }) => {
      const out = tempOut('zd-');
      const { code, stderr } = await runScript(
        SCRIPT,
        ['--start', '1767225600', '--only', 'messages', '--out', out],
        env(base),
      );

      assert.equal(code, 1, 'exits rather than spinning');
      assert.match(stderr, /end_time did not advance/);
      assert.ok(calls.length < 5, `bailed quickly, made ${calls.length} calls`);
    },
  );
});

test('clamps a start time inside the replication-lag window', async () => {
  await withMockApi(
    () => ({ body: { tickets: [], end_of_stream: true } }),
    async ({ base }) => {
      const out = tempOut('zd-');
      const { stderr, summary } = await runScript(
        SCRIPT,
        ['--start', String(Math.floor(Date.now() / 1000)), '--only', 'conversations', '--out', out],
        env(base),
      );

      assert.match(stderr, /replication lag/);
      assert.ok(
        summary.start_time <= Math.floor(Date.now() / 1000) - 60,
        'start time pushed at least a minute into the past',
      );
    },
  );
});

test('--resume without a checkpoint fails instead of silently restarting', async () => {
  const out = tempOut('zd-');
  const { code, stderr } = await runScript(SCRIPT, ['--resume', '--out', out], env('http://127.0.0.1:1'));
  assert.equal(code, 1);
  assert.match(stderr, /no checkpoint/);
});

test('rejects an unknown --only value', async () => {
  const out = tempOut('zd-');
  const { code, stderr } = await runScript(
    SCRIPT,
    ['--start', '30d', '--only', 'tickets', '--out', out],
    env('http://127.0.0.1:1'),
  );
  assert.equal(code, 1);
  assert.match(stderr, /--only must be one of: both, conversations, messages/);
});
