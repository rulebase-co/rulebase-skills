#!/usr/bin/env node
/**
 * Exports HubSpot Service Hub conversation threads and messages to the
 * canonical conversations.jsonl / messages.jsonl shape.
 *
 * Three HubSpot-specific hazards drive this script.
 *
 * 1. Email message bodies are SILENTLY TRUNCATED. Each message carries a
 *    `truncationStatus` of NOT_TRUNCATED, TRUNCATED_TO_MOST_RECENT_REPLY, or
 *    TRUNCATED. A truncated body looks like a complete short message. The script
 *    records the status on every message and reports the totals, so a corpus
 *    built from this export is never quietly incomplete.
 *
 * 2. Archived threads are excluded by default and PERMANENTLY DELETED after 30
 *    days. `--archived` fetches them, but anything older than 30 days is gone.
 *
 * 3. The thread list filters on a single inbox only — multiple inboxId values
 *    are not supported. Omit it to cover all inboxes.
 *
 * Rate limits vary by subscription tier, so rather than assuming a number the
 * limiter reads the X-HubSpot-RateLimit-* response headers and paces itself.
 *
 * No npm dependencies. Node 20+.
 *
 * Credentials (environment only):
 *   HUBSPOT_ACCESS_TOKEN   private app token with the conversations.read scope
 *
 * Optional:
 *   HUBSPOT_API_BASE       override API origin (a mock server, for tests)
 *   HUBSPOT_RATE_PER_SEC   fallback sustained rate when no headers are present
 */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_BASE = 'https://api.hubapi.com';
const PAGE_SIZE = 500;
const FALLBACK_RATE_PER_SEC = Number(process.env.HUBSPOT_RATE_PER_SEC) || 8;

const TRUNCATION_STATUSES = new Set([
  'NOT_TRUNCATED',
  'TRUNCATED_TO_MOST_RECENT_REPLY',
  'TRUNCATED',
]);

function parseArgs(argv) {
  const opts = {
    start: null,
    out: './out/hubspot',
    resume: false,
    maxPages: Infinity,
    concurrency: 4,
    bodies: true,
    only: 'both',
    archived: false,
    inboxId: null,
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
      case '--inbox-id': opts.inboxId = next(); break;
      case '--resume': opts.resume = true; break;
      case '--archived': opts.archived = true; break;
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

  --start <when>       Watermark on thread latestMessageTimestamp. ISO
                       date/timestamp, epoch seconds, or a relative window like
                       30d / 12h. Required unless --resume.
  --out <dir>          Output directory (default ./out/hubspot).
  --resume             Continue from checkpoint.json in --out.
  --only <what>        both (default) | conversations | messages
  --archived           Include archived (soft-deleted) threads. HubSpot removes
                       these permanently after 30 days.
  --inbox-id <id>      Restrict to one inbox. HubSpot supports only a single
                       inbox filter; omit for all inboxes.
  --concurrency <n>    Parallel message fetches (default 4, max 10).
  --no-bodies          Export message metadata without text.
  --max-pages <n>      Stop after n list pages. Use to sample.

Environment: HUBSPOT_ACCESS_TOKEN
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
    return Date.now() - Number(n) * ms;
  }
  if (/^\d{9,11}$/.test(String(input).trim())) return Number(input) * 1000;
  const parsed = Date.parse(input);
  if (Number.isNaN(parsed)) {
    fail(`could not parse --start "${input}". Use 2026-01-01, an epoch, or 30d.`);
  }
  return parsed;
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) fail(`${name} is not set. Export it before running; do not pass tokens as arguments.`);
  return value;
}

const iso = (value) => {
  if (value === null || value === undefined) return null;
  const ms = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
};

class Client {
  constructor({ token, base }) {
    this.base = base.replace(/\/$/, '');
    this.headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
    this.requestCount = 0;
    this.nextSlot = 0;
    this.intervalMs = Math.ceil(1000 / FALLBACK_RATE_PER_SEC);
    this.dailyRemaining = null;
  }

