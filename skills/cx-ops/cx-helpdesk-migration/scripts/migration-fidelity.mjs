#!/usr/bin/env node
/**
 * Compares a source and target canonical export and reports what the migration
 * lost.
 *
 * Migrations fail quietly. The tooling reports success, the ticket counts look
 * about right, and six months later a metric will not reconcile and nobody can
 * say why. This finds the losses while you can still act on them.
 *
 * Both directories must hold canonical conversations.jsonl (and optionally
 * messages.jsonl) as produced by the platform export skills in this catalog, so
 * a Zendesk source can be compared against a Freshdesk target directly.
 *
 * Matching is on `source_id` by default. When the target system reassigns ids —
 * which is usual — pass --id-map with a CSV of source_id,target_id.
 *
 * No npm dependencies. Node 20+.
 *
 *   node scripts/migration-fidelity.mjs --source ./out/zendesk --target ./out/freshdesk
 */

import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';

// A created_at difference beyond this is treated as drift rather than rounding.
const DEFAULT_DRIFT_TOLERANCE_SECONDS = 60;
// If this share of migrated conversations lands inside one day, created_at was
// almost certainly reset to the import date.
const COLLAPSE_SHARE_THRESHOLD = 0.5;

function parseArgs(argv) {
  const opts = {
    source: null,
    target: null,
    idMap: null,
    driftSeconds: DEFAULT_DRIFT_TOLERANCE_SECONDS,
    sampleSize: 5,
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
      case '--source': opts.source = next(); break;
      case '--target': opts.target = next(); break;
      case '--id-map': opts.idMap = next(); break;
      case '--drift-seconds': opts.driftSeconds = Number(next()); break;
      case '--json': opts.json = true; break;
      case '--help': case '-h': usage(); process.exit(0);
      default: fail(`unknown argument: ${arg}`);
    }
  }
  if (!opts.source || !opts.target) fail('--source and --target are both required');
  if (!Number.isFinite(opts.driftSeconds) || opts.driftSeconds < 0) {
    fail('--drift-seconds must be a non-negative number');
  }
  return opts;
}

function usage() {
  process.stderr.write(`
Usage: node scripts/migration-fidelity.mjs --source <dir> --target <dir> [options]

  --source <dir>          Canonical export from the system you are leaving.
  --target <dir>          Canonical export from the system you moved to.
  --id-map <path>         CSV of source_id,target_id for systems that reassign
                          ids. Without it, matching is on source_id.
  --drift-seconds <n>     Timestamp difference tolerated before it counts as
                          drift. Default ${DEFAULT_DRIFT_TOLERANCE_SECONDS}.
  --json                  Emit only JSON on stdout.

Exits non-zero when a critical loss is found.
`);
}

function fail(message) {
  process.stderr.write(`error: ${message}\n`);
  process.exit(1);
}

async function readJsonl(path) {
  const records = [];
  if (!existsSync(path)) return records;
  const stream = createReadStream(path, 'utf8');
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      /* a partial final line from an interrupted export */
    }
  }
  return records;
}

function loadIdMap(path) {
  if (!existsSync(path)) fail(`--id-map ${path} does not exist`);
  const map = new Map();
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [source, target] = trimmed.split(',').map((s) => s.trim().replace(/^"|"$/g, ''));
    if (!source || !target) continue;
    if (source.toLowerCase() === 'source_id') continue; // header
    map.set(source, target);
  }
  if (map.size === 0) fail(`--id-map ${path} contained no usable rows`);
  return map;
}

const month = (iso) => (typeof iso === 'string' && iso.length >= 7 ? iso.slice(0, 7) : '(none)');
const day = (iso) => (typeof iso === 'string' && iso.length >= 10 ? iso.slice(0, 10) : '(none)');

function tally(records, key) {
  const out = {};
  for (const record of records) {
    const value = String(record[key] ?? '(null)');
    out[value] = (out[value] ?? 0) + 1;
  }
  return out;
}

function diffTally(sourceTally, targetTally) {
  const keys = [...new Set([...Object.keys(sourceTally), ...Object.keys(targetTally)])].sort();
  return keys.map((key) => {
    const source = sourceTally[key] ?? 0;
    const target = targetTally[key] ?? 0;
    return { key, source, target, delta: target - source };
  });
}

