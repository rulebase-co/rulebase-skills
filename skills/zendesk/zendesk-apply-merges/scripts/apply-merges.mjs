#!/usr/bin/env node
/**
 * Applies a reviewed merge plan to Zendesk. Merging is IRREVERSIBLE.
 *
 * This is the "doing" half of a plan-first mutation. It decides nothing: it
 * consumes a plan produced by cx-duplicate-detection, re-validates every entry
 * against live Zendesk state, and only then merges.
 *
 * Safety properties, in order of how much they matter:
 *
 *   1. Dry-run is the default. Writing requires --apply.
 *   2. Every entry is re-validated live before it is applied. A plan can be
 *      hours old; requesters change, tickets get closed or merged already. A
 *      stale plan must not cause a wrong merge, so a mismatch skips the entry
 *      rather than proceeding.
 *   3. Every attempt is appended to an audit log with before-state, after-state
 *      and outcome, as it happens.
 *   4. Applied targets are journalled, so an interrupted run resumes without
 *      re-merging.
 *   5. --max-changes bounds the blast radius, defaulting low.
 *
 * No npm dependencies. Node 20+.
 *
 * Credentials (environment only):
 *   ZENDESK_SUBDOMAIN, ZENDESK_EMAIL, ZENDESK_API_TOKEN
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_MAX_CHANGES = 25;
const MIN_INTERVAL_MS = Number(process.env.ZENDESK_MIN_INTERVAL_MS) || 700;

function parseArgs(argv) {
  const opts = {
    plan: null,
    out: './out/merges',
    apply: false,
    minConfidence: 'high',
    maxChanges: DEFAULT_MAX_CHANGES,
    targetComment: null,
    sourceComment: null,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) fail(`${arg} requires a value`);
      return v;
    };
    switch (arg) {
      case '--plan': opts.plan = next(); break;
      case '--out': opts.out = next(); break;
      case '--apply': opts.apply = true; break;
      case '--min-confidence': opts.minConfidence = next(); break;
      case '--max-changes': opts.maxChanges = Number(next()); break;
      case '--target-comment': opts.targetComment = next(); break;
      case '--source-comment': opts.sourceComment = next(); break;
      case '--json': opts.json = true; break;
      case '--help': case '-h': usage(); process.exit(0);
      default:
        if (!opts.plan && !arg.startsWith('-')) { opts.plan = arg; break; }
        fail(`unknown argument: ${arg}`);
    }
  }
  if (!opts.plan) fail('a merge plan file is required');
  if (!['high', 'medium', 'low'].includes(opts.minConfidence)) {
    fail('--min-confidence must be one of: high, medium, low');
  }
  if (!Number.isInteger(opts.maxChanges) || opts.maxChanges < 1) {
    fail('--max-changes must be a positive integer');
  }
  return opts;
}

function usage() {
  process.stderr.write(`
Usage: node scripts/apply-merges.mjs <merge-plan.jsonl> [options]

  <merge-plan.jsonl>        Plan from cx-duplicate-detection.
  --apply                   Actually merge. WITHOUT THIS NOTHING IS WRITTEN.
  --out <dir>               Audit log and journal location. Default ./out/merges.
  --min-confidence <tier>   high (default) | medium | low.
  --max-changes <n>         Maximum merges this run. Default ${DEFAULT_MAX_CHANGES}.
  --target-comment <text>   Public note added to the surviving ticket.
  --source-comment <text>   Public note added to each merged-away ticket.
  --json                    Emit only JSON on stdout.

Merging is IRREVERSIBLE in Zendesk. The default run is a dry run: it re-validates
the plan against live state and prints exactly what would happen.

Environment: ZENDESK_SUBDOMAIN, ZENDESK_EMAIL, ZENDESK_API_TOKEN
`);
}

function fail(message) {
  process.stderr.write(`error: ${message}\n`);
  process.exit(1);
}

function log(message) {
  process.stderr.write(`${message}\n`);
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) fail(`${name} is not set. Export it before running; do not pass tokens as arguments.`);
  return value;
}

class Client {
  constructor({ subdomain, email, token }) {
    this.base = (process.env.ZENDESK_BASE_URL || `https://${subdomain}.zendesk.com`).replace(/\/$/, '');
    this.auth = 'Basic ' + Buffer.from(`${email}/token:${token}`).toString('base64');
    this.requestCount = 0;
    this.nextSlot = 0;
  }

  async #pace() {
    const now = Date.now();
    const wait = Math.max(0, this.nextSlot - now);
    this.nextSlot = Math.max(now, this.nextSlot) + MIN_INTERVAL_MS;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }

  async request(path, { method = 'GET', body, tolerate404 = false } = {}, attempt = 1) {
    await this.#pace();
    this.requestCount++;
    const url = `${this.base}${path}`;

    let res;
    try {
      res = await fetch(url, {
        method,
        headers: {
          Authorization: this.auth,
          Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      if (attempt > 4) throw new Error(`network error after 4 attempts: ${err.message}`);
      await new Promise((r) => setTimeout(r, 2 ** attempt * 1000));
      return this.request(path, { method, body, tolerate404 }, attempt + 1);
    }

    if (res.status === 429) {
      const header = Number(res.headers.get('retry-after'));
      const retryAfter = Number.isFinite(header) && header >= 0 ? header : 60;
      log(`  rate limited; waiting ${retryAfter}s`);
      await new Promise((r) => setTimeout(r, (retryAfter + 1) * 1000));
      return this.request(path, { method, body, tolerate404 }, attempt);
    }

    if (res.status === 401 || res.status === 403) {
      fail(
        `${res.status} from Zendesk. Merging requires an agent with permission to merge tickets; ` +
          `a read-only token cannot do this.`,
      );
    }

    if (res.status === 404 && tolerate404) return null;

    if (res.status >= 500) {
      if (attempt > 4) throw new Error(`Zendesk returned ${res.status} four times`);
      await new Promise((r) => setTimeout(r, 2 ** attempt * 1000));
      return this.request(path, { method, body, tolerate404 }, attempt + 1);
    }

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`${res.status} ${res.statusText} on ${method} ${path}: ${text.slice(0, 300)}`);
    }

    return res.json();
  }

  getTicket(id) {
    return this.request(`/api/v2/tickets/${encodeURIComponent(id)}.json`, { tolerate404: true });
  }

  merge(targetId, sourceIds, { targetComment, sourceComment }) {
    const body = { ids: sourceIds.map((id) => Number(id) || id) };
    if (targetComment) body.target_comment = targetComment;
    if (sourceComment) body.source_comment = sourceComment;
    return this.request(`/api/v2/tickets/${encodeURIComponent(targetId)}/merge.json`, {
      method: 'POST',
      body,
    });
  }
}

const TIER_RANK = { low: 0, medium: 1, high: 2 };

function readPlan(path) {
  if (!existsSync(path)) fail(`plan file ${path} does not exist`);
  const entries = [];
  for (const [index, line] of readFileSync(path, 'utf8').split('\n').entries()) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      fail(`plan line ${index + 1} is not valid JSON. Refusing to act on a malformed plan.`);
    }
    if (!entry.target_id || !Array.isArray(entry.source_ids) || entry.source_ids.length === 0) {
      fail(`plan line ${index + 1} is missing target_id or source_ids. Refusing to act.`);
    }
    entries.push(entry);
  }
  if (entries.length === 0) fail(`plan file ${path} contains no entries`);
  return entries;
}

/**
 * Re-checks an entry against live Zendesk. A plan is a snapshot; by the time it
 * runs, requesters may differ, tickets may be closed or already merged. Anything
 * that does not match exactly is skipped, never forced.
 */
