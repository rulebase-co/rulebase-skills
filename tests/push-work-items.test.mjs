/**
 * Tests for the work item push.
 *
 * The load-bearing case is `rejects a generated UUID as the external_id`. The
 * API upserts on that field, so an unstable id does not error, it silently
 * doubles the data on the second run. The other two validation tests cover the
 * ways a work item can be accepted and then never evaluated: nobody to grade it,
 * and nothing in it to grade.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withMockApi, runScript, tempOut, readJsonl } from './helpers/mock-api.mjs';

const SCRIPT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../skills/rulebase/rulebase-work-items/scripts/push-work-items.mjs',
);

const env = (base, extra = {}) => ({
  RULEBASE_API_KEY: 'rk_live_placeholder',
  RULEBASE_API2_ORIGIN: base,
  ...extra,
});

const item = (over = {}) => ({
  external_id: 'case-8841',
  type: 'kyc_review',
  status: 'completed',
  completed_at: '2026-07-14T16:02:00Z',
  agent_email: 'amara@example.com',
  custom_attributes: { queue: 'enhanced_dd' },
  events: [{ external_id: 'case-8841-note-1', actor_email: 'amara@example.com', content: 'Requested proof of address' }],
  ...over,
});

function files(items, roster = ['amara@example.com']) {
  const dir = tempOut('wi-');
  const manifest = join(dir, 'items.jsonl');
  writeFileSync(manifest, items.map((i) => JSON.stringify(i)).join('\n'));
  const rosterPath = join(dir, 'agents.txt');
  writeFileSync(rosterPath, roster.join('\n'));
  return { dir, manifest, rosterPath, plan: join(dir, 'plan.json') };
}

/** Mock: auth probe 404s (authenticated), create 201, verify 200. */
function planner({ failIds = new Set(), createStatus = 201 } = {}) {
  let n = 0;
  return (req) => {
    if (req.url.startsWith('/work_items/auth-probe')) return { status: 404, body: { error: 'Not found' } };
    if (req.method === 'POST' && req.url === '/work_items') {
      n += 1;
      if (failIds.has(n)) return { status: 422, body: { error: 'invalid' } };
      return { status: createStatus, body: { data: { id: `wi_${n}` } } };
    }
    if (req.method === 'GET' && req.url.startsWith('/work_items/')) return { status: 200, body: { data: { id: 'wi_1' } } };
    return { status: 404, body: {} };
  };
}

const plan = (f, base, extra = []) =>
  runScript(SCRIPT, ['--manifest', f.manifest, '--roster', f.rosterPath, '--plan', f.plan, ...extra], env(base));

test('the default run plans and pushes nothing', async () => {
  const f = files([item()]);
  await withMockApi(planner(), async ({ base, calls }) => {
    const res = await plan(f, base);
    assert.equal(res.code, 0, res.stderr);
    assert.equal(res.summary.pushable, 1);
    assert.equal(calls.filter((c) => c.method === 'POST').length, 0);
  });
});

test('rejects a generated UUID as the external_id', async () => {
  // Succeeds against the API and silently duplicates on the next run, so it has
  // to be caught before anything is sent.
  const f = files([item({ external_id: '3f2504e0-4f89-11d3-9a0c-0305e82c3301' })]);
  await withMockApi(planner(), async ({ base }) => {
    const res = await plan(f, base);
    assert.equal(res.summary.pushable, 0);
    const p = JSON.parse(readFileSync(f.plan, 'utf8'));
    assert.match(p.rejected[0].problems.join(' '), /looks like a generated UUID/);
    assert.match(p.rejected[0].problems.join(' '), /duplicates instead of updating/);
  });
});

test('rejects an item with no agent, which would never be evaluated', async () => {
  const f = files([item({ agent_email: undefined, agent_name: undefined, agent_external_id: undefined })]);
  await withMockApi(planner(), async ({ base }) => {
    const res = await plan(f, base);
    assert.equal(res.summary.pushable, 0);
    const p = JSON.parse(readFileSync(f.plan, 'utf8'));
    assert.match(p.rejected[0].problems.join(' '), /nobody to evaluate/);
  });
});

