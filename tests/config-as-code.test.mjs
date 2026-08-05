/**
 * Tests for Zendesk config-as-code. The refusals matter most: push must never
 * delete, never reorder, never resurrect a resource deleted in Zendesk, and never
 * push something whose dependencies are missing locally.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withMockApi, runScript, tempOut } from './helpers/mock-api.mjs';

const SCRIPT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../skills/zendesk/zendesk-config-as-code/scripts/config.mjs',
);

const { normalizeResource, diffResource, findMissingDependencies } = await import(SCRIPT);

const env = (base) => ({
  ZENDESK_SUBDOMAIN: 'mock',
  ZENDESK_EMAIL: 'svc@example.com',
  ZENDESK_API_TOKEN: 'placeholder-not-a-real-token',
  ZENDESK_BASE_URL: base,
  ZENDESK_MIN_INTERVAL_MS: '1',
});

/** Serves config collections and records writes. */
function zendeskMock(collections) {
  const writes = [];
  const plan = (req, n, body) => {
    const map = {
      '/api/v2/groups.json': 'groups',
      '/api/v2/ticket_fields.json': 'ticket_fields',
      '/api/v2/ticket_forms.json': 'ticket_forms',
      '/api/v2/macros.json': 'macros',
      '/api/v2/views.json': 'views',
      '/api/v2/triggers.json': 'triggers',
      '/api/v2/automations.json': 'automations',
      '/api/v2/slas/policies.json': 'sla_policies',
      '/api/v2/business_hours/schedules.json': 'schedules',
    };
    const path = req.url.split('?')[0];

    if (req.method === 'POST' && map[path]) {
      writes.push({ method: 'POST', resource: map[path], body });
      const singular = map[path].replace(/s$/, '');
      return { body: { [singular]: { id: 9999 } } };
    }
    if (req.method === 'PUT') {
      const match = /\/api\/v2\/(\w+(?:\/\w+)?)\/(\d+)\.json/.exec(path);
      writes.push({ method: 'PUT', path, id: match?.[2], body });
      return { body: {} };
    }
    if (req.method === 'DELETE') {
      writes.push({ method: 'DELETE', path });
      return { status: 204, body: '' };
    }
    if (map[path]) {
      return { body: { [map[path]]: collections[map[path]] ?? [], next_page: null } };
    }
    return { status: 404, body: {} };
  };
  return { plan, writes };
}

const trigger = (id, title, extra = {}) => ({
  id,
  title,
  active: true,
  position: 1,
  conditions: { all: [{ field: 'status', operator: 'is', value: 'new' }], any: [] },
  actions: [{ field: 'group_id', value: '55' }],
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  url: 'https://mock.zendesk.com/api/v2/triggers/1.json',
  ...extra,
});

const group = (id, name) => ({ id, name, created_at: '2026-01-01T00:00:00Z', url: 'x' });

// --- pure functions ---

test('normalizeResource strips computed fields', () => {
  const out = normalizeResource(trigger(1, 'Route new'));
  assert.ok(!('created_at' in out));
  assert.ok(!('updated_at' in out));
  assert.ok(!('url' in out));
  assert.equal(out.title, 'Route new');
  assert.deepEqual(Object.keys(out), Object.keys(out).slice().sort(), 'keys are ordered for stable diffs');
});

test('diffResource classifies creates, updates, unchanged and untracked', () => {
  const live = [trigger(1, 'Route new'), trigger(2, 'Escalate')];
  const local = [
    trigger(1, 'Route new'), // unchanged
    trigger(2, 'Escalate urgently'), // updated
    { title: 'Brand new', active: true, conditions: {}, actions: [] }, // create
  ];

  const diff = diffResource(local, live);
  assert.equal(diff.unchanged.length, 1);
  assert.equal(diff.updates.length, 1);
  assert.deepEqual(diff.updates[0].changedKeys, ['title']);
  assert.equal(diff.creates.length, 1);
  assert.equal(diff.untracked.length, 0);
});

test('diffResource reports live-only resources as untracked, not as deletions', () => {
  const live = [trigger(1, 'Route new'), trigger(2, 'Someone added this in the UI')];
  const local = [trigger(1, 'Route new')];

  const diff = diffResource(local, live);
  assert.equal(diff.untracked.length, 1);
  assert.equal(diff.untracked[0].id, '2');
  assert.equal(diff.updates.length, 0);
  assert.equal(diff.creates.length, 0);
});

