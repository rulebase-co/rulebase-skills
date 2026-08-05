/**
 * Tests for the HubSpot export script. The behaviour that matters most is
 * detecting HubSpot's silent email-body truncation, since a truncated body is
 * indistinguishable from a short one without the truncationStatus field.
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
  CANONICAL_AUTHOR_TYPES,
} from './helpers/mock-api.mjs';

const SCRIPT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../skills/hubspot/hubspot-export-conversations/scripts/export-conversations.mjs',
);

const env = (base, extra = {}) => ({
  HUBSPOT_ACCESS_TOKEN: 'placeholder-not-a-real-token',
  HUBSPOT_API_BASE: base,
  HUBSPOT_RATE_PER_SEC: '500',
  ...extra,
});

const thread = (id, latest, extra = {}) => ({
  id,
  status: 'CLOSED',
  createdAt: '2026-03-01T10:00:00Z',
  latestMessageTimestamp: latest,
  assignedTo: 'A-55',
  inboxId: '7',
  ...extra,
});

const msg = (id, extra = {}) => ({
  id,
  type: 'MESSAGE',
  createdAt: '2026-03-01T10:01:00Z',
  senders: [{ actorId: 'V-900' }],
  text: 'where is my refund',
  truncationStatus: 'NOT_TRUNCATED',
  attachments: [],
  ...extra,
});

test('pages threads with the after cursor and stops at the watermark', async () => {
  await withMockApi(
    (req) => {
      if (req.url.includes('after=p2')) {
        return {
          body: {
            results: [thread('3', '2026-03-02T00:00:00Z'), thread('4', '2025-01-01T00:00:00Z')],
            paging: { next: { after: 'p3' } },
          },
        };
      }
      return {
        body: {
          results: [thread('1', '2026-03-05T00:00:00Z'), thread('2', '2026-03-04T00:00:00Z')],
          paging: { next: { after: 'p2' } },
        },
      };
    },
    async ({ base, calls, urls }) => {
      const out = tempOut('hs-');
      const { summary, stderr } = await runScript(
        SCRIPT,
        ['--start', '2026-03-01', '--only', 'conversations', '--out', out],
        env(base),
      );

      assert.match(urls()[0], /limit=500/);
      assert.match(urls()[1], /after=p2/);
      assert.match(stderr, /reached the watermark/);
      assert.equal(summary.skipped_older_than_watermark, 1);
      assert.deepEqual(
        readJsonl(join(out, 'conversations.jsonl')).map((c) => c.source_id),
        ['1', '2', '3'],
      );
      assert.equal(calls.length, 2);
    },
  );
});

test('detects silent truncation and reports the export as incomplete', async () => {
  await withMockApi(
    (req) => {
      if (req.url.includes('/messages')) {
        return {
          body: {
            results: [
              msg('m1'),
              msg('m2', { truncationStatus: 'TRUNCATED' }),
              msg('m3', { truncationStatus: 'TRUNCATED_TO_MOST_RECENT_REPLY' }),
            ],
            paging: {},
          },
        };
      }
      return { body: { results: [thread('1', '2026-03-05T00:00:00Z')], paging: {} } };
    },
    async ({ base }) => {
      const out = tempOut('hs-');
      const { summary, stderr } = await runScript(
        SCRIPT,
        ['--start', '2026-03-01', '--out', out],
        env(base),
      );

      assert.equal(summary.truncated_messages, 2);
      assert.equal(summary.bodies_complete, false, 'truncation makes the bodies incomplete');
      assert.deepEqual(summary.truncation, {
        NOT_TRUNCATED: 1,
        TRUNCATED: 1,
        TRUNCATED_TO_MOST_RECENT_REPLY: 1,
        UNKNOWN: 0,
      });
      assert.match(stderr, /truncated/);
      assert.match(stderr, /NOT complete messages/);

      const messages = readJsonl(join(out, 'messages.jsonl'));
      assert.equal(messages[1].truncation_status, 'TRUNCATED', 'status is on every message');
    },
  );
});

test('maps actorId prefixes to author types', async () => {
  await withMockApi(
    (req) => {
      if (req.url.includes('/messages')) {
        return {
          body: {
            results: [
              msg('m1', { senders: [{ actorId: 'V-900' }] }),
              msg('m2', { senders: [{ actorId: 'A-55' }] }),
              msg('m3', { senders: [{ actorId: 'I-3' }] }),
              msg('m4', { senders: [{ actorId: 'S-1' }] }),
              msg('m5', { senders: [{ actorId: 'Z-9' }] }),
            ],
            paging: {},
          },
        };
      }
      return { body: { results: [thread('1', '2026-03-05T00:00:00Z')], paging: {} } };
    },
    async ({ base }) => {
      const out = tempOut('hs-');
      await runScript(SCRIPT, ['--start', '2026-03-01', '--out', out], env(base));

      const types = readJsonl(join(out, 'messages.jsonl')).map((m) => m.author_type);
      assert.deepEqual(types, ['customer', 'agent', 'bot', 'system', 'unknown']);
      for (const t of types) assert.ok(CANONICAL_AUTHOR_TYPES.includes(t));
    },
  );
});

test('COMMENT type is an internal note', async () => {
  await withMockApi(
    (req) => {
      if (req.url.includes('/messages')) {
        return { body: { results: [msg('m1'), msg('m2', { type: 'COMMENT' })], paging: {} } };
      }
      return { body: { results: [thread('1', '2026-03-05T00:00:00Z')], paging: {} } };
    },
    async ({ base }) => {
      const out = tempOut('hs-');
      await runScript(SCRIPT, ['--start', '2026-03-01', '--out', out], env(base));

      const messages = readJsonl(join(out, 'messages.jsonl'));
      assert.equal(messages[0].visibility, 'public');
      assert.equal(messages[1].visibility, 'internal');
    },
  );
});

test('--archived opts into soft-deleted threads and is remembered on resume', async () => {
  await withMockApi(
    () => ({ body: { results: [thread('1', '2026-03-05T00:00:00Z')], paging: {} } }),
    async ({ base, urls }) => {
      const out = tempOut('hs-');
      const { summary, stderr } = await runScript(
        SCRIPT,
        ['--start', '2026-03-01', '--only', 'conversations', '--archived', '--out', out],
        env(base),
      );

      assert.match(urls()[0], /archived=true/);
      assert.equal(summary.archived_included, true);
      assert.match(stderr, /30 days/, 'warns that archived threads are deleted permanently');
      assert.equal(readJsonl(join(out, 'conversations.jsonl'))[0].is_deleted, true);
    },
  );
});

test('--inbox-id sends a single inbox filter', async () => {
  await withMockApi(
    () => ({ body: { results: [], paging: {} } }),
    async ({ base, urls }) => {
      const out = tempOut('hs-');
      const { summary } = await runScript(
        SCRIPT,
        ['--start', '2026-03-01', '--only', 'conversations', '--inbox-id', '42', '--out', out],
        env(base),
      );
      assert.match(urls()[0], /inboxId=42/);
      assert.equal(summary.inbox_id, '42');
    },
  );
});

test('canonical fields are present and channel is left null rather than guessed', async () => {
  await withMockApi(
    (req) => {
      if (req.url.includes('/messages')) {
        return { body: { results: [msg('m1', { channelId: 'EMAIL' })], paging: {} } };
      }
      return {
        body: { results: [thread('1', '2026-03-05T00:00:00Z', { latestMessagePreview: 'hi' })], paging: {} },
      };
    },
    async ({ base }) => {
      const out = tempOut('hs-');
      await runScript(SCRIPT, ['--start', '2026-03-01', '--out', out], env(base));

      const [c] = readJsonl(join(out, 'conversations.jsonl'));
      for (const field of CANONICAL_CONVERSATION_FIELDS) assert.ok(field in c, `has ${field}`);
      assert.equal(c.channel, null, 'thread objects carry no channel');
      assert.equal(c.subject, null, 'a message preview is not a subject');

      const [m] = readJsonl(join(out, 'messages.jsonl'));
      for (const field of CANONICAL_MESSAGE_FIELDS) assert.ok(field in m, `has ${field}`);
      assert.equal(m.channel, 'email', 'channel comes from the message');
    },
  );
});

test('401 names the scope and the reinstall requirement', async () => {
  await withMockApi(
    () => ({ status: 401, body: { message: 'nope' } }),
    async ({ base }) => {
      const out = tempOut('hs-');
      const { code, stderr } = await runScript(
        SCRIPT,
        ['--start', '2026-03-01', '--only', 'conversations', '--out', out],
        env(base),
      );
      assert.equal(code, 1);
      assert.match(stderr, /conversations\.read/);
      assert.match(stderr, /reinstalled/);
    },
  );
});
