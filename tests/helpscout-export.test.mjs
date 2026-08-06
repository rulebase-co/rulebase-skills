/**
 * Tests for the Help Scout export.
 *
 * The two that matter most encode the traps documented in the skill: the list
 * endpoint defaults to status=active (so the export must send status=all
 * explicitly, or it silently loses most of the account's history), and
 * `lineitem` threads are state changes rather than messages.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withMockApi, runScript, tempOut, readJsonl } from './helpers/mock-api.mjs';

const SCRIPT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../skills/helpscout/helpscout-export-conversations/scripts/export-conversations.mjs',
);

const env = (base, extra = {}) => ({
  HELPSCOUT_CLIENT_ID: 'placeholder-id',
  HELPSCOUT_CLIENT_SECRET: 'placeholder-secret',
  HELPSCOUT_BASE_URL: base,
  ...extra,
});

const conversation = (id, over = {}) => ({
  id,
  subject: `Subject ${id}`,
  status: 'closed',
  type: 'email',
  mailboxId: 10,
  primaryCustomer: { id: 900 + id },
  assignee: { id: 5 },
  createdAt: '2026-07-01T10:00:00Z',
  userUpdatedAt: '2026-07-02T10:00:00Z',
  closedAt: '2026-07-02T10:00:00Z',
  tags: [{ tag: 'billing' }],
  ...over,
});

const thread = (id, over = {}) => ({
  id,
  type: 'message',
  body: `body ${id}`,
  createdAt: '2026-07-01T10:05:00Z',
  createdBy: { id: 5, type: 'user' },
  attachments: [],
  ...over,
});

/** Mock Help Scout: OAuth, mailboxes, HAL-paginated conversations and threads. */
function planner({ conversations = [conversation(1)], threads = [thread(100)], mailboxes = [{ id: 10, name: 'Support' }], rateLimitOnce = false } = {}) {
  let throttled = false;
  return (req) => {
    if (req.url === '/v2/oauth2/token') {
      return { status: 200, body: { access_token: 'placeholder-token', expires_in: 7200 } };
    }
    if (req.url.startsWith('/v2/mailboxes')) {
      return { status: 200, body: { _embedded: { mailboxes } } };
    }
    if (req.url.startsWith('/v2/conversations?')) {
      if (rateLimitOnce && !throttled) {
        throttled = true;
        return { status: 429, headers: { 'x-ratelimit-retry-after': '1', 'content-type': 'application/json' }, body: {} };
      }
      return {
        status: 200,
        headers: { 'x-ratelimit-limit-minute': '400', 'x-ratelimit-remaining-minute': '399', 'content-type': 'application/json' },
        body: { _embedded: { conversations }, page: { number: 1, size: 25, totalElements: conversations.length, totalPages: 1 } },
      };
    }
    if (/^\/v2\/conversations\/\d+\/threads/.test(req.url)) {
      return {
        status: 200,
        body: { _embedded: { threads }, page: { number: 1, size: 25, totalElements: threads.length, totalPages: 1 } },
      };
    }
    return { status: 404, body: { error: 'not found' } };
  };
}

test('sends status=all by default, because the API default silently omits closed conversations', async () => {
  const dir = tempOut('hs-status-');
  await withMockApi(planner(), async ({ base, calls }) => {
    const res = await runScript(SCRIPT, ['--out', dir], env(base));
    assert.equal(res.code, 0);

    const listCall = calls.find((c) => c.url.startsWith('/v2/conversations?'));
    assert.ok(listCall, 'expected a conversations list request');
    assert.match(listCall.url, /status=all/);
    assert.equal(res.summary.status, 'all');
  });
});

test('warns when a narrower status is requested', async () => {
  const dir = tempOut('hs-narrow-');
  await withMockApi(planner(), async ({ base }) => {
    const res = await runScript(SCRIPT, ['--out', dir, '--status', 'open'], env(base));
    assert.match(res.stderr, /The API default is "active", which omits closed conversations/);
  });
});

