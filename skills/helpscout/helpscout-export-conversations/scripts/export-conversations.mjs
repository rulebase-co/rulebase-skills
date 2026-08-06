#!/usr/bin/env node
/**
 * Exports Help Scout Mailbox API v2 conversations and threads into the canonical
 * conversations.jsonl / messages.jsonl schema.
 *
 * Three Help Scout specifics drive the design:
 *
 *   1. GET /v2/conversations defaults to status=active, silently omitting closed
 *      conversations. This script defaults to status=all and refuses to let the
 *      default pass unnoticed.
 *   2. embed=threads returns truncated chat threads by design, so message bodies
 *      must come from /v2/conversations/{id}/threads — one request per
 *      conversation, hence the checkpointing.
 *   3. `lineitem` threads are state changes, not messages. Counted and dropped
 *      unless --include-line-items.
 *
 * Rate limiting is plan-dependent and shared across the whole account, so the
 * limit is read from response headers rather than hard-coded, and the retry hint
 * is X-RateLimit-Retry-After (not the standard Retry-After).
 *
 * Credentials come from the environment only.
 *
 * Usage:
 *   HELPSCOUT_CLIENT_ID=... HELPSCOUT_CLIENT_SECRET=... \
 *     node export-conversations.mjs --out ./out [--status all] [--mailbox 1,2]
 *     [--modified-since ISO] [--no-bodies] [--include-line-items] [--resume]
 *     [--max-conversations N]
 */

import { writeFileSync, appendFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const API_BASE = (process.env.HELPSCOUT_BASE_URL || 'https://api.helpscout.net').replace(/\/$/, '');

const argv = process.argv.slice(2);
const has = (n) => argv.includes(`--${n}`);
function opt(name, fallback = undefined) {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith('--')) return true;
  return v;
}
const die = (msg) => {
  console.error(`error: ${msg}`);
  process.exit(2);
};

const outDir = String(opt('out', './out'));
const status = String(opt('status', 'all'));
const mailbox = opt('mailbox');
const modifiedSince = opt('modified-since');
const withBodies = !has('no-bodies');
const includeLineItems = has('include-line-items');
const resume = has('resume');
const maxConversations = Number(opt('max-conversations', Infinity));

const VALID_STATUS = new Set(['all', 'active', 'open', 'pending', 'closed', 'spam']);
if (!VALID_STATUS.has(status)) die(`--status must be one of: ${[...VALID_STATUS].join(', ')}`);

const clientId = process.env.HELPSCOUT_CLIENT_ID;
const clientSecret = process.env.HELPSCOUT_CLIENT_SECRET;
if (!clientId || !clientSecret) die('HELPSCOUT_CLIENT_ID and HELPSCOUT_CLIENT_SECRET must be set');

if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
const conversationsPath = join(outDir, 'conversations.jsonl');
const messagesPath = join(outDir, 'messages.jsonl');
const checkpointPath = join(outDir, '.helpscout-checkpoint.json');

// ------------------------------------------------------------------ mappings

const STATUS_MAP = {
  active: 'open',
  open: 'open',
  pending: 'pending',
  closed: 'closed',
  // Judgement call, not a fact: spam is not "resolved work". status_raw keeps the
  // original so it can be excluded from contact-volume analysis.
  spam: 'closed',
};

const CHANNEL_MAP = { email: 'email', chat: 'chat', phone: 'voice' };

/**
 * A message's channel can differ from its conversation's — a phone thread on an
 * email conversation is a call that was logged against it. Only the thread types
 * that genuinely carry a channel are mapped; the rest stay null.
 */
const THREAD_CHANNEL_MAP = { customer: null, message: 'email', chat: 'chat', phone: 'voice' };

/** State-change threads. No body, no recipients, no attachments. Not messages. */
const LINE_ITEM = 'lineitem';

const iso = (value) => {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
};

/**
 * Named entities that actually turn up in support text. Currency symbols matter
 * most here — this is a multi-currency domain and a refund amount rendered as
 * "&pound;40" corrupts every downstream text analysis that touches it.
 */
