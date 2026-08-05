#!/usr/bin/env node
/**
 * Exports Intercom conversations and message bodies to the canonical
 * conversations.jsonl / messages.jsonl shape.
 *
 * Intercom splits this into two unavoidable phases:
 *
 *   1. POST /conversations/search   cursor-paginated, 150 per page.
 *      Returns conversations WITHOUT conversation_parts.
 *   2. GET /conversations/{id}      one request per conversation, because
 *      message bodies live only on the single-conversation endpoint.
 *
 * Unlike Zendesk there is no bulk sideload for message bodies, so phase 2 is a
 * genuine N+1. The budget is large (thousands of requests/minute) but it is
 * bucketed into 10-second windows, so the limiter is adaptive: it reads
 * X-RateLimit-Remaining / X-RateLimit-Reset off each response and paces itself
 * rather than assuming a fixed rate.
 *
 * Phase 2 progress is journalled per conversation id, so --resume skips work
 * already done instead of restarting the N+1.
 *
 * No npm dependencies. Node 20+.
 *
 * Credentials (environment only):
 *   INTERCOM_ACCESS_TOKEN   access token for the app
 *
 * Optional:
 *   INTERCOM_API_BASE       override API origin (regional hosts or a mock)
 *   INTERCOM_API_VERSION    pinned API version (default 2.14)
 */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_BASE = 'https://api.intercom.io';
const DEFAULT_VERSION = '2.14';
const PAGE_SIZE = 150;

// Intercom caps a conversation at 500 parts and silently returns the most
// recent 500. Anything at or above this is flagged as truncated.
const MAX_PARTS = 500;

function parseArgs(argv) {
  const opts = {
    start: null,
    out: './out/intercom',
    resume: false,
    maxPages: Infinity,
    concurrency: 6,
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
  if (!Number.isInteger(opts.concurrency) || opts.concurrency < 1 || opts.concurrency > 20) {
    fail('--concurrency must be an integer between 1 and 20');
  }
  return opts;
}

function usage() {
  process.stderr.write(`
Usage: node scripts/export-conversations.mjs --start <when> [options]

  --start <when>       Required unless --resume. ISO date, epoch seconds, or a
                       relative window like 30d / 12h / 4w. Filters on
                       conversation updated_at.
  --out <dir>          Output directory (default ./out/intercom).
  --resume             Continue from checkpoint.json in --out.
  --only <what>        both (default) | conversations | messages
  --concurrency <n>    Parallel detail fetches in phase 2 (default 6, max 20).
  --no-bodies          Export message metadata without text.
  --max-pages <n>      Stop phase 1 after n search pages. Use to sample.

Environment: INTERCOM_ACCESS_TOKEN
             INTERCOM_API_BASE, INTERCOM_API_VERSION (optional)
`);
}

function fail(message) {
  process.stderr.write(`error: ${message}\n`);
  process.exit(1);
}

function log(message) {
  process.stderr.write(`${message}\n`);
}

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

const iso = (seconds) =>
  typeof seconds === 'number' && Number.isFinite(seconds)
    ? new Date(seconds * 1000).toISOString()
    : null;

class Client {
  constructor({ token, base, version }) {
    this.base = base.replace(/\/$/, '');
    this.headers = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'Intercom-Version': version,
    };
    this.requestCount = 0;
    // Adaptive pacing state, refreshed from response headers.
    this.remaining = null;
    this.resetAt = null;
  }

  /**
   * Spaces requests using the live rate-limit headers. Intercom distributes the
   * per-minute allowance across 10-second windows, so a burst that looks fine
   * against the per-minute number can still 429. When the remaining count in
   * the current window runs low, wait for the window to roll over.
   */
  async #pace() {
    if (this.remaining === null || this.resetAt === null) return;
    if (this.remaining > 5) return;

    const wait = this.resetAt - Date.now();
    if (wait > 0) {
      log(`  rate-limit window nearly exhausted; waiting ${Math.ceil(wait / 1000)}s`);
      await new Promise((r) => setTimeout(r, wait + 250));
    }
    this.remaining = null;
  }

  #absorbHeaders(res) {
    const remaining = Number(res.headers.get('x-ratelimit-remaining'));
    if (Number.isFinite(remaining)) this.remaining = remaining;

    const reset = Number(res.headers.get('x-ratelimit-reset'));
    if (Number.isFinite(reset)) {
      // Documented as a Unix timestamp; tolerate a seconds-until-reset value.
      this.resetAt = reset > 1_000_000_000 ? reset * 1000 : Date.now() + reset * 1000;
    }
  }

  async request(path, { method = 'GET', body } = {}, attempt = 1) {
    await this.#pace();
    this.requestCount++;

    const url = path.startsWith('http') ? path : `${this.base}${path}`;
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: this.headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      if (attempt > 5) fail(`network error after 5 attempts: ${err.message}`);
      const backoff = 2 ** attempt * 1000;
      log(`  network error (${err.message}); retrying in ${backoff / 1000}s`);
      await new Promise((r) => setTimeout(r, backoff));
      return this.request(path, { method, body }, attempt + 1);
    }

    this.#absorbHeaders(res);

    if (res.status === 429) {
      const header = Number(res.headers.get('retry-after'));
      const retryAfter = Number.isFinite(header) && header >= 0 ? header : 10;
      log(`  429 from Intercom; waiting ${retryAfter}s`);
      await new Promise((r) => setTimeout(r, (retryAfter + 1) * 1000));
      return this.request(path, { method, body }, attempt);
    }

    if (res.status === 401 || res.status === 403) {
      fail(
        `${res.status} from Intercom. Check INTERCOM_ACCESS_TOKEN and that the app has the ` +
          `"Read conversations" scope. Tokens are workspace-specific.`,
      );
    }

    if (res.status >= 500) {
      if (attempt > 5) fail(`Intercom returned ${res.status} five times; aborting`);
      const backoff = 2 ** attempt * 1000;
      log(`  ${res.status} from Intercom; retrying in ${backoff / 1000}s`);
      await new Promise((r) => setTimeout(r, backoff));
      return this.request(path, { method, body }, attempt + 1);
    }

    if (!res.ok) {
      fail(`${res.status} ${res.statusText} for ${url}\n${(await res.text()).slice(0, 500)}`);
    }

    return res.json();
  }
}

