#!/usr/bin/env node
/**
 * Audits a knowledge base against the conversations customers actually have.
 *
 * The question this answers: what are people contacting you about that your
 * knowledge base does not cover? That gap is the ceiling on both self-service
 * deflection and any AI agent grounded in the KB — an agent cannot answer what
 * the KB does not contain, so KB coverage is a leading indicator of AI agent
 * performance rather than a documentation chore.
 *
 * Read-only.
 *
 * Inputs:
 *   - a canonical export (conversations.jsonl, messages.jsonl)
 *   - articles.jsonl: { "id", "title", "body", "updated_at", "url", "views" }
 *     `views` and `updated_at` are optional but unlock two extra checks.
 *
 * No npm dependencies. Node 20+.
 *
 *   node scripts/audit-coverage.mjs ./out/zendesk --articles ./kb/articles.jsonl
 */

import { createReadStream, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';

// Overlap score above which a conversation is considered covered by an article.
const COVERED = 0.25;
const WEAK = 0.15;
// Minimum distinct question terms an article must match. Without this a single
// generic noun ("order", "account") clears the ratio on a short question and a
// completely uncovered topic is reported as weakly covered.
const MIN_TERMS_COVERED = 3;
const MIN_TERMS_WEAK = 2;
// Articles not updated in this long are flagged as stale.
const STALE_DAYS = 365;
// Gap themes below this many conversations are noise, not a gap.
const MIN_GAP_SIZE = 5;

const STOPWORDS = new Set(
  ('a about after all also am an and any are as at be because been before being but by can cant could did do ' +
    'does doing dont down during each few for from further had has have having he her here hers him his how i ' +
    'if im in into is it its just me more most my no nor not now of off on once only or other our out over own ' +
    'same she should so some such than that the their them then there these they this those through to too ' +
    'under until up very was we were what when where which while who whom why will with would you your ' +
    'hi hello hey thanks thank please regards dear sincerely help need want get got would like')
    .split(' ')
    .filter(Boolean),
);

function parseArgs(argv) {
  const opts = { dir: null, articles: null, out: './out/kb-audit', staleDays: STALE_DAYS, json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) fail(`${arg} requires a value`);
      return v;
    };
    switch (arg) {
      case '--articles': opts.articles = next(); break;
      case '--out': opts.out = next(); break;
      case '--stale-days': opts.staleDays = Number(next()); break;
      case '--json': opts.json = true; break;
      case '--help': case '-h': usage(); process.exit(0);
      default:
        if (!opts.dir && !arg.startsWith('-')) { opts.dir = arg; break; }
        fail(`unknown argument: ${arg}`);
    }
  }
  if (!opts.dir) fail('a canonical export directory is required');
  if (!opts.articles) fail('--articles is required (a JSONL file of KB articles)');
  if (!Number.isFinite(opts.staleDays) || opts.staleDays <= 0) fail('--stale-days must be positive');
  return opts;
}