const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  pound: '£', euro: '€', yen: '¥', cent: '¢', curren: '¤',
  copy: '©', reg: '®', trade: '™', deg: '°', plusmn: '±',
  times: '×', divide: '÷', middot: '·', bull: '•', hellip: '…',
  ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’',
  ldquo: '“', rdquo: '”', sbquo: '‚', bdquo: '„',
  laquo: '«', raquo: '»', dagger: '†', sect: '§', para: '¶', frac12: '½',
};

// One pass over every entity form. Decoding in sequential passes is a real bug:
// replacing &amp; first turns "&amp;lt;" into "<" instead of "&lt;".
const ENTITY_RE = /&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]{1,31});/g;

function decodeEntity(match, token) {
  if (token[0] === '#') {
    const code = token[1] === 'x' || token[1] === 'X' ? parseInt(token.slice(2), 16) : Number(token.slice(1));
    if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return match;
    try {
      return String.fromCodePoint(code);
    } catch {
      return match;
    }
  }
  const named = NAMED_ENTITIES[token] ?? NAMED_ENTITIES[token.toLowerCase()];
  // Leave anything unrecognised intact rather than silently deleting it.
  return named ?? match;
}

/**
 * Help Scout thread bodies are HTML; the canonical schema requires plain text.
 *
 * Deliberately minimal — no dependencies allowed — but it does the things that
 * matter for downstream text analysis: drop script/style content entirely
 * rather than inlining it, turn block boundaries into newlines so sentences
 * don't run together, and decode the handful of entities that actually appear
 * in support text. Anything more ambitious belongs upstream of this script.
 */
function htmlToText(html) {
  if (typeof html !== 'string' || html === '') return html ?? null;
  return html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(ENTITY_RE, decodeEntity)
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .trim();
}

function normalizeConversation(c) {
  return {
    source: 'helpscout',
    source_id: String(c.id),
    subject: c.subject ?? null,
    status: STATUS_MAP[c.status] ?? 'open',
    status_raw: c.status ?? null,
    channel: CHANNEL_MAP[c.type] ?? (c.type ? 'other' : null),
    channel_raw: c.type ?? null,
    customer_id: c.primaryCustomer?.id ? String(c.primaryCustomer.id) : null,
    assignee_id: c.assignee?.id ? String(c.assignee.id) : null,
    // Help Scout has no separate team object; the inbox is the closest analogue.
    team_id: c.mailboxId != null ? String(c.mailboxId) : null,
    account_id: null,
    created_at: iso(c.createdAt),
    updated_at: iso(c.userUpdatedAt ?? c.createdAt),
    resolved_at: iso(c.closedAt),
    // Satisfaction ratings are a separate resource with their own scale; guessing
    // a mapping here would be worse than leaving it null.
    csat: null,
    csat_raw: null,
    priority: null,
    tags: (c.tags ?? []).map((t) => (typeof t === 'string' ? t : t?.tag)).filter((v) => typeof v === 'string'),
    is_deleted: false,
  };
}

/**
 * createdBy.type is the reliable author signal. Thread type is not — a `chat`
 * thread can be authored by either side.
 */
function normalizeThread(t, conversationId) {
  const byType = t.createdBy?.type;
  let authorType = 'unknown';
  if (byType === 'user') authorType = 'agent';
  else if (byType === 'customer') authorType = 'customer';

  // `note` is the only internal-only thread type; everything else the customer
  // can see. Kept as canonical `visibility`, not a bespoke boolean.
  const visibility = t.type === 'note' ? 'internal' : 'public';

  return {
    source: 'helpscout',
    conversation_source_id: String(conversationId),
    source_id: String(t.id),
    created_at: iso(t.createdAt),
    author_id: t.createdBy?.id != null ? String(t.createdBy.id) : null,
    author_type: authorType,
    author_type_raw: byType ?? null,
    visibility,
    channel: THREAD_CHANNEL_MAP[t.type] ?? null,
    // Thread bodies are HTML; the canonical schema requires plain text.
    body: htmlToText(t.body),
    type_raw: t.type ?? null,
    attachment_count: Array.isArray(t.attachments) ? t.attachments.length : 0,
  };
}

// -------------------------------------------------------------------- client

let accessToken = null;
const stats = {
  conversations: 0,
  messages: 0,
  lineItemsDropped: 0,
  internalNotes: 0,
  throttled: 0,
  throttleWaitMs: 0,
  threadFetchFailures: [],
  statusBreakdown: {},
  mailboxesSeen: new Set(),
  rateLimit: null,
};