async function validate(client, entry) {
  const target = await client.getTicket(entry.target_id);
  if (!target) return { ok: false, reason: `target ${entry.target_id} not found` };

  const ticket = target.ticket ?? target;
  if (ticket.status === 'closed') {
    return { ok: false, reason: `target ${entry.target_id} is closed; Zendesk cannot merge closed tickets` };
  }

  // The plan's customer must still be the live requester. This is the check that
  // makes a stale plan safe: without it, a reassigned ticket could merge one
  // customer's conversation into another's.
  if (entry.customer_id && String(ticket.requester_id) !== String(entry.customer_id)) {
    return {
      ok: false,
      reason:
        `target ${entry.target_id} requester is ${ticket.requester_id}, plan expected ` +
        `${entry.customer_id}. The plan is stale; re-run detection.`,
    };
  }

  const sources = [];
  for (const sourceId of entry.source_ids) {
    const found = await client.getTicket(sourceId);
    if (!found) {
      return { ok: false, reason: `source ${sourceId} not found (already merged or deleted?)` };
    }
    const sourceTicket = found.ticket ?? found;
    if (sourceTicket.status === 'closed') {
      return { ok: false, reason: `source ${sourceId} is closed; Zendesk cannot merge closed tickets` };
    }
    if (String(sourceTicket.requester_id) !== String(ticket.requester_id)) {
      return {
        ok: false,
        reason:
          `source ${sourceId} requester ${sourceTicket.requester_id} differs from target ` +
          `requester ${ticket.requester_id}. Refusing: merging across customers would disclose ` +
          `one customer's conversation to another.`,
      };
    }
    sources.push({
      id: String(sourceTicket.id),
      status: sourceTicket.status,
      requester_id: sourceTicket.requester_id,
      subject: sourceTicket.subject ?? null,
    });
  }

  return {
    ok: true,
    before: {
      target: {
        id: String(ticket.id),
        status: ticket.status,
        requester_id: ticket.requester_id,
        subject: ticket.subject ?? null,
      },
      sources,
    },
  };
}

