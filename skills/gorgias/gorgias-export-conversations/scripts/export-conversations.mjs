#!/usr/bin/env node
/**
 * Exports Gorgias tickets and message bodies to the canonical
 * conversations.jsonl / messages.jsonl shape.
 *
 * Two Gorgias-specific problems shape this script.
 *
 * 1. There is no `updated_since` filter. `GET /api/tickets` accepts `order_by`
 *    but no time filter at all, so incremental sync cannot be expressed as a
 *    query. Instead: order by `updated_datetime:desc` and stop as soon as a page
 *    contains a ticket older than the watermark. Newest-first plus an early stop
 *    is the only correct incremental strategy available.
 *
 * 2. List tickets returns no message bodies — only an `excerpt` of the last
 *    message. Message text is an N+1 over /api/tickets/{id}/messages.
 *
 * Rate limiting is a leaky bucket (API keys: 40 requests per 20s), so the
 * limiter paces to a sustained rate and honours Retry-After.
 *
 * No npm dependencies. Node 20+.
 *
 * Credentials (environment only):
 *   GORGIAS_DOMAIN     e.g. "acme" for acme.gorgias.com
 *   GORGIAS_EMAIL      the account the API key belongs to
 *   GORGIAS_API_KEY
 *
 * Optional:
 *   GORGIAS_API_BASE       override API origin (a mock server, for tests)
 *   GORGIAS_RATE_PER_20S   sustained request budget per 20s (default 40;
 *                          OAuth2 apps get 80)
 */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const PAGE_SIZE = 100;
const RATE_PER_20S = Number(process.env.GORGIAS_RATE_PER_20S) || 40;
const MIN_INTERVAL_MS = Math.ceil(20_000 / RATE_PER_20S);

function parseArgs(argv) {
  const opts = {
    start: null,
    out: './out/gorgias',
    resume: false,
    maxPages: Infinity,
    concurrency: 3,
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
      case '--concurrency': opts.concurrency = Number(next()); break;
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
Usage: node scripts/export-conversations.mjs --start <when> [options]

  --start <when>       Watermark. ISO date/timestamp, epoch seconds, or a
                       relative window like 30d / 12h. Tickets updated before
                       this are not exported. Required unless --resume.
                       Pass a very old date for a full history export.
  --out <dir>          Output directory (default ./out/gorgias).
  --resume             Continue from checkpoint.json in --out.
  --only <what>        both (default) | conversations | messages
  --concurrency <n>    Parallel message fetches (default 3, max 8).
  --no-bodies          Export message metadata without text.
  --max-pages <n>      Stop after n list pages. Use to sample.

Environment: GORGIAS_DOMAIN, GORGIAS_EMAIL, GORGIAS_API_KEY
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
  if (!value) fail(`${name} is not set. Export it before running; do not pass keys as arguments.`);
  return value;
}

class Client {
  constructor({ domain, email, apiKey }) {
    this.base = (process.env.GORGIAS_API_BASE || `https://${domain}.gorgias.com`).replace(/\/$/, '');
    this.auth = 'Basic ' + Buffer.from(`${email}:${apiKey}`).toString('base64');
    this.requestCount = 0;
    this.nextSlot = 0;
  }

  /** Paces to the sustained leaky-bucket rate rather than bursting into a 429. */
  async #pace() {
    const now = Date.now();
    const wait = Math.max(0, this.nextSlot - now);
    this.nextSlot = Math.max(now, this.nextSlot) + MIN_INTERVAL_MS;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }

  async get(path, attempt = 1) {
    await this.#pace();
    this.requestCount++;
    const url = path.startsWith('http') ? path : `${this.base}${path}`;

    let res;
    try {
      res = await fetch(url, { headers: { Authorization: this.auth, Accept: 'application/json' } });
    } catch (err) {
      if (attempt > 5) fail(`network error after 5 attempts: ${err.message}`);
      const backoff = 2 ** attempt * 1000;
      log(`  network error (${err.message}); retrying in ${backoff / 1000}s`);
      await new Promise((r) => setTimeout(r, backoff));
      return this.get(path, attempt + 1);
    }

    if (res.status === 429) {
      const header = Number(res.headers.get('retry-after'));
      const retryAfter = Number.isFinite(header) && header >= 0 ? header : 20;
      log(`  429 from Gorgias; waiting ${retryAfter}s`);
      await new Promise((r) => setTimeout(r, (retryAfter + 1) * 1000));
      return this.get(path, attempt);
    }

    if (res.status === 401 || res.status === 403) {
      fail(
        `${res.status} from Gorgias. Check GORGIAS_EMAIL and GORGIAS_API_KEY — auth is Basic with ` +
          `the account email as username and the API key as password, not the key alone.`,
      );
    }

    if (res.status >= 500) {
      if (attempt > 5) fail(`Gorgias returned ${res.status} five times; aborting`);
      const backoff = 2 ** attempt * 1000;
      log(`  ${res.status} from Gorgias; retrying in ${backoff / 1000}s`);
      await new Promise((r) => setTimeout(r, backoff));
      return this.get(path, attempt + 1);
    }

    if (!res.ok) {
      fail(`${res.status} ${res.statusText} for ${url}\n${(await res.text()).slice(0, 500)}`);
    }

    return res.json();
  }
}