test('drops lineitem threads and counts them', async () => {
  const dir = tempOut('hs-lineitem-');
  const threads = [
    thread(100),
    thread(101, { type: 'lineitem', body: null, createdBy: { id: 5, type: 'user' } }),
    thread(102, { type: 'customer', createdBy: { id: 901, type: 'customer' } }),
  ];

  await withMockApi(planner({ threads }), async ({ base }) => {
    const res = await runScript(SCRIPT, ['--out', dir], env(base));

    assert.equal(res.summary.messages, 2, 'lineitem must not count as a message');
    assert.equal(res.summary.lineItemsDropped, 1);
    const msgs = readJsonl(join(dir, 'messages.jsonl'));
    assert.ok(!msgs.some((m) => m.type_raw === 'lineitem'));
  });
});

test('--include-line-items keeps them when asked', async () => {
  const dir = tempOut('hs-lineitem-keep-');
  const threads = [thread(100), thread(101, { type: 'lineitem', body: null })];

  await withMockApi(planner({ threads }), async ({ base }) => {
    const res = await runScript(SCRIPT, ['--out', dir, '--include-line-items'], env(base));
    assert.equal(res.summary.messages, 2);
    assert.equal(res.summary.lineItemsDropped, 0);
  });
});

test('fetches bodies from the threads endpoint, not from embed=threads', async () => {
  const dir = tempOut('hs-threads-');
  await withMockApi(planner(), async ({ base, calls }) => {
    await runScript(SCRIPT, ['--out', dir], env(base));

    const listCall = calls.find((c) => c.url.startsWith('/v2/conversations?'));
    assert.ok(!/embed=threads/.test(listCall.url), 'embed=threads truncates chat threads by design');
    assert.ok(calls.some((c) => /\/v2\/conversations\/1\/threads/.test(c.url)));
  });
});

test('derives author type from createdBy.type rather than thread type', async () => {
  const dir = tempOut('hs-author-');
  // A chat thread authored by the customer: thread type alone would be ambiguous.
  const threads = [
    thread(100, { type: 'chat', createdBy: { id: 901, type: 'customer' } }),
    thread(101, { type: 'chat', createdBy: { id: 5, type: 'user' } }),
  ];

  await withMockApi(planner({ threads }), async ({ base }) => {
    await runScript(SCRIPT, ['--out', dir], env(base));
    const msgs = readJsonl(join(dir, 'messages.jsonl'));
    assert.equal(msgs.find((m) => m.source_id === '100').author_type, 'customer');
    assert.equal(msgs.find((m) => m.source_id === '101').author_type, 'agent');
  });
});

test('marks internal notes and counts them separately', async () => {
  const dir = tempOut('hs-notes-');
  const threads = [thread(100), thread(101, { type: 'note' })];

  await withMockApi(planner({ threads }), async ({ base }) => {
    const res = await runScript(SCRIPT, ['--out', dir], env(base));
    assert.equal(res.summary.internalNotes, 1);
    const msgs = readJsonl(join(dir, 'messages.jsonl'));
    assert.equal(msgs.find((m) => m.source_id === '101').visibility, 'internal');
    assert.equal(msgs.find((m) => m.source_id === '100').visibility, 'public');
  });
});

test('emits the canonical conversation shape with raw values preserved', async () => {
  const dir = tempOut('hs-shape-');
  await withMockApi(planner({ conversations: [conversation(1, { status: 'spam', type: 'phone' })] }), async ({ base }) => {
    await runScript(SCRIPT, ['--out', dir], env(base));
    const [c] = readJsonl(join(dir, 'conversations.jsonl'));

    assert.equal(c.source, 'helpscout');
    assert.equal(c.source_id, '1');
    assert.equal(c.status, 'closed');
    assert.equal(c.status_raw, 'spam', 'raw status must survive the judgement-call mapping');
    assert.equal(c.channel, 'voice');
    assert.equal(c.channel_raw, 'phone');
    assert.equal(c.team_id, '10');
    assert.deepEqual(c.tags, ['billing']);
    assert.equal(c.csat, null);
    assert.equal(c.created_at, '2026-07-01T10:00:00.000Z');
  });
});

