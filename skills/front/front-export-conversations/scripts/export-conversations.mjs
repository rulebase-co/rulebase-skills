#!/usr/bin/env node
/**
 * Exports Front conversations and message bodies to the canonical
 * conversations.jsonl / messages.jsonl shape.
 *
 * Front's defining constraint is not an endpoint quirk, it is the rate limit:
 * it starts at 50 requests/minute, varies by plan, and is enforced
 * PER COMPANY rather than per token. Your export shares that budget with every
 * other Front integration the company runs, and message bodies require one
 * request per conversation. At 50/min an N+1 over 100,000 conversations takes
 * well over a day.
 *
 * So this script:
 *   - paces to a configured sustained rate rather than bursting,
 *   - respects the documented 5 requests/second per-resource burst ceiling,
 *   - projects and reports the run duration before doing the work,
 *   - checkpoints per conversation so a multi-day run survives interruption.
 *
 * Pagination follows `_pagination.next`, which Front returns as a full URL.
 *
 * No npm dependencies. Node 20+.
 *
 * Credentials (environment only):
 *   FRONT_API_TOKEN     API token with read scope
 *
 * Optional:
 *   FRONT_API_BASE       override API origin (a mock server, for tests)
 *   FRONT_RATE_PER_MIN   sustained request budget per minute (default 50)
 */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_BASE = 'https://api2.frontapp.com';
const PAGE_SIZE = 100;
const RATE_PER_MIN = Number(process.env.FRONT_RATE_PER_MIN) || 50;
const MIN_INTERVAL_MS = Math.ceil(60_000 / RATE_PER_MIN);
// Documented burst ceiling: 5 requests/second per resource type.
const BURST_FLOOR_MS = 200;

function parseArgs(argv) {
  const opts = {
    start: null,
    out: './out/front',
    resume: false,
    maxPages: Infinity,
    bodies: true,
    only: 'both',
    yes: false,
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
      case '--max-pages': opts.maxPages = Number(next()); break;
      case '--only': opts.only = next(); break;
      case '--resume': opts.resume = true; break;
      case '--no-bodies': opts.bodies = false; break;
      case '--yes': opts.yes = true; break;
      case '--help': case '-h': usage(); process.exit(0);
      default: fail(`unknown argument: ${arg}`);
    }
  }
  if (!['both', 'conversations', 'messages'].includes(opts.only)) {
    fail('--only must be one of: both, conversations, messages');
  }
  return opts;
}

