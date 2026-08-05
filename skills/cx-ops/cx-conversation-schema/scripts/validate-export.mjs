#!/usr/bin/env node
/**
 * Validates a canonical conversation export before anyone analyses it.
 *
 * Checks structure (required fields, enum vocabulary, timestamp format) and,
 * more usefully, the semantic problems that make an export look fine and produce
 * wrong answers: orphaned messages, conversations with no messages, unresolved
 * author types, messages predating their conversation, and duplicate ids.
 *
 * Exits non-zero on errors. Warnings describe things that are legal but will
 * distort common analyses.
 *
 * No npm dependencies. Node 20+.
 *
 *   node scripts/validate-export.mjs ./out/zendesk
 *   node scripts/validate-export.mjs ./out/five9 --no-messages
 */

import { createReadStream, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';

const STATUSES = new Set(['open', 'pending', 'resolved', 'closed', 'snoozed', 'deleted']);
const CHANNELS = new Set([
  'email',
  'chat',
  'messaging',
  'voice',
  'social',
  'web_form',
  'api',
  'other',
]);
const AUTHOR_TYPES = new Set(['customer', 'agent', 'bot', 'system', 'unknown']);
const VISIBILITIES = new Set(['public', 'internal']);

const CONVERSATION_REQUIRED = ['source', 'source_id', 'status', 'created_at'];
const MESSAGE_REQUIRED = ['source', 'conversation_source_id', 'source_id', 'created_at'];

// Above this share of messages with an unresolved author, response-time and
// turn-count metrics stop being trustworthy.
const UNKNOWN_AUTHOR_WARN = 0.05;

function parseArgs(argv) {
  const opts = { dir: null, expectMessages: true, json: false, sampleErrors: 5 };
  for (const arg of argv) {
    switch (arg) {
      case '--no-messages': opts.expectMessages = false; break;
      case '--json': opts.json = true; break;
      case '--help': case '-h': usage(); process.exit(0);
      default:
        if (arg.startsWith('-')) fail(`unknown argument: ${arg}`);
        opts.dir = arg;
    }
  }
  if (!opts.dir) fail('an export directory is required');
  return opts;
}

function usage() {
  process.stderr.write(`
Usage: node scripts/validate-export.mjs <export-dir> [options]

  <export-dir>     Directory holding conversations.jsonl and messages.jsonl.
  --no-messages    Voice-only exports have no messages.jsonl (e.g. Five9).
  --json           Emit only JSON on stdout.
`);
}

function fail(message) {
  process.stderr.write(`error: ${message}\n`);
  process.exit(1);
}

const isIso = (v) =>
  typeof v === 'string' && !Number.isNaN(Date.parse(v)) && /^\d{4}-\d{2}-\d{2}T/.test(v);

async function* readJsonl(path) {
  const stream = createReadStream(path, 'utf8').on('error', (err) =>
    fail(`could not read ${path}: ${err.message}`),
  );
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let lineNo = 0;
  for await (const line of lines) {
    lineNo++;
    if (!line.trim()) continue;
    try {
      yield { record: JSON.parse(line), lineNo };
    } catch {
      yield { record: null, lineNo };
    }
  }
}

class Findings {
  constructor(sampleLimit) {
    this.sampleLimit = sampleLimit;
    this.errors = new Map();
    this.warnings = new Map();
  }
  #add(bucket, key, detail) {
    if (!bucket.has(key)) bucket.set(key, { count: 0, samples: [] });
    const entry = bucket.get(key);
    entry.count++;
    if (detail && entry.samples.length < this.sampleLimit) entry.samples.push(detail);
  }
  error(key, detail) {
    this.#add(this.errors, key, detail);
  }
  warn(key, detail) {
    this.#add(this.warnings, key, detail);
  }
  toJson(bucket) {
    return [...bucket.entries()].map(([issue, { count, samples }]) => ({ issue, count, samples }));
  }
}