/** Intercom state -> canonical status. */
function normalizeStatus(conversation) {
  if (conversation.state === 'closed') return 'closed';
  if (conversation.state === 'snoozed') return 'snoozed';
  if (conversation.open === false) return 'closed';
  return 'open';
}

/** Intercom source.type / channel -> canonical channel. */
function normalizeChannel(raw) {
  const map = {
    email: 'email',
    conversation: 'messaging',
    chat: 'chat',
    desktop: 'messaging',
    facebook: 'social',
    twitter: 'social',
    instagram: 'social',
    whatsapp: 'messaging',
    sms: 'messaging',
    phone_call: 'voice',
    phone_switch: 'voice',
    push: 'messaging',
    api: 'api',
  };
  return map[raw] ?? (raw ? 'other' : null);
}

/**
 * Intercom author.type -> canonical author_type. `operator` is Intercom's own
 * bot; `bot` covers Fin and custom bots.
 */
function normalizeAuthorType(authorType) {
  switch (authorType) {
    case 'user':
    case 'lead':
    case 'contact':
      return 'customer';
    case 'admin':
    case 'team':
      return 'agent';
    case 'bot':
    case 'operator':
      return 'bot';
    default:
      return 'unknown';
  }
}

function normalizeConversation(c) {
  const contact = c.contacts?.contacts?.[0] ?? null;
  const rating = c.conversation_rating?.rating ?? null;

  return {
    source: 'intercom',
    source_id: String(c.id),
    subject: c.title ?? null,
    status: normalizeStatus(c),
    status_raw: c.state ?? (c.open ? 'open' : 'closed'),
    channel: normalizeChannel(c.source?.delivered_as ?? c.source?.type),
    channel_raw: c.source?.delivered_as ?? c.source?.type ?? null,
    customer_id: contact ? String(contact.id) : null,
    assignee_id: c.admin_assignee_id ? String(c.admin_assignee_id) : null,
    team_id: c.team_assignee_id ? String(c.team_assignee_id) : null,
    account_id: null,
    created_at: iso(c.created_at),
    updated_at: iso(c.updated_at),
    resolved_at: normalizeStatus(c) === 'closed' ? iso(c.updated_at) : null,
    // Intercom ratings are 1-5; normalise to a 0-1 fraction and keep the raw.
    csat: typeof rating === 'number' ? Number(((rating - 1) / 4).toFixed(3)) : null,
    csat_raw: rating,
    priority: c.priority ?? null,
    tags: (c.tags?.tags ?? []).map((t) => t.name).filter(Boolean),
    is_deleted: false,
  };
}

