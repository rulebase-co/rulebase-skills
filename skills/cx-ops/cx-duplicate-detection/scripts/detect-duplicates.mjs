#!/usr/bin/env node
/**
 * Finds duplicate conversations in a canonical export and writes a reviewable
 * merge plan. Read-only: it never touches the source system.
 *
 * This is the "deciding" half of a plan-first mutation. The plan it produces is
 * a human-reviewable artifact that a separate platform mutation skill applies.
 * Splitting them is what lets an agent safely propose a bulk merge without being
 * able to perform one.
 *
 * Detection is deliberately conservative:
 *   - Candidates must share a customer_id. Cross-customer merges are never
 *     proposed, because a wrong one discloses one customer's data to another.
 *   - Conversations with no customer_id are never matched.
 *   - Every proposal carries a confidence tier and the evidence behind it.
 *
 * No npm dependencies. Node 20+.
 *
 *   node scripts/detect-duplicates.mjs ./out/zendesk --out ./plans
 */

import { createReadStream, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';

const DEFAULT_WINDOW_HOURS = 72;

// Jaccard thresholds for the confidence tiers. Deliberately high: a false merge
// is far more costly than a missed one.
const TIER_HIGH = 0.8;
const TIER_MEDIUM = 0.55;
const TIER_LOW = 0.35;

const STOPWORDS = new Set(
  ('a an and are as at be been but by can cant could did do does for from had has have how i im in is it its ' +
    'me my not of on or please that the their them then there this to was we were what when where which who ' +
    'why will with would you your hi hello hey thanks thank regards sincerely dear')
    .split(' ')
    .filter(Boolean),
);

function parseArgs(argv) {
  const opts = {
    dir: null,
    out: './plans',
    windowHours: DEFAULT_WINDOW_HOURS,
    minConfidence: 'medium',
    allowNullCustomer: false,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) fail(`${arg} requires a value`);
      return v;
    };
    switch (arg) {
      case '--out': opts.out = next(); break;
      case '--window-hours': opts.windowHours = Number(next()); break;
      case '--min-confidence': opts.minConfidence = next(); break;
      case '--allow-null-customer': opts.allowNullCustomer = true; break;
      case '--json': opts.json = true; break;
      case '--help': case '-h': usage(); process.exit(0);
      default:
        if (!opts.dir && !arg.startsWith('-')) { opts.dir = arg; break; }
        fail(`unknown argument: ${arg}`);
    }
  }
  if (!opts.dir) fail('a canonical export directory is required');
  if (!['high', 'medium', 'low'].includes(opts.minConfidence)) {
    fail('--min-confidence must be one of: high, medium, low');
  }
  if (!Number.isFinite(opts.windowHours) || opts.windowHours <= 0) {
    fail('--window-hours must be a positive number');
  }
  return opts;
}

function usage() {
  process.stderr.write(`
Usage: node scripts/detect-duplicates.mjs <export-dir> [options]

  <export-dir>              Canonical export (conversations.jsonl, messages.jsonl).
  --out <dir>               Where to write the merge plan. Default ./plans.
  --window-hours <n>        Only pair conversations opened within this window of
                            each other. Default ${DEFAULT_WINDOW_HOURS}.
  --min-confidence <tier>   high | medium (default) | low. Controls what enters
                            the plan, not what is reported.
  --allow-null-customer     Permit matching conversations with no customer_id.
                            Off by default: identity is the safety boundary.
  --json                    Emit only JSON on stdout.

Read-only. Produces a plan for review; applying it is a separate skill.
`);
}

function fail(message) {
  process.stderr.write(`error: ${message}\n`);
  process.exit(1);
}

function log(message) {
  process.stderr.write(`${message}\n`);
}

async function readJsonl(path) {
  const records = [];
  if (!existsSync(path)) return records;
  const lines = createInterface({
    input: createReadStream(path, 'utf8'),
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      /* partial final line */
    }
  }
  return records;
}

/**
 * Normalises text for comparison. Strips the things that differ between genuine
 * duplicates — order numbers, dates, urls, quoted history — so that two
 * resubmissions of the same problem still match.
 */