/** Gorgias status -> canonical status. */
const STATUS_MAP = { open: 'open', closed: 'closed' };

/** Gorgias channel/via -> canonical channel. */
const CHANNEL_MAP = {
  email: 'email',
  chat: 'chat',
  'api-chat': 'chat',
  sms: 'messaging',
  whatsapp: 'messaging',
  facebook: 'social',
  'facebook-messenger': 'messaging',
  instagram: 'social',
  twitter: 'social',
  phone: 'voice',
  voice: 'voice',
  contact_form: 'web_form',
  'help-center': 'web_form',
  api: 'api',
};

const iso = (value) => {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
};

function normalizeTicket(t) {
  const customer = t.customer ?? t.requester ?? null;

  return {
    source: 'gorgias',
    source_id: String(t.id),
    subject: t.subject ?? null,
    status: STATUS_MAP[t.status] ?? 'open',
    status_raw: t.status ?? null,
    channel: CHANNEL_MAP[t.channel] ?? (t.channel ? 'other' : null),
    channel_raw: t.channel ?? null,
    customer_id: customer?.id ? String(customer.id) : null,
    assignee_id: t.assignee_user?.id ? String(t.assignee_user.id) : null,
    team_id: t.assignee_team?.id ? String(t.assignee_team.id) : null,
    account_id: null,
    created_at: iso(t.created_datetime),
    updated_at: iso(t.updated_datetime),
    resolved_at: iso(t.closed_datetime),
    // Gorgias satisfaction surveys are a separate resource with an
    // account-configurable scale, so no mapping is guessed here.
    csat: null,
    csat_raw: null,
    priority: t.priority ?? null,
    tags: (t.tags ?? []).map((tag) => tag?.name ?? tag).filter((v) => typeof v === 'string'),
    is_deleted: t.trashed_datetime != null,
  };
}

/**
 * `from_agent` is the primary author signal. Gorgias also exposes a `sender`
 * object whose id can be compared against the ticket customer as a fallback,
 * because from_agent is absent on some integration-authored messages.
 */