test('rejects an agent who is not on the roster', async () => {
  const f = files([item({ agent_email: 'ghost@example.com' })]);
  await withMockApi(planner(), async ({ base }) => {
    const res = await plan(f, base);
    assert.equal(res.summary.pushable, 0);
    const p = JSON.parse(readFileSync(f.plan, 'utf8'));
    assert.match(p.rejected[0].problems.join(' '), /not on the supplied roster/);
  });
});

test('rejects an item with no events, which has nothing to assess', async () => {
  const f = files([item({ events: [] })]);
  await withMockApi(planner(), async ({ base }) => {
    const res = await plan(f, base);
    assert.equal(res.summary.pushable, 0);
    const p = JSON.parse(readFileSync(f.plan, 'utf8'));
    assert.match(p.rejected[0].problems.join(' '), /no content for a scorecard to assess/);
  });
});

test('rejects a status outside the documented enum', async () => {
  const f = files([item({ status: 'closed_verified' })]);
  await withMockApi(planner(), async ({ base }) => {
    const res = await plan(f, base);
    const p = JSON.parse(readFileSync(f.plan, 'utf8'));
    assert.match(p.rejected[0].problems.join(' '), /not one of pending, in_progress, completed, cancelled/);
    assert.match(p.rejected[0].problems.join(' '), /keep the raw value in custom_attributes/);
  });
});

test('flags a completed item with no completed_at', async () => {
  const f = files([item({ completed_at: undefined })]);
  await withMockApi(planner(), async ({ base }) => {
    await plan(f, base);
    const p = JSON.parse(readFileSync(f.plan, 'utf8'));
    assert.match(p.rejected[0].problems.join(' '), /eligibility window/);
  });
});

test('catches an event external_id that looks like a loop index', async () => {
  const f = files([item({ events: [{ external_id: 'event-3', content: 'x' }] })]);
  await withMockApi(planner(), async ({ base }) => {
    await plan(f, base);
    const p = JSON.parse(readFileSync(f.plan, 'utf8'));
    assert.match(p.rejected[0].problems.join(' '), /looks like a loop index/);
  });
});

test('catches duplicate event ids within one item and duplicate item ids across the manifest', async () => {
  const dupEvents = files([item({ events: [{ external_id: 'e1' }, { external_id: 'e1' }] })]);
  await withMockApi(planner(), async ({ base }) => {
    await plan(dupEvents, base);
    const p = JSON.parse(readFileSync(dupEvents.plan, 'utf8'));
    assert.match(p.rejected[0].problems.join(' '), /duplicate event external_id/);
  });

  const dupItems = files([item(), item()]);
  await withMockApi(planner(), async ({ base }) => {
    const res = await plan(dupItems, base);
    assert.equal(res.summary.pushable, 1);
    const p = JSON.parse(readFileSync(dupItems.plan, 'utf8'));
    assert.match(p.rejected[0].problems.join(' '), /duplicate external_id/);
  });
});

test('--apply pushes, audits every attempt, and verifies what landed', async () => {
  const f = files([item({ external_id: 'case-1' }), item({ external_id: 'case-2' })]);
  const audit = join(f.dir, 'audit.jsonl');
  await withMockApi(planner(), async ({ base, calls }) => {
    await plan(f, base);
    const res = await runScript(
      SCRIPT,
      ['--plan', f.plan, '--apply', '--audit', audit, '--journal', join(f.dir, 'j.jsonl')],
      env(base),
    );

    assert.equal(res.code, 0, res.stderr);
    assert.equal(res.summary.pushed, 2);
    const rows = readJsonl(audit);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].outcome, 'pushed');
    assert.equal(rows[0].events, 1);
    // Verified by re-reading, not by trusting the 201.
    assert.ok(res.summary.verified.every((v) => v.verified));
    assert.equal(calls.filter((c) => c.method === 'GET' && /\/work_items\/wi_/.test(c.url)).length, 2);
  });
});

