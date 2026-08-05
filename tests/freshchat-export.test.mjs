/**
 * Tests for the Freshchat export script. Freshchat has no list-conversations
 * endpoint, so id discovery through the Reports API is the whole game — and it
 * has to tolerate the report shape differing by account.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
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
  '../skills/freshchat/freshchat-export-conversations/scripts/export-conversations.mjs',
);

const { extractConversationIds } = await import(SCRIPT);

const env = (base, extra = {}) => ({
  FRESHCHAT_DOMAIN: 'mock',
  FRESHCHAT_API_TOKEN: 'placeholder-not-a-real-token',
  FRESHCHAT_API_BASE: base,
  FRESHCHAT_MIN_INTERVAL_MS: '1',
  ...extra,
});

const conversation = (id) => ({
  conversation_id: id,
  status: 'resolved',
  channel_id: 'ch1',
  users: [{ id: `u_${id}` }],
  assigned_agent_id: 'ag_1',
  assigned_group_id: 'gr_1',
  created_time: '2026-03-01T10:00:00Z',
  updated_time: '2026-03-01T10:10:00Z',
  labels: [{ name: 'billing' }],
});

const message = (id, convId, extra = {}) => ({
  id,
  conversation_id: convId,
  actor_type: 'user',
  actor_id: `u_${convId}`,
  message_type: 'normal',
  created_time: '2026-03-01T10:01:00Z',
  message_parts: [{ text: { content: 'where is my refund' } }],
  ...extra,
});

/** Routes report create -> poll -> artifact download -> conversation -> messages. */
function plan({ artifact, artifactPath = '/artifact.csv' }) {
  return (req) => {
    if (req.method === 'POST' && req.url.includes('/v2/reports/raw')) {
      return { body: { id: 'rep1' } };
    }
    if (req.url.includes('/v2/reports/raw/rep1')) {
      return { body: { status: 'COMPLETED', link: `http://127.0.0.1:PORT${artifactPath}` } };
    }
    if (req.url === artifactPath) {
      return { headers: { 'content-type': 'text/csv' }, body: artifact };
    }
    const messagesMatch = /\/v2\/conversations\/([^/]+)\/messages/.exec(req.url);
    if (messagesMatch) {
      return { body: { messages: [message(`m_${messagesMatch[1]}`, messagesMatch[1])] } };
    }
    const convMatch = /\/v2\/conversations\/([^/?]+)$/.exec(req.url);
    if (convMatch) return { body: conversation(convMatch[1]) };
    return { status: 404, body: {} };
  };
}

/** The mock needs its own port inside the artifact link, so patch it at runtime. */
function planWithPort(config) {
  const base = plan(config);
  return (req, n, body) => {
    const reply = base(req, n, body);
    if (reply.body && typeof reply.body === 'object' && typeof reply.body.link === 'string') {
      return {
        ...reply,
        body: { ...reply.body, link: reply.body.link.replace('127.0.0.1:PORT', req.headers.host) },
      };
    }
    return reply;
  };
}

// --- id extraction, exercised directly ---

test('extracts ids from a CSV report', () => {
  const { ids, format } = extractConversationIds(
    'Conversation ID,Created Time\n"c1","2026-03-01"\n"c2","2026-03-01"\n',
  );
  assert.equal(format, 'csv');
  assert.deepEqual(ids, ['c1', 'c2']);
});

test('accepts alternative id column spellings', () => {
  for (const header of ['conversation_id', 'ConversationId', 'CONV ID', 'Conversation Reference Id']) {
    const { ids } = extractConversationIds(`${header},Other\n"c1","x"\n`);
    assert.deepEqual(ids, ['c1'], `header "${header}" should be recognised`);
  }
});

test('extracts ids from a JSON report and dedupes', () => {
  const { ids, format } = extractConversationIds(
    JSON.stringify({ records: [{ conversation_id: 'c1' }, { conversation_id: 'c1' }, { conversation_id: 'c2' }] }),
  );
  assert.equal(format, 'json');
  assert.deepEqual(ids, ['c1', 'c2']);
});

test('reports the headers it saw when no id column is present', () => {
  const { ids, headers } = extractConversationIds('Agent,Created Time\n"Ada","2026-03-01"\n');
  assert.deepEqual(ids, []);
  assert.deepEqual(headers, ['Agent', 'Created Time'], 'headers are surfaced for diagnosis');
});

