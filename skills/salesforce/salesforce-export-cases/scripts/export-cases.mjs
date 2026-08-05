#!/usr/bin/env node
/**
 * Exports Salesforce Service Cloud cases and their conversation text to the
 * canonical conversations.jsonl / messages.jsonl shape, via Bulk API 2.0.
 *
 * THE TRAP: a case's conversation is not in one place. Depending on how the org
 * is configured, message text lives in up to three separate objects:
 *
 *   CaseComment   CommentBody          manual agent/customer comments
 *   EmailMessage  TextBody / HtmlBody  Email-to-Case correspondence
 *   FeedItem      Body                 Chatter / Case Feed posts
 *
 * Exporting only CaseComment — the obvious choice, given the name — misses every
 * email on an Email-to-Case org, which is usually the majority of the
 * conversation. This script queries all three and unifies them into
 * messages.jsonl, reporting how many messages came from each so a missing source
 * is visible rather than silent.
 *
 * Bulk API 2.0 query flow, for each object:
 *   POST /services/data/vXX.X/jobs/query        -> job id
 *   GET  /services/data/vXX.X/jobs/query/{id}   -> poll until state JobComplete
 *   GET  .../results?maxRecords=N&locator=...   -> CSV pages, paged by the
 *                                                  Sforce-Locator response header
 *
 * `queryAll` is used so archived and soft-deleted rows are included; counts then
 * reconcile against the org rather than mysteriously undershooting.
 *
 * No npm dependencies. Node 20+.
 *
 * Credentials (environment only):
 *   SALESFORCE_INSTANCE_URL   e.g. https://acme.my.salesforce.com
 *   SALESFORCE_ACCESS_TOKEN   OAuth access token
 *
 * Optional:
 *   SALESFORCE_API_VERSION    default 61.0
 */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_API_VERSION = '61.0';
const MAX_RECORDS_PER_PAGE = 50_000;
const POLL_INTERVAL_MS = 4000;
const POLL_TIMEOUT_MS = 30 * 60 * 1000;

const MESSAGE_SOURCES = ['CaseComment', 'EmailMessage', 'FeedItem'];

function parseArgs(argv) {
  const opts = {
    start: null,
    out: './out/salesforce',
    resume: false,
    bodies: true,
    only: 'both',
    sources: [...MESSAGE_SOURCES],
    includeDeleted: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) fail(`${arg} requires a value`);
      return v;
    };
    switch (arg) {
      case '--start': opts.start = next(); break;
      case '--out': opts.out = next(); break;
      case '--only': opts.only = next(); break;
      case '--sources': opts.sources = next().split(',').map((s) => s.trim()).filter(Boolean); break;
      case '--resume': opts.resume = true; break;
      case '--no-bodies': opts.bodies = false; break;
      case '--exclude-deleted': opts.includeDeleted = false; break;
      case '--help': case '-h': usage(); process.exit(0);
      default: fail(`unknown argument: ${arg}`);
    }
  }
  if (!['both', 'conversations', 'messages'].includes(opts.only)) {
    fail('--only must be one of: both, conversations, messages');
  }
  for (const source of opts.sources) {
    if (!MESSAGE_SOURCES.includes(source)) {
      fail(`--sources must be a comma-separated subset of: ${MESSAGE_SOURCES.join(',')}`);
    }
  }
  return opts;
}

function usage() {
  process.stderr.write(`
Usage: node scripts/export-cases.mjs --start <when> [options]

  --start <when>       Filter on LastModifiedDate. ISO date/timestamp, epoch
                       seconds, or a relative window like 30d. Required unless
                       --resume.
  --out <dir>          Output directory (default ./out/salesforce).
  --resume             Continue from checkpoint.json in --out.
  --only <what>        both (default) | conversations | messages
  --sources <list>     Message objects to query. Default all three:
                       CaseComment,EmailMessage,FeedItem
                       Narrow ONLY if you know the org doesn't use one.
  --exclude-deleted    Use the query operation instead of queryAll, omitting
                       archived and soft-deleted rows. Counts will not reconcile.
  --no-bodies          Export message metadata without text.

Environment: SALESFORCE_INSTANCE_URL, SALESFORCE_ACCESS_TOKEN
             SALESFORCE_API_VERSION (optional, default ${DEFAULT_API_VERSION})
`);
}

function fail(message) {
  process.stderr.write(`error: ${message}\n`);
  process.exit(1);
}

function log(message) {
  process.stderr.write(`${message}\n`);
}