function usage() {
  process.stderr.write(`
Usage: node scripts/export-conversations.mjs --start <when> [options]

  --start <when>       Watermark on conversation updated_at. ISO date/timestamp,
                       epoch seconds, or a relative window like 30d / 12h.
                       Required unless --resume.
  --out <dir>          Output directory (default ./out/front).
  --resume             Continue from checkpoint.json in --out.
  --only <what>        both (default) | conversations | messages
  --no-bodies          Export message metadata without text.
  --max-pages <n>      Stop after n list pages. Use to sample.
  --yes                Skip the projected-duration confirmation.

Environment: FRONT_API_TOKEN
             FRONT_API_BASE, FRONT_RATE_PER_MIN (optional)

Front's rate limit is per COMPANY, not per token. A long export starves every
other Front integration your company runs. Prefer off-peak.
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
    return Math.floor((Date.now() - Number(n) * ms) / 1000);
  }
  if (/^\d{9,11}$/.test(String(input).trim())) return Number(input);
  const parsed = Date.parse(input);
  if (Number.isNaN(parsed)) {
    fail(`could not parse --start "${input}". Use 2026-01-01, an epoch, or 30d.`);
  }
  return Math.floor(parsed / 1000);
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) fail(`${name} is not set. Export it before running; do not pass tokens as arguments.`);
  return value;
}

const iso = (seconds) =>
  typeof seconds === 'number' && Number.isFinite(seconds)
    ? new Date(seconds * 1000).toISOString()
    : null;

class Client {
  constructor({ token, base }) {
    this.base = base.replace(/\/$/, '');
    this.headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
    this.requestCount = 0;
    this.nextSlot = 0;
  }

  async #pace() {
    const interval = Math.max(MIN_INTERVAL_MS, BURST_FLOOR_MS);
    const now = Date.now();
    const wait = Math.max(0, this.nextSlot - now);
    this.nextSlot = Math.max(now, this.nextSlot) + interval;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }

  async get(pathOrUrl, attempt = 1) {
    await this.#pace();
    this.requestCount++;
    const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${this.base}${pathOrUrl}`;

    let res;
    try {
      res = await fetch(url, { headers: this.headers });
    } catch (err) {
      if (attempt > 5) fail(`network error after 5 attempts: ${err.message}`);
      const backoff = 2 ** attempt * 1000;
      log(`  network error (${err.message}); retrying in ${backoff / 1000}s`);
      await new Promise((r) => setTimeout(r, backoff));
      return this.get(pathOrUrl, attempt + 1);
    }

    if (res.status === 429) {
      const header = Number(res.headers.get('retry-after'));
      const retryAfter = Number.isFinite(header) && header >= 0 ? header : 60;
      log(
        `  429 from Front; waiting ${retryAfter}s. The limit is per-company, so another ` +
          `integration may be consuming it.`,
      );
      await new Promise((r) => setTimeout(r, (retryAfter + 1) * 1000));
      return this.get(pathOrUrl, attempt);
    }

    if (res.status === 401 || res.status === 403) {
      fail(
        `${res.status} from Front. Check FRONT_API_TOKEN and that the token has read scope for the ` +
          `inboxes you need — a token scoped to a subset of inboxes exports a subset silently.`,
      );
    }

    if (res.status >= 500) {
      if (attempt > 5) fail(`Front returned ${res.status} five times; aborting`);
      const backoff = 2 ** attempt * 1000;
      log(`  ${res.status} from Front; retrying in ${backoff / 1000}s`);
      await new Promise((r) => setTimeout(r, backoff));
      return this.get(pathOrUrl, attempt + 1);
    }

    if (!res.ok) {
      fail(`${res.status} ${res.statusText} for ${url}\n${(await res.text()).slice(0, 500)}`);
    }

    return res.json();
  }
}

/** Front status -> canonical status. */
const STATUS_MAP = {
  archived: 'closed',
  unassigned: 'open',
  assigned: 'open',
  deleted: 'deleted',
  spam: 'closed',
};

/** Front conversation/message type -> canonical channel. */
const CHANNEL_MAP = {
  email: 'email',
  tweet: 'social',
  sms: 'messaging',
  smooch: 'messaging',
  whatsapp: 'messaging',
  facebook: 'social',
  intercom: 'chat',
  front_chat: 'chat',
  phone: 'voice',
  call: 'voice',
  voicemail: 'voice',
  custom: 'other',
};

function normalizeConversation(c) {
  const recipientHandle = c.recipient?.handle ?? null;

  return {
    source: 'front',
    source_id: String(c.id),
    subject: c.subject ?? null,
    status: STATUS_MAP[c.status] ?? 'open',
    status_raw: c.status ?? null,
    channel: CHANNEL_MAP[c.type] ?? (c.type ? 'other' : null),
    channel_raw: c.type ?? null,
    // Front identifies contacts by handle (email/phone) when no contact record
    // exists, so fall back to the handle rather than losing the identity.
    customer_id: c.recipient?.contact_id
      ? String(c.recipient.contact_id)
      : recipientHandle
        ? String(recipientHandle)
        : null,
    assignee_id: c.assignee?.id ? String(c.assignee.id) : null,
    team_id: c.inbox?.id ? String(c.inbox.id) : null,
    account_id: null,
    created_at: iso(c.created_at),
    // Front exposes this as waiting_since on some plans; fall back to created.
    updated_at: iso(c.last_message?.created_at ?? c.waiting_since ?? c.created_at),
    resolved_at: c.status === 'archived' ? iso(c.last_message?.created_at ?? c.created_at) : null,
    csat: null,
    csat_raw: null,
    priority: null,
    tags: (c.tags ?? []).map((t) => t?.name).filter(Boolean),
    is_deleted: c.status === 'deleted',
  };
}

