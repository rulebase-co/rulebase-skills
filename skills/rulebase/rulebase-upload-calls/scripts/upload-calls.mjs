#!/usr/bin/env node
/**
 * Uploads call recordings to Rulebase in reviewed, bounded batches.
 *
 * Two phases, deliberately separate:
 *
 *   1. plan  (default)  Validate the manifest and write a plan file. No writes.
 *   2. apply (--apply)  Consume the plan and upload, journaling as it goes.
 *
 * Uploads cannot be deleted through the API, so the plan file exists to be read
 * by a human before anything is transferred, and --max-changes exists to keep a
 * mistake small.
 *
 * Credentials come from RULEBASE_API_KEY only — never argv.
 *
 * Usage:
 *   node upload-calls.mjs --manifest calls.jsonl [--roster agents.txt]
 *                         [--region us|eu] --plan out/plan.json
 *   node upload-calls.mjs --plan out/plan.json --apply
 *                         [--max-changes N] [--audit f] [--journal f]
 */

import { readFileSync, writeFileSync, existsSync, statSync, appendFileSync, mkdirSync, openAsBlob } from 'node:fs';
import { dirname, basename, extname } from 'node:path';

const AUDIO_EXTS = new Set(['.wav', '.mp3', '.m4a']);
const MAX_FILE_BYTES = 100 * 1024 * 1024; // multipart endpoint limit
const REQUIRED_FIELDS = ['file', 'unique_id', 'type', 'agent', 'caller', 'called', 'recorded_at'];
const DEFAULT_MAX_CHANGES = 100;

const argv = process.argv.slice(2);
const has = (name) => argv.includes(`--${name}`);
function opt(name, fallback = undefined) {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith('--')) return true;
  return v;
}

const APPLY = has('apply');
const region = String(opt('region', process.env.RULEBASE_REGION || 'us')).toLowerCase();
if (region !== 'us' && region !== 'eu') die(`--region must be "us" or "eu" (got "${region}")`);

// RULEBASE_API_ORIGIN exists so this script can be exercised against a mock in
// CI. Leave it unset in normal use; the region determines the real host.
const API_BASE = (process.env.RULEBASE_API_ORIGIN || `https://${region === 'eu' ? 'eu.' : ''}api.rulebase.co`).replace(
  /\/$/,
  '',
);
const planPath = opt('plan');
const source = opt('source', process.env.RULEBASE_UPLOAD_SOURCE);

function die(msg, code = 2) {
  console.error(`error: ${msg}`);
  process.exit(code);
}

function ensureDir(file) {
  const dir = dirname(file);
  if (dir && dir !== '.' && !existsSync(dir)) mkdirSync(dir, { recursive: true });
}

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

// ---------------------------------------------------------------- plan phase

/**
 * Validates one manifest record. Returns a list of human-readable problems;
 * empty means the record is uploadable.
 *
 * The inbound/outbound asymmetry in caller/called is checked here because
 * getting it backwards does not fail at the API — it produces conversations
 * with the customer and agent transposed, which then get evaluated that way.
 */