async function loadConversations(path, findings) {
  const ids = new Set();
  const createdAt = new Map();
  const stats = {
    total: 0,
    byStatus: {},
    byChannel: {},
    bySource: {},
    withCsat: 0,
    deleted: 0,
    nullChannel: 0,
    nullCustomer: 0,
  };

  for await (const { record, lineNo } of readJsonl(path)) {
    if (record === null) {
      findings.error('conversations: unparseable JSON line', `line ${lineNo}`);
      continue;
    }
    stats.total++;

    for (const field of CONVERSATION_REQUIRED) {
      if (record[field] === undefined || record[field] === null || record[field] === '') {
        findings.error(`conversations: missing required field "${field}"`, `line ${lineNo}`);
      }
    }

    const id = record.source_id;
    if (id !== undefined && id !== null) {
      const key = String(id);
      if (ids.has(key)) {
        findings.error('conversations: duplicate source_id', `source_id ${key} (line ${lineNo})`);
      }
      ids.add(key);
      if (isIso(record.created_at)) createdAt.set(key, Date.parse(record.created_at));
      if (typeof id !== 'string') {
        findings.warn(
          'conversations: source_id is not a string',
          `source_id ${key} is ${typeof id}; numeric ids lose precision and break joins`,
        );
      }
    }

    if (record.status !== undefined && !STATUSES.has(record.status)) {
      findings.error(
        'conversations: status outside the canonical vocabulary',
        `"${record.status}" (line ${lineNo})`,
      );
    }
    if (record.channel !== undefined && record.channel !== null && !CHANNELS.has(record.channel)) {
      findings.error(
        'conversations: channel outside the canonical vocabulary',
        `"${record.channel}" (line ${lineNo})`,
      );
    }
    if (record.channel === null || record.channel === undefined) stats.nullChannel++;
    if (!record.customer_id) stats.nullCustomer++;

    for (const field of ['created_at', 'updated_at', 'resolved_at']) {
      const value = record[field];
      if (value !== null && value !== undefined && !isIso(value)) {
        findings.error(
          `conversations: ${field} is not an ISO 8601 timestamp`,
          `"${value}" (line ${lineNo})`,
        );
      }
    }

    if (record.csat !== null && record.csat !== undefined) {
      if (typeof record.csat !== 'number' || record.csat < 0 || record.csat > 1) {
        findings.error(
          'conversations: csat is not a 0-1 fraction',
          `${JSON.stringify(record.csat)} (line ${lineNo})`,
        );
      } else {
        stats.withCsat++;
      }
    }

    if (record.tags !== undefined && record.tags !== null && !Array.isArray(record.tags)) {
      findings.error('conversations: tags is not an array', `line ${lineNo}`);
    }

    if (record.status === 'deleted' || record.is_deleted === true) stats.deleted++;

    stats.byStatus[record.status] = (stats.byStatus[record.status] ?? 0) + 1;
    stats.byChannel[record.channel ?? '(null)'] = (stats.byChannel[record.channel ?? '(null)'] ?? 0) + 1;
    stats.bySource[record.source] = (stats.bySource[record.source] ?? 0) + 1;
  }

  return { ids, createdAt, stats };
}

async function loadMessages(path, conversations, findings) {
  const seen = new Set();
  const withMessages = new Set();
  const stats = {
    total: 0,
    byAuthorType: {},
    byVisibility: {},
    withBody: 0,
    emptyBody: 0,
  };

  for await (const { record, lineNo } of readJsonl(path)) {
    if (record === null) {
      findings.error('messages: unparseable JSON line', `line ${lineNo}`);
      continue;
    }
    stats.total++;

    for (const field of MESSAGE_REQUIRED) {
      if (record[field] === undefined || record[field] === null || record[field] === '') {
        findings.error(`messages: missing required field "${field}"`, `line ${lineNo}`);
      }
    }

    const messageKey = `${record.source}:${record.source_id}`;
    if (record.source_id && seen.has(messageKey)) {
      findings.error('messages: duplicate source_id', `${messageKey} (line ${lineNo})`);
    }
    seen.add(messageKey);

    const parentId = record.conversation_source_id;
    if (parentId !== undefined && parentId !== null) {
      const key = String(parentId);
      if (conversations.ids.size > 0 && !conversations.ids.has(key)) {
        findings.error(
          'messages: orphaned — conversation_source_id not in conversations.jsonl',
          `conversation ${key} (line ${lineNo})`,
        );
      } else {
        withMessages.add(key);
      }

      // A message before its conversation started usually means a timezone or
      // epoch-conversion bug, which silently corrupts response-time metrics.
      const parentCreated = conversations.createdAt.get(key);
      if (parentCreated !== undefined && isIso(record.created_at)) {
        const drift = parentCreated - Date.parse(record.created_at);
        if (drift > 60_000) {
          findings.warn(
            'messages: created before the conversation started',
            `message ${record.source_id} precedes conversation ${key} by ` +
              `${Math.round(drift / 1000)}s — check timezone/epoch handling`,
          );
        }
      }
    }

    if (record.author_type !== undefined && !AUTHOR_TYPES.has(record.author_type)) {
      findings.error(
        'messages: author_type outside the canonical vocabulary',
        `"${record.author_type}" (line ${lineNo})`,
      );
    }
    if (record.visibility !== undefined && !VISIBILITIES.has(record.visibility)) {
      findings.error(
        'messages: visibility outside the canonical vocabulary',
        `"${record.visibility}" (line ${lineNo})`,
      );
    }
    if (record.created_at !== null && record.created_at !== undefined && !isIso(record.created_at)) {
      findings.error(
        'messages: created_at is not an ISO 8601 timestamp',
        `"${record.created_at}" (line ${lineNo})`,
      );
    }

    if (typeof record.body === 'string' && record.body.trim() !== '') stats.withBody++;
    else stats.emptyBody++;

    stats.byAuthorType[record.author_type] = (stats.byAuthorType[record.author_type] ?? 0) + 1;
    stats.byVisibility[record.visibility] = (stats.byVisibility[record.visibility] ?? 0) + 1;
  }

  return { stats, withMessages };
}

