/**
 * Tests for the Aircall export.
 *
 * The load-bearing case is `splits a window that exceeds the cap`. Aircall
 * returns at most 10,000 items with no error, so an exporter that just pages
 * until results run out produces a file that looks complete and is not. The
 * adaptive halving is the only thing preventing that, and the unsplittable-window
 * test proves the remaining risk is reported rather than swallowed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withMockApi, runScript, tempOut, readJsonl } from './helpers/mock-api.mjs';

const SCRIPT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../skills/aircall/aircall-export-calls/scripts/export-calls.mjs',
);

const env = (base, extra = {}) => ({
  AIRCALL_API_ID: 'placeholder-id',
  AIRCALL_API_TOKEN: 'placeholder-token',
  AIRCALL_BASE_URL: base,
  ...extra,
});

const unix = (iso) => Math.floor(Date.parse(iso) / 1000);

const call = (id, startedIso, over = {}) => ({
  id,
  direction: 'inbound',
  status: 'done',
  started_at: unix(startedIso),
  answered_at: unix(startedIso) + 5,
  ended_at: unix(startedIso) + 120,
  duration: 120,
  raw_digits: '+441234567890',
  user: { id: 7, name: 'Agent' },
  contact: { id: 900 + id },
  teams: [{ id: 3, name: 'Support' }],
  tags: [{ name: 'billing' }],
  ...over,
});

/**
 * Mock Aircall. `totalFor(from,to)` decides meta.total for a window so window
 * splitting can be exercised; `callsFor` supplies the page contents.
 */
function planner({ totalFor, callsFor }) {
  return (req) => {
    const m = /^\/calls\?from=(\d+)&to=(\d+)&per_page=(\d+)&page=(\d+)/.exec(req.url);
    if (!m) return { status: 404, body: { error: 'not found' } };
    const [, from, to, perPage, page] = m.map(Number);

    const total = totalFor(from, to);
    if (perPage === 1) {
      return { status: 200, headers: { 'x-aircallapi-limit': '120', 'x-aircallapi-remaining': '119', 'content-type': 'application/json' }, body: { calls: [], meta: { total } } };
    }
    const all = callsFor(from, to);
    const start = (page - 1) * perPage;
    const slice = all.slice(start, start + perPage);
    return {
      status: 200,
      headers: { 'x-aircallapi-limit': '120', 'x-aircallapi-remaining': '119', 'content-type': 'application/json' },
      body: {
        calls: slice,
        meta: { total: all.length, next_page_link: start + perPage < all.length ? 'more' : null },
      },
    };
  };
}

const WINDOW = ['--from', '2026-07-01', '--to', '2026-07-03'];

test('exports calls in the canonical schema with UNIX timestamps converted', async () => {
  const dir = tempOut('ac-shape-');
  const calls = [call(1, '2026-07-01T10:00:00Z')];

  await withMockApi(planner({ totalFor: () => calls.length, callsFor: () => calls }), async ({ base }) => {
    const res = await runScript(SCRIPT, ['--out', dir, ...WINDOW], env(base));
    assert.equal(res.code, 0, res.stderr);

    const [c] = readJsonl(join(dir, 'conversations.jsonl'));
    assert.equal(c.source, 'aircall');
    assert.equal(c.source_id, '1');
    assert.equal(c.status, 'closed');
    assert.equal(c.status_raw, 'done');
    assert.equal(c.channel, 'voice');
    assert.equal(c.channel_raw, null);
    assert.equal(c.customer_id, '901');
    assert.equal(c.assignee_id, '7');
    assert.equal(c.team_id, '3');
    // UNIX seconds, not milliseconds — a factor error survives a schema check.
    assert.equal(c.created_at, '2026-07-01T10:00:00.000Z');
    assert.equal(c.duration_seconds, 120);
    assert.deepEqual(c.tags, ['billing']);
  });
});

test('writes no messages.jsonl, because a call has no message list', async () => {
  const dir = tempOut('ac-voice-');
  const calls = [call(1, '2026-07-01T10:00:00Z')];
  await withMockApi(planner({ totalFor: () => 1, callsFor: () => calls }), async ({ base }) => {
    await runScript(SCRIPT, ['--out', dir, ...WINDOW], env(base));
    assert.ok(!existsSync(join(dir, 'messages.jsonl')));
  });
});

