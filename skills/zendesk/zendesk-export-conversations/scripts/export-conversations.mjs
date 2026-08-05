#!/usr/bin/env node
/**
 * Bulk-exports Zendesk tickets and conversation text via the Incremental
 * Exports API, writing newline-delimited JSON.
 *
 * Two independent streams, because Zendesk splits the data:
 *   tickets  -> /api/v2/incremental/tickets/cursor.json   (cursor-paginated)
 *   comments -> /api/v2/incremental/ticket_events.json    (time-paginated,
 *               with ?include=comment_events to sideload comment bodies)
 *
 * Both endpoints are capped at 10 requests/minute, so the run is throttled
 * rather than retried into the ground. Progress is checkpointed after every
 * page: interrupt at any time and re-run with --resume.
 *
 * No npm dependencies. Node 20+.
 *
 * Credentials (environment only — never pass tokens as arguments):
 *   ZENDESK_SUBDOMAIN   e.g. "acme" for acme.zendesk.com
 *   ZENDESK_EMAIL       agent email for the API token
 *   ZENDESK_API_TOKEN   API token (Admin Center > Apps and integrations > APIs)
 *
 * Optional:
 *   ZENDESK_BASE_URL         override the API origin (sandbox or a mock server)
 *   ZENDESK_MIN_INTERVAL_MS  request spacing; lower to 2000 with the High
 *                            Volume API add-on (30 req/min instead of 10)
 */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// Zendesk caps incremental export endpoints at 10 req/min. 6.2s spacing keeps a
// safety margin over a strict 6.0s so clock skew doesn't trip a 429. With the
// High Volume API add-on (30 req/min) 2000 is safe.
const INCREMENTAL_MIN_INTERVAL_MS = Number(process.env.ZENDESK_MIN_INTERVAL_MS) || 6200;

// Zendesk will not return data for the most recent minute (race-condition
// guard), so asking for it wastes a request and can silently miss records.
const REPLICATION_LAG_MS = 90_000;

const PAGE_SIZE = 1000;

function parseArgs(argv) {
  const opts = {
    start: null,
    out: './out/zendesk',
    resume: false,
    maxPages: Infinity,
    bodies: true,
    only: 'both',
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
      case '--help': case '-h': usage(); process.exit(0);
      default: fail(`unknown argument: ${arg}`);
    }
  }
  if (!['both', 'conversations', 'messages'].includes(opts.only)) {
    fail('--only must be one of: both, conversations, messages');
  }
  if (!Number.isFinite(opts.maxPages) && opts.maxPages !== Infinity) {
    fail('--max-pages must be a number');
  }
  return opts;
}

