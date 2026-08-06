/**
 * Tests for the Rulebase call upload mutation. These encode the mutation safety
 * contract: dry-run by default, plan-first, append-only audit, idempotent
 * resume, and a bounded blast radius.
 *
 * The most valuable tests here are the two validation ones. Uploads cannot be
 * deleted through the API, so a transposed caller/called or an agent who is not
 * on the roster has to be caught in the plan phase — after upload it is a
 * support request, not a fix.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withMockApi, runScript, tempOut, readJsonl } from './helpers/mock-api.mjs';

const SCRIPT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../skills/rulebase/rulebase-upload-calls/scripts/upload-calls.mjs',
);

/** A valid inbound call record, with a real (tiny) audio file on disk. */
function fixture(dir, overrides = {}) {
  const audio = join(dir, `${overrides.unique_id ?? 'call-1'}.mp3`);
  writeFileSync(audio, Buffer.from([0xff, 0xfb, 0x90, 0x00, 0x00, 0x00]));
  return {
    file: audio,
    unique_id: 'call-1',
    type: 'inbound',
    agent: 'amara@example.com',
    caller: '+2348012345678',
    called: '+2341234567',
    recorded_at: '2026-07-01T09:14:22Z',
    ...overrides,
  };
}

function manifest(dir, records) {
  const path = join(dir, 'calls.jsonl');
  writeFileSync(path, records.map((r) => JSON.stringify(r)).join('\n'));
  return path;
}

function roster(dir, emails) {
  const path = join(dir, 'agents.txt');
  writeFileSync(path, emails.join('\n'));
  return path;
}

const env = (base, extra = {}) => ({
  RULEBASE_API_KEY: 'rk_live_placeholder',
  RULEBASE_API_ORIGIN: base,
  ...extra,
});

/** Mock: auth probe 404s (authenticated), uploads 201, verification 200. */
function planner({ uploadStatus = 201, failIds = new Set() } = {}) {
  let created = 0;
  return (req) => {
    if (req.url.startsWith('/conversations/upload/auth-probe')) return { status: 404, body: { error: 'Not found' } };
    if (req.method === 'POST' && req.url === '/conversations/upload') {
      created += 1;
      if (failIds.has(created)) return { status: 422, body: { error: 'invalid source' } };
      return { status: uploadStatus, body: { data: { id: `up_${created}`, status: 'pending' } } };
    }
    if (req.method === 'GET' && req.url.startsWith('/conversations/upload/')) {
      return { status: 200, body: { data: { id: req.url.split('/').pop(), status: 'processing' } } };
    }
    return { status: 404, body: { error: 'not found' } };
  };
}

test('the default run plans and uploads nothing', async () => {
  const dir = tempOut('upload-plan-');
  const m = manifest(dir, [fixture(dir)]);
  const planPath = join(dir, 'plan.json');

  await withMockApi(planner(), async ({ base, calls }) => {
    const res = await runScript(
      SCRIPT,
      ['--manifest', m, '--roster', roster(dir, ['amara@example.com']), '--plan', planPath, '--source', 'xcally'],
      env(base),
    );

    assert.equal(res.code, 0);
    assert.equal(res.summary.phase, 'plan');
    assert.equal(res.summary.uploadable, 1);
    assert.ok(existsSync(planPath));

    // The only request made was the auth probe. Nothing was posted.
    assert.equal(calls.filter((c) => c.method === 'POST').length, 0);
  });
});

test('rejects an agent who is not on the roster, because the upload would be unevaluatable', async () => {
  const dir = tempOut('upload-roster-');
  const m = manifest(dir, [fixture(dir, { agent: 'notonroster@example.com' })]);
  const planPath = join(dir, 'plan.json');

  await withMockApi(planner(), async ({ base }) => {
    const res = await runScript(
      SCRIPT,
      ['--manifest', m, '--roster', roster(dir, ['amara@example.com']), '--plan', planPath, '--source', 'xcally'],
      env(base),
    );

    assert.equal(res.summary.uploadable, 0);
    assert.equal(res.summary.rejected, 1);
    const plan = JSON.parse(readFileSync(planPath, 'utf8'));
    assert.match(plan.rejected[0].problems.join(' '), /not on the supplied roster/);
  });
});

