#!/usr/bin/env node
/**
 * Pushes back-office work items into Rulebase in reviewed, bounded batches.
 *
 *   1. plan  (default)  Validate the manifest and write a plan file. No writes.
 *   2. apply (--apply)  Consume the plan and push, journaling as it goes.
 *
 * The API upserts on work_item.external_id, which makes retries safe and makes
 * an unstable id catastrophic: a fresh id per run silently doubles the data
 * instead of updating it. The plan phase exists mostly to catch that, plus the
 * two other things that produce records nobody can evaluate: no agent on the
 * roster, and no events to assess.
 *
 * Credentials come from RULEBASE_API_KEY only.
 *
 * Usage:
 *   node push-work-items.mjs --manifest items.jsonl [--roster agents.txt]
 *                            [--region us|eu] --plan out/plan.json
 *   node push-work-items.mjs --plan out/plan.json --apply
 *                            [--max-changes N] [--audit f] [--journal f]
 */

import { readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const STATUSES = new Set(['pending', 'in_progress', 'completed', 'cancelled']);
const DEFAULT_MAX_CHANGES = 100;

const argv = process.argv.slice(2);
const has = (n) => argv.includes(`--${n}`);
function opt(name, fallback = undefined) {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith('--')) return true;
  return v;
}
const die = (msg) => {
  console.error(`error: ${msg}`);
  process.exit(2);
};

const APPLY = has('apply');
const region = String(opt('region', process.env.RULEBASE_REGION || 'us')).toLowerCase();
if (region !== 'us' && region !== 'eu') die(`--region must be "us" or "eu" (got "${region}")`);

// RULEBASE_API2_ORIGIN exists so this can be exercised against a mock in CI.
const API_BASE = (
  process.env.RULEBASE_API2_ORIGIN || `https://${region === 'eu' ? 'eu.' : ''}api2.rulebase.co`
).replace(/\/$/, '');

const planPath = opt('plan');

const ensureDir = (f) => {
  const d = dirname(f);
  if (d && d !== '.' && !existsSync(d)) mkdirSync(d, { recursive: true });
};

function readJsonl(path) {
  return readFileSync(path, 'utf8')
    .split('\n')
    .map((l, i) => ({ line: i + 1, text: l.trim() }))
    .filter((r) => r.text !== '')
    .map((r) => {
      try {
        return { line: r.line, record: JSON.parse(r.text) };
      } catch (err) {
        die(`${path}:${r.line} is not valid JSON — ${err.message}`);
      }
    });
}

// ---------------------------------------------------------------- validation

/** Returns human-readable problems; empty means the record is pushable. */
function validate(rec, rosterSet) {
  const problems = [];
  const id = rec.external_id;

  if (typeof id !== 'string' || id.trim() === '') {
    problems.push('missing external_id, which is the only required field and the upsert key');
    return problems;
  }
  // A UUID minted at push time is the classic unstable id: it succeeds, and it
  // doubles the data on the next run.
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    problems.push(
      `external_id "${id}" looks like a generated UUID. It must be derived from the source system's own key, or a re-run creates duplicates instead of updating`,
    );
  }

  if (rec.status !== undefined && !STATUSES.has(rec.status)) {
    problems.push(`status "${rec.status}" is not one of ${[...STATUSES].join(', ')}; map it and keep the raw value in custom_attributes`);
  }
  if (rec.status === 'completed' && !rec.completed_at) {
    problems.push('status is "completed" with no completed_at, so the item may fall outside the evaluation eligibility window');
  }
  for (const field of ['completed_at']) {
    if (rec[field] && Number.isNaN(Date.parse(rec[field]))) {
      problems.push(`${field} "${rec[field]}" is not a parseable timestamp`);
    }
  }

  const agent = rec.agent_email || rec.agent_name || rec.agent_external_id;
  if (!agent) {
    problems.push('no agent_email, agent_name or agent_external_id: the item would be stored with nobody to evaluate');
  } else if (rec.agent_email && rosterSet && !rosterSet.has(String(rec.agent_email).trim().toLowerCase())) {
    problems.push(`agent_email "${rec.agent_email}" is not on the supplied roster, so the item would never be evaluated`);
  }

  const events = rec.events;
  if (!Array.isArray(events) || events.length === 0) {
    problems.push('no events: the work item would exist with no content for a scorecard to assess');
  } else {
    const seen = new Set();
    events.forEach((e, i) => {
      if (!e || typeof e.external_id !== 'string' || e.external_id.trim() === '') {
        problems.push(`event ${i + 1} has no external_id, which the events endpoint upserts on`);
        return;
      }
      if (seen.has(e.external_id)) {
        problems.push(`duplicate event external_id "${e.external_id}": the second would overwrite the first`);
      }
      seen.add(e.external_id);
      if (/^(event|note|item)[-_]?\d+$/i.test(e.external_id)) {
        problems.push(
          `event external_id "${e.external_id}" looks like a loop index. Derive it from the source event, or events collide across work items`,
        );
      }
      if (e.occurred_at && Number.isNaN(Date.parse(e.occurred_at))) {
        problems.push(`event "${e.external_id}" has an unparseable occurred_at`);
      }
    });
  }

  return problems;
}