function usage() {
  process.stderr.write(`
Usage: node scripts/export-conversations.mjs --start <when> [options]

  --start <when>     Required unless --resume. ISO date (2026-01-01),
                     ISO timestamp, Unix epoch seconds, or a relative
                     window like 30d / 12h.
  --out <dir>        Output directory (default ./out/zendesk).
  --resume           Continue from checkpoint.json in --out.
  --only <what>      both (default) | conversations | messages
  --no-bodies        Export message metadata without text. Use when you only
                     need volume/structure and want to avoid handling
                     transcript PII.
  --max-pages <n>    Stop after n pages per stream. Use to sample first.

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

/** Accepts ISO dates, epoch seconds, and relative windows like "30d" / "12h". */
function resolveStartTime(input) {
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

class Client {
  constructor({ subdomain, email, token }) {
    this.base = (process.env.ZENDESK_BASE_URL || `https://${subdomain}.zendesk.com`).replace(/\/$/, '');
    this.auth = 'Basic ' + Buffer.from(`${email}/token:${token}`).toString('base64');
    this.lastRequestAt = 0;
    this.requestCount = 0;
  }

  async #throttle() {
    const wait = this.lastRequestAt + INCREMENTAL_MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.lastRequestAt = Date.now();
  }

  /** GETs a URL, honouring Retry-After on 429/503 and retrying transient 5xx. */
  async get(url, attempt = 1) {
    await this.#throttle();
    this.requestCount++;

    let res;
    try {
      res = await fetch(url, {
        headers: { Authorization: this.auth, Accept: 'application/json' },
      });
    } catch (err) {
      if (attempt > 5) fail(`network error after 5 attempts: ${err.message}`);
      const backoff = 2 ** attempt * 1000;
      log(`  network error (${err.message}); retrying in ${backoff / 1000}s`);
      await new Promise((r) => setTimeout(r, backoff));
      return this.get(url, attempt + 1);
    }

    if (res.status === 429 || res.status === 503) {
      // Retry-After: 0 is valid and must not fall through to the default, so
      // test for a finite number rather than relying on truthiness.
      const header = Number(res.headers.get('retry-after'));
      const retryAfter = Number.isFinite(header) && header >= 0 ? header : 60;
      log(`  rate limited (${res.status}); Retry-After ${retryAfter}s`);
      await new Promise((r) => setTimeout(r, (retryAfter + 1) * 1000));
      return this.get(url, attempt);
    }

    if (res.status === 401 || res.status === 403) {
      fail(
        `${res.status} from Zendesk. Check ZENDESK_EMAIL/ZENDESK_API_TOKEN, that token access is ` +
          `enabled in Admin Center > Apps and integrations > APIs, and that the user has ` +
          `permission to export.`,
      );
    }

    if (res.status >= 500) {
      if (attempt > 5) fail(`Zendesk returned ${res.status} five times; aborting`);
      const backoff = 2 ** attempt * 1000;
      log(`  ${res.status} from Zendesk; retrying in ${backoff / 1000}s`);
      await new Promise((r) => setTimeout(r, backoff));
      return this.get(url, attempt + 1);
    }

    if (!res.ok) {
      fail(`${res.status} ${res.statusText} for ${url}\n${(await res.text()).slice(0, 500)}`);
    }

    return res.json();
  }
}

class Checkpoint {
  constructor(dir) {
    this.path = join(dir, 'checkpoint.json');
    this.state = { ticketCursor: null, ticketsDone: false, eventsStartTime: null, eventsDone: false };
  }
  load() {
    if (!existsSync(this.path)) {
      fail(`--resume passed but no checkpoint at ${this.path}`);
    }
    this.state = JSON.parse(readFileSync(this.path, 'utf8'));
    return this.state;
  }
  save(patch) {
    Object.assign(this.state, patch, { updatedAt: new Date().toISOString() });
    writeFileSync(this.path, JSON.stringify(this.state, null, 2));
  }
}