function resolveStart(input) {
  const relative = /^(\d+)([hdw])$/.exec(String(input).trim());
  if (relative) {
    const [, n, unit] = relative;
    const ms = { h: 3_600_000, d: 86_400_000, w: 604_800_000 }[unit];
    return new Date(Date.now() - Number(n) * ms).toISOString();
  }
  if (/^\d{9,11}$/.test(String(input).trim())) {
    return new Date(Number(input) * 1000).toISOString();
  }
  const parsed = Date.parse(input);
  if (Number.isNaN(parsed)) {
    fail(`could not parse --start "${input}". Use 2026-01-01, an epoch, or 30d.`);
  }
  return new Date(parsed).toISOString();
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) fail(`${name} is not set. Export it before running; do not pass tokens as arguments.`);
  return value;
}

/** RFC 4180 CSV parser — Salesforce bodies contain commas, quotes and newlines. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += char;
      continue;
    }
    if (char === '"') inQuotes = true;
    else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\r') {
      /* handled by \n */
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += char;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** Turns CSV text into objects keyed by header. */
export function csvToObjects(text) {
  const rows = parseCsv(text).filter((r) => r.some((c) => c !== ''));
  if (rows.length === 0) return [];
  const headers = rows[0].map((h) => h.trim());
  return rows.slice(1).map((row) => {
    const record = {};
    headers.forEach((header, i) => {
      const value = row[i];
      record[header] = value === '' || value === undefined ? null : value;
    });
    return record;
  });
}

class Client {
  constructor({ instanceUrl, token, apiVersion }) {
    this.base = instanceUrl.replace(/\/$/, '');
    this.apiVersion = apiVersion;
    this.token = token;
    this.requestCount = 0;
  }

  get jobsPath() {
    return `/services/data/v${this.apiVersion}/jobs/query`;
  }

  async #fetch(path, { method = 'GET', body, accept = 'application/json' } = {}, attempt = 1) {
    this.requestCount++;
    const url = path.startsWith('http') ? path : `${this.base}${path}`;

    let res;
    try {
      res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: accept,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      if (attempt > 5) fail(`network error after 5 attempts: ${err.message}`);
      const backoff = 2 ** attempt * 1000;
      log(`  network error (${err.message}); retrying in ${backoff / 1000}s`);
      await new Promise((r) => setTimeout(r, backoff));
      return this.#fetch(path, { method, body, accept }, attempt + 1);
    }

    if (res.status === 401) {
      fail(
        '401 from Salesforce. The OAuth access token is invalid or expired — access tokens are ' +
          'short-lived, so refresh it and re-run with --resume.',
      );
    }
    if (res.status === 403) {
      const text = await res.text();
      fail(
        `403 from Salesforce. Common causes: the user lacks "API Enabled", lacks read access to the ` +
          `object, or the org's 24-hour API request allocation is exhausted.\n${text.slice(0, 400)}`,
      );
    }

    if (res.status === 429 || res.status >= 500) {
      if (attempt > 5) fail(`Salesforce returned ${res.status} five times; aborting`);
      const header = Number(res.headers.get('retry-after'));
      const backoff = Number.isFinite(header) && header > 0 ? header * 1000 : 2 ** attempt * 1000;
      log(`  ${res.status} from Salesforce; retrying in ${Math.round(backoff / 1000)}s`);
      await new Promise((r) => setTimeout(r, backoff));
      return this.#fetch(path, { method, body, accept }, attempt + 1);
    }

    if (!res.ok) {
      fail(`${res.status} ${res.statusText} for ${url}\n${(await res.text()).slice(0, 600)}`);
    }

    return res;
  }

  async createQueryJob(soql, includeDeleted) {
    const res = await this.#fetch(this.jobsPath, {
      method: 'POST',
      body: {
        operation: includeDeleted ? 'queryAll' : 'query',
        query: soql,
        contentType: 'CSV',
        lineEnding: 'LF',
      },
    });
    const job = await res.json();
    if (!job.id) fail(`Bulk query job creation returned no id: ${JSON.stringify(job).slice(0, 300)}`);
    return job.id;
  }

  async waitForJob(jobId) {
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    for (;;) {
      const res = await this.#fetch(`${this.jobsPath}/${jobId}`);
      const job = await res.json();

      if (job.state === 'JobComplete') return job;
      if (job.state === 'Failed' || job.state === 'Aborted') {
        fail(
          `Bulk query job ${jobId} ended in state ${job.state}: ` +
            `${job.errorMessage ?? '(no message)'}`,
        );
      }
      if (Date.now() > deadline) {
        fail(
          `Bulk query job ${jobId} still ${job.state} after ${POLL_TIMEOUT_MS / 60000} minutes. ` +
            `Narrow --start so the query returns less data.`,
        );
      }
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
  }

  /**
   * Streams result pages. Pagination is the Sforce-Locator response header; the
   * string 'null' means no further pages. Locators must never be constructed by
   * hand.
   */
  async *results(jobId) {
    let locator = null;
    for (;;) {
      const params = new URLSearchParams({ maxRecords: String(MAX_RECORDS_PER_PAGE) });
      if (locator) params.set('locator', locator);

      const res = await this.#fetch(`${this.jobsPath}/${jobId}/results?${params}`, {
        accept: 'text/csv',
      });
      const csv = await res.text();
      const next = res.headers.get('sforce-locator');
      const count = res.headers.get('sforce-numberofrecords');

      yield { csv, count: count === null ? null : Number(count) };

      if (!next || next === 'null') return;
      locator = next;
    }
  }
}

