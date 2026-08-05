#!/usr/bin/env node
/**
 * Exports Freshchat conversations and messages to the canonical
 * conversations.jsonl / messages.jsonl shape.
 *
 * The defining Freshchat problem: THERE IS NO LIST-CONVERSATIONS ENDPOINT.
 * `GET /v2/conversations/{id}` requires an id you must already know, and no
 * endpoint enumerates them. Conversation ids only come from the Reports/Extract
 * API — you request a raw report (Chat Transcript / Conversation Created), wait
 * for it, download it, and mine the ids out of it.
 *
 * So this script has three phases, not two:
 *
 *   1. Discover  — request a raw report, poll, download, extract conversation ids.
 *   2. Hydrate   — GET /v2/conversations/{id} per id.
 *   3. Messages  — GET /v2/conversations/{id}/messages per id (50 per page max).
 *
 * Because report definitions and the extract payload shape vary by account, id
 * discovery is deliberately tolerant: it accepts a report id column under
 * several names, and it also accepts a pre-built id list via --ids-file so you
 * can bypass the reporting API entirely if you obtained ids another way.
 *
 * No npm dependencies. Node 20+.
 *
 * Credentials (environment only):
 *   FRESHCHAT_DOMAIN    e.g. "acme" for acme.freshchat.com, or a full host
 *   FRESHCHAT_API_TOKEN Bearer token from Admin > API tokens
 *
 * Optional:
 *   FRESHCHAT_API_BASE  override API origin (a mock server, for tests)
 */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const MESSAGE_PAGE_SIZE = 50; // Freshchat caps items_per_page at 50 for messages.
const POLL_INTERVAL_MS = 5000;
const POLL_TIMEOUT_MS = 20 * 60 * 1000;
const MIN_INTERVAL_MS = Number(process.env.FRESHCHAT_MIN_INTERVAL_MS) || 250;

function parseArgs(argv) {
  const opts = {
    start: null,
    end: null,
    out: './out/freshchat',
    resume: false,
    idsFile: null,
    concurrency: 3,
    bodies: true,
    only: 'both',
    maxIds: Infinity,
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
      case '--end': opts.end = next(); break;
      case '--out': opts.out = next(); break;
      case '--ids-file': opts.idsFile = next(); break;
      case '--concurrency': opts.concurrency = Number(next()); break;
      case '--max-ids': opts.maxIds = Number(next()); break;
      case '--only': opts.only = next(); break;
      case '--resume': opts.resume = true; break;
      case '--no-bodies': opts.bodies = false; break;
      case '--help': case '-h': usage(); process.exit(0);
      default: fail(`unknown argument: ${arg}`);
    }
  }
  if (!['both', 'conversations', 'messages'].includes(opts.only)) {
    fail('--only must be one of: both, conversations, messages');
  }
  if (!Number.isInteger(opts.concurrency) || opts.concurrency < 1 || opts.concurrency > 8) {
    fail('--concurrency must be an integer between 1 and 8');
  }
  return opts;
}

function usage() {
  process.stderr.write(`
Usage: node scripts/export-conversations.mjs --start <when> [--end <when>] [options]

  --start <when>       Report window start. ISO date/timestamp, epoch seconds,
                       or a relative window like 30d. Required unless --resume
                       or --ids-file.
  --end <when>         Report window end. Defaults to now.
  --ids-file <path>    Skip report-based discovery and read conversation ids
                       from a file (one per line). Use when you already have
                       ids, or when your account's report shape isn't parseable.
  --out <dir>          Output directory (default ./out/freshchat).
  --resume             Continue from checkpoint.json in --out.
  --only <what>        both (default) | conversations | messages
  --concurrency <n>    Parallel hydrate/message fetches (default 3, max 8).
  --no-bodies          Export message metadata without text.
  --max-ids <n>        Cap discovered ids. Use to sample.

Environment: FRESHCHAT_DOMAIN, FRESHCHAT_API_TOKEN

Freshchat has no list-conversations endpoint. Ids must come from the Reports
API, so a run that discovers zero ids usually means the report name or window
is wrong, not that there are no conversations.
`);
}