function writeJsonl(path, records) {
  if (records.length === 0) return;
  appendFileSync(path, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

/** Zendesk status -> canonical status. */
const STATUS_MAP = {
  new: 'open',
  open: 'open',
  // `pending` is customer-blocked, `hold` is agent-blocked. Both become
  // `pending`; status_raw keeps the distinction.
  pending: 'pending',
  hold: 'pending',
  solved: 'resolved',
  closed: 'closed',
  deleted: 'deleted',
};

/** Zendesk via.channel -> canonical channel. */
const CHANNEL_MAP = {
  email: 'email',
  web: 'web_form',
  chat: 'chat',
  native_messaging: 'messaging',
  whatsapp: 'messaging',
  sms: 'messaging',
  voice: 'voice',
  phone_call_inbound: 'voice',
  phone_call_outbound: 'voice',
  facebook: 'social',
  twitter: 'social',
  api: 'api',
  rule: 'api',
  system: 'api',
};

/** Ticket -> canonical conversation record. */
function normalizeTicket(t) {
  const rating = t.satisfaction_rating?.score ?? null;

  return {
    source: 'zendesk',
    // Stringified: large integer ids lose precision in JS and in some
    // warehouse loaders, and native types compare unequal across systems.
    source_id: String(t.id),
    subject: t.subject ?? null,
    status: STATUS_MAP[t.status] ?? 'open',
    status_raw: t.status ?? null,
    channel: CHANNEL_MAP[t.via?.channel] ?? (t.via?.channel ? 'other' : null),
    channel_raw: t.via?.channel ?? null,
    customer_id: t.requester_id ? String(t.requester_id) : null,
    assignee_id: t.assignee_id ? String(t.assignee_id) : null,
    team_id: t.group_id ? String(t.group_id) : null,
    account_id: t.organization_id ? String(t.organization_id) : null,
    created_at: t.created_at ?? null,
    updated_at: t.updated_at ?? null,
    resolved_at: t.metric_set?.solved_at ?? null,
    // `offered` / `unoffered` mean a survey was or wasn't sent — they are not
    // scores, so they must not become 0.
    csat: rating === 'good' ? 1 : rating === 'bad' ? 0 : null,
    csat_raw: rating,
    priority: t.priority ?? null,
    tags: t.tags ?? [],
    // Soft-deleted tickets surface here with status "deleted" — keep them so
    // downstream counts reconcile against the Zendesk UI.
    is_deleted: t.status === 'deleted',
  };
}

/**
 * Pulls comment bodies out of a ticket_events page. Comments arrive nested in
 * `child_events`, not as a top-level array, and a single event can carry
 * several child events of which only some are comments.
 */
function extractComments(events, includeBodies, requesterIndex) {
  const out = [];
  for (const event of events) {
    for (const child of event.child_events ?? []) {
      const type = child.event_type ?? child.type;
      if (type !== 'Comment') continue;

      const conversationId = String(event.ticket_id);
      const authorId = (child.author_id ?? event.updater_id) ?? null;

      out.push({
        source: 'zendesk',
        conversation_source_id: conversationId,
        source_id: String(child.id ?? `${event.id}:comment`),
        created_at: new Date(event.timestamp * 1000).toISOString(),
        author_id: authorId === null ? null : String(authorId),
        // Zendesk puts no role flag on a comment, only an author id. Comparing
        // it against the ticket requester is the only reliable signal.
        author_type: resolveAuthorType(authorId, requesterIndex.get(conversationId)),
        visibility: child.public === false ? 'internal' : 'public',
        channel:
          CHANNEL_MAP[child.via?.channel ?? event.via?.channel] ??
          (child.via?.channel ?? event.via?.channel ? 'other' : null),
        attachment_count: (child.attachments ?? []).length,
        // plain_body is preferred: `body` carries quoted email history, which
        // inflates length and token metrics.
        body: includeBodies ? (child.plain_body ?? child.body ?? null) : null,
      });
    }
  }
  return out;
}

function resolveAuthorType(authorId, requesterId) {
  if (authorId === null || requesterId === undefined) return 'unknown';
  return String(authorId) === String(requesterId) ? 'customer' : 'agent';
}

/**
 * Builds conversation_source_id -> customer_id from the tickets already written.
 * The two incremental streams are independent, so author attribution needs this
 * index; without it every message is `unknown`.
 */
function loadRequesterIndex(outDir) {
  const index = new Map();
  const path = join(outDir, 'conversations.jsonl');
  if (!existsSync(path)) return index;

  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const conversation = JSON.parse(line);
      if (conversation.source_id) index.set(conversation.source_id, conversation.customer_id);
    } catch {
      /* a partial final line from an interrupted run */
    }
  }
  return index;
}

async function exportTickets(client, ckpt, opts, startTime) {
  const path = join(opts.out, 'conversations.jsonl');
  let url = ckpt.state.ticketCursor
    ? `${client.base}/api/v2/incremental/tickets/cursor.json?cursor=${encodeURIComponent(ckpt.state.ticketCursor)}`
    : `${client.base}/api/v2/incremental/tickets/cursor.json?start_time=${startTime}&per_page=${PAGE_SIZE}`;

  let pages = 0;
  let total = 0;

  while (pages < opts.maxPages) {
    const page = await client.get(url);
    const tickets = page.tickets ?? [];
    writeJsonl(path, tickets.map(normalizeTicket));
    total += tickets.length;
    pages++;

    log(`  tickets page ${pages}: ${tickets.length} records (${total} total)`);
    ckpt.save({ ticketCursor: page.after_cursor ?? ckpt.state.ticketCursor });

    if (page.end_of_stream) {
      ckpt.save({ ticketsDone: true });
      log(`  tickets: caught up at end_of_stream`);
      break;
    }
    if (!page.after_cursor) {
      log(`  tickets: no after_cursor and end_of_stream false; stopping to avoid a loop`);
      break;
    }
    url = `${client.base}/api/v2/incremental/tickets/cursor.json?cursor=${encodeURIComponent(page.after_cursor)}`;
  }

  return total;
}

