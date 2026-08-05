#!/usr/bin/env node
/**
 * Applies a reviewed erasure plan to Zendesk. Redaction and deletion are
 * IRREVERSIBLE and unauditable after the fact — you cannot see what was removed.
 *
 * This is the "doing" half of a plan-first mutation. It decides nothing: it
 * consumes a plan from cx-erasure-plan, re-validates every entry against live
 * Zendesk, and refuses anything the plan marked for human decision.
 *
 * Defence in depth: the plan should never propose deleting a conversation the
 * subject merely appears in, and this script refuses to do so regardless of what
 * the plan says. A hand-edited plan cannot talk it into destroying another data
 * subject's record.
 *
 * No npm dependencies. Node 20+.
 *
 * Credentials (environment only):
 *   ZENDESK_SUBDOMAIN, ZENDESK_EMAIL, ZENDESK_API_TOKEN
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_MAX_CHANGES = 10;
const MIN_INTERVAL_MS = Number(process.env.ZENDESK_MIN_INTERVAL_MS) || 700;

// Actions this script will never execute, whatever the plan says.
const REFUSED_ACTIONS = new Set(['manual_review', 'blocked_legal_hold']);

function parseArgs(argv) {
  const opts = {
    plan: null,
    out: './out/erasure',
    apply: false,
    permanent: false,
    maxChanges: DEFAULT_MAX_CHANGES,
    only: 'all',
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
      case '--permanent': opts.permanent = true; break;
      case '--max-changes': opts.maxChanges = Number(next()); break;
      case '--only': opts.only = next(); break;
      case '--json': opts.json = true; break;
      case '--help': case '-h': usage(); process.exit(0);
      default:
        if (!opts.plan && !arg.startsWith('-')) { opts.plan = arg; break; }
        fail(`unknown argument: ${arg}`);
    }
  }
  if (!opts.plan) fail('an erasure plan file is required');
  if (!['all', 'redact', 'delete'].includes(opts.only)) {
    fail('--only must be one of: all, redact, delete');
  }
  if (!Number.isInteger(opts.maxChanges) || opts.maxChanges < 1) {
    fail('--max-changes must be a positive integer');
  }
  return opts;
}

function usage() {
  process.stderr.write(`
Usage: node scripts/apply-erasure.mjs <erasure-plan.jsonl> [options]

  <erasure-plan.jsonl>   Plan from cx-erasure-plan, reviewed by compliance.
  --apply                Actually erase. WITHOUT THIS NOTHING IS WRITTEN.
  --only <what>          all (default) | redact | delete. Run redactions first.
  --permanent            After deleting, also purge from Deleted Tickets. A
                         second, separate irreversible step; off by default.
  --max-changes <n>      Maximum conversations this run. Default ${DEFAULT_MAX_CHANGES}.
  --out <dir>            Audit log and journal. Default ./out/erasure.
  --json                 Emit only JSON on stdout.

Redaction replaces characters permanently; you cannot see what was removed.
Deletion cannot be undone. The default run is a dry run.

Entries the plan marked manual_review or blocked_legal_hold are always refused.

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

    let res;
    try {
      res = await fetch(`${this.base}${path}`, {
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
        `${res.status} from Zendesk. Redaction and deletion require an agent with delete ` +
          `permission, and the "Agents can delete tickets" setting must be enabled in Admin ` +
          `Center. A read-only token cannot erase.`,
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

    const text = await res.text();
    if (text === '') return {};
    try {
      return JSON.parse(text);
    } catch {
      return {};
    }
  }

  getTicket(id) {
    return this.request(`/api/v2/tickets/${encodeURIComponent(id)}.json`, { tolerate404: true });
  }

  getComments(id) {
    return this.request(`/api/v2/tickets/${encodeURIComponent(id)}/comments.json`, {
      tolerate404: true,
    });
  }

  redact(ticketId, commentId, text) {
    return this.request(
      `/api/v2/tickets/${encodeURIComponent(ticketId)}/comments/${encodeURIComponent(commentId)}/redact.json`,
      { method: 'PUT', body: { text } },
    );
  }

  deleteTicket(id) {
    return this.request(`/api/v2/tickets/${encodeURIComponent(id)}.json`, { method: 'DELETE' });
  }

  purgeTicket(id) {
    return this.request(`/api/v2/deleted_tickets/${encodeURIComponent(id)}.json`, {
      method: 'DELETE',
    });
  }
}

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
    if (!entry.conversation_source_id || !entry.action) {
      fail(`plan line ${index + 1} is missing conversation_source_id or action. Refusing to act.`);
    }
    entries.push(entry);
  }
  if (entries.length === 0) fail(`plan file ${path} contains no entries`);
  return entries;
}

class Journal {
  constructor(dir) {
    mkdirSync(dir, { recursive: true });
    this.auditPath = join(dir, 'audit-log.jsonl');
    this.donePath = join(dir, 'completed.txt');
    this.done = new Set();
    if (existsSync(this.donePath)) {
      for (const line of readFileSync(this.donePath, 'utf8').split('\n')) {
        if (line.trim()) this.done.add(line.trim());
      }
    }
  }
  audit(record) {
    appendFileSync(this.auditPath, JSON.stringify({ at: new Date().toISOString(), ...record }) + '\n');
  }
  markDone(key) {
    appendFileSync(this.donePath, `${key}\n`);
    this.done.add(key);
  }
  isDone(key) {
    return this.done.has(key);
  }
}

/**
 * Live re-validation. Status is decisive here: Zendesk cannot redact comments on
 * a closed ticket, so a ticket that closed since the plan was built silently
 * changes which remedy is legal.
 */
