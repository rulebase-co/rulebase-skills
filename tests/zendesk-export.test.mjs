/**
 * Integration test for the Zendesk export script, run against an in-process
 * mock of the Incremental Exports API.
 *
 * Covers the paths that break in production and never get exercised by a
 * happy-path manual run: cursor pagination, comment extraction from mixed
 * child_events, 429 + Retry-After backoff, checkpoint/resume, and the
 * non-advancing end_time guard.
 *
 *   node --test tests/
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../skills/zendesk/zendesk-export-conversations/scripts/export-conversations.mjs',
);

function ticket(id) {
  return {
    id,
    subject: `Ticket ${id}`,
    status: id % 7 === 0 ? 'deleted' : 'solved',
    via: { channel: 'email' },
    requester_id: 1000 + id,
    assignee_id: 55,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-02T00:00:00Z',
    tags: ['billing'],
    satisfaction_rating: { score: 'good' },
  };
}

/** An event carrying one real comment plus noise children, as Zendesk does. */
function event(id, ticketId, timestamp) {
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
      },
      { id: id * 10 + 3, event_type: 'Notification', recipients: [1] },
    ],
  };
}

/** Mock Zendesk. `plan(req, callNumber)` scripts the responses a test needs. */
async function withMockZendesk(plan, run) {
  const calls = [];
  const server = createServer((req, res) => {
    calls.push(req.url);
    const reply = plan(req, calls.length);
    res.writeHead(reply.status ?? 200, reply.headers ?? { 'content-type': 'application/json' });
    res.end(typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body ?? {}));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await run({ base, calls });
  } finally {
    server.close();
  }
}

function runScript(args, env) {
  return new Promise((resolvePromise) => {
    execFile(
      process.execPath,
      [SCRIPT, ...args],
      {
        env: {
          ...process.env,
          ZENDESK_SUBDOMAIN: 'mock',
          ZENDESK_EMAIL: 'svc@example.com',
          ZENDESK_API_TOKEN: 'placeholder-not-a-real-token',
          ZENDESK_MIN_INTERVAL_MS: '1',
          ...env,
        },
      },
      (err, stdout, stderr) => resolvePromise({ code: err?.code ?? 0, stdout, stderr }),
    );
  });
}

const readJsonl = (p) =>
  existsSync(p)
    ? readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : [];

test('paginates tickets by cursor until end_of_stream', async () => {
  await withMockZendesk(
    (req) => {
      if (req.url.includes('cursor=page2')) {
        return { body: { tickets: [ticket(3)], after_cursor: null, end_of_stream: true } };
      }
      return {
        body: { tickets: [ticket(1), ticket(2)], after_cursor: 'page2', end_of_stream: false },
      };
    },
    async ({ base, calls }) => {
      const out = mkdtempSync(join(tmpdir(), 'zd-'));
      const { code, stdout } = await runScript(
        ['--start', '2026-01-01', '--only', 'tickets', '--out', out],
        { ZENDESK_BASE_URL: base },
      );

      assert.equal(code, 0);
      const tickets = readJsonl(join(out, 'tickets.jsonl'));
      assert.equal(tickets.length, 3, 'follows the cursor to the second page');
      assert.deepEqual(tickets.map((t) => t.id), [1, 2, 3]);
      assert.equal(JSON.parse(stdout).tickets_complete, true);

      assert.match(calls[1], /cursor=page2/);
      assert.ok(!calls[1].includes('start_time'), 'cursor request drops start_time');
    },
  );
});

test('normalises tickets and flags soft-deleted ones', async () => {
  await withMockZendesk(
    () => ({ body: { tickets: [ticket(7), ticket(8)], end_of_stream: true } }),
    async ({ base }) => {
      const out = mkdtempSync(join(tmpdir(), 'zd-'));
      await runScript(['--start', '2026-01-01', '--only', 'tickets', '--out', out], {
        ZENDESK_BASE_URL: base,
      });

      const [deleted, kept] = readJsonl(join(out, 'tickets.jsonl'));
      assert.equal(deleted.is_deleted, true, 'status "deleted" sets is_deleted');
      assert.equal(kept.is_deleted, false);
      assert.equal(deleted.channel, 'email', 'via.channel is flattened');
      assert.equal(deleted.satisfaction_rating, 'good', 'rating object flattened to score');
    },
  );
});

test('extracts only Comment children and prefers plain_body', async () => {
  await withMockZendesk(
    () => ({
      body: {
        ticket_events: [event(1, 4242, 1767225600), event(2, 4242, 1767225601)],
        end_time: 1767225601,
        end_of_stream: true,
      },
    }),
    async ({ base, calls }) => {
      const out = mkdtempSync(join(tmpdir(), 'zd-'));
      await runScript(['--start', '2026-01-01', '--only', 'comments', '--out', out], {
        ZENDESK_BASE_URL: base,
      });

      const comments = readJsonl(join(out, 'comments.jsonl'));
      assert.equal(comments.length, 2, 'Change and Notification children are ignored');
      assert.equal(comments[0].body, 'the actual message', 'uses plain_body, not body');
      assert.equal(comments[0].ticket_id, 4242);
      assert.equal(comments[0].author_id, 77);
      assert.equal(comments[0].public, true);
      assert.equal(comments[0].attachment_count, 1);
      assert.equal(
        comments[0].created_at,
        new Date(1767225600 * 1000).toISOString(),
        'event Unix timestamp converted to ISO',
      );
      assert.match(calls[0], /include=comment_events/, 'requests the sideload');
    },
  );
});