test('honours X-RateLimit-Retry-After rather than only the standard header', async () => {
  const dir = tempOut('hs-throttle-');
  await withMockApi(planner({ rateLimitOnce: true }), async ({ base }) => {
    const started = Date.now();
    const res = await runScript(SCRIPT, ['--out', dir], env(base));

    assert.equal(res.code, 0);
    assert.equal(res.summary.throttled, 1);
    assert.ok(Date.now() - started >= 1000, 'should have waited the hinted second');
    assert.equal(res.summary.conversations, 1);
  });
});

test('reports accessible inboxes so a permission gap is visible', async () => {
  const dir = tempOut('hs-inbox-');
  await withMockApi(
    planner({ mailboxes: [{ id: 10, name: 'Support' }, { id: 11, name: 'Billing' }] }),
    async ({ base }) => {
      const res = await runScript(SCRIPT, ['--out', dir], env(base));
      assert.equal(res.summary.inboxes.accessible.length, 2);
      assert.deepEqual(res.summary.inboxes.seenInExport, ['10']);
    },
  );
});

test('warns loudly when the app can see no inboxes at all', async () => {
  const dir = tempOut('hs-noinbox-');
  await withMockApi(planner({ mailboxes: [], conversations: [] }), async ({ base }) => {
    const res = await runScript(SCRIPT, ['--out', dir], env(base));
    assert.match(res.stderr, /can see no inboxes/);
  });
});

test('--no-bodies skips the per-conversation thread fetch', async () => {
  const dir = tempOut('hs-nobodies-');
  await withMockApi(planner(), async ({ base, calls }) => {
    const res = await runScript(SCRIPT, ['--out', dir, '--no-bodies'], env(base));
    assert.equal(res.summary.messages, 0);
    assert.ok(!calls.some((c) => /threads/.test(c.url)));
    assert.ok(existsSync(join(dir, 'conversations.jsonl')));
  });
});

test('re-authenticates on a 401 instead of failing a long run', async () => {
  const dir = tempOut('hs-reauth-');
  let served = 0;
  await withMockApi(
    (req) => {
      if (req.url === '/v2/oauth2/token') return { status: 200, body: { access_token: 'placeholder-token' } };
      if (req.url.startsWith('/v2/mailboxes')) return { status: 200, body: { _embedded: { mailboxes: [{ id: 10, name: 'S' }] } } };
      if (req.url.startsWith('/v2/conversations?')) {
        served += 1;
        if (served === 1) return { status: 401, body: { error: 'expired' } };
        return {
          status: 200,
          body: { _embedded: { conversations: [conversation(1)] }, page: { totalPages: 1 } },
        };
      }
      if (/threads/.test(req.url)) return { status: 200, body: { _embedded: { threads: [] }, page: { totalPages: 1 } } };
      return { status: 404, body: {} };
    },
    async ({ base, calls }) => {
      const res = await runScript(SCRIPT, ['--out', dir], env(base));
      assert.equal(res.code, 0);
      assert.equal(res.summary.conversations, 1);
      assert.ok(calls.filter((c) => c.url === '/v2/oauth2/token').length >= 2, 'should have re-authenticated');
    },
  );
});

test('rejects an unknown --status rather than sending it', async () => {
  const res = await runScript(SCRIPT, ['--out', tempOut('hs-bad-'), '--status', 'archived'], {
    HELPSCOUT_CLIENT_ID: 'x',
    HELPSCOUT_CLIENT_SECRET: 'y',
  });
  assert.equal(res.code, 2);
  assert.match(res.stderr, /--status must be one of/);
});