async function validate(client, entry) {
  const response = await client.getTicket(entry.conversation_source_id);
  if (!response) {
    return { ok: false, reason: `ticket ${entry.conversation_source_id} not found (already deleted?)` };
  }
  const ticket = response.ticket ?? response;

  if (entry.action === 'redact_messages' && ticket.status === 'closed') {
    return {
      ok: false,
      reason:
        `ticket ${ticket.id} has closed since the plan was built; Zendesk cannot redact comments ` +
        `on a closed ticket. Re-run the plan — the remedy for a closed ticket is different.`,
    };
  }

  // Defence in depth: never delete a conversation the subject only appears in,
  // even if a hand-edited plan asks for it.
  if (entry.action === 'delete_conversation' && entry.subject_role !== 'requester') {
    return {
      ok: false,
      reason:
        `refusing to delete ticket ${ticket.id}: the subject is "${entry.subject_role}", not the ` +
        `requester. Deleting it would destroy another data subject's record.`,
    };
  }

  return {
    ok: true,
    before: {
      id: String(ticket.id),
      status: ticket.status,
      requester_id: ticket.requester_id,
      subject: ticket.subject ?? null,
    },
  };
}

async function applyRedactions(client, entry, before, opts, journal) {
  // Map plan message ids to live comment ids, and only redact strings that are
  // still present — a literal already gone must not be reported as redacted.
  const commentsResponse = await client.getComments(entry.conversation_source_id);
  const comments = commentsResponse?.comments ?? [];
  const byId = new Map(comments.map((c) => [String(c.id), c]));

  const performed = [];
  const missing = [];

  for (const redaction of entry.redactions ?? []) {
    const comment = byId.get(String(redaction.message_source_id));
    if (!comment) {
      missing.push({ message_source_id: redaction.message_source_id, reason: 'comment not found' });
      continue;
    }
    const haystack = `${comment.plain_body ?? ''}\n${comment.body ?? ''}\n${comment.html_body ?? ''}`;
    for (const literal of redaction.literals) {
      if (!haystack.includes(literal)) {
        missing.push({ message_source_id: redaction.message_source_id, literal, reason: 'not present' });
        continue;
      }
      if (!opts.apply) {
        performed.push({ comment_id: String(comment.id), literal, applied: false });
        continue;
      }
      await client.redact(entry.conversation_source_id, comment.id, literal);
      performed.push({ comment_id: String(comment.id), literal, applied: true });
      journal.audit({
        action: 'redact',
        mode: 'apply',
        conversation_source_id: entry.conversation_source_id,
        comment_id: String(comment.id),
        // Never log the redacted value itself — that would defeat the erasure.
        literal_length: literal.length,
        before: { status: before.status },
        outcome: 'applied',
      });
    }
  }

  return { performed, missing };
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

  const refused = plan.filter((e) => REFUSED_ACTIONS.has(e.action));
  let actionable = plan.filter((e) => !REFUSED_ACTIONS.has(e.action));
  if (opts.only === 'redact') actionable = actionable.filter((e) => e.action === 'redact_messages');
  if (opts.only === 'delete') actionable = actionable.filter((e) => e.action === 'delete_conversation');

  const pending = actionable.filter((e) => !journal.isDone(String(e.conversation_source_id)));

  log('');
  log(
    opts.apply
      ? '*** APPLY MODE — redaction and deletion are irreversible ***'
      : 'dry run (no changes will be made)',
  );
  log(`plan:            ${opts.plan} (${plan.length} entries)`);
  log(`refused:         ${refused.length} (manual_review / legal hold — never applied)`);
  log(`already done:    ${actionable.length - pending.length}`);
  log(`pending:         ${pending.length}`);
  log(`max changes:     ${opts.maxChanges}`);
  log(`permanent purge: ${opts.permanent ? 'YES' : 'no'}`);
  log(`audit log:       ${journal.auditPath}`);
  log('');

  for (const entry of refused) {
    journal.audit({
      action: entry.action,
      conversation_source_id: entry.conversation_source_id,
      outcome: 'refused',
      reason: entry.reason ?? 'plan marked this entry as needing a human decision',
    });
  }
  if (refused.length > 0) {
    log(`${refused.length} entries need a human decision and were not touched:`);
    for (const entry of refused.slice(0, 5)) {
      log(`  ${entry.conversation_source_id}: ${entry.action}`);
    }
    log('');
  }

  if (pending.length > opts.maxChanges) {
    log(
      `NOTE: ${pending.length} pending but --max-changes is ${opts.maxChanges}. Processing the ` +
        `first ${opts.maxChanges}.`,
    );
    log('');
  }

  const batch = pending.slice(0, opts.maxChanges);
  const results = {
    redacted_literals: 0,
    would_redact_literals: 0,
    deleted: 0,
    would_delete: 0,
    purged: 0,
    skipped: 0,
    failed: 0,
  };
  const skipped = [];
  const failures = [];

  for (const entry of batch) {
    const key = String(entry.conversation_source_id);
    let validation;
    try {
      validation = await validate(client, entry);
    } catch (err) {
      results.failed++;
      failures.push({ conversation_source_id: key, error: err.message });
      journal.audit({ action: 'validate', conversation_source_id: key, outcome: 'error', error: err.message });
      continue;
    }

    if (!validation.ok) {
      results.skipped++;
      skipped.push({ conversation_source_id: key, reason: validation.reason });
      journal.audit({
        action: entry.action,
        conversation_source_id: key,
        outcome: 'skipped',
        reason: validation.reason,
      });
      log(`  skip  ${key}: ${validation.reason}`);
      continue;
    }

    try {
      if (entry.action === 'redact_messages') {
        const { performed, missing } = await applyRedactions(client, entry, validation.before, opts, journal);
        if (opts.apply) {
          results.redacted_literals += performed.length;
          journal.markDone(key);
          log(`  redacted ${performed.length} literal(s) in ticket ${key}`);
        } else {
          results.would_redact_literals += performed.length;
          log(`  would redact ${performed.length} literal(s) in ticket ${key}`);
          journal.audit({
            action: 'redact',
            mode: 'dry-run',
            conversation_source_id: key,
            literal_count: performed.length,
            before: { status: validation.before.status },
            outcome: 'would_apply',
          });
        }
        if (missing.length > 0) {
          log(`    note: ${missing.length} planned literal(s) no longer present or comment missing`);
        }
      } else if (entry.action === 'delete_conversation') {
        if (!opts.apply) {
          results.would_delete++;
          log(`  would DELETE ticket ${key} (closed; redaction unavailable)`);
          journal.audit({
            action: 'delete',
            mode: 'dry-run',
            conversation_source_id: key,
            before: validation.before,
            outcome: 'would_apply',
          });
        } else {
          await client.deleteTicket(key);
          results.deleted++;
          let purged = false;
          if (opts.permanent) {
            await client.purgeTicket(key);
            results.purged++;
            purged = true;
          }
          journal.markDone(key);
          journal.audit({
            action: 'delete',
            mode: 'apply',
            conversation_source_id: key,
            before: validation.before,
            after: { deleted: true, purged },
            outcome: 'applied',
          });
          log(`  DELETED ticket ${key}${purged ? ' and purged' : ' (in Deleted Tickets for 30 days)'}`);
        }
      } else {
        results.skipped++;
        skipped.push({ conversation_source_id: key, reason: `unknown action "${entry.action}"` });
        journal.audit({
          action: entry.action,
          conversation_source_id: key,
          outcome: 'skipped',
          reason: 'unknown action',
        });
      }
    } catch (err) {
      results.failed++;
      failures.push({ conversation_source_id: key, error: err.message });
      journal.audit({
        action: entry.action,
        conversation_source_id: key,
        before: validation.before,
        outcome: 'error',
        error: err.message,
      });
      log(`  FAILED ${key}: ${err.message}`);
    }
  }

  const summary = {
    plan_path: opts.plan,
    mode: opts.apply ? 'apply' : 'dry-run',
    audit_log: journal.auditPath,
    plan_entries: plan.length,
    refused_needing_human_decision: refused.length,
    processed: batch.length,
    remaining: Math.max(0, pending.length - batch.length),
    permanent_purge: opts.permanent,
    ...results,
    skipped_detail: skipped,
    failures,
    requests: client.requestCount,
    reversible: false,
  };

  log('');
  if (opts.apply) {
    log(
      `redacted ${results.redacted_literals} literal(s), deleted ${results.deleted} ticket(s), ` +
        `skipped ${results.skipped}, failed ${results.failed}`,
    );
    log('Erasure is irreversible and the removed content is not recoverable or viewable.');
    if (!opts.permanent && results.deleted > 0) {
      log(
        `${results.deleted} deleted ticket(s) sit in Deleted Tickets for 30 days before Zendesk ` +
          `purges them. Use --permanent if the DSR requires immediate purge.`,
      );
    }
  } else {
    log(
      `would redact ${results.would_redact_literals} literal(s), would delete ${results.would_delete} ` +
        `ticket(s), would skip ${results.skipped}`,
    );
    log('Nothing was changed. Re-run with --apply once compliance has signed off.');
  }
  if (summary.remaining > 0) log(`${summary.remaining} entries remain; re-run to continue.`);
  log('');

  process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
}

await main();