function usage() {
  process.stderr.write(`
Usage: node scripts/audit-coverage.mjs <export-dir> --articles <articles.jsonl> [options]

  <export-dir>          Canonical export (conversations.jsonl, messages.jsonl).
  --articles <path>     JSONL: { id, title, body, updated_at?, url?, views? }
  --out <dir>           Output directory. Default ./out/kb-audit.
  --stale-days <n>      Flag articles not updated in this many days. Default ${STALE_DAYS}.
  --json                Emit only JSON on stdout.

Read-only. Reports coverage gaps, unused articles, and stale articles.
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
  const lines = createInterface({ input: createReadStream(path, 'utf8'), crlfDelay: Infinity });
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

export function tokenize(text) {
  if (typeof text !== 'string') return [];
  return text
    .toLowerCase()
    .split(/\n\s*(?:>|on .{0,40}wrote:)/)[0]
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\d+/g, ' ')
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));
}

/**
 * Inverse document frequency across the article set, plus the weight to give a
 * term that appears in no article at all. That weight is the IDF of a term found
 * in exactly one article — the rarest thing the corpus contains — because a term
 * absent entirely is at least that informative about a gap.
 */
export function buildIdf(articleTokenSets) {
  const df = new Map();
  for (const tokens of articleTokenSets) {
    for (const token of tokens) df.set(token, (df.get(token) ?? 0) + 1);
  }
  const total = Math.max(articleTokenSets.length, 1);
  const weights = new Map();
  for (const [token, count] of df) weights.set(token, Math.log(1 + total / count));
  return { weights, unseen: Math.log(1 + total) };
}

/**
 * Asymmetric containment rather than Jaccard: an article is usually far longer
 * than a customer question, and Jaccard punishes that length difference so
 * heavily that a perfectly good article scores near zero. What matters is what
 * share of the QUESTION's terms the article covers.
 *
 * Terms are IDF-weighted so boilerplate present in every article ("contact",
 * "support", "account") stops propping up the score, and the count of matched
 * terms is returned so a single-term match can be rejected outright.
 */
export function coverageScore(questionTokens, articleTokenSet, idf) {
  if (questionTokens.size === 0 || articleTokenSet.size === 0) return { score: 0, terms: 0 };
  let matchedWeight = 0;
  let totalWeight = 0;
  let terms = 0;
  for (const token of questionTokens) {
    // A word absent from the whole KB is the strongest evidence of a gap, so it
    // carries the corpus's maximum weight.
    const weight = idf.weights.get(token) ?? idf.unseen;
    totalWeight += weight;
    if (articleTokenSet.has(token)) {
      matchedWeight += weight;
      terms++;
    }
  }
  return { score: totalWeight === 0 ? 0 : matchedWeight / totalWeight, terms };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  const conversations = await readJsonl(join(opts.dir, 'conversations.jsonl'));
  if (conversations.length === 0) fail(`no conversations found in ${opts.dir}`);
  const messages = await readJsonl(join(opts.dir, 'messages.jsonl'));
  const articles = await readJsonl(opts.articles);
  if (articles.length === 0) fail(`no articles found in ${opts.articles}`);

  // Index the first public customer message per conversation.
  const firstMessage = new Map();
  for (const message of messages) {
    if (message.author_type !== 'customer' || message.visibility === 'internal') continue;
    if (typeof message.body !== 'string' || message.body.trim() === '') continue;
    const key = String(message.conversation_source_id);
    const existing = firstMessage.get(key);
    if (!existing || String(message.created_at) < String(existing.created_at)) {
      firstMessage.set(key, message);
    }
  }

  const articleIndex = articles.map((article) => {
    // Title terms count double: they describe what the article is about, while
    // body terms include boilerplate that matches everything.
    const titleTokens = tokenize(article.title ?? '');
    const tokens = new Set([...titleTokens, ...titleTokens, ...tokenize(article.body ?? '')]);
    const updatedAt = article.updated_at ? Date.parse(article.updated_at) : null;
    return {
      id: String(article.id),
      title: article.title ?? '(untitled)',
      url: article.url ?? null,
      views: typeof article.views === 'number' ? article.views : null,
      updatedAt: Number.isFinite(updatedAt) ? updatedAt : null,
      tokens,
      matched: 0,
    };
  });

  const idf = buildIdf(articleIndex.map((a) => a.tokens));

  const buckets = { covered: 0, weak: 0, uncovered: 0, no_text: 0 };
  const gapTerms = new Map();
  const uncoveredSamples = [];

  for (const conversation of conversations) {
    if (conversation.is_deleted) continue;
    const message = firstMessage.get(String(conversation.source_id));
    const text = message?.body ?? conversation.subject ?? '';
    const tokens = new Set(tokenize(text));
    if (tokens.size === 0) {
      buckets.no_text++;
      continue;
    }

    let best = null;
    let bestScore = 0;
    let bestTerms = 0;
    for (const article of articleIndex) {
      const { score, terms } = coverageScore(tokens, article.tokens, idf);
      if (score > bestScore) {
        bestScore = score;
        bestTerms = terms;
        best = article;
      }
    }

    if (bestScore >= COVERED && bestTerms >= MIN_TERMS_COVERED) {
      buckets.covered++;
      if (best) best.matched++;
    } else if (bestScore >= WEAK && bestTerms >= MIN_TERMS_WEAK) {
      buckets.weak++;
      if (best) best.matched++;
    } else {
      buckets.uncovered++;
      // Accumulate terms so the gaps can be named rather than just counted.
      for (const token of tokens) gapTerms.set(token, (gapTerms.get(token) ?? 0) + 1);
      if (uncoveredSamples.length < 20) {
        uncoveredSamples.push({
          conversation_source_id: String(conversation.source_id),
          channel: conversation.channel,
          best_score: Number(bestScore.toFixed(3)),
          preview: tokenize(text).slice(0, 12).join(' '),
        });
      }
    }
  }

  const analysed = buckets.covered + buckets.weak + buckets.uncovered;

  const gaps = [...gapTerms.entries()]
    .filter(([, count]) => count >= MIN_GAP_SIZE)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 30)
    .map(([term, count]) => ({
      term,
      uncovered_conversations: count,
      share_of_uncovered: Number((count / Math.max(buckets.uncovered, 1)).toFixed(3)),
    }));

  const now = Date.now();
  const staleCutoff = now - opts.staleDays * 86_400_000;

  const unused = articleIndex
    .filter((a) => a.matched === 0)
    .map((a) => ({ id: a.id, title: a.title, url: a.url, views: a.views }));

  const stale = articleIndex
    .filter((a) => a.updatedAt !== null && a.updatedAt < staleCutoff)
    .map((a) => ({
      id: a.id,
      title: a.title,
      updated_at: new Date(a.updatedAt).toISOString(),
      days_since_update: Math.round((now - a.updatedAt) / 86_400_000),
      matched_conversations: a.matched,
    }))
    .sort((a, b) => b.matched_conversations - a.matched_conversations);

  const noUpdatedAt = articleIndex.filter((a) => a.updatedAt === null).length;
  const noViews = articleIndex.filter((a) => a.views === null).length;

  const topArticles = [...articleIndex]
    .sort((a, b) => b.matched - a.matched)
    .slice(0, 15)
    .map((a) => ({ id: a.id, title: a.title, matched_conversations: a.matched, views: a.views }));

  mkdirSync(opts.out, { recursive: true });
  const gapsPath = join(opts.out, 'coverage-gaps.jsonl');
  writeFileSync(
    gapsPath,
    gaps.map((g) => JSON.stringify(g)).join('\n') + (gaps.length ? '\n' : ''),
  );

  const report = {
    export_dir: opts.dir,
    articles_path: opts.articles,
    gaps_path: gapsPath,
    articles: articleIndex.length,
    conversations_analysed: analysed,
    conversations_without_text: buckets.no_text,
    coverage: {
      covered: buckets.covered,
      weak: buckets.weak,
      uncovered: buckets.uncovered,
      covered_rate: analysed ? Number((buckets.covered / analysed).toFixed(4)) : null,
      uncovered_rate: analysed ? Number((buckets.uncovered / analysed).toFixed(4)) : null,
    },
    thresholds: {
      covered: COVERED,
      weak: WEAK,
      min_terms_covered: MIN_TERMS_COVERED,
      min_terms_weak: MIN_TERMS_WEAK,
      stale_days: opts.staleDays,
    },
    top_gap_terms: gaps,
    uncovered_samples: uncoveredSamples,
    most_matched_articles: topArticles,
    unused_articles: unused,
    stale_articles: stale,
    metadata_gaps: { articles_without_updated_at: noUpdatedAt, articles_without_views: noViews },
    caveats: buildCaveats(buckets, articleIndex, unused, stale, noViews, messages.length),
  };

  if (!opts.json) process.stderr.write(render(report));
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
}

function buildCaveats(buckets, articles, unused, stale, noViews, messageCount) {
  const caveats = [];

  if (messageCount === 0) {
    caveats.push(
      'No messages.jsonl found, so matching used conversation subjects only. Subjects are short ' +
        'and often generic ("Help", "Question"), which understates coverage badly. Re-export with ' +
        'message bodies.',
    );
  }
  if (buckets.no_text > 0) {
    caveats.push(
      `${buckets.no_text} conversations had no usable text and were excluded from the coverage rate.`,
    );
  }
  if (unused.length > 0) {
    caveats.push(
      `${unused.length} article(s) matched no conversation. That does not mean they are worthless — ` +
        'an article may be preventing contacts that therefore never appear in this data. Check ' +
        'view counts before deleting anything.',
    );
  }
  if (noViews > 0) {
    caveats.push(
      `${noViews} article(s) have no view count. Without views you cannot distinguish "nobody needs ` +
        'this" from "this successfully prevents contacts". Export view data if your platform ' +
        'provides it.',
    );
  }
  if (stale.length > 0) {
    caveats.push(
      `${stale.length} article(s) are stale. Prioritise the ones with high matched-conversation ` +
        'counts: a stale article people are actively hitting is worse than an untouched one nobody ' +
        'reads, because agents and AI agents are grounding answers in it.',
    );
  }
  caveats.push(
    'Matching is lexical term overlap, not semantic. An article that answers a question in ' +
      'different words scores low, so treat "uncovered" as a list to review rather than a verdict. ' +
      'Read the samples before commissioning content.',
  );
  caveats.push(
    'Coverage is necessary but not sufficient for deflection. An article that exists but is ' +
      'unfindable, out of date, or wrong does not deflect anything — and if an AI agent is ' +
      'grounded in it, a wrong article is worse than a missing one.',
  );

  return caveats;
}