async function exportComments(client, ckpt, opts, startTime) {
  const path = join(opts.out, 'messages.jsonl');
  const requesterIndex = loadRequesterIndex(opts.out);
  if (requesterIndex.size === 0) {
    log(
      '  WARNING: no conversations.jsonl to index, so every message author_type will be ' +
        '"unknown". Run the tickets stream first for correct author attribution.',
    );
  }

  let cursorTime = ckpt.state.eventsStartTime ?? startTime;
  let pages = 0;
  let total = 0;

  while (pages < opts.maxPages) {
    const url =
      `${client.base}/api/v2/incremental/ticket_events.json` +
      `?start_time=${cursorTime}&include=comment_events&per_page=${PAGE_SIZE}`;
    const page = await client.get(url);
    const events = page.ticket_events ?? [];
    const comments = extractComments(events, opts.bodies, requesterIndex);
    writeJsonl(path, comments);
    total += comments.length;
    pages++;

    log(
      `  messages page ${pages}: ${events.length} events -> ${comments.length} messages (${total} total)`,
    );

    if (page.end_of_stream) {
      ckpt.save({ eventsDone: true, eventsStartTime: page.end_time ?? cursorTime });
      log(`  comments: caught up at end_of_stream`);
      break;
    }

    const nextTime = page.end_time;
    if (!nextTime) {
      log(`  comments: no end_time returned and end_of_stream false; stopping`);
      break;
    }
    // Time-based export cannot advance past a second that holds more than one
    // page of events. Bail loudly instead of spinning on the same window.
    if (nextTime <= cursorTime) {
      fail(
        `ticket_events end_time did not advance (${nextTime} <= ${cursorTime}). More than ` +
          `${PAGE_SIZE} events share one timestamp. Narrow the window or export this period via ` +
          `a bounded ticket-by-ticket comment fetch.`,
      );
    }
    cursorTime = nextTime;
    ckpt.save({ eventsStartTime: cursorTime });
  }

  return total;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  const client = new Client({
    subdomain: requireEnv('ZENDESK_SUBDOMAIN'),
    email: requireEnv('ZENDESK_EMAIL'),
    token: requireEnv('ZENDESK_API_TOKEN'),
  });

  mkdirSync(opts.out, { recursive: true });
  const ckpt = new Checkpoint(opts.out);

  let startTime;
  if (opts.resume) {
    ckpt.load();
    startTime = ckpt.state.startTime;
    log(`resuming from ${ckpt.path}`);
  } else {
    if (!opts.start) fail('--start is required (or use --resume)');
    startTime = resolveStartTime(opts.start);
    const maxStart = Math.floor((Date.now() - REPLICATION_LAG_MS) / 1000);
    if (startTime > maxStart) {
      log(`note: --start is inside Zendesk's replication lag window; clamping back 90s`);
      startTime = maxStart;
    }
    ckpt.save({ startTime, startedAt: new Date().toISOString() });
  }

  log(`Zendesk export from ${new Date(startTime * 1000).toISOString()}`);
  log(`output: ${opts.out}`);
  if (!opts.bodies) log('bodies suppressed (--no-bodies): message metadata only');

  const started = Date.now();
  const summary = { conversations: 0, messages: 0 };

  if (opts.only !== 'messages' && !ckpt.state.ticketsDone) {
    log('streaming tickets...');
    summary.conversations = await exportTickets(client, ckpt, opts, startTime);
  }
  if (opts.only !== 'conversations' && !ckpt.state.eventsDone) {
    log('streaming comment events...');
    summary.messages = await exportComments(client, ckpt, opts, startTime);
  }

  const elapsed = Math.round((Date.now() - started) / 1000);
  log(
    `done in ${elapsed}s using ${client.requestCount} requests ` +
      `(${summary.conversations} conversations, ${summary.messages} messages)`,
  );

  // Machine-readable summary on stdout so an agent can consume it directly.
  process.stdout.write(
    JSON.stringify(
      {
        ...summary,
        out_dir: opts.out,
        start_time: startTime,
        requests: client.requestCount,
        elapsed_seconds: elapsed,
        conversations_complete: Boolean(ckpt.state.ticketsDone),
        messages_complete: Boolean(ckpt.state.eventsDone),
        bodies_included: opts.bodies,
      },
      null,
      2,
    ) + '\n',
  );
}

await main();