class Journal {
  constructor(dir) {
    mkdirSync(dir, { recursive: true });
    this.auditPath = join(dir, 'audit-log.jsonl');
    this.appliedPath = join(dir, 'applied-targets.txt');
    this.applied = new Set();
    if (existsSync(this.appliedPath)) {
      for (const line of readFileSync(this.appliedPath, 'utf8').split('\n')) {
        if (line.trim()) this.applied.add(line.trim());
      }
    }
  }
  /** Append-only, written as the run proceeds so a crash keeps the record. */
  audit(record) {
    appendFileSync(this.auditPath, JSON.stringify({ at: new Date().toISOString(), ...record }) + '\n');
  }
  markApplied(targetId) {
    appendFileSync(this.appliedPath, `${targetId}\n`);
    this.applied.add(String(targetId));
  }
  isApplied(targetId) {
    return this.applied.has(String(targetId));
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const plan = readPlan(opts.plan);

  const client = new Client({
    subdomain: requireEnv('ZENDESK_SUBDOMAIN'),
    email: requireEnv('ZENDESK_EMAIL'),
    token: requireEnv('ZENDESK_API_TOKEN'),
  });

  const journal = new Journal(opts.out);
  const threshold = TIER_RANK[opts.minConfidence];

  const eligible = plan.filter((entry) => {
    const tier = entry.confidence ?? 'low';
    return (TIER_RANK[tier] ?? 0) >= threshold;
  });
  const belowConfidence = plan.length - eligible.length;
  const alreadyApplied = eligible.filter((e) => journal.isApplied(e.target_id)).length;
  const pending = eligible.filter((e) => !journal.isApplied(e.target_id));

  log('');
  log(opts.apply ? '*** APPLY MODE — merges are irreversible ***' : 'dry run (no changes will be made)');
  log(`plan:              ${opts.plan} (${plan.length} entries)`);
  log(`min confidence:    ${opts.minConfidence} (${belowConfidence} entries below it, skipped)`);
  log(`already applied:   ${alreadyApplied}`);
  log(`pending:           ${pending.length}`);
  log(`max changes:       ${opts.maxChanges}`);
  log(`audit log:         ${journal.auditPath}`);
  log('');

  if (pending.length > opts.maxChanges) {
    log(
      `NOTE: ${pending.length} entries pending but --max-changes is ${opts.maxChanges}. Only the ` +
        `first ${opts.maxChanges} will be processed. Raise it deliberately once you trust the plan.`,
    );
    log('');
  }

  const batch = pending.slice(0, opts.maxChanges);
  const results = { merged: 0, would_merge: 0, skipped: 0, failed: 0 };
  const skipped = [];
  const failures = [];

  for (const entry of batch) {
    let validation;
    try {
      validation = await validate(client, entry);
    } catch (err) {
      results.failed++;
      failures.push({ target_id: entry.target_id, error: err.message });
      journal.audit({ action: 'validate', target_id: entry.target_id, outcome: 'error', error: err.message });
      continue;
    }

    if (!validation.ok) {
      results.skipped++;
      skipped.push({ target_id: entry.target_id, reason: validation.reason });
      journal.audit({
        action: 'validate',
        target_id: entry.target_id,
        source_ids: entry.source_ids,
        outcome: 'skipped',
        reason: validation.reason,
      });
      log(`  skip  ${entry.target_id}: ${validation.reason}`);
      continue;
    }

    if (!opts.apply) {
      results.would_merge++;
      log(
        `  would merge ${entry.source_ids.join(', ')} -> ${entry.target_id}  ` +
          `(${entry.confidence}, requester ${validation.before.target.requester_id})`,
      );
      journal.audit({
        action: 'merge',
        mode: 'dry-run',
        target_id: entry.target_id,
        source_ids: entry.source_ids,
        confidence: entry.confidence,
        before: validation.before,
        outcome: 'would_apply',
      });
      continue;
    }

    try {
      const response = await client.merge(entry.target_id, entry.source_ids, {
        targetComment: opts.targetComment,
        sourceComment: opts.sourceComment,
      });

      // Verify: re-read and confirm the sources actually closed.
      const after = [];
      for (const sourceId of entry.source_ids) {
        const found = await client.getTicket(sourceId);
        const ticket = found?.ticket ?? found;
        after.push({ id: String(sourceId), status: ticket?.status ?? 'not_found' });
      }
      const unverified = after.filter((a) => a.status !== 'closed' && a.status !== 'not_found');

      journal.markApplied(entry.target_id);
      results.merged++;
      journal.audit({
        action: 'merge',
        mode: 'apply',
        target_id: entry.target_id,
        source_ids: entry.source_ids,
        confidence: entry.confidence,
        before: validation.before,
        after: { sources: after, job_status: response?.job_status?.id ?? null },
        outcome: unverified.length === 0 ? 'applied' : 'applied_unverified',
        unverified: unverified.length > 0 ? unverified : undefined,
      });

      log(
        `  merged ${entry.source_ids.join(', ')} -> ${entry.target_id}` +
          (unverified.length > 0
            ? `  (WARNING: ${unverified.length} source(s) not yet closed; Zendesk merge is async)`
            : ''),
      );
    } catch (err) {
      results.failed++;
      failures.push({ target_id: entry.target_id, error: err.message });
      journal.audit({
        action: 'merge',
        mode: 'apply',
        target_id: entry.target_id,
        source_ids: entry.source_ids,
        before: validation.before,
        outcome: 'error',
        error: err.message,
      });
      log(`  FAILED ${entry.target_id}: ${err.message}`);
    }
  }

  const summary = {
    plan_path: opts.plan,
    mode: opts.apply ? 'apply' : 'dry-run',
    audit_log: journal.auditPath,
    plan_entries: plan.length,
    below_confidence: belowConfidence,
    already_applied: alreadyApplied,
    processed: batch.length,
    remaining: Math.max(0, pending.length - batch.length),
    ...results,
    skipped_detail: skipped,
    failures,
    requests: client.requestCount,
    reversible: false,
  };

  log('');
  if (opts.apply) {
    log(`merged ${results.merged}, skipped ${results.skipped}, failed ${results.failed}`);
    log('Merges are irreversible. The audit log is your only record of what changed.');
  } else {
    log(`would merge ${results.would_merge}, would skip ${results.skipped}`);
    log('Nothing was changed. Re-run with --apply once the plan looks right.');
  }
  if (summary.remaining > 0) {
    log(`${summary.remaining} entries remain; re-run to continue (applied entries are skipped).`);
  }
  log('');

  process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
}

await main();