function render(report) {
  const pct = (v) => (v === null ? 'n/a' : `${(v * 100).toFixed(1)}%`);
  const lines = [''];

  lines.push(`articles:      ${report.articles}`);
  lines.push(`conversations: ${report.conversations_analysed} analysed`);
  lines.push('');
  lines.push(`  covered    ${String(report.coverage.covered).padStart(7)}  ${pct(report.coverage.covered_rate)}`);
  lines.push(`  weak       ${String(report.coverage.weak).padStart(7)}`);
  lines.push(`  uncovered  ${String(report.coverage.uncovered).padStart(7)}  ${pct(report.coverage.uncovered_rate)}`);

  if (report.top_gap_terms.length > 0) {
    lines.push('');
    lines.push('  top gap terms (in uncovered conversations)');
    for (const gap of report.top_gap_terms.slice(0, 15)) {
      lines.push(
        `    ${gap.term.padEnd(22)} ${String(gap.uncovered_conversations).padStart(6)}  ` +
          `${pct(gap.share_of_uncovered)} of uncovered`,
      );
    }
  }

  if (report.uncovered_samples.length > 0) {
    lines.push('');
    lines.push('  uncovered samples');
    for (const sample of report.uncovered_samples.slice(0, 8)) {
      lines.push(`    ${sample.conversation_source_id.padEnd(12)} "${sample.preview}"`);
    }
  }

  if (report.stale_articles.length > 0) {
    lines.push('');
    lines.push('  stale articles, most-used first');
    for (const article of report.stale_articles.slice(0, 8)) {
      lines.push(
        `    ${String(article.days_since_update).padStart(5)}d  ` +
          `matched ${String(article.matched_conversations).padStart(5)}  ${article.title.slice(0, 50)}`,
      );
    }
  }

  if (report.unused_articles.length > 0) {
    lines.push('');
    lines.push(`  ${report.unused_articles.length} article(s) matched no conversation`);
    for (const article of report.unused_articles.slice(0, 5)) {
      lines.push(`    ${article.title.slice(0, 60)}${article.views !== null ? ` (${article.views} views)` : ''}`);
    }
  }

  lines.push('');
  lines.push('  caveats');
  for (const caveat of report.caveats) lines.push(`    - ${caveat}`);
  lines.push('');

  return lines.join('\n');
}

// Guarded so the scoring functions can be imported by tests without running.
if (process.argv[1] && process.argv[1].endsWith('audit-coverage.mjs')) {
  await main();
}