test('--max-changes bounds the batch and reports what remains', async () => {
  const f = files([1, 2, 3, 4].map((i) => item({ external_id: `case-${i}` })));
  await withMockApi(planner(), async ({ base }) => {
    await plan(f, base);
    const res = await runScript(
      SCRIPT,
      ['--plan', f.plan, '--apply', '--max-changes', '2', '--audit', join(f.dir, 'a.jsonl'), '--journal', join(f.dir, 'j.jsonl')],
      env(base),
    );
    assert.equal(res.summary.pushed, 2);
    assert.equal(res.summary.remaining, 2);
  });
});

test('re-running after an interruption does not re-push', async () => {
  const f = files([1, 2, 3].map((i) => item({ external_id: `case-${i}` })));
  const journal = join(f.dir, 'j.jsonl');
  await withMockApi(planner(), async ({ base, calls }) => {
    await plan(f, base);
    const args = ['--plan', f.plan, '--apply', '--max-changes', '2', '--audit', join(f.dir, 'a.jsonl'), '--journal', journal];
    const first = await runScript(SCRIPT, args, env(base));
    assert.equal(first.summary.pushed, 2);

    const posts = () => calls.filter((c) => c.method === 'POST' && c.url === '/work_items').length;
    const after = posts();
    const second = await runScript(SCRIPT, args, env(base));

    assert.equal(second.summary.skipped, 2);
    assert.equal(second.summary.pushed, 1);
    assert.equal(posts() - after, 1);
  });
});

test('a failed push is audited and exits non-zero', async () => {
  const f = files([item({ external_id: 'case-1' }), item({ external_id: 'case-2' })]);
  const audit = join(f.dir, 'audit.jsonl');
  await withMockApi(planner({ failIds: new Set([2]) }), async ({ base }) => {
    await plan(f, base);
    const res = await runScript(
      SCRIPT,
      ['--plan', f.plan, '--apply', '--audit', audit, '--journal', join(f.dir, 'j.jsonl')],
      env(base),
    );
    assert.equal(res.code, 1);
    assert.equal(res.summary.pushed, 1);
    assert.equal(res.summary.failed, 1);
    assert.equal(readJsonl(audit).filter((r) => r.outcome === 'failed').length, 1);
  });
});

test('backs off on a 429 rather than hammering', async () => {
  const f = files([item()]);
  let limited = false;
  await withMockApi(
    (req) => {
      if (req.url.startsWith('/work_items/auth-probe')) return { status: 404, body: {} };
      if (req.method === 'POST' && req.url === '/work_items' && !limited) {
        limited = true;
        return { status: 429, headers: { 'retry-after': '1', 'content-type': 'application/json' }, body: {} };
      }
      return planner()(req);
    },
    async ({ base }) => {
      await plan(f, base);
      const started = Date.now();
      const res = await runScript(
        SCRIPT,
        ['--plan', f.plan, '--apply', '--audit', join(f.dir, 'a.jsonl'), '--journal', join(f.dir, 'j.jsonl')],
        env(base),
      );
      assert.equal(res.summary.pushed, 1);
      assert.ok(Date.now() - started >= 900, 'should have waited the retry-after');
    },
  );
});

test('a 401 points at the region before the key', async () => {
  const f = files([item()]);
  await withMockApi(() => ({ status: 401, body: { error: 'Unauthorized' } }), async ({ base }) => {
    const res = await plan(f, base);
    assert.equal(res.code, 2);
    assert.match(res.stderr, /Check the region first/);
  });
});

test('refuses to apply a plan built for the other region', async () => {
  const f = files([item()]);
  await withMockApi(planner(), async ({ base }) => {
    await plan(f, base, ['--region', 'us']);
    const res = await runScript(SCRIPT, ['--plan', f.plan, '--apply', '--region', 'eu'], env(base));
    assert.equal(res.code, 2);
    assert.match(res.stderr, /Re-plan rather than retargeting/);
  });
});

test('offers no --force flag', async () => {
  assert.ok(!/--force\b/.test(readFileSync(SCRIPT, 'utf8')), 'destruction must never be the convenient path');
});
