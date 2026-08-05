#!/usr/bin/env node
/**
 * Zendesk configuration as code: pull config to versioned files, diff local
 * against live, and push changes back.
 *
 * Config is harder than data. It is interdependent (a trigger references a field,
 * a group and a macro), ordered (trigger position is semantic), and there is no
 * un-delete. So the write path is deliberately narrow:
 *
 *   pull   read-only. Writes normalised JSON files, one per resource.
 *   diff   read-only. Compares local files against live and prints a plan.
 *   push   applies the plan. Dry-run by default; --apply required.
 *
 * What push will NOT do, by design:
 *   - Delete anything. Removing a local file does not delete the live resource;
 *     it is reported as untracked. Deletion of a trigger or field is the change
 *     most likely to break a production workflow silently.
 *   - Reorder triggers or automations. Position is semantic and reordering has
 *     effects far beyond the resource being changed.
 *   - Create or modify resources whose dependencies are missing locally.
 *
 * No npm dependencies. Node 20+.
 *
 * Credentials (environment only):
 *   ZENDESK_SUBDOMAIN, ZENDESK_EMAIL, ZENDESK_API_TOKEN
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

const DEFAULT_MAX_CHANGES = 10;
const MIN_INTERVAL_MS = Number(process.env.ZENDESK_MIN_INTERVAL_MS) || 700;

/**
 * Resource types, in dependency order: things referenced by others come first, so
 * a pull produces a directory you can reason about and a push creates
 * prerequisites before the things that need them.
 */
const RESOURCES = [
  { name: 'groups', path: '/api/v2/groups.json', key: 'groups', writable: true },
  { name: 'ticket_fields', path: '/api/v2/ticket_fields.json', key: 'ticket_fields', writable: true },
  { name: 'ticket_forms', path: '/api/v2/ticket_forms.json', key: 'ticket_forms', writable: true },
  { name: 'macros', path: '/api/v2/macros.json', key: 'macros', writable: true },
  { name: 'views', path: '/api/v2/views.json', key: 'views', writable: true },
  { name: 'triggers', path: '/api/v2/triggers.json', key: 'triggers', writable: true },
  { name: 'automations', path: '/api/v2/automations.json', key: 'automations', writable: true },
  // SLA policies are order-sensitive and their API shape varies by plan; pulled
  // for reference and diffing, never pushed.
  { name: 'sla_policies', path: '/api/v2/slas/policies.json', key: 'sla_policies', writable: false },
  { name: 'schedules', path: '/api/v2/business_hours/schedules.json', key: 'schedules', writable: false },
];

/**
 * Fields Zendesk computes. They differ on every pull and would produce
 * meaningless diffs, so they are stripped before writing and before comparing.
 */
const VOLATILE_FIELDS = new Set([
  'created_at',
  'updated_at',
  'url',
  'execution',
  'raw_title',
  'raw_subject',
  'raw_description',
  'raw_value',
  'ticket_count',
  'usage_1h',
  'usage_24h',
  'usage_7d',
  'usage_30d',
  'default',
  'system_field_options',
]);

function parseArgs(argv) {
  const opts = {
    command: null,
    dir: './zendesk-config',
    apply: false,
    maxChanges: DEFAULT_MAX_CHANGES,
    only: null,
    json: false,
  };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) fail(`${arg} requires a value`);
      return v;
    };
    switch (arg) {
      case '--dir': opts.dir = next(); break;
      case '--apply': opts.apply = true; break;
      case '--max-changes': opts.maxChanges = Number(next()); break;
      case '--only': opts.only = next().split(',').map((s) => s.trim()).filter(Boolean); break;
      case '--json': opts.json = true; break;
      case '--help': case '-h': usage(); process.exit(0);
      default:
        if (arg.startsWith('-')) fail(`unknown argument: ${arg}`);
        rest.push(arg);
    }
  }
  opts.command = rest[0] ?? null;
  if (!['pull', 'diff', 'push'].includes(opts.command)) {
    fail('the first argument must be one of: pull, diff, push');
  }
  if (opts.only) {
    for (const name of opts.only) {
      if (!RESOURCES.some((r) => r.name === name)) {
        fail(`--only got unknown resource "${name}". Known: ${RESOURCES.map((r) => r.name).join(', ')}`);
      }
    }
  }
  if (!Number.isInteger(opts.maxChanges) || opts.maxChanges < 1) {
    fail('--max-changes must be a positive integer');
  }
  return opts;
}