function normalizeMessage(m, ticket, includeBodies) {
  const senderId = m.sender?.id ? String(m.sender.id) : null;
  const customerId = ticket?.customer_id ?? null;

  let authorType = 'unknown';
  if (m.from_agent === true) authorType = 'agent';
  else if (m.from_agent === false) authorType = 'customer';
  else if (senderId && customerId) authorType = senderId === customerId ? 'customer' : 'agent';

  return {
    source: 'gorgias',
    conversation_source_id: String(m.ticket_id),
    source_id: String(m.id),
    created_at: iso(m.created_datetime ?? m.sent_datetime),
    author_id: senderId,
    author_type: authorType,
    // Gorgias internal notes are messages with public: false.
    visibility: m.public === false ? 'internal' : 'public',
    channel: CHANNEL_MAP[m.channel] ?? (m.channel ? 'other' : null),
    attachment_count: (m.attachments ?? []).length,
    body: includeBodies ? (m.body_text ?? stripHtml(m.body_html)) : null,
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
    this.state = { start: null, cursor: null, listDone: false };
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

/**
 * Walks tickets newest-first and stops at the watermark. Gorgias has no time
 * filter, so the early stop is the incremental mechanism.
 */
async function listTickets(client, ckpt, opts) {
  const path = join(opts.out, 'conversations.jsonl');
  const idsPath = join(opts.out, 'conversation-ids.txt');
  const watermark = Date.parse(ckpt.state.start);

  let cursor = ckpt.state.cursor;
  let pages = 0;
  let total = 0;
  let skippedOlder = 0;

  while (pages < opts.maxPages) {
    const query =
      `/api/tickets?limit=${PAGE_SIZE}&order_by=updated_datetime%3Adesc` +
      (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');

    const page = await client.get(query);
    const tickets = page.data ?? [];
    pages++;

    // Newest-first means the first ticket older than the watermark ends the walk.
    const fresh = [];
    let reachedWatermark = false;
    for (const ticket of tickets) {
      const updated = Date.parse(ticket.updated_datetime ?? '');
      if (Number.isFinite(updated) && updated < watermark) {
        reachedWatermark = true;
        skippedOlder++;
        continue;
      }
      fresh.push(ticket);
    }

    if (fresh.length > 0) {
      writeJsonl(path, fresh.map(normalizeTicket));
      appendFileSync(idsPath, fresh.map((t) => String(t.id)).join('\n') + '\n');
      total += fresh.length;
    }

    log(`  page ${pages}: ${tickets.length} tickets, ${fresh.length} within window (${total} total)`);

    if (reachedWatermark) {
      ckpt.save({ listDone: true, cursor: null });
      log(`  reached the watermark (${ckpt.state.start}); stopping`);
      break;
    }

    const nextCursor = page.meta?.next_cursor ?? null;
    if (!nextCursor) {
      ckpt.save({ listDone: true, cursor: null });
      log('  reached the end of the ticket list');
      break;
    }

    cursor = nextCursor;
    ckpt.save({ cursor });
  }

  return { total, skippedOlder };
}

/** N+1 over the messages sub-resource, with a bounded concurrency pool. */
async function fetchMessages(client, ckpt, opts) {
  const idsPath = join(opts.out, 'conversation-ids.txt');
  if (!existsSync(idsPath)) fail(`no ${idsPath}; run the conversations phase first`);

  const ticketIndex = new Map();
  const conversationsPath = join(opts.out, 'conversations.jsonl');
  if (existsSync(conversationsPath)) {
    for (const line of readFileSync(conversationsPath, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const t = JSON.parse(line);
        ticketIndex.set(t.source_id, t);
      } catch {
        /* a partial final line from an interrupted run */
      }
    }
  }

  const allIds = [
    ...new Set(
      readFileSync(idsPath, 'utf8')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean),
    ),
  ];
  const todo = allIds.filter((id) => !ckpt.fetched.has(id));
  log(`  ${allIds.length} tickets known, ${todo.length} still need message text`);

  const messagesPath = join(opts.out, 'messages.jsonl');
  let done = 0;
  let messageCount = 0;
  let cursor = 0;

  const worker = async () => {
    while (cursor < todo.length) {
      const id = todo[cursor++];
      const entries = [];
      let pageCursor = null;

      for (;;) {
        const page = await client.get(
          `/api/tickets/${encodeURIComponent(id)}/messages?limit=${PAGE_SIZE}` +
            (pageCursor ? `&cursor=${encodeURIComponent(pageCursor)}` : ''),
        );
        entries.push(...(page.data ?? []));
        pageCursor = page.meta?.next_cursor ?? null;
        if (!pageCursor) break;
      }

      const ticket = ticketIndex.get(String(id));
      const messages = entries.map((m) => normalizeMessage(m, ticket, opts.bodies));
      writeJsonl(messagesPath, messages);
      messageCount += messages.length;
      ckpt.markFetched([id]);
      done++;

      if (done % 100 === 0) log(`  fetched ${done}/${todo.length} tickets (${messageCount} messages)`);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(opts.concurrency, Math.max(todo.length, 1)) }, worker),
  );

  return { conversations: done, messages: messageCount };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  const client = new Client({
    domain: requireEnv('GORGIAS_DOMAIN'),
    email: requireEnv('GORGIAS_EMAIL'),
    apiKey: requireEnv('GORGIAS_API_KEY'),
  });

  mkdirSync(opts.out, { recursive: true });
  const ckpt = new Checkpoint(opts.out);

  if (opts.resume) {
    ckpt.load();
    log(`resuming from ${ckpt.path}`);
  } else {
    if (!opts.start) fail('--start is required (or use --resume)');
    ckpt.save({ start: resolveStart(opts.start), cursor: null, listDone: false });
  }

  log(`Gorgias export of tickets updated since ${ckpt.state.start}`);
  log(`pacing at ${RATE_PER_20S} requests/20s, output ${opts.out}`);
  if (!opts.bodies) log('bodies suppressed (--no-bodies): message metadata only');

  const started = Date.now();
  const summary = { conversations: 0, messages: 0, skipped_older_than_watermark: 0 };

  if (opts.only !== 'messages' && !ckpt.state.listDone) {
    log('phase 1: listing tickets newest-first...');
    const result = await listTickets(client, ckpt, opts);
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
        watermark: ckpt.state.start,
        requests: client.requestCount,
        elapsed_seconds: elapsed,
        list_complete: Boolean(ckpt.state.listDone),
        bodies_included: opts.bodies,
      },
      null,
      2,
    ) + '\n',
  );
}

await main();