/**
 * `is_inbound` is the author signal. Front comments (internal notes) are a
 * separate resource from messages, so a messages-only export contains no
 * internal notes at all — see the skill body.
 */
function normalizeMessage(m, conversationId, includeBodies) {
  const authorId = m.author?.id ? String(m.author.id) : null;

  let authorType = 'unknown';
  if (m.is_inbound === true) authorType = 'customer';
  else if (m.is_inbound === false) authorType = authorId ? 'agent' : 'system';

  return {
    source: 'front',
    conversation_source_id: String(conversationId),
    source_id: String(m.id),
    created_at: iso(m.created_at),
    author_id: authorId,
    author_type: authorType,
    visibility: 'public',
    channel: CHANNEL_MAP[m.type] ?? (m.type ? 'other' : null),
    attachment_count: (m.attachments ?? []).length,
    body: includeBodies ? (m.text ?? stripHtml(m.body)) : null,
  };
}

function stripHtml(html) {
  if (typeof html !== 'string') return null;
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div)>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

class Checkpoint {
  constructor(dir) {
    this.path = join(dir, 'checkpoint.json');
    this.fetchedPath = join(dir, 'fetched-ids.txt');
    this.state = { startTime: null, nextUrl: null, listDone: false };
    this.fetched = new Set();
  }
  load() {
    if (!existsSync(this.path)) fail(`--resume passed but no checkpoint at ${this.path}`);
    this.state = JSON.parse(readFileSync(this.path, 'utf8'));
    if (existsSync(this.fetchedPath)) {
      for (const line of readFileSync(this.fetchedPath, 'utf8').split('\n')) {
        if (line.trim()) this.fetched.add(line.trim());
      }
    }
    return this.state;
  }
  save(patch) {
    Object.assign(this.state, patch, { updatedAt: new Date().toISOString() });
    writeFileSync(this.path, JSON.stringify(this.state, null, 2));
  }
  markFetched(ids) {
    if (ids.length === 0) return;
    appendFileSync(this.fetchedPath, ids.join('\n') + '\n');
    for (const id of ids) this.fetched.add(id);
  }
}