function validateRecord(rec, rosterSet) {
  const problems = [];

  for (const field of REQUIRED_FIELDS) {
    const v = rec[field];
    if (v === undefined || v === null || String(v).trim() === '') {
      problems.push(`missing required field \`${field}\``);
    }
  }
  if (problems.length) return problems;

  const type = String(rec.type).toLowerCase();
  if (type !== 'inbound' && type !== 'outbound') {
    problems.push(`type must be "inbound" or "outbound" (got "${rec.type}")`);
  }

  if (!existsSync(rec.file)) {
    problems.push(`file not found: ${rec.file}`);
  } else {
    const ext = extname(rec.file).toLowerCase();
    if (!AUDIO_EXTS.has(ext)) {
      problems.push(`unsupported audio format "${ext}" (accepts ${[...AUDIO_EXTS].join(', ')})`);
    }
    const size = statSync(rec.file).size;
    if (size === 0) problems.push('file is empty');
    if (size > MAX_FILE_BYTES) {
      problems.push(
        `file is ${(size / 1024 / 1024).toFixed(1)} MB, over the 100 MB multipart limit — use the presign path for this one`,
      );
    }
  }

  const looksLikeEmail = (s) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(s).trim());
  if (!looksLikeEmail(rec.agent)) {
    problems.push(`agent "${rec.agent}" is not an email address; agent identity is matched on email`);
  } else if (rosterSet && !rosterSet.has(String(rec.agent).trim().toLowerCase())) {
    problems.push(`agent "${rec.agent}" is not on the supplied roster — the call would be uploaded with nobody to evaluate`);
  }

  // Direction-specific shape. Advisory but high-value: these are the errors that
  // survive ingestion and corrupt evaluations rather than failing the request.
  if (type === 'outbound' && !looksLikeEmail(rec.caller)) {
    problems.push(`outbound call: caller should be the agent email, got "${rec.caller}" — check caller/called are not transposed`);
  }
  if (type === 'inbound' && looksLikeEmail(rec.caller)) {
    problems.push(`inbound call: caller should be the customer phone number, got an email — check caller/called are not transposed`);
  }

  if (Number.isNaN(Date.parse(rec.recorded_at))) {
    problems.push(`recorded_at "${rec.recorded_at}" is not a parseable timestamp`);
  }

  return problems;
}

async function checkAuth(apiKey) {
  // Cheapest authenticated read that exists on v1 for this resource family: a
  // lookup of an id that will not exist. 401 means the credential/region is
  // wrong; 404 means we are authenticated and the id simply is not there.
  const res = await fetch(`${API_BASE}/conversations/upload/auth-probe-nonexistent`, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
  }).catch((err) => ({ networkError: String(err?.message || err) }));

  if (res.networkError) return { ok: false, detail: `could not reach ${API_BASE} — ${res.networkError}` };
  if (res.status === 401) {
    return {
      ok: false,
      detail: `401 from ${API_BASE}. Check the region first (this run used "${region}") — a key from the other region returns exactly this.`,
    };
  }
  return { ok: true, detail: `authenticated against ${API_BASE} (probe returned ${res.status})` };
}

async function doPlan() {
  const manifestPath = opt('manifest');
  if (!manifestPath || manifestPath === true) die('--manifest <file.jsonl> is required when planning');
  if (!planPath || planPath === true) die('--plan <file.json> is required: the plan is what --apply consumes');
  if (!existsSync(manifestPath)) die(`manifest not found: ${manifestPath}`);

  const apiKey = process.env.RULEBASE_API_KEY;
  if (!apiKey) die('RULEBASE_API_KEY is not set');
  if (apiKey !== apiKey.trim()) {
    die('RULEBASE_API_KEY has leading or trailing whitespace, which breaks the Authorization header');
  }

  const rosterPath = opt('roster');
  let rosterSet = null;
  if (rosterPath && rosterPath !== true) {
    if (!existsSync(rosterPath)) die(`roster not found: ${rosterPath}`);
    rosterSet = new Set(
      readFileSync(rosterPath, 'utf8')
        .split('\n')
        .map((l) => l.trim().toLowerCase())
        .filter(Boolean),
    );
    console.error(`roster: ${rosterSet.size} agent email(s) loaded`);
  } else {
    console.error('roster: not supplied — agent emails will not be reconciled (pass --roster to catch unevaluatable uploads)');
  }

  const auth = await checkAuth(apiKey);
  console.error(`${auth.ok ? 'ok  ' : 'FAIL'}  auth: ${auth.detail}`);
  if (!auth.ok) process.exit(1);

  const rows = readJsonl(manifestPath);
  const uploadable = [];
  const rejected = [];
  const seen = new Map();

  for (const { line, record } of rows) {
    const problems = validateRecord(record, rosterSet);

    const uid = String(record.unique_id ?? '').trim();
    if (uid && seen.has(uid)) {
      problems.push(`duplicate unique_id "${uid}" (also on line ${seen.get(uid)})`);
    } else if (uid) {
      seen.set(uid, line);
    }

    if (problems.length) rejected.push({ line, unique_id: record.unique_id ?? null, problems });
    else uploadable.push({ line, ...record });
  }

  const plan = {
    createdAt: new Date().toISOString(),
    region,
    apiBase: API_BASE,
    source: source && source !== true ? String(source) : null,
    manifest: manifestPath,
    rosterReconciled: Boolean(rosterSet),
    counts: { total: rows.length, uploadable: uploadable.length, rejected: rejected.length },
    uploads: uploadable,
    rejected,
  };

  ensureDir(planPath);
  writeFileSync(planPath, JSON.stringify(plan, null, 2));

  console.error('');
  console.error(`plan written to ${planPath}`);
  console.error(`  ${uploadable.length} uploadable, ${rejected.length} rejected, ${rows.length} total`);
  if (!plan.source) {
    console.error('  WARNING: no --source set. The API accepts a fixed enum of source values;');
    console.error('           check the v1 reference and re-plan with --source <value>.');
  }
  if (rejected.length) {
    console.error('');
    console.error('Rejected records (first 10):');
    for (const r of rejected.slice(0, 10)) {
      console.error(`  line ${r.line}${r.unique_id ? ` (${r.unique_id})` : ''}: ${r.problems.join('; ')}`);
    }
  }
  console.error('');
  console.error('Nothing has been uploaded. Review the plan, then re-run with --apply.');

  console.log(JSON.stringify({ phase: 'plan', ...plan.counts, plan: planPath, source: plan.source }, null, 2));
}