function usage() {
  process.stderr.write(`
Usage: node scripts/config.mjs <pull|diff|push> [options]

  pull                 Read live config into --dir as versioned JSON. Read-only.
  diff                 Compare --dir against live and print a change plan.
                       Read-only.
  push                 Apply the plan. Dry-run unless --apply is given.

  --dir <path>         Config directory. Default ./zendesk-config.
  --apply              Actually write to Zendesk (push only).
  --max-changes <n>    Maximum resources changed per push. Default ${DEFAULT_MAX_CHANGES}.
  --only <list>        Comma-separated resource types.
                       ${RESOURCES.map((r) => r.name).join(', ')}
  --json               Emit only JSON on stdout.

push never deletes and never reorders. Removing a local file does not remove the
live resource — it is reported as untracked. Deleting a trigger or field is the
change most likely to break a production workflow, so it stays a manual action.

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

  async request(path, { method = 'GET', body } = {}, attempt = 1) {
    await this.#pace();
    this.requestCount++;
    const url = path.startsWith('http') ? path : `${this.base}${path}`;

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
      return this.request(path, { method, body }, attempt + 1);
    }

    if (res.status === 429) {
      const header = Number(res.headers.get('retry-after'));
      const retryAfter = Number.isFinite(header) && header >= 0 ? header : 60;
      log(`  rate limited; waiting ${retryAfter}s`);
      await new Promise((r) => setTimeout(r, (retryAfter + 1) * 1000));
      return this.request(path, { method, body }, attempt);
    }
    if (res.status === 401 || res.status === 403) {
      fail(
        `${res.status} from Zendesk. Reading configuration needs an admin token; writing it needs ` +
          `admin rights too. An agent token cannot manage triggers, fields or macros.`,
      );
    }
    if (res.status >= 500) {
      if (attempt > 4) throw new Error(`Zendesk returned ${res.status} four times`);
      await new Promise((r) => setTimeout(r, 2 ** attempt * 1000));
      return this.request(path, { method, body }, attempt + 1);
    }
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`${res.status} ${res.statusText} on ${method} ${path}: ${text.slice(0, 300)}`);
    }

    const text = await res.text();
    return text === '' ? {} : JSON.parse(text);
  }

  async listAll(resource) {
    const items = [];
    let path = resource.path;
    for (let page = 0; page < 100 && path; page++) {
      const response = await this.request(path);
      items.push(...(response[resource.key] ?? []));
      path = response.next_page ?? null;
    }
    return items;
  }
}

/** Strips computed fields so diffs reflect intent rather than server state. */
export function normalizeResource(record) {
  const out = {};
  for (const key of Object.keys(record).sort()) {
    if (VOLATILE_FIELDS.has(key)) continue;
    out[key] = record[key];
  }
  return out;
}

const stable = (value) => JSON.stringify(value, null, 2);

function resourceFile(dir, resourceName) {
  return join(dir, `${resourceName}.json`);
}

function readLocal(dir, resourceName) {
  const path = resourceFile(dir, resourceName);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (!Array.isArray(parsed)) fail(`${path} must contain a JSON array`);
    return parsed;
  } catch (err) {
    fail(`could not parse ${path}: ${err.message}`);
  }
}

/**
 * Compares local against live per resource type. Matching is on id; a local
 * record without an id is a create.
 */
export function diffResource(localRecords, liveRecords) {
  const liveById = new Map(liveRecords.map((r) => [String(r.id), r]));
  const localIds = new Set();

  const creates = [];
  const updates = [];
  const unchanged = [];

  for (const record of localRecords) {
    if (record.id === undefined || record.id === null) {
      creates.push({ local: record });
      continue;
    }
    const id = String(record.id);
    localIds.add(id);
    const live = liveById.get(id);
    if (!live) {
      // A local record with an id that no longer exists live: it was deleted in
      // Zendesk. Recreating it silently would resurrect something someone removed.
      creates.push({ local: record, missingLive: true });
      continue;
    }
    const a = stable(normalizeResource(record));
    const b = stable(normalizeResource(live));
    if (a === b) unchanged.push({ id, local: record });
    else updates.push({ id, local: record, live, changedKeys: changedKeys(record, live) });
  }

  const untracked = liveRecords
    .filter((r) => !localIds.has(String(r.id)))
    .map((r) => ({ id: String(r.id), title: r.title ?? r.name ?? null }));

  return { creates, updates, unchanged, untracked };
}

function changedKeys(local, live) {
  const a = normalizeResource(local);
  const b = normalizeResource(live);
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const changed = [];
  for (const key of keys) {
    if (stable(a[key]) !== stable(b[key])) changed.push(key);
  }
  return changed.sort();
}

/**
 * Dependency check: a trigger or macro that references a group or field absent
 * from the local config would be pushed against an unknown target.
 */
export function findMissingDependencies(resourceName, record, known) {
  if (!['triggers', 'automations', 'views', 'macros'].includes(resourceName)) return [];

  const missing = [];
  const serialised = JSON.stringify(record);

  // Zendesk expresses conditions and actions as {field, [operator,] value}, so
  // the referenced id is in a sibling "value" rather than being the value of a
  // "group_id" key. An `operator` may sit between them.
  const REFERENCE = /"field"\s*:\s*"(group_id|assignee_id)"(?:\s*,\s*"operator"\s*:\s*"[^"]*")?\s*,\s*"value"\s*:\s*"?(\d+)"?/g;
  for (const match of serialised.matchAll(REFERENCE)) {
    const id = match[2];
    if (!known.groups.has(id)) missing.push({ type: 'group', id });
  }

  for (const match of serialised.matchAll(/custom_fields_(\d+)/g)) {
    const id = match[1];
    if (!known.ticket_fields.has(id)) missing.push({ type: 'ticket_field', id });
  }

  // Deduplicate: one missing group referenced three times is one problem.
  const seen = new Set();
  return missing.filter((m) => {
    const key = `${m.type}:${m.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Append-only audit log plus a resume journal. `applied.txt` journals the key of
 * every resource successfully written, so an interrupted push resumes without
 * re-applying anything — a config push that is unsafe to retry cannot be operated
 * safely, because interruptions are certain.
 */
class AuditLog {
  constructor(dir) {
    mkdirSync(dir, { recursive: true });
    this.path = join(dir, 'audit-log.jsonl');
    // Resume journal: keys already applied are skipped on a later run.
    this.appliedPath = join(dir, 'applied.txt');
    this.applied = new Set();
    if (existsSync(this.appliedPath)) {
      for (const line of readFileSync(this.appliedPath, 'utf8').split('\n')) {
        if (line.trim()) this.applied.add(line.trim());
      }
    }
  }
  write(record) {
    appendFileSync(this.path, JSON.stringify({ at: new Date().toISOString(), ...record }) + '\n');
  }
  markApplied(key) {
    appendFileSync(this.appliedPath, `${key}\n`);
    this.applied.add(key);
  }
  isApplied(key) {
    return this.applied.has(key);
  }
}

function selectedResources(opts) {
  return RESOURCES.filter((r) => !opts.only || opts.only.includes(r.name));
}

async function commandPull(client, opts) {
  mkdirSync(opts.dir, { recursive: true });
  const summary = { command: 'pull', dir: opts.dir, resources: {} };

  for (const resource of selectedResources(opts)) {
    let items;
    try {
      items = await client.listAll(resource);
    } catch (err) {
      log(`  ${resource.name}: SKIPPED (${err.message.slice(0, 90)})`);
      summary.resources[resource.name] = { error: err.message };
      continue;
    }
    const normalised = items
      .map(normalizeResource)
      .sort((a, b) => String(a.id ?? '').localeCompare(String(b.id ?? '')));
    writeFileSync(resourceFile(opts.dir, resource.name), stable(normalised) + '\n');
    summary.resources[resource.name] = { count: normalised.length, writable: resource.writable };
    log(`  ${resource.name.padEnd(16)} ${normalised.length}`);
  }

  summary.requests = client.requestCount;
  summary.note =
    'Commit this directory. It is a reviewable record of your configuration and the baseline for ' +
    'diffing future changes.';
  return summary;
}

async function buildPlan(client, opts) {
  const plan = { resources: {}, totals: { creates: 0, updates: 0, untracked: 0, unchanged: 0 } };
  const known = { groups: new Set(), ticket_fields: new Set() };

  // Learn ids first so dependency checks can run.
  for (const name of ['groups', 'ticket_fields']) {
    const local = readLocal(opts.dir, name);
    if (local) for (const record of local) known[name].add(String(record.id));
  }

  for (const resource of selectedResources(opts)) {
    const local = readLocal(opts.dir, resource.name);
    if (local === null) {
      plan.resources[resource.name] = { skipped: 'no local file' };
      continue;
    }
    let live;
    try {
      live = await client.listAll(resource);
    } catch (err) {
      plan.resources[resource.name] = { error: err.message };
      continue;
    }

    const diff = diffResource(local, live);
    const withDeps = [...diff.creates, ...diff.updates].map((entry) => ({
      ...entry,
      missingDependencies: findMissingDependencies(resource.name, entry.local, known),
    }));

    plan.resources[resource.name] = {
      writable: resource.writable,
      creates: withDeps.filter((e) => !e.id),
      updates: withDeps.filter((e) => e.id),
      unchanged: diff.unchanged.length,
      untracked: diff.untracked,
    };
    plan.totals.creates += diff.creates.length;
    plan.totals.updates += diff.updates.length;
    plan.totals.untracked += diff.untracked.length;
    plan.totals.unchanged += diff.unchanged.length;
  }

  return plan;
}

async function commandDiff(client, opts) {
  const plan = await buildPlan(client, opts);
  return { command: 'diff', dir: opts.dir, ...plan, requests: client.requestCount };
}

async function commandPush(client, opts) {
  const plan = await buildPlan(client, opts);
  const audit = new AuditLog(opts.dir);

  const results = { applied: 0, would_apply: 0, skipped: 0, failed: 0 };
  const skipped = [];
  const failures = [];
  let budget = opts.maxChanges;

  log('');
  log(opts.apply ? '*** APPLY MODE — writing configuration to Zendesk ***' : 'dry run (no changes)');
  log('');

  for (const resource of selectedResources(opts)) {
    const entry = plan.resources[resource.name];
    if (!entry || entry.skipped || entry.error) continue;

    if (!resource.writable) {
      const count = (entry.creates?.length ?? 0) + (entry.updates?.length ?? 0);
      if (count > 0) {
        results.skipped += count;
        skipped.push({
          resource: resource.name,
          reason:
            `${resource.name} is pull-only in this skill: its ordering is semantic and its API ` +
            `shape varies by plan. Change it in the Zendesk admin UI.`,
        });
      }
      continue;
    }

    for (const change of [...(entry.creates ?? []), ...(entry.updates ?? [])]) {
      if (budget <= 0) break;
      const key = `${resource.name}:${change.id ?? change.local.title ?? 'new'}`;

      if (audit.isApplied(key)) continue;

      if (change.missingLive) {
        results.skipped++;
        skipped.push({
          resource: resource.name,
          key,
          reason:
            `local record has id ${change.id ?? '(none)'} but no live resource with that id exists. ` +
            `It was deleted in Zendesk; recreating it would resurrect something someone removed. ` +
            `Remove it from the local file, or create it deliberately in the UI.`,
        });
        audit.write({ resource: resource.name, key, outcome: 'skipped', reason: 'live resource missing' });
        continue;
      }

      if (change.missingDependencies?.length > 0) {
        results.skipped++;
        const detail = change.missingDependencies.map((d) => `${d.type} ${d.id}`).join(', ');
        skipped.push({
          resource: resource.name,
          key,
          reason: `references ${detail}, which is not in the local config. Pull again or add the dependency first.`,
        });
        audit.write({
          resource: resource.name,
          key,
          outcome: 'skipped',
          reason: `missing dependencies: ${detail}`,
        });
        continue;
      }

      if (!opts.apply) {
        results.would_apply++;
        budget--;
        log(
          `  would ${change.id ? 'update' : 'create'} ${resource.name} ${change.id ?? '(new)'}` +
            (change.changedKeys ? `  [${change.changedKeys.join(', ')}]` : ''),
        );
        audit.write({
          resource: resource.name,
          key,
          mode: 'dry-run',
          outcome: 'would_apply',
          changed_keys: change.changedKeys ?? null,
        });
        continue;
      }

      const singular = resource.key.replace(/s$/, '');
      try {
        if (change.id) {
          const before = change.live;
          await client.request(`${resource.path.replace('.json', '')}/${change.id}.json`, {
            method: 'PUT',
            body: { [singular]: change.local },
          });
          audit.write({
            resource: resource.name,
            key,
            mode: 'apply',
            outcome: 'updated',
            changed_keys: change.changedKeys,
            before: normalizeResource(before),
            after: normalizeResource(change.local),
          });
          log(`  updated ${resource.name} ${change.id} [${change.changedKeys.join(', ')}]`);
        } else {
          const created = await client.request(resource.path, {
            method: 'POST',
            body: { [singular]: change.local },
          });
          audit.write({
            resource: resource.name,
            key,
            mode: 'apply',
            outcome: 'created',
            after: normalizeResource(change.local),
            new_id: created?.[singular]?.id ?? null,
          });
          log(`  created ${resource.name} ${created?.[singular]?.id ?? ''}`);
        }
        audit.markApplied(key);
        results.applied++;
        budget--;
      } catch (err) {
        results.failed++;
        failures.push({ resource: resource.name, key, error: err.message });
        audit.write({ resource: resource.name, key, mode: 'apply', outcome: 'error', error: err.message });
        log(`  FAILED ${resource.name} ${change.id ?? '(new)'}: ${err.message}`);
        budget--;
      }
    }
  }

  const remaining = plan.totals.creates + plan.totals.updates - (results.applied + results.would_apply);

  return {
    command: 'push',
    mode: opts.apply ? 'apply' : 'dry-run',
    dir: opts.dir,
    audit_log: audit.path,
    ...results,
    remaining: Math.max(0, remaining),
    untracked_live_resources: plan.totals.untracked,
    skipped_detail: skipped,
    failures,
    deletions_performed: 0,
    reorders_performed: 0,
    reversible: false,
    requests: client.requestCount,
  };
}

function render(summary) {
  const lines = [''];

  if (summary.command === 'pull') {
    lines.push(`pulled into ${summary.dir}`);
    lines.push('');
    lines.push(`  ${summary.note}`);
  } else if (summary.command === 'diff') {
    lines.push(`local: ${summary.dir}`);
    lines.push(
      `  creates ${summary.totals.creates}   updates ${summary.totals.updates}   ` +
        `untracked-live ${summary.totals.untracked}   unchanged ${summary.totals.unchanged}`,
    );
    for (const [name, entry] of Object.entries(summary.resources)) {
      if (entry.skipped || entry.error) {
        lines.push(`  ${name.padEnd(16)} ${entry.skipped ?? `error: ${entry.error.slice(0, 60)}`}`);
        continue;
      }
      const bits = [];
      if (entry.creates.length) bits.push(`+${entry.creates.length}`);
      if (entry.updates.length) bits.push(`~${entry.updates.length}`);
      if (entry.untracked.length) bits.push(`untracked ${entry.untracked.length}`);
      if (bits.length === 0) continue;
      lines.push(`  ${name.padEnd(16)} ${bits.join('  ')}${entry.writable ? '' : '  (pull-only)'}`);
      for (const update of entry.updates.slice(0, 5)) {
        lines.push(`      ~ ${update.id} [${update.changedKeys.join(', ')}]`);
      }
    }
  } else {
    lines.push(
      summary.mode === 'apply'
        ? `applied ${summary.applied}, skipped ${summary.skipped}, failed ${summary.failed}`
        : `would apply ${summary.would_apply}, would skip ${summary.skipped}`,
    );
    if (summary.skipped_detail.length > 0) {
      lines.push('');
      lines.push('  skipped');
      for (const item of summary.skipped_detail.slice(0, 8)) {
        lines.push(`    ${item.resource}${item.key ? ` ${item.key}` : ''}: ${item.reason}`);
      }
    }
    if (summary.untracked_live_resources > 0) {
      lines.push('');
      lines.push(
        `  ${summary.untracked_live_resources} live resource(s) are not in the local config. ` +
          `They were NOT deleted — push never deletes. Pull again to track them.`,
      );
    }
    lines.push('');
    lines.push(`  audit log: ${summary.audit_log}`);
  }

  lines.push('');
  return lines.join('\n');
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  const client = new Client({
    subdomain: requireEnv('ZENDESK_SUBDOMAIN'),
    email: requireEnv('ZENDESK_EMAIL'),
    token: requireEnv('ZENDESK_API_TOKEN'),
  });

  let summary;
  if (opts.command === 'pull') summary = await commandPull(client, opts);
  else if (opts.command === 'diff') summary = await commandDiff(client, opts);
  else summary = await commandPush(client, opts);

  if (!opts.json) process.stderr.write(render(summary));
  process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
}

if (process.argv[1] && process.argv[1].endsWith('config.mjs')) {
  await main();
}