test('states in its own output that embed=threads truncates', async () => {
  const dir = tempOut('hs-notes2-');
  await withMockApi(planner(), async ({ base }) => {
    const res = await runScript(SCRIPT, ['--out', dir], env(base));
    assert.ok(res.summary.notes.some((n) => /truncates chat threads/.test(n)));
  });
});

test('converts HTML thread bodies to plain text, as the canonical schema requires', async () => {
  const dir = tempOut('hs-html-');
  const threads = [
    thread(100, {
      body: '<div><p>Hi Jane,</p><p>Your refund of &pound;40 &amp; the fee<br>are processed.</p><style>.x{}</style></div>',
    }),
  ];

  await withMockApi(planner({ threads }), async ({ base }) => {
    await runScript(SCRIPT, ['--out', dir], env(base));
    const [m] = readJsonl(join(dir, 'messages.jsonl'));

    assert.ok(!/[<>]/.test(m.body), `body still contains markup: ${m.body}`);
    assert.ok(!m.body.includes('.x{}'), 'style content must be dropped, not inlined');
    assert.match(m.body, /Your refund of £40 & the fee/);
    // Block boundaries become newlines so sentences don't run together.
    assert.match(m.body, /Hi Jane,\nYour refund/);
  });
});

test('sets message channel, which can differ from the conversation channel', async () => {
  const dir = tempOut('hs-mchannel-');
  const threads = [thread(100, { type: 'phone' }), thread(101, { type: 'message' })];

  await withMockApi(planner({ threads }), async ({ base }) => {
    await runScript(SCRIPT, ['--out', dir], env(base));
    const msgs = readJsonl(join(dir, 'messages.jsonl'));
    assert.equal(msgs.find((m) => m.source_id === '100').channel, 'voice');
    assert.equal(msgs.find((m) => m.source_id === '101').channel, 'email');
  });
});

test('output passes the canonical conversation-schema validator', async () => {
  const dir = tempOut('hs-canon-');
  const threads = [
    thread(100, { type: 'customer', createdBy: { id: 901, type: 'customer' }, body: '<p>I need help</p>' }),
    thread(101, { type: 'message', createdBy: { id: 5, type: 'user' }, body: '<p>Happy to help</p>' }),
    thread(102, { type: 'note', createdBy: { id: 5, type: 'user' }, body: '<p>internal</p>' }),
    thread(103, { type: 'lineitem', body: null }),
  ];

  await withMockApi(planner({ threads }), async ({ base }) => {
    const exported = await runScript(SCRIPT, ['--out', dir], env(base));
    assert.equal(exported.code, 0);

    const validator = resolve(
      dirname(fileURLToPath(import.meta.url)),
      '../skills/data-and-integration/cx-conversation-schema/scripts/validate-export.mjs',
    );
    const check = await runScript(validator, [dir, '--json'], {});
    assert.equal(check.code, 0, `canonical validation failed:\n${check.stdout}\n${check.stderr}`);
    assert.equal(check.summary.ok, true);
    assert.deepEqual(check.summary.errors, []);
  });
});

test('decodes entities in one pass, so &amp;lt; does not become <', async () => {
  const dir = tempOut('hs-entity-');
  // A customer quoting literal markup. Sequential decoding would turn this into
  // "<script>", silently changing what the customer actually wrote.
  const threads = [thread(100, { body: '<p>I typed &amp;lt;script&amp;gt; and &#x2705; and &notareal;</p>' })];

  await withMockApi(planner({ threads }), async ({ base }) => {
    await runScript(SCRIPT, ['--out', dir], env(base));
    const [m] = readJsonl(join(dir, 'messages.jsonl'));

    assert.match(m.body, /I typed &lt;script&gt;/, 'double-encoded markup must decode exactly once');
    assert.match(m.body, /✅/, 'hex numeric entities should decode');
    assert.match(m.body, /&notareal;/, 'unknown entities are left intact, not deleted');
  });
});