  /**
   * Paces using the interval and max HubSpot reports for this token, falling
   * back to a conservative fixed rate. Subscription tiers differ enough that a
   * hardcoded number is either wrong or wasteful.
   */
  #absorbHeaders(res) {
    const max = Number(res.headers.get('x-hubspot-ratelimit-max'));
    const interval = Number(res.headers.get('x-hubspot-ratelimit-interval-milliseconds'));
    if (Number.isFinite(max) && max > 0 && Number.isFinite(interval) && interval > 0) {
      // Use 80% of the advertised rate so other integrations keep headroom.
      this.intervalMs = Math.ceil(interval / (max * 0.8));
    }
    const daily = Number(res.headers.get('x-hubspot-ratelimit-daily-remaining'));
    if (Number.isFinite(daily)) this.dailyRemaining = daily;
  }

  async #pace() {
    const now = Date.now();
    const wait = Math.max(0, this.nextSlot - now);
    this.nextSlot = Math.max(now, this.nextSlot) + this.intervalMs;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }

  async get(path, attempt = 1) {
    await this.#pace();
    this.requestCount++;
    const url = path.startsWith('http') ? path : `${this.base}${path}`;

    let res;
    try {
      res = await fetch(url, { headers: this.headers });
    } catch (err) {
      if (attempt > 5) fail(`network error after 5 attempts: ${err.message}`);
      const backoff = 2 ** attempt * 1000;
      log(`  network error (${err.message}); retrying in ${backoff / 1000}s`);
      await new Promise((r) => setTimeout(r, backoff));
      return this.get(path, attempt + 1);
    }

    this.#absorbHeaders(res);

    if (res.status === 429) {
      const header = Number(res.headers.get('retry-after'));
      const retryAfter = Number.isFinite(header) && header >= 0 ? header : 10;
      log(`  429 from HubSpot; waiting ${retryAfter}s`);
      await new Promise((r) => setTimeout(r, (retryAfter + 1) * 1000));
      return this.get(path, attempt);
    }

    if (res.status === 401 || res.status === 403) {
      fail(
        `${res.status} from HubSpot. Check HUBSPOT_ACCESS_TOKEN and that the private app has the ` +
          `conversations.read scope. Scope changes require the app to be reinstalled.`,
      );
    }

    if (res.status >= 500) {
      if (attempt > 5) fail(`HubSpot returned ${res.status} five times; aborting`);
      const backoff = 2 ** attempt * 1000;
      log(`  ${res.status} from HubSpot; retrying in ${backoff / 1000}s`);
      await new Promise((r) => setTimeout(r, backoff));
      return this.get(path, attempt + 1);
    }

    if (!res.ok) {
      fail(`${res.status} ${res.statusText} for ${url}\n${(await res.text()).slice(0, 500)}`);
    }

    return res.json();
  }
}

/** HubSpot thread status -> canonical status. */
const STATUS_MAP = { OPEN: 'open', CLOSED: 'closed' };

/** HubSpot channel type -> canonical channel. */
const CHANNEL_MAP = {
  EMAIL: 'email',
  LIVE_CHAT: 'chat',
  FB_MESSENGER: 'messaging',
  WHATS_APP: 'messaging',
  SMS: 'messaging',
  CALL: 'voice',
  FORMS: 'web_form',
  CUSTOM_CHANNEL: 'other',
};

function normalizeThread(t, archived) {
  return {
    source: 'hubspot',
    source_id: String(t.id),
    // Threads have no subject. `latestMessagePreview` is a body excerpt, not a
    // subject, so using it here would silently mislabel the field.
    subject: null,
    status: archived ? 'closed' : (STATUS_MAP[t.status] ?? 'open'),
    status_raw: t.status ?? null,
    // Channel lives on the messages, not the thread. Left null by design rather
    // than guessed — derive it per conversation from messages.jsonl if needed.
    channel: null,
    channel_raw: null,
    // Thread objects carry no contact id. Associated contacts come from the
    // CRM associations API, which this export does not call.
    customer_id: null,
    assignee_id: t.assignedTo ? String(t.assignedTo) : null,
    team_id: t.inboxId ? String(t.inboxId) : null,
    account_id: null,
    created_at: iso(t.createdAt),
    updated_at: iso(t.latestMessageTimestamp ?? t.createdAt),
    resolved_at: t.status === 'CLOSED' ? iso(t.latestMessageTimestamp) : null,
    csat: null,
    csat_raw: null,
    priority: null,
    tags: [],
    is_deleted: Boolean(t.archived) || archived,
  };
}