test('diffResource flags a local record whose live counterpart is gone', () => {
  const diff = diffResource([trigger(7, 'Deleted in Zendesk')], []);
  assert.equal(diff.creates.length, 1);
  assert.equal(diff.creates[0].missingLive, true, 'not treated as an ordinary create');
});

test('ignoring volatile fields prevents a no-op diff', () => {
  const live = [trigger(1, 'Route new', { updated_at: '2026-06-01T00:00:00Z', usage_24h: 42 })];
  const local = [trigger(1, 'Route new', { updated_at: '2026-01-01T00:00:00Z' })];
  const diff = diffResource(local, live);
  assert.equal(diff.unchanged.length, 1, 'a changed updated_at is not a change');
});

test('findMissingDependencies spots an unknown group reference', () => {
  const known = { groups: new Set(['55']), ticket_fields: new Set() };
  const ok = findMissingDependencies('triggers', trigger(1, 'a'), known);
  assert.deepEqual(ok, []);

  const bad = findMissingDependencies(
    'triggers',
    trigger(2, 'b', { actions: [{ field: 'group_id', value: '999' }] }),
    known,
  );
  assert.equal(bad.length, 1);
  assert.deepEqual(bad[0], { type: 'group', id: '999' });
});

// --- commands ---

test('pull writes normalised files and stays read-only', async () => {
  const { plan, writes } = zendeskMock({
    groups: [group(55, 'Support')],
    triggers: [trigger(1, 'Route new')],
  });

  await withMockApi(plan, async ({ base }) => {
    const dir = tempOut('cfg-');
    const { code, summary } = await runScript(SCRIPT, ['pull', '--dir', dir, '--json'], env(base));

    assert.equal(code, 0);
    assert.equal(writes.length, 0, 'pull performs no writes');
    assert.equal(summary.resources.triggers.count, 1);

    const written = JSON.parse(readFileSync(join(dir, 'triggers.json'), 'utf8'));
    assert.ok(!('updated_at' in written[0]), 'computed fields stripped on disk');
    assert.equal(written[0].title, 'Route new');
    assert.match(summary.note, /Commit this directory/);
  });
});

test('diff is read-only and reports the change plan', async () => {
  const { plan, writes } = zendeskMock({
    groups: [group(55, 'Support')],
    triggers: [trigger(1, 'Route new'), trigger(3, 'Added in the UI')],
  });

  await withMockApi(plan, async ({ base }) => {
    const dir = tempOut('cfg-');
    writeFileSync(join(dir, 'groups.json'), JSON.stringify([normalizeResource(group(55, 'Support'))]));
    writeFileSync(
      join(dir, 'triggers.json'),
      JSON.stringify([normalizeResource(trigger(1, 'Route new differently'))]),
    );

    const { code, summary } = await runScript(SCRIPT, ['diff', '--dir', dir, '--json'], env(base));

    assert.equal(code, 0);
    assert.equal(writes.length, 0, 'diff performs no writes');
    assert.equal(summary.totals.updates, 1);
    assert.equal(summary.totals.untracked, 1, 'the UI-added trigger is untracked');
    assert.deepEqual(summary.resources.triggers.updates[0].changedKeys, ['title']);
  });
});

test('push is a dry run without --apply', async () => {
  const { plan, writes } = zendeskMock({ groups: [group(55, 'Support')], triggers: [trigger(1, 'Route new')] });

  await withMockApi(plan, async ({ base }) => {
    const dir = tempOut('cfg-');
    writeFileSync(join(dir, 'groups.json'), JSON.stringify([normalizeResource(group(55, 'Support'))]));
    writeFileSync(join(dir, 'triggers.json'), JSON.stringify([normalizeResource(trigger(1, 'Renamed'))]));

    const { summary, stderr } = await runScript(SCRIPT, ['push', '--dir', dir, '--json'], env(base));

    assert.equal(summary.mode, 'dry-run');
    assert.equal(summary.would_apply, 1);
    assert.equal(summary.applied, 0);
    assert.equal(writes.length, 0);
    assert.match(stderr, /dry run \(no changes\)/);
  });
});