export function normalizeText(text) {
  if (typeof text !== 'string') return '';
  return text
    .toLowerCase()
    // Cut quoted email history: everything from the first quote marker.
    .split(/\n\s*(?:>|on .{0,40}wrote:|-{2,}\s*original message)/)[0]
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, ' ')
    .replace(/\d+/g, ' ')
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function tokenSet(text) {
  return new Set(
    normalizeText(text)
      .split(' ')
      .filter((t) => t.length > 2 && !STOPWORDS.has(t)),
  );
}

export function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection++;
  return intersection / (a.size + b.size - intersection);
}

/** Union-find, so transitive duplicates collapse into one cluster. */
class DisjointSet {
  constructor() {
    this.parent = new Map();
  }
  find(x) {
    if (!this.parent.has(x)) this.parent.set(x, x);
    let root = x;
    while (this.parent.get(root) !== root) root = this.parent.get(root);
    // Path compression.
    let cursor = x;
    while (this.parent.get(cursor) !== root) {
      const next = this.parent.get(cursor);
      this.parent.set(cursor, root);
      cursor = next;
    }
    return root;
  }
  union(a, b) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(rb, ra);
  }
  groups() {
    const out = new Map();
    for (const key of this.parent.keys()) {
      const root = this.find(key);
      if (!out.has(root)) out.set(root, []);
      out.get(root).push(key);
    }
    return [...out.values()].filter((g) => g.length > 1);
  }
}

function tier(score, subjectScore, hoursApart) {
  // Identical subject within an hour is the signature of a double submission,
  // even when bodies differ in wording.
  if (score >= TIER_HIGH || (subjectScore >= 0.95 && hoursApart <= 1)) return 'high';
  if (score >= TIER_MEDIUM) return 'medium';
  if (score >= TIER_LOW) return 'low';
  return null;
}