function writeJsonl(path, records) {
  if (records.length === 0) return;
  appendFileSync(path, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

const conversationTime = (c) => c.last_message?.created_at ?? c.waiting_since ?? c.created_at ?? 0;

/**
 * Lists conversations newest-first and stops at the watermark. Front's list
 * endpoint has no time filter, so the early stop is the incremental mechanism.
 */
async function listConversations(client, ckpt, opts) {
  const path = join(opts.out, 'conversations.jsonl');
  const idsPath = join(opts.out, 'conversation-ids.txt');
  const watermark = ckpt.state.startTime;

  let url =
    ckpt.state.nextUrl ??
    `/conversations?limit=${PAGE_SIZE}&sort_by=date&sort_order=desc`;
  let pages = 0;
  let total = 0;
  let skippedOlder = 0;

  while (pages < opts.maxPages) {
    const page = await client.get(url);
    const conversations = page._results ?? [];
    pages++;

    const fresh = [];
    let reachedWatermark = false;
    for (const conversation of conversations) {
      const at = conversationTime(conversation);
      if (Number.isFinite(at) && at < watermark) {
        reachedWatermark = true;
        skippedOlder++;
        continue;
      }
      fresh.push(conversation);
    }

    if (fresh.length > 0) {
      writeJsonl(path, fresh.map(normalizeConversation));
      appendFileSync(idsPath, fresh.map((c) => String(c.id)).join('\n') + '\n');
      total += fresh.length;
    }

    log(
      `  page ${pages}: ${conversations.length} conversations, ${fresh.length} within window (${total} total)`,
    );

    if (reachedWatermark) {
      ckpt.save({ listDone: true, nextUrl: null });
      log(`  reached the watermark (${iso(watermark)}); stopping`);
      break;
    }

    const next = page._pagination?.next ?? null;
    if (!next) {
      ckpt.save({ listDone: true, nextUrl: null });
      log('  reached the end of the conversation list');
      break;
    }

    url = next;
    ckpt.save({ nextUrl: next });
  }

  return { total, skippedOlder };
}

/**
 * N+1 over the messages sub-resource. Deliberately serial: Front's limit is
 * per-company and low, so concurrency here buys nothing and only makes the
 * export more disruptive to the rest of the business.
 */
async function fetchMessages(client, ckpt, opts) {
  const idsPath = join(opts.out, 'conversation-ids.txt');
  if (!existsSync(idsPath)) fail(`no ${idsPath}; run the conversations phase first`);

  const allIds = [
    ...new Set(
      readFileSync(idsPath, 'utf8')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean),
    ),
  ];
  const todo = allIds.filter((id) => !ckpt.fetched.has(id));

  const projectedMinutes = Math.ceil((todo.length / RATE_PER_MIN) * 1.05);
  log(`  ${allIds.length} conversations known, ${todo.length} still need message text`);
  log(
    `  at ${RATE_PER_MIN} requests/min this phase will take roughly ` +
      `${projectedMinutes} minutes (${(projectedMinutes / 60).toFixed(1)} hours)`,
  );
  if (projectedMinutes > 120 && !opts.yes) {
    log(
      `  NOTE: this is a long run against a per-company rate limit. Progress is checkpointed, so ` +
        `it is safe to interrupt and --resume. Pass --yes to silence this notice.`,
    );
  }

  const messagesPath = join(opts.out, 'messages.jsonl');
  let done = 0;
  let messageCount = 0;

  for (const id of todo) {
    const entries = [];
    let url = `/conversations/${encodeURIComponent(id)}/messages?limit=${PAGE_SIZE}`;
    for (;;) {
      const page = await client.get(url);
      entries.push(...(page._results ?? []));
      const next = page._pagination?.next ?? null;
      if (!next) break;
      url = next;
    }

    const messages = entries.map((m) => normalizeMessage(m, id, opts.bodies));
    writeJsonl(messagesPath, messages);
    messageCount += messages.length;
    ckpt.markFetched([id]);
    done++;

    if (done % 50 === 0) {
      log(`  fetched ${done}/${todo.length} conversations (${messageCount} messages)`);
    }
  }

  return { conversations: done, messages: messageCount };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  const client = new Client({
    token: requireEnv('FRONT_API_TOKEN'),
    base: process.env.FRONT_API_BASE || DEFAULT_BASE,
  });

  mkdirSync(opts.out, { recursive: true });
  const ckpt = new Checkpoint(opts.out);

  if (opts.resume) {
    ckpt.load();
    log(`resuming from ${ckpt.path}`);
  } else {
    if (!opts.start) fail('--start is required (or use --resume)');
    ckpt.save({ startTime: resolveStart(opts.start), nextUrl: null, listDone: false });
  }

  log(`Front export of conversations updated since ${iso(ckpt.state.startTime)}`);
  log(`pacing at ${RATE_PER_MIN} requests/min (per-company limit), output ${opts.out}`);
  if (!opts.bodies) log('bodies suppressed (--no-bodies): message metadata only');

  const started = Date.now();
  const summary = { conversations: 0, messages: 0, skipped_older_than_watermark: 0 };

  if (opts.only !== 'messages' && !ckpt.state.listDone) {
    log('phase 1: listing conversations newest-first...');
    const result = await listConversations(client, ckpt, opts);
    summary.conversations = result.total;
    summary.skipped_older_than_watermark = result.skippedOlder;
  } else if (opts.only !== 'messages') {
    log('phase 1: already complete per checkpoint');
  }

  if (opts.only !== 'conversations') {
    log('phase 2: fetching message text...');
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
        watermark: iso(ckpt.state.startTime),
        requests: client.requestCount,
        elapsed_seconds: elapsed,
        list_complete: Boolean(ckpt.state.listDone),
        bodies_included: opts.bodies,
        // Front comments (internal notes) are a separate resource and are not
        // included by this export.
        internal_notes_included: false,
      },
      null,
      2,
    ) + '\n',
  );
}

await main();