// -------------------------------------------------------------------- client

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, path, body, attempt = 0) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.RULEBASE_API_KEY}`,
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  if (res.status === 429 && attempt < 6) {
    const retry = Number(res.headers.get('retry-after'));
    const wait = Number.isFinite(retry) && retry >= 0 ? Math.max(1000, retry * 1000) : Math.min(30000, 1000 * 2 ** attempt);
    console.error(`  rate limited, waiting ${Math.round(wait / 1000)}s`);
    await sleep(wait);
    return api(method, path, body, attempt + 1);
  }

  const text = await res.text().catch(() => '');
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON errors are reported as text */
  }
  return { status: res.status, json, raw: text.slice(0, 300) };
}

// ---------------------------------------------------------------- plan phase

async function doPlan() {
  const manifestPath = opt('manifest');
  if (!manifestPath || manifestPath === true) die('--manifest <file.jsonl> is required when planning');
  if (!planPath || planPath === true) die('--plan <file.json> is required: the plan is what --apply consumes');
  if (!existsSync(String(manifestPath))) die(`manifest not found: ${manifestPath}`);

  const key = process.env.RULEBASE_API_KEY;
  if (!key) die('RULEBASE_API_KEY is not set');
  if (key !== key.trim()) die('RULEBASE_API_KEY has leading or trailing whitespace, which breaks the Authorization header');

  const rosterPath = opt('roster');
  let rosterSet = null;
  if (rosterPath && rosterPath !== true) {
    if (!existsSync(String(rosterPath))) die(`roster not found: ${rosterPath}`);
    rosterSet = new Set(
      readFileSync(String(rosterPath), 'utf8').split('\n').map((l) => l.trim().toLowerCase()).filter(Boolean),
    );
    console.error(`roster: ${rosterSet.size} agent email(s) loaded`);
  } else {
    console.error('roster: not supplied, so agent emails will not be reconciled (pass --roster to catch unevaluatable items)');
  }

  // Cheapest authenticated read: a work item id that will not exist. 401 means
  // the credential or region is wrong; 404 means we are authenticated.
  const probe = await api('GET', '/work_items/auth-probe-nonexistent');
  if (probe.status === 401) {
    die(`401 from ${API_BASE}. Check the region first (this run used "${region}"), because a key from the other region returns exactly this.`);
  }
  console.error(`ok    auth: authenticated against ${API_BASE} (probe returned ${probe.status})`);

  const rows = readJsonl(String(manifestPath));
  const pushable = [];
  const rejected = [];
  const seen = new Map();

  for (const { line, record } of rows) {
    const problems = validate(record, rosterSet);
    const id = String(record.external_id ?? '').trim();
    if (id && seen.has(id)) {
      problems.push(`duplicate external_id "${id}" (also on line ${seen.get(id)}); the second would overwrite the first`);
    } else if (id) {
      seen.set(id, line);
    }
    if (problems.length) rejected.push({ line, external_id: record.external_id ?? null, problems });
    else pushable.push({ line, ...record });
  }

  const plan = {
    createdAt: new Date().toISOString(),
    region,
    apiBase: API_BASE,
    manifest: String(manifestPath),
    rosterReconciled: Boolean(rosterSet),
    counts: { total: rows.length, pushable: pushable.length, rejected: rejected.length },
    items: pushable,
    rejected,
  };

  ensureDir(String(planPath));
  writeFileSync(String(planPath), JSON.stringify(plan, null, 2));

  console.error('');
  console.error(`plan written to ${planPath}`);
  console.error(`  ${pushable.length} pushable, ${rejected.length} rejected, ${rows.length} total`);
  if (rejected.length) {
    console.error('');
    console.error('Rejected records (first 10):');
    for (const r of rejected.slice(0, 10)) {
      console.error(`  line ${r.line}${r.external_id ? ` (${r.external_id})` : ''}: ${r.problems.join('; ')}`);
    }
  }
  console.error('');
  console.error('Nothing has been pushed. Review the plan, then re-run with --apply.');

  console.log(JSON.stringify({ phase: 'plan', ...plan.counts, plan: String(planPath) }, null, 2));
}

// --------------------------------------------------------------- apply phase

async function doApply() {
  if (!planPath || planPath === true) die('--plan <file.json> is required');
  if (!existsSync(String(planPath))) die(`plan not found: ${planPath}. Run without --apply first to create one.`);
  if (!process.env.RULEBASE_API_KEY) die('RULEBASE_API_KEY is not set');

  const plan = JSON.parse(readFileSync(String(planPath), 'utf8'));
  if (plan.region && plan.region !== region) {
    die(`plan was built for region "${plan.region}" but this run is "${region}". Re-plan rather than retargeting.`);
  }

  const maxChanges = Number(opt('max-changes', DEFAULT_MAX_CHANGES));
  if (!Number.isInteger(maxChanges) || maxChanges <= 0) die('--max-changes must be a positive integer');

  const auditPath = String(opt('audit', './out/work-items-audit.jsonl'));
  const journalPath = String(opt('journal', './out/work-items-journal.jsonl'));
  ensureDir(auditPath);
  ensureDir(journalPath);

  const done = new Set();
  if (existsSync(journalPath)) {
    for (const { record } of readJsonl(journalPath)) {
      if (record.external_id && record.outcome === 'pushed') done.add(String(record.external_id));
    }
    console.error(`journal: ${done.size} item(s) already pushed, skipping those`);
  }

  const queue = (plan.items ?? []).filter((r) => !done.has(String(r.external_id)));
  const batch = queue.slice(0, maxChanges);

  console.error(`applying: ${batch.length} of ${queue.length} remaining (--max-changes ${maxChanges}) to ${API_BASE}`);
  if (queue.length > batch.length) console.error(`         ${queue.length - batch.length} will remain; re-run to continue`);
  console.error('');

  const results = { pushed: 0, failed: 0, skipped: done.size, remaining: queue.length - batch.length };
  const applied = [];

  for (const item of batch) {
    const stamp = new Date().toISOString();
    const { line, ...work_item } = item;
    let outcome;
    let detail;

    try {
      const res = await api('POST', '/work_items', { work_item });
      if (res.status === 201 || res.status === 200) {
        outcome = 'pushed';
        detail = { id: res.json?.data?.id ?? null, status: res.status };
        results.pushed += 1;
        applied.push({ external_id: work_item.external_id, id: detail.id });
        console.error(`  ok    ${work_item.external_id}`);
      } else {
        outcome = 'failed';
        detail = { httpStatus: res.status, body: res.raw };
        results.failed += 1;
        console.error(`  FAIL  ${work_item.external_id} -> HTTP ${res.status} ${res.raw}`);
      }
    } catch (err) {
      outcome = 'failed';
      detail = { error: String(err?.message || err) };
      results.failed += 1;
      console.error(`  FAIL  ${work_item.external_id} -> ${detail.error}`);
    }

    // Written as the run proceeds so an interrupted run still explains itself.
    // The API upserts, so before-state is not knowable from the push alone.
    appendFileSync(
      auditPath,
      `${JSON.stringify({
        timestamp: stamp,
        plan: String(planPath),
        external_id: work_item.external_id,
        agent: work_item.agent_email ?? work_item.agent_external_id ?? null,
        events: Array.isArray(work_item.events) ? work_item.events.length : 0,
        before: null,
        after: outcome === 'pushed' ? detail : null,
        outcome,
        detail,
      })}\n`,
    );
    appendFileSync(journalPath, `${JSON.stringify({ external_id: work_item.external_id, outcome, timestamp: stamp })}\n`);
  }

  // Rule 7: verify rather than trusting the 201.
  const verified = [];
  if (applied.length) {
    console.error('');
    console.error('verifying...');
    for (const a of applied) {
      if (!a.id) {
        verified.push({ ...a, verified: false, reason: 'no id returned' });
        continue;
      }
      const res = await api('GET', `/work_items/${encodeURIComponent(a.id)}`);
      const ok = res.status === 200;
      verified.push({ ...a, verified: ok, status: res.status });
      if (!ok) console.error(`  WARN  ${a.external_id}: could not re-read ${a.id}`);
    }
  }

  const unverified = verified.filter((v) => !v.verified);
  console.error('');
  console.error(`pushed ${results.pushed}, failed ${results.failed}, skipped ${results.skipped}, remaining ${results.remaining}`);
  console.error(`audit: ${auditPath}`);

  console.log(
    JSON.stringify(
      {
        phase: 'apply',
        region,
        apiBase: API_BASE,
        ...results,
        verified,
        notes: [
          'The API upserts on external_id, so re-running corrects rather than duplicates. An unstable id does the opposite.',
          'A work item with no agent on the QA roster, or with no events, is stored and never evaluated.',
          'There is no delete endpoint for a work item.',
        ],
      },
      null,
      2,
    ),
  );

  if (results.failed > 0 || unverified.length > 0) process.exit(1);
}

if (APPLY) await doApply();
else await doPlan();