// --------------------------------------------------------------- apply phase

async function uploadOne(apiKey, rec, planSource) {
  const form = new FormData();
  form.set('upload[source]', planSource);
  form.set('upload[metadata][unique_id]', String(rec.unique_id));
  form.set('upload[metadata][type]', String(rec.type).toLowerCase());
  form.set('upload[metadata][agent]', String(rec.agent));
  form.set('upload[metadata][caller]', String(rec.caller));
  form.set('upload[metadata][called]', String(rec.called));
  form.set('upload[metadata][recorded_at]', String(rec.recorded_at));

  const blob = await openAsBlob(rec.file);
  form.set('upload[file]', blob, basename(rec.file));

  const res = await fetch(`${API_BASE}/conversations/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
    body: form,
  });

  const text = await res.text().catch(() => '');
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* non-JSON error bodies are reported as text */
  }

  return { status: res.status, uploadId: body?.data?.id ?? null, uploadStatus: body?.data?.status ?? null, raw: text.slice(0, 300) };
}

async function verifyUpload(apiKey, uploadId) {
  const res = await fetch(`${API_BASE}/conversations/upload/${encodeURIComponent(uploadId)}`, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
  }).catch((err) => ({ networkError: String(err?.message || err) }));
  if (res.networkError) return { ok: false, detail: res.networkError };
  const text = await res.text().catch(() => '');
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* ignore */
  }
  return { ok: res.status === 200, status: res.status, uploadStatus: body?.data?.status ?? null };
}

async function doApply() {
  if (!planPath || planPath === true) die('--plan <file.json> is required');
  if (!existsSync(planPath)) die(`plan not found: ${planPath}. Run without --apply first to create one.`);

  const apiKey = process.env.RULEBASE_API_KEY;
  if (!apiKey) die('RULEBASE_API_KEY is not set');

  const plan = JSON.parse(readFileSync(planPath, 'utf8'));
  const planSource = source && source !== true ? String(source) : plan.source;
  if (!planSource) {
    die('no upload source: the API requires one of a fixed enum of source values. Re-plan with --source <value>.');
  }
  if (plan.region && plan.region !== region) {
    die(`plan was built for region "${plan.region}" but this run is "${region}". Re-plan rather than retargeting.`);
  }

  const maxChanges = Number(opt('max-changes', DEFAULT_MAX_CHANGES));
  if (!Number.isInteger(maxChanges) || maxChanges <= 0) die('--max-changes must be a positive integer');

  const auditPath = String(opt('audit', './out/upload-audit.jsonl'));
  const journalPath = String(opt('journal', './out/upload-journal.jsonl'));
  ensureDir(auditPath);
  ensureDir(journalPath);

  // Resume: anything already journaled as succeeded is skipped, so an
  // interrupted backfill can be re-run with the identical command.
  const done = new Set();
  if (existsSync(journalPath)) {
    for (const { record } of readJsonl(journalPath)) {
      if (record.unique_id && record.outcome === 'uploaded') done.add(String(record.unique_id));
    }
    console.error(`journal: ${done.size} call(s) already uploaded — skipping those`);
  }

  const queue = (plan.uploads ?? []).filter((r) => !done.has(String(r.unique_id)));
  const batch = queue.slice(0, maxChanges);

  console.error(
    `applying: ${batch.length} of ${queue.length} remaining (--max-changes ${maxChanges}) to ${API_BASE}`,
  );
  if (queue.length > batch.length) {
    console.error(`         ${queue.length - batch.length} will remain; re-run to continue`);
  }
  console.error('');

  const results = { uploaded: 0, failed: 0, skipped: done.size, remaining: queue.length - batch.length };
  const applied = [];

  for (const rec of batch) {
    const stamp = new Date().toISOString();
    let outcome;
    let detail;

    try {
      const res = await uploadOne(apiKey, rec, planSource);
      if (res.status === 201 || res.status === 200) {
        outcome = 'uploaded';
        detail = { uploadId: res.uploadId, uploadStatus: res.uploadStatus };
        results.uploaded += 1;
        applied.push({ unique_id: rec.unique_id, uploadId: res.uploadId });
        console.error(`  ok    ${rec.unique_id} -> upload ${res.uploadId ?? '(no id returned)'}`);
      } else {
        outcome = 'failed';
        detail = { httpStatus: res.status, body: res.raw };
        results.failed += 1;
        console.error(`  FAIL  ${rec.unique_id} -> HTTP ${res.status} ${res.raw}`);
      }
    } catch (err) {
      outcome = 'failed';
      detail = { error: String(err?.message || err) };
      results.failed += 1;
      console.error(`  FAIL  ${rec.unique_id} -> ${detail.error}`);
    }

    // Audit record is written as the run proceeds, never buffered, so an
    // interrupted run still explains what it did. before-state is "absent":
    // this endpoint creates, it does not update.
    appendFileSync(
      auditPath,
      `${JSON.stringify({
        timestamp: stamp,
        plan: planPath,
        unique_id: rec.unique_id,
        file: rec.file,
        agent: rec.agent,
        before: null,
        after: outcome === 'uploaded' ? detail : null,
        outcome,
        detail,
      })}\n`,
    );
    appendFileSync(journalPath, `${JSON.stringify({ unique_id: rec.unique_id, outcome, timestamp: stamp })}\n`);
  }

  // Rule 7: verify what landed rather than trusting the 201.
  const verified = [];
  if (applied.length) {
    console.error('');
    console.error('verifying...');
    for (const a of applied) {
      if (!a.uploadId) {
        verified.push({ ...a, verified: false, reason: 'no upload id returned' });
        continue;
      }
      const v = await verifyUpload(apiKey, a.uploadId);
      verified.push({ ...a, verified: v.ok, uploadStatus: v.uploadStatus ?? null });
      if (!v.ok) console.error(`  WARN  ${a.unique_id}: could not re-read upload ${a.uploadId}`);
    }
  }

  const unverified = verified.filter((v) => !v.verified);
  console.error('');
  console.error(
    `uploaded ${results.uploaded}, failed ${results.failed}, skipped ${results.skipped}, remaining ${results.remaining}`,
  );
  if (unverified.length) console.error(`${unverified.length} upload(s) could not be verified — see output`);
  console.error(`audit: ${auditPath}`);

  console.log(JSON.stringify({ phase: 'apply', region, apiBase: API_BASE, ...results, verified }, null, 2));

  if (results.failed > 0 || unverified.length > 0) process.exit(1);
}

if (APPLY) await doApply();
else await doPlan();