/**
 * Fields whose loss changes what analyses are possible. Losing `subject` is
 * cosmetic; losing `created_at` destroys every historical metric.
 */
const CRITICAL_FIELDS = ['created_at', 'customer_id', 'status'];
const IMPORTANT_FIELDS = ['channel', 'assignee_id', 'resolved_at', 'csat', 'tags', 'priority'];

function isEmpty(value) {
  if (value === null || value === undefined || value === '') return true;
  if (Array.isArray(value) && value.length === 0) return true;
  return false;
}

function compareConversations(source, target, idMap, opts, findings) {
  const targetById = new Map(target.map((c) => [String(c.source_id), c]));
  const resolveTargetId = (sourceId) => (idMap ? idMap.get(sourceId) : sourceId);

  const missing = [];
  const matched = [];

  for (const record of source) {
    const sourceId = String(record.source_id);
    const targetId = resolveTargetId(sourceId);
    const found = targetId === undefined ? undefined : targetById.get(String(targetId));
    if (!found) {
      missing.push(sourceId);
      continue;
    }
    matched.push({ source: record, target: found });
  }

  const mappedTargetIds = new Set(
    source.map((r) => String(resolveTargetId(String(r.source_id)) ?? '')).filter(Boolean),
  );
  const extra = target
    .map((c) => String(c.source_id))
    .filter((id) => !mappedTargetIds.has(id));

  if (missing.length > 0) {
    findings.critical(
      'conversations missing from the target',
      `${missing.length} of ${source.length} source conversations have no target record`,
      missing.slice(0, opts.sampleSize),
    );
  }
  if (extra.length > 0) {
    findings.warn(
      'conversations in the target with no source',
      `${extra.length} target conversations are not in the source export. Usually new activity ` +
        `since the source export, or a duplicated import.`,
      extra.slice(0, opts.sampleSize),
    );
  }

  // --- timestamp fidelity: the single most damaging loss ---
  const drift = [];
  const targetDays = {};
  for (const { source: s, target: t } of matched) {
    const a = Date.parse(s.created_at ?? '');
    const b = Date.parse(t.created_at ?? '');
    if (Number.isFinite(b)) targetDays[day(t.created_at)] = (targetDays[day(t.created_at)] ?? 0) + 1;
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    const deltaSeconds = Math.abs(a - b) / 1000;
    if (deltaSeconds > opts.driftSeconds) {
      drift.push({ source_id: String(s.source_id), source: s.created_at, target: t.created_at });
    }
  }

  if (drift.length > 0) {
    findings.critical(
      'created_at drifted',
      `${drift.length} of ${matched.length} conversations have a created_at more than ` +
        `${opts.driftSeconds}s from the source. Historical volume, response-time and cohort ` +
        `metrics are all computed from this field.`,
      drift.slice(0, opts.sampleSize).map((d) => `${d.source_id}: ${d.source} -> ${d.target}`),
    );
  }

  // The signature of a reset: most conversations sharing one target day.
  const dayEntries = Object.entries(targetDays).sort((a, b) => b[1] - a[1]);
  if (matched.length >= 10 && dayEntries.length > 0) {
    const [topDay, topCount] = dayEntries[0];
    const share = topCount / matched.length;
    if (share >= COLLAPSE_SHARE_THRESHOLD && Object.keys(tally(source, 'created_at')).length > 5) {
      findings.critical(
        'created_at collapsed to the import date',
        `${(share * 100).toFixed(0)}% of migrated conversations have created_at on ${topDay}, ` +
          `while the source spans many dates. The migration stamped import time instead of ` +
          `preserving creation time. This is unrecoverable once the source is decommissioned.`,
        [`${topCount} of ${matched.length} conversations on ${topDay}`],
      );
    }
  }

  // --- field-level loss on matched records ---
  for (const field of [...CRITICAL_FIELDS, ...IMPORTANT_FIELDS]) {
    let lost = 0;
    const samples = [];
    for (const { source: s, target: t } of matched) {
      if (!isEmpty(s[field]) && isEmpty(t[field])) {
        lost++;
        if (samples.length < opts.sampleSize) samples.push(String(s.source_id));
      }
    }
    if (lost === 0) continue;
    const share = ((lost / Math.max(matched.length, 1)) * 100).toFixed(1);
    const message = `${lost} conversations (${share}%) had ${field} in the source and null in the target`;
    if (CRITICAL_FIELDS.includes(field)) {
      findings.critical(`${field} lost`, message, samples);
    } else {
      findings.warn(`${field} lost`, message, samples);
    }
  }

  return { matched, missing, extra };
}