// --- export behaviour ---

test('discovers ids via the reports API, then hydrates and fetches messages', async () => {
  await withMockApi(
    planWithPort({ artifact: 'Conversation ID\n"c1"\n"c2"\n' }),
    async ({ base, calls }) => {
      const out = tempOut('fc-');
      const { code, summary, stderr } = await runScript(
        SCRIPT,
        ['--start', '2026-03-01', '--end', '2026-03-02', '--out', out],
        env(base),
      );

      assert.equal(code, 0, `stderr: ${stderr}`);
      assert.equal(summary.discovered, 2);
      assert.equal(summary.conversations, 2);
      assert.equal(summary.messages, 2);
      assert.equal(summary.complete, true);

      const post = calls.find((c) => c.method === 'POST');
      assert.match(post.url, /\/v2\/reports\/raw/);
      assert.ok(post.body.start && post.body.end, 'the report is windowed');

      const [c] = readJsonl(join(out, 'conversations.jsonl'));
      assert.equal(c.source, 'freshchat');
      assert.equal(c.status, 'resolved');
      assert.equal(c.channel, 'chat', 'Freshchat is a messaging product');
      assert.equal(c.customer_id, 'u_c1');
      assert.deepEqual(c.tags, ['billing']);
      for (const field of CANONICAL_CONVERSATION_FIELDS) assert.ok(field in c, `has ${field}`);

      const [m] = readJsonl(join(out, 'messages.jsonl'));
      assert.equal(m.author_type, 'customer', 'actor_type user');
      assert.equal(m.body, 'where is my refund', 'text comes from message_parts');
      assert.equal(m.visibility, 'public');
      for (const field of CANONICAL_MESSAGE_FIELDS) assert.ok(field in m, `has ${field}`);
    },
  );
});

test('fails with an actionable message when the report has no id column', async () => {
  await withMockApi(
    planWithPort({ artifact: 'Agent,Created Time\n"Ada","2026-03-01"\n' }),
    async ({ base }) => {
      const out = tempOut('fc-');
      const { code, stderr } = await runScript(
        SCRIPT,
        ['--start', '2026-03-01', '--out', out],
        env(base),
      );

      assert.equal(code, 1);
      assert.match(stderr, /no conversation ids found/);
      assert.match(stderr, /Columns seen: Agent, Created Time/, 'shows what the report contained');
      assert.match(stderr, /--ids-file/, 'names the escape hatch');
    },
  );
});

test('--ids-file bypasses report discovery entirely', async () => {
  await withMockApi(
    planWithPort({ artifact: '' }),
    async ({ base, calls }) => {
      const out = tempOut('fc-');
      const idsFile = join(out, 'ids.txt');
      writeFileSync(idsFile, 'c1\nc2\nc1\n');

      const { code, summary, stderr } = await runScript(
        SCRIPT,
        ['--ids-file', idsFile, '--out', out],
        env(base),
      );

      assert.equal(code, 0, `stderr: ${stderr}`);
      assert.equal(summary.discovered, 2, 'duplicate id deduped');
      assert.equal(summary.conversations, 2);
      assert.ok(
        !calls.some((c) => c.method === 'POST'),
        'no report was requested',
      );
    },
  );
});

test('reports ids from the report that no longer resolve', async () => {
  await withMockApi(
    (req, n, body) => {
      if (req.method === 'POST' && req.url.includes('/v2/reports/raw')) return { body: { id: 'rep1' } };
      if (req.url.includes('/v2/reports/raw/rep1')) {
        return { body: { status: 'COMPLETED', link: `http://${req.headers.host}/artifact.csv` } };
      }
      if (req.url === '/artifact.csv') {
        return { headers: { 'content-type': 'text/csv' }, body: 'Conversation ID\n"c1"\n"gone"\n' };
      }
      if (/\/v2\/conversations\/gone/.test(req.url)) return { status: 404, body: {} };
      const messagesMatch = /\/v2\/conversations\/([^/]+)\/messages/.exec(req.url);
      if (messagesMatch) return { body: { messages: [] } };
      const convMatch = /\/v2\/conversations\/([^/?]+)$/.exec(req.url);
      if (convMatch) return { body: conversation(convMatch[1]) };
      return { status: 404, body: {} };
    },
    async ({ base }) => {
      const out = tempOut('fc-');
      const { summary, stderr } = await runScript(
        SCRIPT,
        ['--start', '2026-03-01', '--out', out],
        env(base),
      );

      assert.equal(summary.discovered, 2);
      assert.equal(summary.conversations, 1, 'only the resolvable conversation was written');
      assert.equal(summary.unresolved_ids, 1);
      assert.equal(summary.complete, false, 'unresolved ids make the export incomplete');
      assert.match(stderr, /did not resolve/);
    },
  );
});