function fail(message) {
  process.stderr.write(`error: ${message}\n`);
  process.exit(1);
}

function log(message) {
  process.stderr.write(`${message}\n`);
}

function resolveTime(input) {
  const relative = /^(\d+)([hdw])$/.exec(String(input).trim());
  if (relative) {
    const [, n, unit] = relative;
    const ms = { h: 3_600_000, d: 86_400_000, w: 604_800_000 }[unit];
    return new Date(Date.now() - Number(n) * ms);
  }
  if (/^\d{9,11}$/.test(String(input).trim())) return new Date(Number(input) * 1000);
  const parsed = Date.parse(input);
  if (Number.isNaN(parsed)) fail(`could not parse time "${input}". Use 2026-01-01, an epoch, or 30d.`);
  return new Date(parsed);
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) fail(`${name} is not set. Export it before running; do not pass tokens as arguments.`);
  return value;
}

const iso = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const ms = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
};

class Client {
  constructor({ domain, token }) {
    const host = domain.includes('.') ? domain : `${domain}.freshchat.com`;
    this.base = (process.env.FRESHCHAT_API_BASE || `https://${host}`).replace(/\/$/, '');
    this.headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
    this.requestCount = 0;
    this.nextSlot = 0;
  }

  async #pace() {
    const now = Date.now();
    const wait = Math.max(0, this.nextSlot - now);
    this.nextSlot = Math.max(now, this.nextSlot) + MIN_INTERVAL_MS;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }

  /**
   * `tolerate404` returns null instead of aborting. Reports routinely reference
   * conversations that no longer resolve, and one stale id must not kill an
   * export of thousands.
   */
  async request(path, { method = 'GET', body, raw = false, tolerate404 = false } = {}, attempt = 1) {
    await this.#pace();
    this.requestCount++;
    const url = path.startsWith('http') ? path : `${this.base}${path}`;

    let res;
    try {
      res = await fetch(url, {
        method,
        headers: body ? { ...this.headers, 'Content-Type': 'application/json' } : this.headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      if (attempt > 5) fail(`network error after 5 attempts: ${err.message}`);
      const backoff = 2 ** attempt * 1000;
      log(`  network error (${err.message}); retrying in ${backoff / 1000}s`);
      await new Promise((r) => setTimeout(r, backoff));
      return this.request(path, { method, body, raw, tolerate404 }, attempt + 1);
    }

    if (res.status === 429) {
      const header = Number(res.headers.get('retry-after'));
      const retryAfter = Number.isFinite(header) && header >= 0 ? header : 30;
      log(`  429 from Freshchat; waiting ${retryAfter}s`);
      await new Promise((r) => setTimeout(r, (retryAfter + 1) * 1000));
      return this.request(path, { method, body, raw, tolerate404 }, attempt);
    }

    if (res.status === 401 || res.status === 403) {
      fail(
        `${res.status} from Freshchat. Check FRESHCHAT_API_TOKEN and FRESHCHAT_DOMAIN. The token must ` +
          `come from Admin > API tokens, and reporting endpoints require a token with report access — ` +
          `an agent-scoped token can read conversations but not request reports.`,
      );
    }

    if (res.status >= 500) {
      if (attempt > 5) fail(`Freshchat returned ${res.status} five times; aborting`);
      const backoff = 2 ** attempt * 1000;
      log(`  ${res.status} from Freshchat; retrying in ${backoff / 1000}s`);
      await new Promise((r) => setTimeout(r, backoff));
      return this.request(path, { method, body, raw, tolerate404 }, attempt + 1);
    }

    if (res.status === 404 && (raw || tolerate404)) return null;

    if (!res.ok) {
      fail(`${res.status} ${res.statusText} for ${url}\n${(await res.text()).slice(0, 500)}`);
    }

    return raw ? res.text() : res.json();
  }

  /** Downloads a report artifact from a signed URL (no auth header). */
  async download(url, attempt = 1) {
    this.requestCount++;
    try {
      const res = await fetch(url);
      if (!res.ok) {
        if (res.status >= 500 && attempt <= 4) {
          await new Promise((r) => setTimeout(r, 2 ** attempt * 1000));
          return this.download(url, attempt + 1);
        }
        fail(`${res.status} downloading report artifact`);
      }
      return res.text();
    } catch (err) {
      if (attempt > 4) fail(`network error downloading report: ${err.message}`);
      await new Promise((r) => setTimeout(r, 2 ** attempt * 1000));
      return this.download(url, attempt + 1);
    }
  }
}

/** RFC 4180 CSV parser — report cells contain commas and newlines. */
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
  return rows.filter((r) => r.some((c) => c !== ''));
}