test('--apply updates a changed resource and audits before/after', async () => {
  const { plan, writes } = zendeskMock({ groups: [group(55, 'Support')], triggers: [trigger(1, 'Route new')] });

  await withMockApi(plan, async ({ base }) => {
    const dir = tempOut('cfg-');
    writeFileSync(join(dir, 'groups.json'), JSON.stringify([normalizeResource(group(55, 'Support'))]));
    writeFileSync(join(dir, 'triggers.json'), JSON.stringify([normalizeResource(trigger(1, 'Renamed'))]));

    const { summary } = await runScript(SCRIPT, ['push', '--apply', '--dir', dir, '--json'], env(base));

    assert.equal(summary.applied, 1);
    const put = writes.find((w) => w.method === 'PUT');
    assert.ok(put, 'a PUT was issued');
    assert.equal(put.id, '1');
    assert.equal(put.body.trigger.title, 'Renamed');

    const audit = readFileSync(summary.audit_log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const updated = audit.find((a) => a.outcome === 'updated');
    assert.ok(updated.before, 'before-state captured');
    assert.ok(updated.after, 'after-state captured');
    assert.deepEqual(updated.changed_keys, ['title']);
    assert.equal(summary.reversible, false);
  });
});

test('push never deletes, and reports untracked live resources instead', async () => {
  const { plan, writes } = zendeskMock({
    groups: [group(55, 'Support')],
    triggers: [trigger(1, 'Keep'), trigger(2, 'Not in local config')],
  });

  await withMockApi(plan, async ({ base }) => {
    const dir = tempOut('cfg-');
    writeFileSync(join(dir, 'groups.json'), JSON.stringify([normalizeResource(group(55, 'Support'))]));
    // Only trigger 1 is tracked locally.
    writeFileSync(join(dir, 'triggers.json'), JSON.stringify([normalizeResource(trigger(1, 'Keep'))]));

    // No --json here: the human-readable summary is what must carry the warning.
    const { summary, stderr } = await runScript(SCRIPT, ['push', '--apply', '--dir', dir], env(base));

    assert.equal(summary.deletions_performed, 0);
    assert.equal(summary.reorders_performed, 0);
    assert.ok(!writes.some((w) => w.method === 'DELETE'), 'no DELETE was issued');
    assert.equal(summary.untracked_live_resources, 1);
    assert.match(stderr, /were NOT deleted/);
  });
});

test('refuses to recreate a resource that was deleted in Zendesk', async () => {
  const { plan, writes } = zendeskMock({ groups: [group(55, 'Support')], triggers: [] });

  await withMockApi(plan, async ({ base }) => {
    const dir = tempOut('cfg-');
    writeFileSync(join(dir, 'groups.json'), JSON.stringify([normalizeResource(group(55, 'Support'))]));
    writeFileSync(join(dir, 'triggers.json'), JSON.stringify([normalizeResource(trigger(7, 'Was deleted'))]));

    const { summary } = await runScript(SCRIPT, ['push', '--apply', '--dir', dir, '--json'], env(base));

    assert.equal(summary.applied, 0);
    assert.equal(summary.skipped, 1);
    assert.equal(writes.filter((w) => w.method !== 'GET').length, 0);
    assert.match(summary.skipped_detail[0].reason, /resurrect something someone removed/);
  });
});

test('refuses to push a trigger whose group dependency is missing locally', async () => {
  const { plan, writes } = zendeskMock({
    groups: [group(55, 'Support')],
    triggers: [trigger(1, 'Route new')],
  });

  await withMockApi(plan, async ({ base }) => {
    const dir = tempOut('cfg-');
    // Local groups file does not contain group 999.
    writeFileSync(join(dir, 'groups.json'), JSON.stringify([normalizeResource(group(55, 'Support'))]));
    writeFileSync(
      join(dir, 'triggers.json'),
      JSON.stringify([
        normalizeResource(trigger(1, 'Route new', { actions: [{ field: 'group_id', value: '999' }] })),
      ]),
    );

    const { summary } = await runScript(SCRIPT, ['push', '--apply', '--dir', dir, '--json'], env(base));

    assert.equal(summary.applied, 0);
    assert.equal(summary.skipped, 1);
    assert.ok(!writes.some((w) => w.method === 'PUT'));
    assert.match(summary.skipped_detail[0].reason, /group 999/);
    assert.match(summary.skipped_detail[0].reason, /not in the local config/);
  });
});

test('pull-only resources are never pushed', async () => {
  const { plan, writes } = zendeskMock({
    sla_policies: [{ id: 1, title: 'Standard', policy_metrics: [], position: 1 }],
  });

  await withMockApi(plan, async ({ base }) => {
    const dir = tempOut('cfg-');
    writeFileSync(
      join(dir, 'sla_policies.json'),
      JSON.stringify([{ id: 1, title: 'Changed locally', policy_metrics: [], position: 1 }]),
    );

    const { summary } = await runScript(
      SCRIPT,
      ['push', '--apply', '--only', 'sla_policies', '--dir', dir, '--json'],
      env(base),
    );

    assert.equal(summary.applied, 0);
    assert.equal(summary.skipped, 1);
    assert.ok(!writes.some((w) => w.method === 'PUT'));
    assert.match(summary.skipped_detail[0].reason, /pull-only/);
    assert.match(summary.skipped_detail[0].reason, /ordering is semantic/);
  });
});

test('--max-changes bounds a push', async () => {
  const triggers = Array.from({ length: 25 }, (_, i) => trigger(i + 1, `Live ${i + 1}`));
  const { plan, writes } = zendeskMock({ groups: [group(55, 'Support')], triggers });

  await withMockApi(plan, async ({ base }) => {
    const dir = tempOut('cfg-');
    writeFileSync(join(dir, 'groups.json'), JSON.stringify([normalizeResource(group(55, 'Support'))]));
    writeFileSync(
      join(dir, 'triggers.json'),
      JSON.stringify(triggers.map((t, i) => normalizeResource(trigger(i + 1, `Renamed ${i + 1}`)))),
    );

    const { summary } = await runScript(SCRIPT, ['push', '--apply', '--dir', dir, '--json'], env(base));

    assert.equal(summary.applied, 10, 'default max-changes is 10');
    assert.equal(writes.filter((w) => w.method === 'PUT').length, 10);
    assert.ok(summary.remaining > 0);
  });
});

test('resume skips already-applied resources', async () => {
  const { plan, writes } = zendeskMock({ groups: [group(55, 'Support')], triggers: [trigger(1, 'Route new')] });

  await withMockApi(plan, async ({ base }) => {
    const dir = tempOut('cfg-');
    writeFileSync(join(dir, 'groups.json'), JSON.stringify([normalizeResource(group(55, 'Support'))]));
    writeFileSync(join(dir, 'triggers.json'), JSON.stringify([normalizeResource(trigger(1, 'Renamed'))]));
    const e = env(base);

    await runScript(SCRIPT, ['push', '--apply', '--dir', dir, '--json'], e);
    const after = writes.filter((w) => w.method === 'PUT').length;
    assert.equal(after, 1);

    const second = await runScript(SCRIPT, ['push', '--apply', '--dir', dir, '--json'], e);
    assert.equal(writes.filter((w) => w.method === 'PUT').length, after, 'not re-applied');
    assert.equal(second.summary.applied, 0);
  });
});

test('rejects an unknown command and an unknown resource', async () => {
  const bad = await runScript(SCRIPT, ['destroy', '--json'], env('http://127.0.0.1:1'));
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /must be one of: pull, diff, push/);

  const unknown = await runScript(SCRIPT, ['diff', '--only', 'nonsense', '--json'], env('http://127.0.0.1:1'));
  assert.equal(unknown.code, 1);
  assert.match(unknown.stderr, /unknown resource "nonsense"/);
});

test('403 explains that config needs an admin token', async () => {
  await withMockApi(
    () => ({ status: 403, body: {} }),
    async ({ base }) => {
      const dir = tempOut('cfg-');
      const { code, stderr } = await runScript(SCRIPT, ['pull', '--dir', dir, '--json'], env(base));
      assert.equal(code, 1);
      assert.match(stderr, /admin token/);
      assert.match(stderr, /agent token cannot manage triggers/);
    },
  );
});