test('maps actor types and treats private messages as internal', async () => {
  await withMockApi(
    (req, n, body) => {
      if (req.method === 'POST') return { body: { id: 'rep1' } };
      if (req.url.includes('/v2/reports/raw/rep1')) {
        return { body: { status: 'COMPLETED', link: `http://${req.headers.host}/artifact.csv` } };
      }
      if (req.url === '/artifact.csv') return { body: 'Conversation ID\n"c1"\n' };
      if (/\/messages/.test(req.url)) {
        return {
          body: {
            messages: [
              message('m1', 'c1', { actor_type: 'user' }),
              message('m2', 'c1', { actor_type: 'agent' }),
              message('m3', 'c1', { actor_type: 'bot' }),
              message('m4', 'c1', { actor_type: 'agent', message_type: 'private' }),
            ],
          },
        };
      }
      const convMatch = /\/v2\/conversations\/([^/?]+)$/.exec(req.url);
      if (convMatch) return { body: conversation(convMatch[1]) };
      return { status: 404, body: {} };
    },
    async ({ base }) => {
      const out = tempOut('fc-');
      await runScript(SCRIPT, ['--start', '2026-03-01', '--out', out], env(base));

      const messages = readJsonl(join(out, 'messages.jsonl'));
      assert.deepEqual(
        messages.map((m) => m.author_type),
        ['customer', 'agent', 'bot', 'agent'],
      );
      assert.equal(messages[3].visibility, 'internal', 'message_type private is an agent note');
      assert.equal(messages[0].visibility, 'public');
    },
  );
});

test('resume skips discovery and already-processed conversations', async () => {
  let convCalls = 0;
  await withMockApi(
    (req, n, body) => {
      if (req.method === 'POST') return { body: { id: 'rep1' } };
      if (req.url.includes('/v2/reports/raw/rep1')) {
        return { body: { status: 'COMPLETED', link: `http://${req.headers.host}/artifact.csv` } };
      }
      if (req.url === '/artifact.csv') return { body: 'Conversation ID\n"c1"\n"c2"\n' };
      if (/\/messages/.test(req.url)) return { body: { messages: [] } };
      const convMatch = /\/v2\/conversations\/([^/?]+)$/.exec(req.url);
      if (convMatch) {
        convCalls++;
        return { body: conversation(convMatch[1]) };
      }
      return { status: 404, body: {} };
    },
    async ({ base, calls }) => {
      const out = tempOut('fc-');
      const e = env(base);
      await runScript(SCRIPT, ['--start', '2026-03-01', '--out', out], e);
      assert.equal(convCalls, 2);
      const postsBefore = calls.filter((c) => c.method === 'POST').length;

      await runScript(SCRIPT, ['--resume', '--out', out], e);
      assert.equal(convCalls, 2, 'conversations were not re-hydrated');
      assert.equal(
        calls.filter((c) => c.method === 'POST').length,
        postsBefore,
        'no second report was requested',
      );
    },
  );
});

test('a failed report aborts rather than reporting zero conversations', async () => {
  await withMockApi(
    (req) => {
      if (req.method === 'POST') return { body: { id: 'rep1' } };
      return { body: { status: 'FAILED' } };
    },
    async ({ base }) => {
      const out = tempOut('fc-');
      const { code, stderr } = await runScript(
        SCRIPT,
        ['--start', '2026-03-01', '--out', out],
        env(base),
      );
      assert.equal(code, 1);
      assert.match(stderr, /failed on Freshchat's side/);
    },
  );
});

test('401 distinguishes report access from conversation access', async () => {
  await withMockApi(
    () => ({ status: 403, body: {} }),
    async ({ base }) => {
      const out = tempOut('fc-');
      const { code, stderr } = await runScript(
        SCRIPT,
        ['--start', '2026-03-01', '--out', out],
        env(base),
      );
      assert.equal(code, 1);
      assert.match(stderr, /report access/);
      assert.match(stderr, /agent-scoped token/);
    },
  );
});
