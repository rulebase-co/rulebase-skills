#!/usr/bin/env node
/**
 * Exports Freshdesk tickets and conversation text to the canonical
 * conversations.jsonl / messages.jsonl shape.
 *
 * Freshdesk has a hard wall the other helpdesks don't: GET /api/v2/tickets
 * returns at most 300 pages. At the maximum per_page=100 that is 30,000
 * tickets, after which paging simply stops. There is no error and no cursor.
 * The Filter/Search API is worse: 10 pages of 30, so 300 results total.
 *
 * The way past it is a moving watermark rather than deeper paging:
 *
 *   1. Request updated_since=<watermark>, ordered by updated_at ascending.
 *   2. Page until the results run out or the 300-page ceiling is reached.
 *   3. Set the watermark to the last ticket's updated_at and start again.
 *
 * Ascending order is what makes this work — it guarantees the watermark always
 * advances and that no ticket is skipped. Descending order (Freshdesk's
 * default) makes the ceiling unescapable.
 *
 * Conversation text is not on the ticket object, and Freshdesk has no bulk
 * sideload, so message bodies are an N+1 over
 * GET /api/v2/tickets/{id}/conversations.
 *
 * No npm dependencies. Node 20+.
 *
 * Credentials (environment only):
 *   FRESHDESK_DOMAIN    e.g. "acme" for acme.freshdesk.com
 *   FRESHDESK_API_KEY   API key from Profile settings
 *
 * Optional:
 *   FRESHDESK_API_BASE  override API origin (a mock server, for tests)
 */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// Overridable so the ceiling-rollover path can be exercised in tests, and so a
// change to Freshdesk's documented limits doesn't require a code change.
const PAGE_SIZE = Number(process.env.FRESHDESK_PAGE_SIZE) || 100;
// Freshdesk stops serving results after page 300 on list endpoints.
const MAX_PAGE = Number(process.env.FRESHDESK_MAX_PAGE) || 300;

function parseArgs(argv) {
  const opts = {
    start: null,
    out: './out/freshdesk',
    resume: false,
    maxPages: Infinity,
    concurrency: 4,
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
  if (!Number.isInteger(opts.concurrency) || opts.concurrency < 1 || opts.concurrency > 10) {
    fail('--concurrency must be an integer between 1 and 10');
  }
  return opts;
}

function usage() {
  process.stderr.write(`
Usage: node scripts/export-conversations.mjs --start <when> [options]

  --start <when>       Required unless --resume. ISO date, epoch seconds, or a
                       relative window like 30d / 12h / 4w. Maps to
                       updated_since. Freshdesk returns only the last 30 days
                       without it.
  --out <dir>          Output directory (default ./out/freshdesk).
  --resume             Continue from checkpoint.json in --out.
  --only <what>        both (default) | conversations | messages
  --concurrency <n>    Parallel detail fetches (default 4, max 10).
  --no-bodies          Export message metadata without text.
  --max-pages <n>      Stop after n pages total. Use to sample.

Environment: FRESHDESK_DOMAIN, FRESHDESK_API_KEY
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
  constructor({ domain, apiKey }) {
    this.base = (process.env.FRESHDESK_API_BASE || `https://${domain}.freshdesk.com`).replace(/\/$/, '');
    // Freshdesk uses the API key as the Basic username with any password.
    this.auth = 'Basic ' + Buffer.from(`${apiKey}:X`).toString('base64');
    this.requestCount = 0;
  }

  async get(path, attempt = 1) {
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
      // Freshdesk always sends Retry-After on 429. Trust it: the account budget
      // is per-minute and plan-dependent, so a fixed local rate is guesswork.
      const header = Number(res.headers.get('retry-after'));
      const retryAfter = Number.isFinite(header) && header >= 0 ? header : 60;
      log(`  429 from Freshdesk; Retry-After ${retryAfter}s`);
      await new Promise((r) => setTimeout(r, (retryAfter + 1) * 1000));
      return this.get(path, attempt);
    }

    if (res.status === 401 || res.status === 403) {
      fail(
        `${res.status} from Freshdesk. Check FRESHDESK_API_KEY and FRESHDESK_DOMAIN. The key is ` +
          `the Basic auth username with any password, and the agent must have permission to view ` +
          `all tickets — an agent scoped to their own tickets silently exports a subset.`,
      );
    }

    if (res.status >= 500) {
      if (attempt > 5) fail(`Freshdesk returned ${res.status} five times; aborting`);
      const backoff = 2 ** attempt * 1000;
      log(`  ${res.status} from Freshdesk; retrying in ${backoff / 1000}s`);
      await new Promise((r) => setTimeout(r, backoff));
      return this.get(path, attempt + 1);
    }

    if (!res.ok) {
      fail(`${res.status} ${res.statusText} for ${url}\n${(await res.text()).slice(0, 500)}`);
    }

    return res.json();
  }
}