test('--no-bodies keeps structure but drops message text', async () => {
  await withMockZendesk(
    () => ({
      body: { ticket_events: [event(1, 1, 1767225600)], end_time: 1767225600, end_of_stream: true },
    }),
    async ({ base }) => {
      const out = mkdtempSync(join(tmpdir(), 'zd-'));
      const { stdout } = await runScript(
        ['--start', '2026-01-01', '--only', 'comments', '--no-bodies', '--out', out],
        { ZENDESK_BASE_URL: base },
      );

      const [comment] = readJsonl(join(out, 'comments.jsonl'));
      assert.equal(comment.body, null);
      assert.equal(comment.html_body, null);
      assert.equal(comment.public, true, 'metadata is retained');
      assert.equal(JSON.parse(stdout).bodies_included, false);
    },
  );
});

test('honours Retry-After on 429 and then succeeds', async () => {
  await withMockZendesk(
    (req, n) => {
      if (n === 1) {
        return { status: 429, headers: { 'retry-after': '0' }, body: { error: 'rate limited' } };
      }
      return { body: { tickets: [ticket(1)], end_of_stream: true } };
    },
    async ({ base, calls }) => {
      const out = mkdtempSync(join(tmpdir(), 'zd-'));
      const { code, stderr } = await runScript(
        ['--start', '2026-01-01', '--only', 'tickets', '--out', out],
        { ZENDESK_BASE_URL: base },
      );

      assert.equal(code, 0, 'a 429 is retried, not fatal');
      assert.match(stderr, /rate limited/);
      assert.equal(calls.length, 2, 'retries the same page once');
      assert.equal(readJsonl(join(out, 'tickets.jsonl')).length, 1);
    },
  );
});

test('fails fast on 401 with an actionable message', async () => {
  await withMockZendesk(
    () => ({ status: 401, body: { error: 'could not authenticate' } }),
    async ({ base }) => {
      const out = mkdtempSync(join(tmpdir(), 'zd-'));
      const { code, stderr } = await runScript(
        ['--start', '2026-01-01', '--only', 'tickets', '--out', out],
        { ZENDESK_BASE_URL: base },
      );

      assert.equal(code, 1);
      assert.match(stderr, /ZENDESK_API_TOKEN/, 'names the fix');
      assert.match(stderr, /token access/);
    },
  );
});

test('checkpoints each page and resumes from the stored cursor', async () => {
  await withMockZendesk(
    (req) => {
      if (req.url.includes('cursor=page2')) {
        return { body: { tickets: [ticket(2)], after_cursor: null, end_of_stream: true } };
      }
      return { body: { tickets: [ticket(1)], after_cursor: 'page2', end_of_stream: false } };
    },
    async ({ base }) => {
      const out = mkdtempSync(join(tmpdir(), 'zd-'));
      const env = { ZENDESK_BASE_URL: base };

      await runScript(
        ['--start', '2026-01-01', '--only', 'tickets', '--max-pages', '1', '--out', out],
        env,
      );

      const checkpoint = JSON.parse(readFileSync(join(out, 'checkpoint.json'), 'utf8'));
      assert.equal(checkpoint.ticketCursor, 'page2', 'cursor persisted after page 1');
      assert.notEqual(checkpoint.ticketsDone, true);
      assert.equal(readJsonl(join(out, 'tickets.jsonl')).length, 1);

      const { code, stdout } = await runScript(['--resume', '--only', 'tickets', '--out', out], env);

      assert.equal(code, 0);
      assert.equal(JSON.parse(stdout).tickets_complete, true);
      const tickets = readJsonl(join(out, 'tickets.jsonl'));
      assert.deepEqual(
        tickets.map((t) => t.id),
        [1, 2],
        'resume appends page 2 without re-fetching page 1',
      );
    },
  );
});

test('refuses to loop when time-based end_time cannot advance', async () => {
  await withMockZendesk(
    () => ({
      body: { ticket_events: [event(1, 1, 1767225600)], end_time: 1767225600, end_of_stream: false },
    }),
    async ({ base, calls }) => {
      const out = mkdtempSync(join(tmpdir(), 'zd-'));
      const { code, stderr } = await runScript(
        ['--start', '1767225600', '--only', 'comments', '--out', out],
        { ZENDESK_BASE_URL: base },
      );

      assert.equal(code, 1, 'exits rather than spinning');
      assert.match(stderr, /end_time did not advance/);
      assert.ok(calls.length < 5, `bailed quickly, made ${calls.length} calls`);
    },
  );
});

test('clamps a start time inside the replication-lag window', async () => {
  await withMockZendesk(
    () => ({ body: { tickets: [], end_of_stream: true } }),
    async ({ base }) => {
      const out = mkdtempSync(join(tmpdir(), 'zd-'));
      const { stderr, stdout } = await runScript(
        ['--start', String(Math.floor(Date.now() / 1000)), '--only', 'tickets', '--out', out],
        { ZENDESK_BASE_URL: base },
      );

      assert.match(stderr, /replication lag/);
      const startTime = JSON.parse(stdout).start_time;
      assert.ok(
        startTime <= Math.floor(Date.now() / 1000) - 60,
        'start time pushed at least a minute into the past',
      );
    },
  );
});

test('--resume without a checkpoint fails instead of silently restarting', async () => {
  const out = mkdtempSync(join(tmpdir(), 'zd-'));
  const { code, stderr } = await runScript(['--resume', '--out', out], {});
  assert.equal(code, 1);
  assert.match(stderr, /no checkpoint/);
});