const iso = (value) => {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
};

/**
 * Salesforce case Status is org-configurable, so map on well-known values and
 * fall back rather than dropping rows. IsClosed is the reliable signal.
 */
function normalizeCaseStatus(record) {
  const status = String(record.Status ?? '').toLowerCase();
  if (record.IsDeleted === 'true') return 'deleted';
  if (record.IsClosed === 'true' || status === 'closed') return 'closed';
  if (status.includes('escalat') || status === 'working' || status === 'in progress') return 'open';
  if (status.includes('wait') || status === 'pending' || status.includes('hold')) return 'pending';
  if (status === 'resolved') return 'resolved';
  if (status === 'new' || status === 'open') return 'open';
  return 'open';
}

/** Case Origin is org-configurable; match on substrings. */
function normalizeChannel(origin) {
  const value = String(origin ?? '').toLowerCase();
  if (!value) return null;
  if (value.includes('email')) return 'email';
  if (value.includes('phone') || value.includes('call')) return 'voice';
  if (value.includes('chat')) return 'chat';
  if (value.includes('web') || value.includes('portal') || value.includes('form')) return 'web_form';
  if (value.includes('whatsapp') || value.includes('sms') || value.includes('messag')) return 'messaging';
  if (value.includes('facebook') || value.includes('twitter') || value.includes('social')) return 'social';
  if (value.includes('api')) return 'api';
  return 'other';
}

const CASE_FIELDS = [
  'Id',
  'CaseNumber',
  'Subject',
  'Status',
  'IsClosed',
  'IsDeleted',
  'Origin',
  'Priority',
  'ContactId',
  'AccountId',
  'OwnerId',
  'CreatedDate',
  'LastModifiedDate',
  'ClosedDate',
];

function normalizeCase(record) {
  return {
    source: 'salesforce',
    source_id: String(record.Id),
    subject: record.Subject ?? null,
    status: normalizeCaseStatus(record),
    status_raw: record.Status ?? null,
    channel: normalizeChannel(record.Origin),
    channel_raw: record.Origin ?? null,
    customer_id: record.ContactId ?? null,
    assignee_id: record.OwnerId ?? null,
    // Salesforce queues are also Group records in OwnerId; there is no separate
    // team field on Case, so team is left null rather than duplicating owner.
    team_id: null,
    account_id: record.AccountId ?? null,
    created_at: iso(record.CreatedDate),
    updated_at: iso(record.LastModifiedDate),
    resolved_at: iso(record.ClosedDate),
    // Salesforce has no standard CSAT field; surveys live in Feedback Management
    // or a custom field, so nothing is guessed here.
    csat: null,
    csat_raw: null,
    priority: record.Priority ? String(record.Priority).toLowerCase() : null,
    tags: [],
    is_deleted: record.IsDeleted === 'true',
  };
}