/** Freshdesk numeric status -> canonical status. */
const STATUS_MAP = { 2: 'open', 3: 'pending', 4: 'resolved', 5: 'closed', 6: 'open', 7: 'pending' };

function normalizeStatus(status) {
  // Freshdesk allows custom statuses above 7; treat unknown numeric codes as
  // open rather than dropping the ticket, and keep the raw value.
  return STATUS_MAP[status] ?? 'open';
}

/** Freshdesk source code -> canonical channel. */
const CHANNEL_MAP = {
  1: 'email',
  2: 'web_form',
  3: 'voice',
  4: 'email',
  5: 'email',
  6: 'email',
  7: 'chat',
  8: 'messaging',
  9: 'messaging',
  10: 'social',
  11: 'messaging',
  12: 'social',
};

const PRIORITY_MAP = { 1: 'low', 2: 'medium', 3: 'high', 4: 'urgent' };

function normalizeTicket(t) {
  return {
    source: 'freshdesk',
    source_id: String(t.id),
    subject: t.subject ?? null,
    status: normalizeStatus(t.status),
    status_raw: t.status ?? null,
    channel: CHANNEL_MAP[t.source] ?? 'other',
    channel_raw: t.source ?? null,
    customer_id: t.requester_id ? String(t.requester_id) : null,
    assignee_id: t.responder_id ? String(t.responder_id) : null,
    team_id: t.group_id ? String(t.group_id) : null,
    account_id: t.company_id ? String(t.company_id) : null,
    created_at: t.created_at ?? null,
    updated_at: t.updated_at ?? null,
    // Only present when the stats sideload is requested.
    resolved_at: t.stats?.resolved_at ?? null,
    // Freshdesk CSAT lives on a separate survey resource and its scale is
    // configurable per account, so it is not inferred here.
    csat: null,
    csat_raw: null,
    priority: PRIORITY_MAP[t.priority] ?? null,
    tags: t.tags ?? [],
    is_deleted: t.deleted === true,
  };
}

/**
 * Conversation entries are notes and replies. `private: true` marks an internal
 * note; `incoming: true` marks a message from the customer.
 */