function compareMessages(sourceMessages, targetMessages, matched, idMap, opts, findings) {
  if (sourceMessages.length === 0 && targetMessages.length === 0) return null;

  if (sourceMessages.length > 0 && targetMessages.length === 0) {
    findings.critical(
      'all messages lost',
      `the source has ${sourceMessages.length} messages and the target has none. The migration ` +
        `moved conversation records without their contents.`,
      [],
    );
    return { sourceTotal: sourceMessages.length, targetTotal: 0 };
  }

  const countBy = (records) => {
    const out = new Map();
    for (const m of records) {
      const key = String(m.conversation_source_id);
      out.set(key, (out.get(key) ?? 0) + 1);
    }
    return out;
  };
  const sourceCounts = countBy(sourceMessages);
  const targetCounts = countBy(targetMessages);

  let conversationsShort = 0;
  let messagesLost = 0;
  const samples = [];
  for (const { source: s } of matched) {
    const sourceId = String(s.source_id);
    const targetId = String(idMap ? (idMap.get(sourceId) ?? sourceId) : sourceId);
    const before = sourceCounts.get(sourceId) ?? 0;
    const after = targetCounts.get(targetId) ?? 0;
    if (after < before) {
      conversationsShort++;
      messagesLost += before - after;
      if (samples.length < opts.sampleSize) samples.push(`${sourceId}: ${before} -> ${after}`);
    }
  }

  if (messagesLost > 0) {
    findings.critical(
      'messages lost',
      `${messagesLost} messages missing across ${conversationsShort} conversations`,
      samples,
    );
  }

  // Internal notes becoming customer-visible is a disclosure incident, not a
  // data-quality nit.
  const visibility = (records) => {
    const out = { public: 0, internal: 0 };
    for (const m of records) {
      if (m.visibility === 'internal') out.internal++;
      else if (m.visibility === 'public') out.public++;
    }
    return out;
  };
  const sourceVis = visibility(sourceMessages);
  const targetVis = visibility(targetMessages);

  if (sourceVis.internal > 0 && targetVis.internal === 0) {
    findings.critical(
      'internal notes lost their visibility flag',
      `the source has ${sourceVis.internal} internal notes and the target has none. Either the ` +
        `notes were dropped, or — far worse — they were imported as customer-visible messages. ` +
        `Verify in the target UI before anyone contacts a customer.`,
      [],
    );
  } else if (sourceVis.internal > targetVis.internal) {
    findings.warn(
      'fewer internal notes in the target',
      `${sourceVis.internal - targetVis.internal} internal notes unaccounted for`,
      [],
    );
  }

  const authorTypes = (records) => {
    const out = {};
    for (const m of records) out[m.author_type ?? '(none)'] = (out[m.author_type ?? '(none)'] ?? 0) + 1;
    return out;
  };
  const sourceAuthors = authorTypes(sourceMessages);
  const targetAuthors = authorTypes(targetMessages);
  const sourceUnknownShare = (sourceAuthors.unknown ?? 0) / Math.max(sourceMessages.length, 1);
  const targetUnknownShare = (targetAuthors.unknown ?? 0) / Math.max(targetMessages.length, 1);

  if (targetUnknownShare > sourceUnknownShare + 0.05) {
    findings.warn(
      'author attribution degraded',
      `messages with author_type "unknown" rose from ${(sourceUnknownShare * 100).toFixed(1)}% to ` +
        `${(targetUnknownShare * 100).toFixed(1)}%. Usually agents who left and were not mapped. ` +
        `Response-time and per-agent metrics on migrated data will be wrong.`,
      [],
    );
  }

  return {
    sourceTotal: sourceMessages.length,
    targetTotal: targetMessages.length,
    messages_lost: messagesLost,
    conversations_short: conversationsShort,
    visibility: { source: sourceVis, target: targetVis },
    author_types: { source: sourceAuthors, target: targetAuthors },
  };
}