test('flags transposed caller/called on an outbound call', async () => {
  const dir = tempOut('upload-transposed-');
  // Outbound: caller should be the agent email. Here it holds a phone number,
  // which is the inbound shape — the classic transposition.
  const m = manifest(dir, [fixture(dir, { type: 'outbound', caller: '+2348012345678', called: '+2341234567' })]);
  const planPath = join(dir, 'plan.json');

  await withMockApi(planner(), async ({ base }) => {
    await runScript(SCRIPT, ['--manifest', m, '--plan', planPath, '--source', 'xcally'], env(base));

    const plan = JSON.parse(readFileSync(planPath, 'utf8'));
    assert.equal(plan.counts.rejected, 1);
    assert.match(plan.rejected[0].problems.join(' '), /transposed/);
  });
});

test('rejects duplicate unique_ids within one manifest', async () => {
  const dir = tempOut('upload-dupe-');
  const m = manifest(dir, [fixture(dir), { ...fixture(dir), file: fixture(dir).file }]);
  const planPath = join(dir, 'plan.json');

  await withMockApi(planner(), async ({ base }) => {
    await runScript(SCRIPT, ['--manifest', m, '--plan', planPath, '--source', 'xcally'], env(base));
    const plan = JSON.parse(readFileSync(planPath, 'utf8'));
    assert.equal(plan.counts.uploadable, 1);
    assert.match(plan.rejected[0].problems.join(' '), /duplicate unique_id/);
  });
});

test('--apply uploads, audits every attempt, and verifies what landed', async () => {
  const dir = tempOut('upload-apply-');
  const m = manifest(dir, [fixture(dir, { unique_id: 'c1' }), fixture(dir, { unique_id: 'c2' })]);
  const planPath = join(dir, 'plan.json');
  const auditPath = join(dir, 'audit.jsonl');
  const journalPath = join(dir, 'journal.jsonl');

  await withMockApi(planner(), async ({ base, calls }) => {
    await runScript(SCRIPT, ['--manifest', m, '--plan', planPath, '--source', 'xcally'], env(base));

    const res = await runScript(
      SCRIPT,
      ['--plan', planPath, '--apply', '--audit', auditPath, '--journal', journalPath],
      env(base),
    );

    assert.equal(res.code, 0);
    assert.equal(res.summary.uploaded, 2);
    assert.equal(res.summary.failed, 0);

    // Rule 3: one audit record per attempt, with the plan it came from.
    const audit = readJsonl(auditPath);
    assert.equal(audit.length, 2);
    assert.equal(audit[0].plan, planPath);
    assert.equal(audit[0].outcome, 'uploaded');
    assert.equal(audit[0].before, null);

    // Rule 7: each upload was re-read after applying.
    assert.equal(res.summary.verified.length, 2);
    assert.ok(res.summary.verified.every((v) => v.verified));
    assert.equal(calls.filter((c) => c.method === 'GET' && /\/conversations\/upload\/up_/.test(c.url)).length, 2);
  });
});

test('--max-changes bounds the batch and reports what remains', async () => {
  const dir = tempOut('upload-bound-');
  const m = manifest(dir, [1, 2, 3, 4].map((i) => fixture(dir, { unique_id: `c${i}` })));
  const planPath = join(dir, 'plan.json');

  await withMockApi(planner(), async ({ base }) => {
    await runScript(SCRIPT, ['--manifest', m, '--plan', planPath, '--source', 'xcally'], env(base));
    const res = await runScript(
      SCRIPT,
      ['--plan', planPath, '--apply', '--max-changes', '2', '--audit', join(dir, 'a.jsonl'), '--journal', join(dir, 'j.jsonl')],
      env(base),
    );

    assert.equal(res.summary.uploaded, 2);
    assert.equal(res.summary.remaining, 2);
  });
});