const MESSAGE_QUERIES = {
  CaseComment: {
    fields: ['Id', 'ParentId', 'CommentBody', 'CreatedById', 'CreatedDate', 'IsPublished', 'IsDeleted'],
    object: 'CaseComment',
    normalize: (r, caseIndex, includeBodies) => {
      const parent = caseIndex.get(r.ParentId);
      const author = r.CreatedById ?? null;
      return {
        source: 'salesforce',
        conversation_source_id: String(r.ParentId),
        source_id: String(r.Id),
        created_at: iso(r.CreatedDate),
        author_id: author,
        author_type:
          author && parent?.customer_id
            ? author === parent.customer_id
              ? 'customer'
              : 'agent'
            : author
              ? 'agent'
              : 'unknown',
        // IsPublished false means the comment is agent-only.
        visibility: r.IsPublished === 'true' ? 'public' : 'internal',
        channel: parent?.channel ?? null,
        attachment_count: 0,
        body: includeBodies ? (r.CommentBody ?? null) : null,
        message_source: 'CaseComment',
      };
    },
  },
  EmailMessage: {
    fields: [
      'Id',
      'ParentId',
      'TextBody',
      'Subject',
      'FromAddress',
      'Incoming',
      'MessageDate',
      'CreatedDate',
      'CreatedById',
      'HasAttachment',
      'IsDeleted',
    ],
    object: 'EmailMessage',
    normalize: (r, caseIndex, includeBodies) => ({
      source: 'salesforce',
      conversation_source_id: String(r.ParentId),
      source_id: String(r.Id),
      created_at: iso(r.MessageDate ?? r.CreatedDate),
      // Inbound email has no Salesforce user; the sender address is the identity.
      author_id: r.Incoming === 'true' ? (r.FromAddress ?? null) : (r.CreatedById ?? null),
      author_type: r.Incoming === 'true' ? 'customer' : 'agent',
      visibility: 'public',
      channel: 'email',
      attachment_count: r.HasAttachment === 'true' ? 1 : 0,
      body: includeBodies ? (r.TextBody ?? null) : null,
      message_source: 'EmailMessage',
    }),
  },
  FeedItem: {
    fields: ['Id', 'ParentId', 'Body', 'Type', 'CreatedById', 'CreatedDate', 'IsDeleted'],
    object: 'FeedItem',
    normalize: (r, caseIndex, includeBodies) => {
      const parent = caseIndex.get(r.ParentId);
      const author = r.CreatedById ?? null;
      return {
        source: 'salesforce',
        conversation_source_id: String(r.ParentId),
        source_id: String(r.Id),
        created_at: iso(r.CreatedDate),
        author_id: author,
        author_type:
          author && parent?.customer_id && author === parent.customer_id ? 'customer' : 'agent',
        // Chatter posts on a case are internal unless the org exposes them to a
        // community; treat as internal by default rather than overstating what
        // the customer saw.
        visibility: 'internal',
        channel: parent?.channel ?? null,
        attachment_count: 0,
        body: includeBodies ? (r.Body ?? null) : null,
        message_source: 'FeedItem',
      };
    },
  },
};

class Checkpoint {
  constructor(dir) {
    this.path = join(dir, 'checkpoint.json');
    this.state = { start: null, done: [] };
  }
  load() {
    if (!existsSync(this.path)) fail(`--resume passed but no checkpoint at ${this.path}`);
    this.state = JSON.parse(readFileSync(this.path, 'utf8'));
    return this.state;
  }
  save(patch) {
    Object.assign(this.state, patch, { updatedAt: new Date().toISOString() });
    writeFileSync(this.path, JSON.stringify(this.state, null, 2));
  }
  isDone(key) {
    return (this.state.done ?? []).includes(key);
  }
  complete(key) {
    (this.state.done ??= []).push(key);
    this.save({});
  }
}

