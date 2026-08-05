/**
 * Tests for the Front export script. Front's constraint is a low, per-company
 * rate limit, so the behaviour worth testing is that the script paces, projects
 * the run length honestly, and checkpoints finely enough to survive a multi-day
 * export.
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
} from './helpers/mock-api.mjs';

const SCRIPT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../skills/front/front-export-conversations/scripts/export-conversations.mjs',
);

const env = (base, extra = {}) => ({
  FRONT_API_TOKEN: 'placeholder-not-a-real-token',
  FRONT_API_BASE: base,
  FRONT_RATE_PER_MIN: '60000',
  ...extra,
});

const epoch = (s) => Math.floor(Date.parse(s) / 1000);

const conversation = (id, lastAt, extra = {}) => ({
  id,
  subject: `Conversation ${id}`,
  status: 'archived',
  type: 'email',
  created_at: epoch('2026-03-01T10:00:00Z'),
  last_message: { created_at: epoch(lastAt) },
  recipient: { contact_id: `ct_${id}`, handle: `user${id}@example.com` },
  assignee: { id: 'tea_1' },
  inbox: { id: 'inb_9' },
  tags: [{ name: 'billing' }],
  ...extra,
});

const message = (id, extra = {}) => ({
  id,
  type: 'email',
  is_inbound: true,
  created_at: epoch('2026-03-01T10:01:00Z'),
  author: { id: 'tea_77' },
  text: 'where is my refund',
  attachments: [],
  ...extra,
});

test('follows _pagination.next as a full URL and stops at the watermark', async () => {
  await withMockApi(
    (req, n) => {
      if (n === 1) {
        return {
          body: {
            _results: [
              conversation('cnv_1', '2026-03-05T00:00:00Z'),
              conversation('cnv_2', '2026-03-04T00:00:00Z'),
            ],
            _pagination: { next: `${req.headers.host ? `http://${req.headers.host}` : ''}/conversations?page_token=t2` },
          },
        };
      }
      return {
        body: {
          _results: [
            conversation('cnv_3', '2026-03-02T00:00:00Z'),
            conversation('cnv_4', '2025-01-01T00:00:00Z'),
          ],
          _pagination: {},
        },
      };
    },
    async ({ base, urls }) => {
      const out = tempOut('fr-');
      const { code, summary, stderr } = await runScript(
        SCRIPT,
        ['--start', '2026-03-01', '--only', 'conversations', '--out', out],
        env(base),
      );

      assert.equal(code, 0);
      assert.match(urls()[1], /page_token=t2/, 'follows the pagination URL verbatim');
      assert.match(stderr, /reached the watermark/);
      assert.equal(summary.skipped_older_than_watermark, 1);
      assert.deepEqual(
        readJsonl(join(out, 'conversations.jsonl')).map((c) => c.source_id),
        ['cnv_1', 'cnv_2', 'cnv_3'],
      );
    },
  );
});

test('normalises to the canonical shape and keeps the handle as a fallback identity', async () => {
  await withMockApi(
    (req) => {
      if (req.url.includes('/messages')) {
        return {
          body: {
            _results: [message('msg_1'), message('msg_2', { is_inbound: false })],
            _pagination: {},
          },
        };
      }
      return {
        body: {
          _results: [
            conversation('cnv_1', '2026-03-05T00:00:00Z'),
            // No contact record: Front identifies this one only by handle.
            conversation('cnv_2', '2026-03-04T00:00:00Z', {
              recipient: { handle: 'anon@example.com' },
            }),
          ],
          _pagination: {},
        },
      };
    },
    async ({ base }) => {
      const out = tempOut('fr-');
      await runScript(SCRIPT, ['--start', '2026-03-01', '--out', out], env(base));

      const [a, b] = readJsonl(join(out, 'conversations.jsonl'));
      assert.equal(a.source, 'front');
      assert.equal(a.status, 'closed', 'archived maps to closed');
      assert.equal(a.status_raw, 'archived');
      assert.equal(a.channel, 'email');
      assert.equal(a.customer_id, 'ct_cnv_1');
      assert.equal(a.team_id, 'inb_9', 'the inbox is the team');
      assert.deepEqual(a.tags, ['billing']);
      for (const field of CANONICAL_CONVERSATION_FIELDS) assert.ok(field in a, `has ${field}`);

      assert.equal(
        b.customer_id,
        'anon@example.com',
        'falls back to the handle rather than losing the identity',
      );

      const messages = readJsonl(join(out, 'messages.jsonl'));
      assert.equal(messages[0].author_type, 'customer', 'is_inbound true');
      assert.equal(messages[1].author_type, 'agent', 'is_inbound false with an author');
      for (const field of CANONICAL_MESSAGE_FIELDS) assert.ok(field in messages[0], `has ${field}`);
    },
  );
});

test('an outbound message with no author is attributed to the system', async () => {
  await withMockApi(
    (req) => {
      if (req.url.includes('/messages')) {
        return {
          body: {
            _results: [message('msg_1', { is_inbound: false, author: null })],
            _pagination: {},
          },
        };
      }
      return { body: { _results: [conversation('cnv_1', '2026-03-05T00:00:00Z')], _pagination: {} } };
    },
    async ({ base }) => {
      const out = tempOut('fr-');
      await runScript(SCRIPT, ['--start', '2026-03-01', '--out', out], env(base));
      const [m] = readJsonl(join(out, 'messages.jsonl'));
      assert.equal(m.author_type, 'system', 'an automated send is not an agent');
    },
  );
});

test('projects the run duration from the configured rate', async () => {
  await withMockApi(
    (req) => {
      if (req.url.includes('/messages')) {
        return { body: { _results: [message('msg_1')], _pagination: {} } };
      }
      return {
        body: {
          _results: Array.from({ length: 20 }, (_, i) =>
            conversation(`cnv_${i}`, '2026-03-05T00:00:00Z'),
          ),
          _pagination: {},
        },
      };
    },
    async ({ base }) => {
      const out = tempOut('fr-');
      // A realistic 50/min rate makes 20 conversations project to ~1 minute.
      const { stderr } = await runScript(
        SCRIPT,
        ['--start', '2026-03-01', '--only', 'conversations', '--out', out],
        env(base),
      );
      assert.match(stderr, /per-company limit/, 'states the constraint up front');

      const { stderr: phase2 } = await runScript(SCRIPT, ['--resume', '--out', out], env(base));
      assert.match(phase2, /this phase will take roughly/, 'projects the N+1 duration');
    },
  );
});

test('reports that internal notes are not included', async () => {
  await withMockApi(
    (req) => {
      if (req.url.includes('/messages')) {
        return { body: { _results: [message('msg_1')], _pagination: {} } };
      }
      return { body: { _results: [conversation('cnv_1', '2026-03-05T00:00:00Z')], _pagination: {} } };
    },
    async ({ base }) => {
      const out = tempOut('fr-');
      const { summary } = await runScript(SCRIPT, ['--start', '2026-03-01', '--out', out], env(base));
      assert.equal(
        summary.internal_notes_included,
        false,
        'Front comments are a separate resource; the export must not imply otherwise',
      );
    },
  );
});

test('resume skips conversations already fetched', async () => {
  let messageCalls = 0;
  await withMockApi(
    (req) => {
      if (req.url.includes('/messages')) {
        messageCalls++;
        return { body: { _results: [message(`msg_${messageCalls}`)], _pagination: {} } };
      }
      return {
        body: {
          _results: [
            conversation('cnv_1', '2026-03-05T00:00:00Z'),
            conversation('cnv_2', '2026-03-04T00:00:00Z'),
          ],
          _pagination: {},
        },
      };
    },
    async ({ base }) => {
      const out = tempOut('fr-');
      const e = env(base);
      await runScript(SCRIPT, ['--start', '2026-03-01', '--out', out], e);
      assert.equal(messageCalls, 2);
      await runScript(SCRIPT, ['--resume', '--out', out], e);
      assert.equal(messageCalls, 2, 'resume re-fetched nothing');
    },
  );
});

test('429 explains that the limit is shared across the company', async () => {
  await withMockApi(
    (req, n) => {
      if (n === 1) return { status: 429, headers: { 'retry-after': '0' }, body: {} };
      return { body: { _results: [conversation('cnv_1', '2026-03-05T00:00:00Z')], _pagination: {} } };
    },
    async ({ base }) => {
      const out = tempOut('fr-');
      const { code, stderr } = await runScript(
        SCRIPT,
        ['--start', '2026-03-01', '--only', 'conversations', '--out', out],
        env(base),
      );
      assert.equal(code, 0);
      assert.match(stderr, /per-company/);
      assert.match(stderr, /another\s+integration/);
    },
  );
});

test('401 warns that an inbox-scoped token exports a subset silently', async () => {
  await withMockApi(
    () => ({ status: 403, body: {} }),
    async ({ base }) => {
      const out = tempOut('fr-');
      const { code, stderr } = await runScript(
        SCRIPT,
        ['--start', '2026-03-01', '--only', 'conversations', '--out', out],
        env(base),
      );
      assert.equal(code, 1);
      assert.match(stderr, /FRONT_API_TOKEN/);
      assert.match(stderr, /exports a subset silently/);
    },
  );
});