async function authenticate() {
  const res = await fetch(`${API_BASE}/v2/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    die(`authentication failed (${res.status}): ${body.slice(0, 200)}`);
  }
  const json = await res.json();
  if (!json.access_token) die('authentication succeeded but returned no access_token');
  accessToken = json.access_token;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Help Scout's retry hint is X-RateLimit-Retry-After, NOT the standard
 * Retry-After — a generic client's backoff will not find it and will hammer
 * straight back into the 429. Both are read here, Help Scout's first.
 */
function retryDelayMs(res, attempt) {
  const raw = res.headers.get('x-ratelimit-retry-after') ?? res.headers.get('retry-after');
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.max(1000, seconds * 1000);
  return Math.min(60000, 1000 * 2 ** attempt);
}

async function apiGet(path, { attempt = 0, reauthed = false } = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
  });

  const limit = res.headers.get('x-ratelimit-limit-minute');
  const remaining = res.headers.get('x-ratelimit-remaining-minute');
  if (limit) stats.rateLimit = { limitPerMinute: Number(limit), remaining: Number(remaining) };

  if (res.status === 401 && !reauthed) {
    await authenticate();
    return apiGet(path, { attempt, reauthed: true });
  }

  if (res.status === 429) {
    if (attempt >= 8) die(`rate limited repeatedly on ${path}; giving up after ${attempt} attempts`);
    const wait = retryDelayMs(res, attempt);
    stats.throttled += 1;
    stats.throttleWaitMs += wait;
    console.error(`  throttled — waiting ${Math.round(wait / 1000)}s (attempt ${attempt + 1})`);
    await sleep(wait);
    return apiGet(path, { attempt: attempt + 1, reauthed });
  }

  if (res.status >= 500) {
    if (attempt >= 5) die(`server error ${res.status} on ${path} after ${attempt} retries`);
    const wait = Math.min(30000, 1000 * 2 ** attempt);
    await sleep(wait);
    return apiGet(path, { attempt: attempt + 1, reauthed });
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    die(`GET ${path} failed (${res.status}): ${body.slice(0, 300)}`);
  }

  return res.json();
}

const embedded = (payload, key) => payload?._embedded?.[key] ?? [];

// ---------------------------------------------------------------- checkpoint

function loadCheckpoint() {
  if (!resume || !existsSync(checkpointPath)) return { page: 1, doneIds: [] };
  try {
    const cp = JSON.parse(readFileSync(checkpointPath, 'utf8'));
    return { page: cp.page ?? 1, doneIds: cp.doneIds ?? [] };
  } catch {
    return { page: 1, doneIds: [] };
  }
}

function saveCheckpoint(page, doneIds) {
  writeFileSync(checkpointPath, JSON.stringify({ page, doneIds: [...doneIds], updatedAt: new Date().toISOString() }));
}

// --------------------------------------------------------------------- run

await authenticate();

// Confirm inbox coverage up front: an app scoped to a subset of inboxes produces
// a partial export with no error at all.
const mailboxesPayload = await apiGet('/v2/mailboxes?size=200');
const accessibleMailboxes = embedded(mailboxesPayload, 'mailboxes').map((m) => ({ id: m.id, name: m.name }));
console.error(`accessible inboxes: ${accessibleMailboxes.length}`);
for (const m of accessibleMailboxes) console.error(`  ${m.id}  ${m.name}`);
if (accessibleMailboxes.length === 0) {
  console.error('WARNING: this app can see no inboxes. The export will be empty — check the app\'s permissions.');
}

const checkpoint = loadCheckpoint();
const doneIds = new Set(checkpoint.doneIds);

if (!resume) {
  writeFileSync(conversationsPath, '');
  writeFileSync(messagesPath, '');
}

const params = new URLSearchParams();
params.set('status', status);
params.set('sortField', 'createdAt');
params.set('sortOrder', 'asc');
if (mailbox && mailbox !== true) params.set('mailbox', String(mailbox));
if (modifiedSince && modifiedSince !== true) params.set('modifiedSince', String(modifiedSince));

if (status !== 'all') {
  console.error(`NOTE: exporting status="${status}". The API default is "active", which omits closed conversations.`);
}

let page = checkpoint.page;
let totalPages = 1;

console.error(`\nexporting conversations (status=${status}, bodies=${withBodies})...`);

while (page <= totalPages && stats.conversations < maxConversations) {
  params.set('page', String(page));
  const payload = await apiGet(`/v2/conversations?${params.toString()}`);

  totalPages = payload?.page?.totalPages ?? 1;
  const batch = embedded(payload, 'conversations');
  if (batch.length === 0) break;

  for (const raw of batch) {
    if (stats.conversations >= maxConversations) break;
    const id = String(raw.id);
    if (doneIds.has(id)) continue;

    const conversation = normalizeConversation(raw);
    appendFileSync(conversationsPath, `${JSON.stringify(conversation)}\n`);
    stats.conversations += 1;
    stats.statusBreakdown[conversation.status_raw ?? 'unknown'] =
      (stats.statusBreakdown[conversation.status_raw ?? 'unknown'] ?? 0) + 1;
    if (raw.mailboxId != null) stats.mailboxesSeen.add(String(raw.mailboxId));

    if (withBodies) {
      try {
        let threadPage = 1;
        let threadTotalPages = 1;
        while (threadPage <= threadTotalPages) {
          const tp = await apiGet(`/v2/conversations/${id}/threads?page=${threadPage}`);
          threadTotalPages = tp?.page?.totalPages ?? 1;
          for (const t of embedded(tp, 'threads')) {
            if (t.type === LINE_ITEM && !includeLineItems) {
              stats.lineItemsDropped += 1;
              continue;
            }
            const message = normalizeThread(t, id);
            if (message.visibility === 'internal') stats.internalNotes += 1;
            appendFileSync(messagesPath, `${JSON.stringify(message)}\n`);
            stats.messages += 1;
          }
          threadPage += 1;
        }
      } catch (err) {
        stats.threadFetchFailures.push({ conversationId: id, error: String(err?.message || err) });
      }
    }

    doneIds.add(id);
  }

  saveCheckpoint(page, doneIds);
  console.error(`  page ${page}/${totalPages} — ${stats.conversations} conversations, ${stats.messages} messages`);
  page += 1;
}

const summary = {
  source: 'helpscout',
  status,
  modifiedSince: modifiedSince && modifiedSince !== true ? String(modifiedSince) : null,
  bodiesIncluded: withBodies,
  conversations: stats.conversations,
  messages: stats.messages,
  internalNotes: stats.internalNotes,
  lineItemsDropped: stats.lineItemsDropped,
  statusBreakdown: stats.statusBreakdown,
  inboxes: {
    accessible: accessibleMailboxes,
    seenInExport: [...stats.mailboxesSeen],
  },
  rateLimit: stats.rateLimit,
  throttled: stats.throttled,
  throttleWaitSeconds: Math.round(stats.throttleWaitMs / 1000),
  threadFetchFailures: stats.threadFetchFailures,
  output: { conversations: conversationsPath, messages: messagesPath },
  notes: [
    'status defaults to "active" in the API; this export used status=' + status + '.',
    'Message bodies come from /v2/conversations/{id}/threads, not from embed=threads, which truncates chat threads by design.',
    'lineitem threads are state changes, not messages' + (includeLineItems ? ' and were included on request.' : ' and were dropped.'),
    'Thread bodies are HTML in the API and are converted to plain text here, as the canonical schema requires.',
    'CSAT is not exported: Help Scout satisfaction ratings are a separate resource with their own scale.',
    'Deletions are not visible to a modifiedSince sweep. Reconcile with a periodic full id diff.',
    'Transcripts are production PII. Do not commit the output.',
  ],
};

console.error('');
console.error(`done: ${stats.conversations} conversations, ${stats.messages} messages`);
if (stats.lineItemsDropped) console.error(`      ${stats.lineItemsDropped} lineitem threads dropped (state changes, not messages)`);
if (stats.threadFetchFailures.length) {
  console.error(`      WARNING: threads failed for ${stats.threadFetchFailures.length} conversation(s)`);
}

console.log(JSON.stringify(summary, null, 2));

if (stats.threadFetchFailures.length) process.exit(1);