/**
 * Conversation parts include state changes as well as messages. Only comments
 * and notes carry customer-visible or agent-visible text; everything else
 * (assignment, close, open, snooze) is workflow noise.
 */
const MESSAGE_PART_TYPES = new Set(['comment', 'note', 'note_and_reopen']);

function extractMessages(conversation, includeBodies) {
  const messages = [];
  const conversationId = String(conversation.id);
  const customerId = conversation.contacts?.contacts?.[0]?.id
    ? String(conversation.contacts.contacts[0].id)
    : null;

  // The opening message is on source, not in conversation_parts.
  const source = conversation.source;
  if (source && (source.body || !includeBodies)) {
    const authorId = source.author?.id ? String(source.author.id) : null;
    messages.push({
      source: 'intercom',
      conversation_source_id: conversationId,
      source_id: source.id ? String(source.id) : `${conversationId}:source`,
      created_at: iso(conversation.created_at),
      author_id: authorId,
      author_type: resolveAuthorType(source.author?.type, authorId, customerId),
      visibility: 'public',
      channel: normalizeChannel(source.delivered_as ?? source.type),
      attachment_count: (source.attachments ?? []).length,
      body: includeBodies ? stripHtml(source.body) : null,
    });
  }

  for (const part of conversation.conversation_parts?.conversation_parts ?? []) {
    if (!MESSAGE_PART_TYPES.has(part.part_type)) continue;
    // A comment with no body is a state change that reused the comment type.
    if (!part.body && includeBodies) continue;

    const authorId = part.author?.id ? String(part.author.id) : null;
    messages.push({
      source: 'intercom',
      conversation_source_id: conversationId,
      source_id: String(part.id),
      created_at: iso(part.created_at),
      author_id: authorId,
      author_type: resolveAuthorType(part.author?.type, authorId, customerId),
      visibility: part.part_type === 'comment' ? 'public' : 'internal',
      channel: normalizeChannel(conversation.source?.delivered_as ?? conversation.source?.type),
      attachment_count: (part.attachments ?? []).length,
      body: includeBodies ? stripHtml(part.body) : null,
    });
  }

  return messages;
}

/**
 * Role flags are the primary signal, but they are unreliable across Intercom
 * versions and for bot-authored parts. Fall back to comparing the author id to
 * the conversation's contact, which is the one thing that is always consistent.
 */
function resolveAuthorType(rawType, authorId, customerId) {
  const mapped = normalizeAuthorType(rawType);
  if (mapped !== 'unknown') return mapped;
  if (authorId && customerId && authorId === customerId) return 'customer';
  return 'unknown';
}