test('re-running after an interruption does not double-apply', async () => {
  const dir = tempOut('upload-resume-');
  const m = manifest(dir, [1, 2, 3].map((i) => fixture(dir, { unique_id: `c${i}` })));
  const planPath = join(dir, 'plan.json');
  const journalPath = join(dir, 'journal.jsonl');
  const auditPath = join(dir, 'audit.jsonl');

  await withMockApi(planner(), async ({ base, calls }) => {
    await runScript(SCRIPT, ['--manifest', m, '--plan', planPath, '--source', 'xcally'], env(base));

    const first = await runScript(
      SCRIPT,
      ['--plan', planPath, '--apply', '--max-changes', '2', '--audit', auditPath, '--journal', journalPath],
      env(base),
    );
    assert.equal(first.summary.uploaded, 2);

    const posts = () => calls.filter((c) => c.method === 'POST' && c.url === '/conversations/upload').length;
    const afterFirst = posts();

    // Identical command, as an operator would re-run it.
    const second = await runScript(
      SCRIPT,
      ['--plan', planPath, '--apply', '--max-changes', '2', '--audit', auditPath, '--journal', journalPath],
      env(base),
    );

    assert.equal(second.summary.skipped, 2, 'journaled uploads should be skipped');
    assert.equal(second.summary.uploaded, 1, 'only the remaining call should upload');
    assert.equal(posts() - afterFirst, 1, 'exactly one new upload request');
  });
});

test('a failed upload is audited and exits non-zero', async () => {
  const dir = tempOut('upload-fail-');
  const m = manifest(dir, [fixture(dir, { unique_id: 'c1' }), fixture(dir, { unique_id: 'c2' })]);
  const planPath = join(dir, 'plan.json');
  const auditPath = join(dir, 'audit.jsonl');

  await withMockApi(planner({ failIds: new Set([2]) }), async ({ base }) => {
    await runScript(SCRIPT, ['--manifest', m, '--plan', planPath, '--source', 'xcally'], env(base));
    const res = await runScript(
      SCRIPT,
      ['--plan', planPath, '--apply', '--audit', auditPath, '--journal', join(dir, 'j.jsonl')],
      env(base),
    );

    assert.equal(res.code, 1);
    assert.equal(res.summary.uploaded, 1);
    assert.equal(res.summary.failed, 1);
    const audit = readJsonl(auditPath);
    assert.equal(audit.filter((a) => a.outcome === 'failed').length, 1);
  });
});

test('refuses to apply a plan built for the other region', async () => {
  const dir = tempOut('upload-region-');
  const m = manifest(dir, [fixture(dir)]);
  const planPath = join(dir, 'plan.json');

  await withMockApi(planner(), async ({ base }) => {
    await runScript(SCRIPT, ['--manifest', m, '--plan', planPath, '--region', 'us', '--source', 'xcally'], env(base));
    const res = await runScript(SCRIPT, ['--plan', planPath, '--apply', '--region', 'eu'], env(base));

    assert.equal(res.code, 2);
    assert.match(res.stderr, /Re-plan rather than retargeting/);
  });
});

test('--apply without a plan file refuses to run', async () => {
  const res = await runScript(SCRIPT, ['--apply', '--plan', '/nonexistent/plan.json'], { RULEBASE_API_KEY: 'x' });
  assert.equal(res.code, 2);
  assert.match(res.stderr, /Run without --apply first/);
});

test('offers no --force flag', async () => {
  const source = readFileSync(SCRIPT, 'utf8');
  assert.ok(!/--force\b/.test(source), 'destruction must never be the convenient path');
});