/**
 * HubSpot message senders carry an actorId prefixed by type: `V-` visitor,
 * `A-` agent, `I-` integration, `S-` system. That prefix is the author signal.
 */
function actorType(actorId) {
  if (typeof actorId !== 'string') return 'unknown';
  if (actorId.startsWith('V-')) return 'customer';
  if (actorId.startsWith('A-')) return 'agent';
  if (actorId.startsWith('I-')) return 'bot';
  if (actorId.startsWith('S-')) return 'system';
  return 'unknown';
}

function normalizeMessage(m, threadId, includeBodies) {
  const sender = (m.senders ?? [])[0] ?? null;
  const actorId = sender?.actorId ?? m.createdBy ?? null;

  const truncation = TRUNCATION_STATUSES.has(m.truncationStatus)
    ? m.truncationStatus
    : m.truncationStatus
      ? 'UNKNOWN'
      : null;

  return {
    source: 'hubspot',
    conversation_source_id: String(threadId),
    source_id: String(m.id),
    created_at: iso(m.createdAt),
    author_id: actorId ? String(actorId) : null,
    author_type: actorType(actorId),
    // COMMENT type is an internal note; MESSAGE is customer-visible.
    visibility: m.type === 'COMMENT' ? 'internal' : 'public',
    channel: CHANNEL_MAP[m.channelId ?? m.channel] ?? null,
    attachment_count: (m.attachments ?? []).length,
    body: includeBodies ? (m.text ?? stripHtml(m.richText)) : null,
    // Non-canonical but essential: a truncated body is not the whole message.
    truncation_status: truncation,
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
    this.state = { startTime: null, after: null, listDone: false, archived: false };
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

async function listThreads(client, ckpt, opts) {
  const path = join(opts.out, 'conversations.jsonl');
  const idsPath = join(opts.out, 'conversation-ids.txt');
  const watermark = ckpt.state.startTime;

  let after = ckpt.state.after;
  let pages = 0;
  let total = 0;
  let skippedOlder = 0;

  while (pages < opts.maxPages) {
    const params = new URLSearchParams({ limit: String(PAGE_SIZE), sort: '-latestMessageTimestamp' });
    if (after) params.set('after', after);
    if (opts.archived) params.set('archived', 'true');
    if (opts.inboxId) params.set('inboxId', opts.inboxId);

    const page = await client.get(`/conversations/v3/conversations/threads?${params}`);
    const threads = page.results ?? [];
    pages++;

    const fresh = [];
    let reachedWatermark = false;
    for (const thread of threads) {
      const at = Date.parse(thread.latestMessageTimestamp ?? thread.createdAt ?? '');
      if (Number.isFinite(at) && at < watermark) {
        reachedWatermark = true;
        skippedOlder++;
        continue;
      }
      fresh.push(thread);
    }

    if (fresh.length > 0) {
      writeJsonl(path, fresh.map((t) => normalizeThread(t, opts.archived)));
      appendFileSync(idsPath, fresh.map((t) => String(t.id)).join('\n') + '\n');
      total += fresh.length;
    }

    log(`  page ${pages}: ${threads.length} threads, ${fresh.length} within window (${total} total)`);

    if (reachedWatermark) {
      ckpt.save({ listDone: true, after: null });
      log(`  reached the watermark (${iso(watermark)}); stopping`);
      break;
    }

    const nextAfter = page.paging?.next?.after ?? null;
    if (!nextAfter) {
      ckpt.save({ listDone: true, after: null });
      log('  reached the end of the thread list');
      break;
    }

    after = nextAfter;
    ckpt.save({ after });
  }

  return { total, skippedOlder };
}

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
  log(`  ${allIds.length} threads known, ${todo.length} still need message text`);

  const messagesPath = join(opts.out, 'messages.jsonl');
  let done = 0;
  let messageCount = 0;
  let cursor = 0;
  const truncation = { NOT_TRUNCATED: 0, TRUNCATED_TO_MOST_RECENT_REPLY: 0, TRUNCATED: 0, UNKNOWN: 0 };

  const worker = async () => {
    while (cursor < todo.length) {
      const id = todo[cursor++];
      const entries = [];
      let after = null;

      for (;;) {
        const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
        if (after) params.set('after', after);
        const page = await client.get(
          `/conversations/v3/conversations/threads/${encodeURIComponent(id)}/messages?${params}`,
        );
        entries.push(...(page.results ?? []));
        after = page.paging?.next?.after ?? null;
        if (!after) break;
      }

      const messages = entries.map((m) => normalizeMessage(m, id, opts.bodies));
      for (const m of messages) {
        if (m.truncation_status && truncation[m.truncation_status] !== undefined) {
          truncation[m.truncation_status]++;
        }
      }

      writeJsonl(messagesPath, messages);
      messageCount += messages.length;
      ckpt.markFetched([id]);
      done++;

      if (done % 100 === 0) log(`  fetched ${done}/${todo.length} threads (${messageCount} messages)`);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(opts.concurrency, Math.max(todo.length, 1)) }, worker),
  );

  const truncated = truncation.TRUNCATED + truncation.TRUNCATED_TO_MOST_RECENT_REPLY;
  if (truncated > 0) {
    log(
      `  WARNING: ${truncated} of ${messageCount} message bodies are truncated ` +
        `(${truncation.TRUNCATED} TRUNCATED, ${truncation.TRUNCATED_TO_MOST_RECENT_REPLY} ` +
        `TRUNCATED_TO_MOST_RECENT_REPLY). These are NOT complete messages. Full text requires ` +
        `HubSpot's original-content endpoint per message.`,
    );
  }

  return { conversations: done, messages: messageCount, truncation };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  const client = new Client({
    token: requireEnv('HUBSPOT_ACCESS_TOKEN'),
    base: process.env.HUBSPOT_API_BASE || DEFAULT_BASE,
  });

  mkdirSync(opts.out, { recursive: true });
  const ckpt = new Checkpoint(opts.out);

  if (opts.resume) {
    ckpt.load();
    opts.archived = Boolean(ckpt.state.archived);
    log(`resuming from ${ckpt.path}`);
  } else {
    if (!opts.start) fail('--start is required (or use --resume)');
    ckpt.save({
      startTime: resolveStart(opts.start),
      after: null,
      listDone: false,
      archived: opts.archived,
    });
  }

  log(`HubSpot export of threads updated since ${iso(ckpt.state.startTime)}`);
  log(`output: ${opts.out}${opts.inboxId ? `, inbox ${opts.inboxId}` : ', all inboxes'}`);
  if (opts.archived) {
    log('including archived threads (HubSpot deletes these permanently after 30 days)');
  }
  if (!opts.bodies) log('bodies suppressed (--no-bodies): message metadata only');

  const started = Date.now();
  const summary = { conversations: 0, messages: 0, skipped_older_than_watermark: 0, truncation: null };

  if (opts.only !== 'messages' && !ckpt.state.listDone) {
    log('phase 1: listing threads newest-first...');
    const result = await listThreads(client, ckpt, opts);
    summary.conversations = result.total;
    summary.skipped_older_than_watermark = result.skippedOlder;
  } else if (opts.only !== 'messages') {
    log('phase 1: already complete per checkpoint');
  }

  if (opts.only !== 'conversations') {
    log('phase 2: fetching message text...');
    const result = await fetchMessages(client, ckpt, opts);
    summary.messages = result.messages;
    summary.truncation = result.truncation;
  }

  const elapsed = Math.round((Date.now() - started) / 1000);
  log(
    `done in ${elapsed}s using ${client.requestCount} requests ` +
      `(${summary.conversations} conversations, ${summary.messages} messages)`,
  );
  if (client.dailyRemaining !== null) {
    log(`daily API allowance remaining: ${client.dailyRemaining}`);
  }

  const truncated = summary.truncation
    ? summary.truncation.TRUNCATED + summary.truncation.TRUNCATED_TO_MOST_RECENT_REPLY
    : 0;

  process.stdout.write(
    JSON.stringify(
      {
        ...summary,
        truncated_messages: truncated,
        bodies_complete: truncated === 0,
        out_dir: opts.out,
        watermark: iso(ckpt.state.startTime),
        archived_included: opts.archived,
        inbox_id: opts.inboxId,
        requests: client.requestCount,
        daily_remaining: client.dailyRemaining,
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