const TIER_RANK = { low: 0, medium: 1, high: 2 };

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  const conversations = await readJsonl(join(opts.dir, 'conversations.jsonl'));
  if (conversations.length === 0) fail(`no conversations found in ${opts.dir}`);
  const messages = await readJsonl(join(opts.dir, 'messages.jsonl'));

  // The first customer message is the best signal for "same problem". Fall back
  // to the subject when message bodies are absent (a --no-bodies export).
  const firstCustomerMessage = new Map();
  for (const message of messages) {
    if (message.author_type !== 'customer') continue;
    if (message.visibility === 'internal') continue;
    if (typeof message.body !== 'string' || message.body.trim() === '') continue;
    const key = String(message.conversation_source_id);
    const existing = firstCustomerMessage.get(key);
    if (!existing || String(message.created_at) < String(existing.created_at)) {
      firstCustomerMessage.set(key, message);
    }
  }

  const usable = [];
  const stats = { total: conversations.length, no_customer: 0, no_text: 0, deleted: 0 };

  for (const conversation of conversations) {
    if (conversation.is_deleted) {
      stats.deleted++;
      continue;
    }
    const customerId = conversation.customer_id;
    if (!customerId && !opts.allowNullCustomer) {
      stats.no_customer++;
      continue;
    }
    const first = firstCustomerMessage.get(String(conversation.source_id));
    const text = first?.body ?? conversation.subject ?? '';
    const tokens = tokenSet(text);
    if (tokens.size === 0) {
      stats.no_text++;
      continue;
    }
    usable.push({
      id: String(conversation.source_id),
      source: conversation.source,
      customerId: customerId ? String(customerId) : null,
      createdAt: Date.parse(conversation.created_at ?? '') || 0,
      createdIso: conversation.created_at ?? null,
      status: conversation.status,
      channel: conversation.channel,
      subject: conversation.subject ?? '',
      subjectTokens: tokenSet(conversation.subject ?? ''),
      tokens,
      textUsed: first ? 'first_customer_message' : 'subject',
      preview: normalizeText(text).slice(0, 80),
    });
  }

  log(
    `${usable.length} of ${stats.total} conversations comparable ` +
      `(${stats.no_customer} without customer_id, ${stats.no_text} without text, ${stats.deleted} deleted)`,
  );

  // Group by customer: cross-customer merges are never proposed.
  const byCustomer = new Map();
  for (const record of usable) {
    const key = record.customerId ?? `__null__${record.id}`;
    if (!byCustomer.has(key)) byCustomer.set(key, []);
    byCustomer.get(key).push(record);
  }

  const windowMs = opts.windowHours * 3_600_000;
  const pairs = [];
  let comparisons = 0;

  for (const group of byCustomer.values()) {
    if (group.length < 2) continue;
    group.sort((a, b) => a.createdAt - b.createdAt);
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i];
        const b = group[j];
        const apart = Math.abs(b.createdAt - a.createdAt);
        // Sorted by time, so once out of window every later j is too.
        if (apart > windowMs) break;
        comparisons++;

        const score = jaccard(a.tokens, b.tokens);
        const subjectScore = jaccard(a.subjectTokens, b.subjectTokens);
        const hoursApart = apart / 3_600_000;
        const confidence = tier(score, subjectScore, hoursApart);
        if (!confidence) continue;

        pairs.push({
          a,
          b,
          confidence,
          similarity: Number(score.toFixed(3)),
          subject_similarity: Number(subjectScore.toFixed(3)),
          hours_apart: Number(hoursApart.toFixed(2)),
        });
      }
    }
  }

  // Collapse transitive duplicates, but only using pairs at or above the
  // requested confidence — a low-confidence link must not silently chain two
  // high-confidence clusters together.
  const threshold = TIER_RANK[opts.minConfidence];
  const eligible = pairs.filter((p) => TIER_RANK[p.confidence] >= threshold);

  const sets = new DisjointSet();
  for (const pair of eligible) sets.union(pair.a.id, pair.b.id);

  const byId = new Map(usable.map((r) => [r.id, r]));
  const pairIndex = new Map();
  for (const pair of eligible) {
    pairIndex.set(`${pair.a.id}|${pair.b.id}`, pair);
  }

  const plan = [];
  for (const cluster of sets.groups()) {
    const records = cluster.map((id) => byId.get(id)).filter(Boolean);
    records.sort((a, b) => a.createdAt - b.createdAt);

    // Merge into the earliest conversation: it holds the original context and is
    // the one the customer and any prior agent already referenced.
    const [target, ...sources] = records;

    const evidence = [];
    let weakest = 'high';
    for (const source of sources) {
      const pair =
        pairIndex.get(`${target.id}|${source.id}`) ?? pairIndex.get(`${source.id}|${target.id}`);
      const link = pair ?? eligible.find((p) => p.a.id === source.id || p.b.id === source.id);
      if (link) {
        if (TIER_RANK[link.confidence] < TIER_RANK[weakest]) weakest = link.confidence;
        evidence.push({
          source_id: source.id,
          similarity: link.similarity,
          subject_similarity: link.subject_similarity,
          hours_apart: link.hours_apart,
          confidence: link.confidence,
          // Transitive members are linked through another conversation, not the
          // target directly. Flag it: those need closer review.
          direct: Boolean(pair),
        });
      }
    }

    plan.push({
      source: target.source,
      target_id: target.id,
      source_ids: sources.map((s) => s.id),
      customer_id: target.customerId,
      confidence: weakest,
      cluster_size: records.length,
      target_created_at: target.createdIso,
      channels: [...new Set(records.map((r) => r.channel).filter(Boolean))],
      statuses: [...new Set(records.map((r) => r.status).filter(Boolean))],
      text_basis: target.textUsed,
      preview: target.preview,
      evidence,
    });
  }

  plan.sort((a, b) => TIER_RANK[b.confidence] - TIER_RANK[a.confidence] || b.cluster_size - a.cluster_size);

  const byTier = { high: 0, medium: 0, low: 0 };
  let conversationsAffected = 0;
  for (const entry of plan) {
    byTier[entry.confidence]++;
    conversationsAffected += entry.source_ids.length;
  }

  const planPath = join(opts.out, 'merge-plan.jsonl');
  mkdirSync(opts.out, { recursive: true });
  writeFileSync(planPath, plan.map((p) => JSON.stringify(p)).join('\n') + (plan.length ? '\n' : ''));

  const report = {
    export_dir: opts.dir,
    plan_path: planPath,
    parameters: {
      window_hours: opts.windowHours,
      min_confidence: opts.minConfidence,
      allow_null_customer: opts.allowNullCustomer,
      thresholds: { high: TIER_HIGH, medium: TIER_MEDIUM, low: TIER_LOW },
    },
    input: stats,
    comparable: usable.length,
    comparisons,
    candidate_pairs: pairs.length,
    clusters: plan.length,
    by_confidence: byTier,
    conversations_that_would_be_merged: conversationsAffected,
    caveats: buildCaveats(stats, opts, plan),
  };

  if (!opts.json) process.stderr.write(render(report, plan));
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
}