function writeJsonl(path, records) {
  if (records.length === 0) return;
  appendFileSync(path, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

/** Runs one bulk query and streams its pages through `onRecords`. */
async function runQuery(client, { object, fields, where }, includeDeleted, onRecords) {
  const soql = `SELECT ${fields.join(', ')} FROM ${object} WHERE ${where}`;
  log(`  querying ${object}...`);

  const jobId = await client.createQueryJob(soql, includeDeleted);
  await client.waitForJob(jobId);

  let total = 0;
  let pages = 0;
  for await (const { csv, count } of client.results(jobId)) {
    const records = csvToObjects(csv);
    pages++;
    total += records.length;
    onRecords(records);
    log(`    page ${pages}: ${records.length} rows${count !== null ? ` (header count ${count})` : ''}`);
  }

  log(`  ${object}: ${total} rows`);
  return total;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  const client = new Client({
    instanceUrl: requireEnv('SALESFORCE_INSTANCE_URL'),
    token: requireEnv('SALESFORCE_ACCESS_TOKEN'),
    apiVersion: process.env.SALESFORCE_API_VERSION || DEFAULT_API_VERSION,
  });

  mkdirSync(opts.out, { recursive: true });
  const ckpt = new Checkpoint(opts.out);

  if (opts.resume) {
    ckpt.load();
    log(`resuming from ${ckpt.path} (${ckpt.state.done.length} objects done)`);
  } else {
    if (!opts.start) fail('--start is required (or use --resume)');
    ckpt.save({ start: resolveStart(opts.start), done: [] });
  }

  const since = ckpt.state.start;
  const caseWhere = `LastModifiedDate >= ${since}`;

  log(`Salesforce export of cases modified since ${since}`);
  log(`API v${client.apiVersion}, ${opts.includeDeleted ? 'queryAll' : 'query'}, output ${opts.out}`);
  log(`message sources: ${opts.sources.join(', ')}`);
  if (opts.sources.length < MESSAGE_SOURCES.length) {
    log(
      `  NOTE: ${MESSAGE_SOURCES.filter((s) => !opts.sources.includes(s)).join(', ')} excluded. ` +
        `On an Email-to-Case org, omitting EmailMessage drops most of the conversation.`,
    );
  }

  const started = Date.now();
  const conversationsPath = join(opts.out, 'conversations.jsonl');
  const messagesPath = join(opts.out, 'messages.jsonl');
  const summary = { conversations: 0, messages: 0, by_source: {} };

  // Cases first: the case index resolves author types for comments and feed items.
  if (opts.only !== 'messages' && !ckpt.isDone('Case')) {
    summary.conversations = await runQuery(
      client,
      { object: 'Case', fields: CASE_FIELDS, where: caseWhere },
      opts.includeDeleted,
      (records) => writeJsonl(conversationsPath, records.map(normalizeCase)),
    );
    ckpt.complete('Case');
  }

  const caseIndex = new Map();
  if (existsSync(conversationsPath)) {
    for (const line of readFileSync(conversationsPath, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const c = JSON.parse(line);
        caseIndex.set(c.source_id, c);
      } catch {
        /* partial final line */
      }
    }
  }
  if (opts.only !== 'conversations' && caseIndex.size === 0) {
    log(
      '  WARNING: no cases indexed, so CaseComment and FeedItem author types cannot be resolved. ' +
        'Run the conversations phase first.',
    );
  }

  if (opts.only !== 'conversations') {
    for (const source of opts.sources) {
      if (ckpt.isDone(source)) {
        log(`  ${source}: already complete per checkpoint`);
        continue;
      }
      const spec = MESSAGE_QUERIES[source];
      // ParentId on all three points at the Case; filter by the case window so
      // messages and cases cover the same period.
      const where = `LastModifiedDate >= ${since} AND Parent.Type = 'Case'`;
      const fallbackWhere = `LastModifiedDate >= ${since}`;

      const count = await runQuery(
        client,
        {
          object: spec.object,
          fields: spec.fields,
          // FeedItem supports Parent.Type; CaseComment and EmailMessage parent
          // is already a Case, so the simpler filter avoids an invalid field.
          where: source === 'FeedItem' ? where : fallbackWhere,
        },
        opts.includeDeleted,
        (records) => {
          const messages = records
            .filter((r) => r.ParentId && (caseIndex.size === 0 || caseIndex.has(r.ParentId)))
            .map((r) => spec.normalize(r, caseIndex, opts.bodies));
          writeJsonl(messagesPath, messages);
          summary.messages += messages.length;
          summary.by_source[source] = (summary.by_source[source] ?? 0) + messages.length;
        },
      );
      ckpt.complete(source);
      if (count > 0 && (summary.by_source[source] ?? 0) === 0) {
        log(
          `    NOTE: ${count} ${source} rows returned but none matched an exported case. ` +
            `Those rows belong to other parent objects.`,
        );
      }
    }
  }

  const elapsed = Math.round((Date.now() - started) / 1000);
  log(
    `done in ${elapsed}s using ${client.requestCount} requests ` +
      `(${summary.conversations} cases, ${summary.messages} messages)`,
  );
  for (const source of opts.sources) {
    log(`  ${source}: ${summary.by_source[source] ?? 0} messages`);
  }
  const zeroSources = opts.sources.filter((s) => (summary.by_source[s] ?? 0) === 0);
  if (zeroSources.length > 0) {
    log(
      `WARNING: no messages from ${zeroSources.join(', ')}. Either the org does not use ` +
        `${zeroSources.length > 1 ? 'them' : 'it'}, or read access is missing. Confirm before ` +
        `treating the conversation as complete.`,
    );
  }

  process.stdout.write(
    JSON.stringify(
      {
        ...summary,
        out_dir: opts.out,
        since,
        api_version: client.apiVersion,
        include_deleted: opts.includeDeleted,
        sources_queried: opts.sources,
        sources_with_no_messages: zeroSources,
        requests: client.requestCount,
        elapsed_seconds: elapsed,
        complete: ckpt.state.done.length >= 1 + opts.sources.length,
        bodies_included: opts.bodies,
      },
      null,
      2,
    ) + '\n',
  );
}

if (process.argv[1] && process.argv[1].endsWith('export-cases.mjs')) {
  await main();
}