function crossChecks(conversations, messages, findings) {
  const notes = [];

  if (messages === null) return notes;

  const missing = conversations.ids.size - messages.withMessages.size;
  if (missing > 0) {
    const share = missing / Math.max(conversations.ids.size, 1);
    notes.push(
      `${missing} of ${conversations.ids.size} conversations (${(share * 100).toFixed(1)}%) have no messages.`,
    );
    if (share > 0.1) {
      findings.warn(
        'export: many conversations have no messages',
        `${(share * 100).toFixed(1)}% — usually an interrupted message phase, or an API that ` +
          `truncates message history. Let the export finish before analysing.`,
      );
    }
  }

  const unknown = messages.stats.byAuthorType.unknown ?? 0;
  if (messages.stats.total > 0) {
    const share = unknown / messages.stats.total;
    if (share > UNKNOWN_AUTHOR_WARN) {
      findings.warn(
        'export: unresolved author types',
        `${(share * 100).toFixed(1)}% of messages have author_type "unknown". Response-time and ` +
          `turn-count metrics depend on telling customer from agent; treat them as unreliable.`,
      );
    }
  }

  const customer = messages.stats.byAuthorType.customer ?? 0;
  if (messages.stats.total > 0 && customer === 0) {
    findings.error(
      'export: no customer messages at all',
      'every message is attributed to an agent, bot, or unknown. The author mapping is wrong.',
    );
  }

  if (conversations.stats.total > 0) {
    const share = conversations.stats.nullCustomer / conversations.stats.total;
    if (share > 0.1) {
      findings.warn(
        'export: conversations without a customer_id',
        `${(share * 100).toFixed(1)}% have no customer_id. Repeat-contact and deflection analysis ` +
          `needs a stable customer identity; those rows cannot participate.`,
      );
    }
  }

  return notes;
}

function render(report) {
  const lines = [''];
  const { conversations, messages } = report.stats;

  lines.push(`conversations: ${conversations.total}`);
  const sources = Object.keys(conversations.bySource).filter((s) => s !== 'undefined');
  lines.push(`  sources:  ${sources.join(', ') || '(none)'}`);
  lines.push(
    `  statuses: ${Object.entries(conversations.byStatus).map(([k, v]) => `${k}=${v}`).join(' ')}`,
  );
  lines.push(
    `  channels: ${Object.entries(conversations.byChannel).map(([k, v]) => `${k}=${v}`).join(' ')}`,
  );
  lines.push(`  with csat: ${conversations.withCsat}, deleted: ${conversations.deleted}`);

  if (messages) {
    lines.push('');
    lines.push(`messages: ${messages.total}`);
    lines.push(
      `  authors:    ${Object.entries(messages.byAuthorType).map(([k, v]) => `${k}=${v}`).join(' ')}`,
    );
    lines.push(
      `  visibility: ${Object.entries(messages.byVisibility).map(([k, v]) => `${k}=${v}`).join(' ')}`,
    );
    lines.push(`  with text:  ${messages.withBody} (${messages.emptyBody} empty)`);
  }

  for (const note of report.notes) lines.push(`  ${note}`);

  if (report.errors.length > 0) {
    lines.push('');
    lines.push('ERRORS');
    for (const { issue, count, samples } of report.errors) {
      lines.push(`  ${issue} (${count})`);
      for (const sample of samples) lines.push(`      ${sample}`);
    }
  }

  if (report.warnings.length > 0) {
    lines.push('');
    lines.push('WARNINGS');
    for (const { issue, count, samples } of report.warnings) {
      lines.push(`  ${issue} (${count})`);
      for (const sample of samples) lines.push(`      ${sample}`);
    }
  }

  lines.push('');
  lines.push(
    report.errors.length === 0
      ? report.warnings.length === 0
        ? 'PASS — export is structurally valid with no distortion warnings'
        : 'PASS WITH WARNINGS — valid, but read the warnings before analysing'
      : 'FAIL — fix the errors before analysing this export',
  );
  lines.push('');

  return lines.join('\n');
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  const conversationsPath = join(opts.dir, 'conversations.jsonl');
  const messagesPath = join(opts.dir, 'messages.jsonl');

  if (!existsSync(conversationsPath)) {
    fail(`no conversations.jsonl in ${opts.dir}`);
  }

  const findings = new Findings(opts.sampleErrors);
  const conversations = await loadConversations(conversationsPath, findings);

  let messages = null;
  if (opts.expectMessages) {
    if (!existsSync(messagesPath)) {
      fail(
        `no messages.jsonl in ${opts.dir}. If this is a voice-only export with no message ` +
          `bodies, pass --no-messages.`,
      );
    }
    messages = await loadMessages(messagesPath, conversations, findings);
  }

  const notes = crossChecks(conversations, messages, findings);

  const report = {
    dir: opts.dir,
    stats: { conversations: conversations.stats, messages: messages?.stats ?? null },
    notes,
    errors: findings.toJson(findings.errors),
    warnings: findings.toJson(findings.warnings),
  };
  report.ok = report.errors.length === 0;

  if (!opts.json) process.stderr.write(render(report));
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');

  process.exit(report.ok ? 0 : 1);
}

await main();