test('splits a window that exceeds the cap instead of truncating at it', async () => {
  const dir = tempOut('ac-split-');
  // The full range reports over the cap; each half reports under it.
  const fullFrom = unix('2026-07-01T00:00:00Z');
  const fullTo = unix('2026-07-03T00:00:00Z');

  const planned = planner({
    totalFor: (from, to) => (from === fullFrom && to === fullTo ? 50 : 5),
    callsFor: (from) => [call(from, new Date(from * 1000).toISOString())],
  });

  await withMockApi(planned, async ({ base, calls: httpCalls }) => {
    const res = await runScript(SCRIPT, ['--out', dir, ...WINDOW, '--max-window-calls', '10'], env(base));

    assert.equal(res.code, 0);
    assert.equal(res.summary.windowsFetched, 2, 'the over-cap window should have been halved');
    assert.equal(res.summary.unsplittableWindows.length, 0);
    // The full range must never have been paged at per_page=50.
    assert.ok(
      !httpCalls.some((c) => c.url.includes(`from=${fullFrom}&to=${fullTo}&per_page=50`)),
      'should not page the over-cap window directly',
    );
  });
});

test('reports an unsplittable window rather than silently truncating', async () => {
  const dir = tempOut('ac-unsplit-');
  const planned = planner({ totalFor: () => 50_000, callsFor: () => [] });

  await withMockApi(planned, async ({ base }) => {
    const res = await runScript(
      SCRIPT,
      ['--out', dir, '--from', '2026-07-01', '--to', '2026-07-01T02:00:00Z', '--max-window-calls', '10', '--min-window-hours', '4'],
      env(base),
    );

    assert.equal(res.code, 1, 'an unsplittable window must exit non-zero');
    assert.equal(res.summary.unsplittableWindows.length, 1);
    assert.match(res.stderr, /cannot be split below --min-window-hours/);
    assert.match(res.stderr, /data may be missing/);
  });
});

test('paginates within a window at the API maximum page size', async () => {
  const dir = tempOut('ac-page-');
  const calls = Array.from({ length: 120 }, (_, i) => call(i + 1, '2026-07-01T10:00:00Z'));

  await withMockApi(planner({ totalFor: () => calls.length, callsFor: () => calls }), async ({ base, calls: httpCalls }) => {
    const res = await runScript(SCRIPT, ['--out', dir, ...WINDOW], env(base));
    assert.equal(res.summary.calls, 120);
    assert.ok(httpCalls.some((c) => c.url.includes('per_page=50&page=3')), 'should reach page 3 at 50 per page');
  });
});

test('preserves missed_call_reason and counts the reasons', async () => {
  const dir = tempOut('ac-missed-');
  const calls = [
    call(1, '2026-07-01T10:00:00Z', { answered_at: null, missed_call_reason: 'abandoned_in_ivr' }),
    call(2, '2026-07-01T11:00:00Z', { answered_at: null, missed_call_reason: 'no_available_agent' }),
    call(3, '2026-07-01T12:00:00Z'),
  ];

  await withMockApi(planner({ totalFor: () => calls.length, callsFor: () => calls }), async ({ base }) => {
    const res = await runScript(SCRIPT, ['--out', dir, ...WINDOW], env(base));

    assert.equal(res.summary.answered, 1);
    assert.equal(res.summary.missed, 2);
    // The distinction between these two is an abandonment finding versus a
    // staffing one, so it must survive the export.
    assert.deepEqual(res.summary.missedReasons, { abandoned_in_ivr: 1, no_available_agent: 1 });
    const recs = readJsonl(join(dir, 'conversations.jsonl'));
    assert.equal(recs.find((r) => r.source_id === '1').missed_call_reason_raw, 'abandoned_in_ivr');
    assert.equal(recs.find((r) => r.source_id === '3').answered, true);
  });
});

test('does not treat an anonymous caller as a phone number', async () => {
  const dir = tempOut('ac-anon-');
  const calls = [
    call(1, '2026-07-01T10:00:00Z', { raw_digits: 'anonymous' }),
    call(2, '2026-07-01T11:00:00Z'),
  ];

  await withMockApi(planner({ totalFor: () => calls.length, callsFor: () => calls }), async ({ base }) => {
    await runScript(SCRIPT, ['--out', dir, ...WINDOW], env(base));
    const recs = readJsonl(join(dir, 'conversations.jsonl'));
    assert.equal(recs.find((r) => r.source_id === '1').raw_digits_present, false);
    assert.equal(recs.find((r) => r.source_id === '2').raw_digits_present, true);
  });
});

test('never persists a recording URL into the dataset', async () => {
  const dir = tempOut('ac-nourl-');
  const url = 'https://recordings.example/abc.mp3';
  const calls = [call(1, '2026-07-01T10:00:00Z', { recording: url })];

  await withMockApi(planner({ totalFor: () => 1, callsFor: () => calls }), async ({ base }) => {
    await runScript(SCRIPT, ['--out', dir, ...WINDOW], env(base));
    const [c] = readJsonl(join(dir, 'conversations.jsonl'));
    // The URL is valid for an hour; storing it would persist a dead value.
    assert.ok(!JSON.stringify(c).includes(url), 'expiring URL must not be written to the export');
    assert.equal(c.has_recording, true);
  });
});