function buildCaveats(stats, opts, plan) {
  const caveats = [];

  if (stats.no_customer > 0) {
    caveats.push(
      `${stats.no_customer} conversations have no customer_id and were excluded. Identity is the ` +
        `safety boundary here — without it a merge could join two different people's ` +
        `conversations. Resolve identity first rather than passing --allow-null-customer.`,
    );
  }
  if (opts.allowNullCustomer) {
    caveats.push(
      '--allow-null-customer is set. Conversations without an identity can now be paired on text ' +
        'alone. Review every proposal in this run individually; do not bulk-approve.',
    );
  }
  if (stats.no_text > 0) {
    caveats.push(
      `${stats.no_text} conversations had no usable text (often a --no-bodies export) and were ` +
        `excluded. Duplicate detection needs message bodies.`,
    );
  }
  const transitive = plan.filter((p) => p.evidence.some((e) => !e.direct)).length;
  if (transitive > 0) {
    caveats.push(
      `${transitive} clusters contain conversations linked transitively rather than directly to ` +
        `the target. Chained similarity is weaker than it looks; review these individually.`,
    );
  }
  const crossChannel = plan.filter((p) => p.channels.length > 1).length;
  if (crossChannel > 0) {
    caveats.push(
      `${crossChannel} clusters span multiple channels. These are usually genuine duplicates (the ` +
        `customer tried again elsewhere) and are the most valuable to merge, but merging across ` +
        `channels can lose channel-specific metadata in some platforms.`,
    );
  }
  caveats.push(
    'This is a proposal, not a change. Review the plan, then apply it with the platform mutation ' +
      'skill. Merging is not reversible on most helpdesks.',
  );

  return caveats;
}

function render(report, plan) {
  const lines = [''];
  lines.push(`comparable conversations: ${report.comparable} (${report.comparisons} pairs compared)`);
  lines.push(`candidate pairs:          ${report.candidate_pairs}`);
  lines.push(`clusters proposed:        ${report.clusters}`);
  lines.push(
    `  high ${report.by_confidence.high}   medium ${report.by_confidence.medium}   ` +
      `low ${report.by_confidence.low}`,
  );
  lines.push(`conversations to merge:   ${report.conversations_that_would_be_merged}`);
  lines.push('');
  lines.push(`plan written to: ${report.plan_path}`);

  if (plan.length > 0) {
    lines.push('');
    lines.push('  top proposals');
    for (const entry of plan.slice(0, 15)) {
      const worst = Math.min(...entry.evidence.map((e) => e.similarity));
      lines.push(
        `    ${entry.confidence.padEnd(6)} target ${String(entry.target_id).padEnd(12)} ` +
          `+${entry.source_ids.length} source(s)  sim>=${worst.toFixed(2)}  ` +
          `[${entry.channels.join(',')}]  "${entry.preview.slice(0, 40)}"`,
      );
    }
    if (plan.length > 15) lines.push(`    ... and ${plan.length - 15} more in the plan file`);
  }

  lines.push('');
  lines.push('  caveats');
  for (const caveat of report.caveats) lines.push(`    - ${caveat}`);
  lines.push('');

  return lines.join('\n');
}

await main();