function normalizeConversationEntry(entry, ticket, includeBodies) {
  const authorId = entry.user_id ? String(entry.user_id) : null;
  const requesterId = ticket?.customer_id ?? null;

  let authorType = 'unknown';
  if (entry.incoming === true) authorType = 'customer';
  else if (authorId && requesterId && authorId === requesterId) authorType = 'customer';
  else if (authorId) authorType = 'agent';

  return {
    source: 'freshdesk',
    conversation_source_id: String(entry.ticket_id),
    source_id: String(entry.id),
    created_at: entry.created_at ?? null,
    author_id: authorId,
    author_type: authorType,
    visibility: entry.private === true ? 'internal' : 'public',
    channel: CHANNEL_MAP[entry.source] ?? null,
    attachment_count: (entry.attachments ?? []).length,
    body: includeBodies ? (entry.body_text ?? stripHtml(entry.body)) : null,
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
    this.state = { watermark: null, page: 1, listDone: false, start: null };
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
 * Walks tickets using a moving updated_since watermark so the 300-page ceiling
 * cannot cap the export.
 */
async function listTickets(client, ckpt, opts) {
  const path = join(opts.out, 'conversations.jsonl');
  const idsPath = join(opts.out, 'conversation-ids.txt');

  let watermark = ckpt.state.watermark ?? ckpt.state.start;
  let page = ckpt.state.page ?? 1;
  let pagesThisRun = 0;
  let total = 0;
  let windows = 0;

  while (pagesThisRun < opts.maxPages) {
    const query =
      `/api/v2/tickets?per_page=${PAGE_SIZE}&page=${page}` +
      `&updated_since=${encodeURIComponent(watermark)}` +
      `&order_by=updated_at&order_type=asc&include=stats`;

    const tickets = await client.get(query);
    if (!Array.isArray(tickets)) {
      fail(`expected an array of tickets, got ${typeof tickets}. Check the domain and API version.`);
    }

    pagesThisRun++;
    if (tickets.length > 0) {
      writeJsonl(path, tickets.map(normalizeTicket));
      appendFileSync(idsPath, tickets.map((t) => String(t.id)).join('\n') + '\n');
      total += tickets.length;
    }

    log(`  page ${page} (window ${windows + 1}): ${tickets.length} tickets (${total} this run)`);

    // Fewer than a full page means this watermark window is exhausted.
    if (tickets.length < PAGE_SIZE) {
      ckpt.save({ listDone: true, watermark, page });
      log('  reached the end of the ticket stream');
      break;
    }

    const lastUpdated = tickets[tickets.length - 1].updated_at;

    if (page >= MAX_PAGE) {
      // Hit the ceiling: roll the watermark forward and restart paging. This is
      // the whole point of ascending order.
      if (!lastUpdated || lastUpdated === watermark) {
        fail(
          `hit the ${MAX_PAGE}-page ceiling but the watermark did not advance (${watermark}). ` +
            `More than ${MAX_PAGE * PAGE_SIZE} tickets share one updated_at second; export this ` +
            `period with a narrower window.`,
        );
      }
      windows++;
      watermark = lastUpdated;
      page = 1;
      log(`  hit the ${MAX_PAGE}-page ceiling; advancing watermark to ${watermark}`);
      ckpt.save({ watermark, page });
      continue;
    }

    page++;
    ckpt.save({ watermark, page });
  }

  return total;
}

/** N+1 over the conversations sub-resource, with a bounded concurrency pool. */
async function fetchMessages(client, ckpt, opts) {
  const idsPath = join(opts.out, 'conversation-ids.txt');
  if (!existsSync(idsPath)) fail(`no ${idsPath}; run the conversations phase first`);

  // Index the exported tickets so author_type can fall back to comparing the
  // message author against the ticket requester.
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
  log(`  ${allIds.length} tickets known, ${todo.length} still need conversation text`);

  const messagesPath = join(opts.out, 'messages.jsonl');
  let done = 0;
  let messageCount = 0;
  let cursor = 0;

  const worker = async () => {
    while (cursor < todo.length) {
      const id = todo[cursor++];
      // The sub-resource paginates too, though 100 replies on one ticket is rare.
      let page = 1;
      const entries = [];
      for (;;) {
        const batch = await client.get(
          `/api/v2/tickets/${encodeURIComponent(id)}/conversations?per_page=${PAGE_SIZE}&page=${page}`,
        );
        if (!Array.isArray(batch)) break;
        entries.push(...batch);
        if (batch.length < PAGE_SIZE || page >= MAX_PAGE) break;
        page++;
      }

      const ticket = ticketIndex.get(String(id));
      const messages = entries.map((e) => normalizeConversationEntry(e, ticket, opts.bodies));
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
    domain: requireEnv('FRESHDESK_DOMAIN'),
    apiKey: requireEnv('FRESHDESK_API_KEY'),
  });

  mkdirSync(opts.out, { recursive: true });
  const ckpt = new Checkpoint(opts.out);

  if (opts.resume) {
    ckpt.load();
    log(`resuming from ${ckpt.path} (watermark ${ckpt.state.watermark}, page ${ckpt.state.page})`);
  } else {
    if (!opts.start) fail('--start is required (or use --resume)');
    ckpt.save({ start: resolveStart(opts.start), watermark: resolveStart(opts.start), page: 1 });
  }

  log(`Freshdesk export of tickets updated since ${ckpt.state.start}`);
  log(`output: ${opts.out}`);
  if (!opts.bodies) log('bodies suppressed (--no-bodies): message metadata only');

  const started = Date.now();
  const summary = { conversations: 0, messages: 0 };

  if (opts.only !== 'messages' && !ckpt.state.listDone) {
    log('phase 1: listing tickets...');
    summary.conversations = await listTickets(client, ckpt, opts);
  } else if (opts.only !== 'messages') {
    log('phase 1: already complete per checkpoint');
  }

  if (opts.only !== 'conversations') {
    log('phase 2: fetching conversation text...');
    const result = await fetchMessages(client, ckpt, opts);
    summary.messages = result.messages;
  }

  const elapsed = Math.round((Date.now() - started) / 1000);
  log(
    `done in ${elapsed}s using ${client.requestCount} requests ` +
      `(${summary.conversations} tickets, ${summary.messages} messages)`,
  );

  process.stdout.write(
    JSON.stringify(
      {
        ...summary,
        out_dir: opts.out,
        start: ckpt.state.start,
        final_watermark: ckpt.state.watermark,
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