test('flags a likely history ceiling when the earliest call sits near six months back', async () => {
  const dir = tempOut('ac-ceiling-');
  const sixMonthsAgo = new Date(Date.now() - 180 * 86400000).toISOString();
  const calls = [call(1, sixMonthsAgo)];

  await withMockApi(planner({ totalFor: () => 1, callsFor: () => calls }), async ({ base }) => {
    // Ask for two years of history; only ~6 months comes back.
    const from = new Date(Date.now() - 730 * 86400000).toISOString().slice(0, 10);
    const res = await runScript(SCRIPT, ['--out', dir, '--from', from, '--to', '2030-01-01'], env(base));

    assert.equal(res.summary.historyCeilingLikely, true);
    assert.match(res.stderr, /6 month default history limit/);
    assert.match(res.stderr, /not the start of your account/);
  });
});

test('honours the rate-limit reset header on a 429', async () => {
  const dir = tempOut('ac-throttle-');
  const calls = [call(1, '2026-07-01T10:00:00Z')];
  let throttled = false;

  await withMockApi(
    (req) => {
      if (!throttled && req.url.includes('per_page=50')) {
        throttled = true;
        return {
          status: 429,
          headers: { 'x-aircallapi-reset': String(Math.floor(Date.now() / 1000) + 1), 'content-type': 'application/json' },
          body: {},
        };
      }
      return planner({ totalFor: () => 1, callsFor: () => calls })(req);
    },
    async ({ base }) => {
      const started = Date.now();
      const res = await runScript(SCRIPT, ['--out', dir, ...WINDOW], env(base));
      assert.equal(res.code, 0);
      assert.equal(res.summary.throttled, 1);
      assert.ok(Date.now() - started >= 900, 'should have waited for the reset');
      assert.equal(res.summary.rateLimit.perMinute, 120);
    },
  );
});

test('rejects a --max-window-calls above the API cap', async () => {
  const res = await runScript(SCRIPT, ['--out', tempOut('ac-bad-'), ...WINDOW, '--max-window-calls', '25000'], {
    AIRCALL_API_ID: 'x',
    AIRCALL_API_TOKEN: 'y',
  });
  assert.equal(res.code, 2);
  assert.match(res.stderr, /caps result sets at 10,000/);
});

test('requires an explicit window', async () => {
  const res = await runScript(SCRIPT, ['--out', tempOut('ac-nowindow-')], {
    AIRCALL_API_ID: 'x',
    AIRCALL_API_TOKEN: 'y',
  });
  assert.equal(res.code, 2);
  assert.match(res.stderr, /--from is required/);
});

test('states the caps in its own output', async () => {
  const dir = tempOut('ac-notes-');
  const calls = [call(1, '2026-07-01T10:00:00Z')];
  await withMockApi(planner({ totalFor: () => 1, callsFor: () => calls }), async ({ base }) => {
    const res = await runScript(SCRIPT, ['--out', dir, ...WINDOW], env(base));
    assert.ok(res.summary.notes.some((n) => /10,000 items with no error/.test(n)));
    assert.ok(res.summary.notes.some((n) => /six months of history/.test(n)));
    assert.ok(res.summary.notes.some((n) => /valid for one hour/.test(n)));
  });
});

test('output passes the canonical conversation-schema validator', async () => {
  const dir = tempOut('ac-canon-');
  const calls = [
    call(1, '2026-07-01T10:00:00Z'),
    call(2, '2026-07-01T11:00:00Z', { direction: 'outbound', teams: [] }),
    call(3, '2026-07-01T12:00:00Z', { answered_at: null, missed_call_reason: 'short_abandoned' }),
  ];

  await withMockApi(planner({ totalFor: () => calls.length, callsFor: () => calls }), async ({ base }) => {
    const exported = await runScript(SCRIPT, ['--out', dir, ...WINDOW], env(base));
    assert.equal(exported.code, 0);

    const validator = resolve(
      dirname(fileURLToPath(import.meta.url)),
      '../skills/data-and-integration/cx-conversation-schema/scripts/validate-export.mjs',
    );
    // Voice-only source: no messages.jsonl by design.
    const check = await runScript(validator, [dir, '--no-messages', '--json'], {});
    assert.equal(check.code, 0, `canonical validation failed:\n${check.stdout}\n${check.stderr}`);
    assert.equal(check.summary.ok, true);
    assert.deepEqual(check.summary.errors, []);
  });
});