/** Column names accounts use for the conversation id in raw reports. */
const ID_COLUMN_ALIASES = [
  'conversation id',
  'conversationid',
  'conversation_id',
  'conv id',
  'conversation reference id',
];

const norm = (h) => String(h).trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * Mines conversation ids out of a report artifact. Accepts CSV or JSON, because
 * the extract format differs by account and report type.
 */
export function extractConversationIds(payload) {
  const trimmed = payload.trim();

  // JSON array or object with a records/data array.
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      const records = Array.isArray(parsed)
        ? parsed
        : (parsed.records ?? parsed.data ?? parsed.results ?? []);
      const ids = [];
      for (const record of records) {
        if (!record || typeof record !== 'object') continue;
        for (const [key, value] of Object.entries(record)) {
          if (ID_COLUMN_ALIASES.includes(norm(key)) && value) {
            ids.push(String(value));
            break;
          }
        }
      }
      return { ids: [...new Set(ids)], format: 'json', headers: null };
    } catch {
      /* fall through to CSV */
    }
  }

  const rows = parseCsv(trimmed);
  if (rows.length === 0) return { ids: [], format: 'empty', headers: null };

  const headers = rows[0].map((h) => h.trim());
  const index = headers.findIndex((h) => ID_COLUMN_ALIASES.includes(norm(h)));
  if (index === -1) return { ids: [], format: 'csv', headers };

  const ids = rows
    .slice(1)
    .map((r) => (r[index] ?? '').trim())
    .filter(Boolean);
  return { ids: [...new Set(ids)], format: 'csv', headers };
}

/** Freshchat conversation status -> canonical status. */
const STATUS_MAP = { new: 'open', assigned: 'open', resolved: 'resolved', reopened: 'open' };

function normalizeConversation(c) {
  const status = String(c.status ?? '').toLowerCase();
  const user = (c.users ?? [])[0] ?? null;

  return {
    source: 'freshchat',
    source_id: String(c.conversation_id ?? c.id),
    subject: null,
    status: STATUS_MAP[status] ?? 'open',
    status_raw: c.status ?? null,
    // Freshchat is a messaging product; every conversation is a chat.
    channel: 'chat',
    channel_raw: c.channel_id ? String(c.channel_id) : null,
    customer_id: user?.id ? String(user.id) : (c.user_id ? String(c.user_id) : null),
    assignee_id: c.assigned_agent_id ? String(c.assigned_agent_id) : null,
    team_id: c.assigned_group_id ? String(c.assigned_group_id) : null,
    account_id: null,
    created_at: iso(c.created_time ?? c.created_at),
    updated_at: iso(c.updated_time ?? c.updated_at ?? c.created_time),
    resolved_at: status === 'resolved' ? iso(c.updated_time ?? c.resolved_time) : null,
    // Freshchat CSAT is a separate resource with an account-configurable scale.
    csat: null,
    csat_raw: null,
    priority: null,
    tags: Array.isArray(c.labels)
      ? c.labels.map((l) => l?.name ?? l).filter((v) => typeof v === 'string')
      : [],
    is_deleted: false,
  };
}

/**
 * Freshchat message actor_type is the author signal, but it is unreliable for
 * bot-authored messages, so compare the actor id against the conversation's
 * user as a fallback.
 */