class Findings {
  constructor() {
    this.items = [];
  }
  #add(severity, issue, detail, samples) {
    this.items.push({ severity, issue, detail, samples: samples ?? [] });
  }
  critical(issue, detail, samples) {
    this.#add('critical', issue, detail, samples);
  }
  warn(issue, detail, samples) {
    this.#add('warning', issue, detail, samples);
  }
  get criticals() {
    return this.items.filter((i) => i.severity === 'critical');
  }
  get warnings() {
    return this.items.filter((i) => i.severity === 'warning');
  }
}

function render(report) {
  const lines = [''];
  const c = report.counts;

  lines.push(`source: ${report.source}  (${c.source_conversations} conversations, ${c.source_messages} messages)`);
  lines.push(`target: ${report.target}  (${c.target_conversations} conversations, ${c.target_messages} messages)`);
  lines.push('');
  lines.push(`matched: ${c.matched}   missing: ${c.missing}   unexpected: ${c.extra}`);

  const rows = report.by_month.filter((r) => r.delta !== 0);
  if (rows.length > 0) {
    lines.push('');
    lines.push('  conversation count by month (source -> target)');
    for (const row of rows.slice(0, 24)) {
      lines.push(
        `    ${row.key.padEnd(10)} ${String(row.source).padStart(7)} -> ${String(row.target).padStart(7)}` +
          `   ${row.delta > 0 ? '+' : ''}${row.delta}`,
      );
    }
  }

  for (const [label, items] of [
    ['CRITICAL', report.findings.filter((f) => f.severity === 'critical')],
    ['WARNINGS', report.findings.filter((f) => f.severity === 'warning')],
  ]) {
    if (items.length === 0) continue;
    lines.push('');
    lines.push(label);
    for (const item of items) {
      lines.push(`  ${item.issue}`);
      lines.push(`      ${item.detail}`);
      for (const sample of item.samples) lines.push(`      e.g. ${sample}`);
    }
  }

  lines.push('');
  lines.push(
    report.ok
      ? report.findings.length === 0
        ? 'PASS — no losses detected'
        : 'PASS WITH WARNINGS — no critical losses, but read the warnings'
      : 'FAIL — critical losses found. Do not decommission the source system.',
  );
  lines.push('');

  return lines.join('\n');
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  const sourceConversations = await readJsonl(join(opts.source, 'conversations.jsonl'));
  const targetConversations = await readJsonl(join(opts.target, 'conversations.jsonl'));

  if (sourceConversations.length === 0) fail(`no conversations found in ${opts.source}`);
  if (targetConversations.length === 0) {
    fail(
      `no conversations found in ${opts.target}. If the migration has not run yet, there is ` +
        `nothing to compare.`,
    );
  }

  const sourceMessages = await readJsonl(join(opts.source, 'messages.jsonl'));
  const targetMessages = await readJsonl(join(opts.target, 'messages.jsonl'));
  const idMap = opts.idMap ? loadIdMap(opts.idMap) : null;

  const findings = new Findings();
  const { matched, missing, extra } = compareConversations(
    sourceConversations,
    targetConversations,
    idMap,
    opts,
    findings,
  );
  const messageStats = compareMessages(
    sourceMessages,
    targetMessages,
    matched,
    idMap,
    opts,
    findings,
  );

  const report = {
    source: opts.source,
    target: opts.target,
    id_matching: idMap ? `id-map (${idMap.size} entries)` : 'source_id',
    counts: {
      source_conversations: sourceConversations.length,
      target_conversations: targetConversations.length,
      source_messages: sourceMessages.length,
      target_messages: targetMessages.length,
      matched: matched.length,
      missing: missing.length,
      extra: extra.length,
    },
    by_month: diffTally(
      tally(sourceConversations.map((c) => ({ m: month(c.created_at) })), 'm'),
      tally(targetConversations.map((c) => ({ m: month(c.created_at) })), 'm'),
    ),
    by_status: diffTally(tally(sourceConversations, 'status'), tally(targetConversations, 'status')),
    by_channel: diffTally(tally(sourceConversations, 'channel'), tally(targetConversations, 'channel')),
    messages: messageStats,
    findings: findings.items,
  };
  report.ok = findings.criticals.length === 0;

  if (!opts.json) process.stderr.write(render(report));
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');

  process.exit(report.ok ? 0 : 1);
}

await main();