/** Intercom bodies are HTML. The canonical schema stores plain text. */
function stripHtml(html) {
  if (typeof html !== 'string') return null;
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
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
    this.state = { searchCursor: null, searchDone: false, startTime: null };
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
  /** Append-only so a very large id set never has to be held in the JSON blob. */
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

/** Phase 1: search for conversations updated since startTime. */
async function searchConversations(client, ckpt, opts, startTime) {
  const path = join(opts.out, 'conversations.jsonl');
  const idsPath = join(opts.out, 'conversation-ids.txt');
  let pages = 0;
  let total = 0;

  while (pages < opts.maxPages) {
    const body = {
      query: {
        field: 'updated_at',
        operator: '>',
        value: startTime,
      },
      pagination: { per_page: PAGE_SIZE },
    };
    if (ckpt.state.searchCursor) body.pagination.starting_after = ckpt.state.searchCursor;

    const page = await client.request('/conversations/search', { method: 'POST', body });
    const conversations = page.conversations ?? [];

    writeJsonl(path, conversations.map(normalizeConversation));
    if (conversations.length > 0) {
      appendFileSync(idsPath, conversations.map((c) => String(c.id)).join('\n') + '\n');
    }
    total += conversations.length;
    pages++;

    const cursor = page.pages?.next?.starting_after ?? null;
    log(
      `  search page ${pages}: ${conversations.length} conversations (${total} total` +
        `${page.total_count ? ` of ~${page.total_count}` : ''})`,
    );

    if (!cursor) {
      ckpt.save({ searchDone: true, searchCursor: null });
      log('  search: no further pages');
      break;
    }
    ckpt.save({ searchCursor: cursor });
  }

  return total;
}

/**
 * Phase 2: fetch each conversation's detail for message bodies. This is the
 * N+1 Intercom forces, so it runs a bounded concurrency pool and journals
 * progress per id.
 */
async function fetchMessages(client, ckpt, opts) {
  const idsPath = join(opts.out, 'conversation-ids.txt');
  if (!existsSync(idsPath)) {
    fail(`no ${idsPath}; run the conversations phase first`);
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
  log(`  ${allIds.length} conversations known, ${todo.length} still need message bodies`);

  const messagesPath = join(opts.out, 'messages.jsonl');
  let done = 0;
  let messageCount = 0;
  let truncated = 0;

  // Workers pull from a shared cursor so a slow request doesn't stall a batch.
  let cursor = 0;
  const worker = async () => {
    while (cursor < todo.length) {
      const id = todo[cursor++];
      const conversation = await client.request(`/conversations/${encodeURIComponent(id)}`);
      const messages = extractMessages(conversation, opts.bodies);

      const parts = conversation.conversation_parts;
      if (parts && (parts.total_count > MAX_PARTS || (parts.conversation_parts ?? []).length >= MAX_PARTS)) {
        truncated++;
      }

      writeJsonl(messagesPath, messages);
      messageCount += messages.length;
      ckpt.markFetched([id]);
      done++;

      if (done % 100 === 0) {
        log(`  fetched ${done}/${todo.length} conversations (${messageCount} messages)`);
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(opts.concurrency, Math.max(todo.length, 1)) }, worker),
  );

  if (truncated > 0) {
    log(
      `  WARNING: ${truncated} conversations hit Intercom's ${MAX_PARTS}-part cap. Only the most ` +
        `recent ${MAX_PARTS} parts were returned; earlier messages are not retrievable via this API.`,
    );
  }

  return { conversations: done, messages: messageCount, truncated };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  const client = new Client({
    token: requireEnv('INTERCOM_ACCESS_TOKEN'),
    base: process.env.INTERCOM_API_BASE || DEFAULT_BASE,
    version: process.env.INTERCOM_API_VERSION || DEFAULT_VERSION,
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
    ckpt.save({ startTime, startedAt: new Date().toISOString() });
  }

  log(`Intercom export of conversations updated since ${new Date(startTime * 1000).toISOString()}`);
  log(`API version ${client.headers['Intercom-Version']}, output ${opts.out}`);
  if (!opts.bodies) log('bodies suppressed (--no-bodies): message metadata only');

  const started = Date.now();
  const summary = { conversations: 0, messages: 0, truncated_conversations: 0 };

  if (opts.only !== 'messages' && !ckpt.state.searchDone) {
    log('phase 1: searching conversations...');
    summary.conversations = await searchConversations(client, ckpt, opts, startTime);
  } else if (opts.only !== 'messages') {
    log('phase 1: already complete per checkpoint');
  }

  if (opts.only !== 'conversations') {
    log('phase 2: fetching message bodies...');
    const result = await fetchMessages(client, ckpt, opts);
    summary.messages = result.messages;
    summary.truncated_conversations = result.truncated;
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
        start_time: startTime,
        api_version: client.headers['Intercom-Version'],
        requests: client.requestCount,
        elapsed_seconds: elapsed,
        search_complete: Boolean(ckpt.state.searchDone),
        messages_complete: opts.only !== 'conversations',
        bodies_included: opts.bodies,
      },
      null,
      2,
    ) + '\n',
  );
}

await main();