function normalizeMessage(m, conversation, includeBodies) {
  const actorType = String(m.actor_type ?? '').toLowerCase();
  const actorId = m.actor_id ? String(m.actor_id) : null;
  const customerId = conversation?.customer_id ?? null;

  let authorType = 'unknown';
  if (actorType === 'user') authorType = 'customer';
  else if (actorType === 'agent') authorType = 'agent';
  else if (actorType === 'bot' || actorType === 'system') authorType = actorType === 'bot' ? 'bot' : 'system';
  else if (actorId && customerId) authorType = actorId === customerId ? 'customer' : 'agent';

  // Message text lives in message_parts[].text.content, not a single body field.
  const text = (m.message_parts ?? [])
    .map((part) => part?.text?.content)
    .filter((v) => typeof v === 'string' && v.trim() !== '')
    .join('\n')
    .trim();

  return {
    source: 'freshchat',
    conversation_source_id: String(m.conversation_id ?? conversation?.source_id),
    source_id: String(m.id ?? m.message_id),
    created_at: iso(m.created_time ?? m.created_at),
    author_id: actorId,
    author_type: authorType,
    // message_type "private" marks an agent-only note.
    visibility: String(m.message_type ?? '').toLowerCase() === 'private' ? 'internal' : 'public',
    channel: 'chat',
    attachment_count: (m.message_parts ?? []).filter((p) => p?.image || p?.file).length,
    body: includeBodies ? (text === '' ? null : text) : null,
  };
}

class Checkpoint {
  constructor(dir) {
    this.path = join(dir, 'checkpoint.json');
    this.hydratedPath = join(dir, 'hydrated-ids.txt');
    this.messagedPath = join(dir, 'messaged-ids.txt');
    this.state = { start: null, end: null, discoverDone: false, reportId: null };
    this.hydrated = new Set();
    this.messaged = new Set();
  }
  #loadSet(path, set) {
    if (!existsSync(path)) return;
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (line.trim()) set.add(line.trim());
    }
  }
  load() {
    if (!existsSync(this.path)) fail(`--resume passed but no checkpoint at ${this.path}`);
    this.state = JSON.parse(readFileSync(this.path, 'utf8'));
    this.#loadSet(this.hydratedPath, this.hydrated);
    this.#loadSet(this.messagedPath, this.messaged);
    return this.state;
  }
  save(patch) {
    Object.assign(this.state, patch, { updatedAt: new Date().toISOString() });
    writeFileSync(this.path, JSON.stringify(this.state, null, 2));
  }
  markHydrated(id) {
    appendFileSync(this.hydratedPath, id + '\n');
    this.hydrated.add(id);
  }
  markMessaged(id) {
    appendFileSync(this.messagedPath, id + '\n');
    this.messaged.add(id);
  }
}

function writeJsonl(path, records) {
  if (records.length === 0) return;
  appendFileSync(path, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

/** Phase 1: request a raw report, poll for it, download, mine ids. */
async function discoverIds(client, ckpt, opts) {
  const idsPath = join(opts.out, 'conversation-ids.txt');

  if (opts.idsFile) {
    if (!existsSync(opts.idsFile)) fail(`--ids-file ${opts.idsFile} does not exist`);
    const ids = [
      ...new Set(
        readFileSync(opts.idsFile, 'utf8')
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean),
      ),
    ];
    writeFileSync(idsPath, ids.join('\n') + '\n');
    ckpt.save({ discoverDone: true });
    log(`  using ${ids.length} ids from ${opts.idsFile} (report discovery skipped)`);
    return ids.length;
  }

  const start = new Date(ckpt.state.start);
  const end = new Date(ckpt.state.end);

  log(`  requesting raw report for ${start.toISOString()} -> ${end.toISOString()}`);
  const created = await client.request('/v2/reports/raw', {
    method: 'POST',
    body: {
      start: start.toISOString(),
      end: end.toISOString(),
      event: 'Conversation-Created',
      format: 'csv',
    },
  });

  const reportId = created?.id ?? created?.report_id ?? created?.link_id;
  if (!reportId) {
    fail(
      'the reports API returned no report id. Response keys: ' +
        `${Object.keys(created ?? {}).join(', ') || '(none)'}. Report request shapes differ by ` +
        'account — obtain conversation ids another way and pass --ids-file.',
    );
  }
  ckpt.save({ reportId: String(reportId) });

  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let artifactUrl = null;
  for (;;) {
    const status = await client.request(`/v2/reports/raw/${encodeURIComponent(reportId)}`);
    const state = String(status?.status ?? status?.state ?? '').toUpperCase();
    artifactUrl = status?.link ?? status?.url ?? status?.download_url ?? null;

    if (artifactUrl || state === 'COMPLETED' || state === 'SUCCESS') break;
    if (state === 'FAILED' || state === 'ERROR') fail(`report ${reportId} failed on Freshchat's side`);
    if (Date.now() > deadline) {
      fail(
        `report ${reportId} did not complete within ${POLL_TIMEOUT_MS / 60000} minutes. Narrow the ` +
          `--start/--end window.`,
      );
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  if (!artifactUrl) fail(`report ${reportId} completed but returned no download link`);

  const payload = await client.download(artifactUrl);
  const { ids, format, headers } = extractConversationIds(payload);

  if (ids.length === 0) {
    fail(
      `no conversation ids found in the ${format} report artifact.` +
        (headers ? ` Columns seen: ${headers.join(', ')}.` : '') +
        ` Expected one of: ${ID_COLUMN_ALIASES.join(', ')}. Add a conversation id column to the ` +
        `report, or pass --ids-file.`,
    );
  }

  const capped = Number.isFinite(opts.maxIds) ? ids.slice(0, opts.maxIds) : ids;
  writeFileSync(idsPath, capped.join('\n') + '\n');
  ckpt.save({ discoverDone: true });
  log(`  discovered ${ids.length} conversation ids from the ${format} report`);
  if (capped.length < ids.length) log(`  capped to ${capped.length} by --max-ids`);
  return capped.length;
}

function loadIds(opts) {
  const idsPath = join(opts.out, 'conversation-ids.txt');
  if (!existsSync(idsPath)) fail(`no ${idsPath}; run the discovery phase first`);
  return [
    ...new Set(
      readFileSync(idsPath, 'utf8')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean),
    ),
  ];
}

/** Phase 2: hydrate each conversation. */
async function hydrate(client, ckpt, opts) {
  const ids = loadIds(opts).filter((id) => !ckpt.hydrated.has(id));
  const path = join(opts.out, 'conversations.jsonl');
  log(`  ${ids.length} conversations to hydrate`);

  let done = 0;
  let missing = 0;
  let cursor = 0;

  const worker = async () => {
    while (cursor < ids.length) {
      const id = ids[cursor++];
      const conversation = await client
        .request(`/v2/conversations/${encodeURIComponent(id)}`, { tolerate404: true })
        .catch(() => null);

      if (!conversation || (!conversation.conversation_id && !conversation.id)) {
        // Reports can reference conversations that no longer resolve.
        missing++;
        ckpt.markHydrated(id);
        continue;
      }

      writeJsonl(path, [normalizeConversation(conversation)]);
      ckpt.markHydrated(id);
      done++;
      if (done % 100 === 0) log(`  hydrated ${done}/${ids.length}`);
    }
  };

  await Promise.all(Array.from({ length: Math.min(opts.concurrency, Math.max(ids.length, 1)) }, worker));

  if (missing > 0) {
    log(`  WARNING: ${missing} conversation ids from the report did not resolve and were skipped`);
  }
  return { hydrated: done, missing };
}

/** Phase 3: messages, 50 per page. */
async function fetchMessages(client, ckpt, opts) {
  const conversationIndex = new Map();
  const conversationsPath = join(opts.out, 'conversations.jsonl');
  if (existsSync(conversationsPath)) {
    for (const line of readFileSync(conversationsPath, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const c = JSON.parse(line);
        conversationIndex.set(c.source_id, c);
      } catch {
        /* partial final line */
      }
    }
  }

  const ids = loadIds(opts).filter((id) => !ckpt.messaged.has(id));
  const messagesPath = join(opts.out, 'messages.jsonl');
  log(`  ${ids.length} conversations still need messages`);

  let done = 0;
  let messageCount = 0;
  let cursor = 0;

  const worker = async () => {
    while (cursor < ids.length) {
      const id = ids[cursor++];
      const entries = [];
      let page = 1;

      for (;;) {
        const result = await client
          .request(
            `/v2/conversations/${encodeURIComponent(id)}/messages` +
              `?page=${page}&items_per_page=${MESSAGE_PAGE_SIZE}`,
            { tolerate404: true },
          )
          .catch(() => null);
        const batch = result?.messages ?? [];
        entries.push(...batch);
        if (batch.length < MESSAGE_PAGE_SIZE) break;
        page++;
      }

      const conversation = conversationIndex.get(String(id));
      const messages = entries.map((m) => normalizeMessage(m, conversation, opts.bodies));
      writeJsonl(messagesPath, messages);
      messageCount += messages.length;
      ckpt.markMessaged(id);
      done++;
      if (done % 100 === 0) log(`  fetched ${done}/${ids.length} (${messageCount} messages)`);
    }
  };

  await Promise.all(Array.from({ length: Math.min(opts.concurrency, Math.max(ids.length, 1)) }, worker));

  return { conversations: done, messages: messageCount };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  const client = new Client({
    domain: requireEnv('FRESHCHAT_DOMAIN'),
    token: requireEnv('FRESHCHAT_API_TOKEN'),
  });

  mkdirSync(opts.out, { recursive: true });
  const ckpt = new Checkpoint(opts.out);

  if (opts.resume) {
    ckpt.load();
    log(`resuming from ${ckpt.path}`);
  } else {
    if (!opts.start && !opts.idsFile) fail('--start is required (or use --ids-file or --resume)');
    const start = opts.start ? resolveTime(opts.start) : new Date(0);
    const end = opts.end ? resolveTime(opts.end) : new Date();
    if (start >= end) fail('--start must be before --end');
    ckpt.save({ start: start.toISOString(), end: end.toISOString(), discoverDone: false });
  }

  log(`Freshchat export, output ${opts.out}`);
  if (!opts.bodies) log('bodies suppressed (--no-bodies): message metadata only');

  const started = Date.now();
  const summary = { discovered: 0, conversations: 0, messages: 0, unresolved_ids: 0 };

  if (!ckpt.state.discoverDone) {
    log('phase 1: discovering conversation ids via the reports API...');
    summary.discovered = await discoverIds(client, ckpt, opts);
  } else {
    summary.discovered = loadIds(opts).length;
    log(`phase 1: already complete (${summary.discovered} ids)`);
  }

  if (opts.only !== 'messages') {
    log('phase 2: hydrating conversations...');
    const result = await hydrate(client, ckpt, opts);
    summary.conversations = result.hydrated;
    summary.unresolved_ids = result.missing;
  }

  if (opts.only !== 'conversations') {
    log('phase 3: fetching messages...');
    const result = await fetchMessages(client, ckpt, opts);
    summary.messages = result.messages;
  }

  const elapsed = Math.round((Date.now() - started) / 1000);
  log(
    `done in ${elapsed}s using ${client.requestCount} requests ` +
      `(${summary.conversations} conversations, ${summary.messages} messages)`,
  );

  process.stdout.write(
    JSON.stringify(
      {
        ...summary,
        out_dir: opts.out,
        window: { start: ckpt.state.start, end: ckpt.state.end },
        report_id: ckpt.state.reportId,
        requests: client.requestCount,
        elapsed_seconds: elapsed,
        // Completeness is bounded by the report, not by the API.
        complete: summary.discovered > 0 && summary.unresolved_ids === 0,
        bodies_included: opts.bodies,
      },
      null,
      2,
    ) + '\n',
  );
}

if (process.argv[1] && process.argv[1].endsWith('export-conversations.mjs')) {
  await main();
}
