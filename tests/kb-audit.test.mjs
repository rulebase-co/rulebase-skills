/**
 * Tests for the knowledge base coverage audit. The properties that matter: a
 * genuinely uncovered topic must be reported as uncovered (not weakly covered),
 * generic term overlap must not fake coverage, and articles nobody matched must
 * not be presented as safe to delete.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runScript, tempOut } from './helpers/mock-api.mjs';

const SCRIPT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../skills/cx-operations/cx-knowledge-base-audit/scripts/audit-coverage.mjs',
);

const { tokenize, buildIdf, coverageScore } = await import(SCRIPT);

const conversation = (id, subject) => ({
  source: 'zendesk',
  source_id: String(id),
  subject,
  status: 'closed',
  status_raw: 'closed',
  channel: 'email',
  channel_raw: 'email',
  customer_id: `u${id}`,
  assignee_id: null,
  team_id: null,
  account_id: null,
  created_at: '2026-03-01T10:00:00.000Z',
  updated_at: '2026-03-01T10:00:00.000Z',
  resolved_at: null,
  csat: null,
  csat_raw: null,
  priority: null,
  tags: [],
  is_deleted: false,
});

const message = (conversationId, body) => ({
  source: 'zendesk',
  conversation_source_id: String(conversationId),
  source_id: `m${conversationId}`,
  created_at: '2026-03-01T10:00:00.000Z',
  author_id: `u${conversationId}`,
  author_type: 'customer',
  visibility: 'public',
  channel: 'email',
  attachment_count: 0,
  body,
});

/** Builds an export plus an article file and returns both paths. */
function fixture(topics, articles) {
  const dir = tempOut('kb-');
  const conversations = [];
  const messages = [];
  let id = 0;
  for (const { text, count } of topics) {
    for (let i = 0; i < count; i++) {
      id++;
      conversations.push(conversation(id, 'Support request'));
      messages.push(message(id, text));
    }
  }
  writeFileSync(join(dir, 'conversations.jsonl'), conversations.map((c) => JSON.stringify(c)).join('\n') + '\n');
  writeFileSync(join(dir, 'messages.jsonl'), messages.map((m) => JSON.stringify(m)).join('\n') + '\n');
  const articlesPath = join(dir, 'articles.jsonl');
  writeFileSync(articlesPath, articles.map((a) => JSON.stringify(a)).join('\n') + '\n');
  return { dir, articlesPath };
}

const run = (dir, articlesPath, args = []) =>
  runScript(SCRIPT, [dir, '--articles', articlesPath, '--json', ...args], {});

// --- scoring internals ---

test('tokenize strips numbers, urls, emails and markup', () => {
  const tokens = tokenize('Order 4481 at https://x.test from jo@example.com <b>refund</b> please');
  assert.ok(tokens.includes('order'));
  assert.ok(tokens.includes('refund'));
  assert.ok(!tokens.includes('4481'));
  assert.ok(!tokens.some((t) => t.includes('example')));
  assert.ok(!tokens.includes('please'), 'stopword removed');
});

test('coverageScore weights rare terms above boilerplate', () => {
  // "support" is in every article; "cryptocurrency" in none.
  const articleSets = [
    new Set(['support', 'refund', 'bank']),
    new Set(['support', 'password', 'login']),
    new Set(['support', 'delivery', 'tracking']),
  ];
  const idf = buildIdf(articleSets);
  assert.ok(
    idf.weights.get('support') < idf.weights.get('refund'),
    'ubiquitous terms weigh less than rare ones',
  );
  assert.ok(idf.unseen >= idf.weights.get('refund'), 'an unseen term is the most informative');

  const question = new Set(['support', 'cryptocurrency', 'wallet']);
  const { score, terms } = coverageScore(question, articleSets[0], idf);
  // The real property: a boilerplate-only match cannot qualify as coverage.
  assert.equal(terms, 1, 'only the boilerplate term matched');
  assert.ok(terms < 2, 'below the minimum-terms rule, so it is classified uncovered');
  assert.ok(score < 0.25, `and below the covered threshold, got ${score}`);
});

test('coverageScore rewards a genuine topical match', () => {
  const articleSets = [
    new Set(['support', 'refund', 'bank', 'returned', 'order']),
    new Set(['support', 'password', 'login']),
  ];
  const idf = buildIdf(articleSets);
  const question = new Set(['returned', 'order', 'refund', 'bank']);
  const { score, terms } = coverageScore(question, articleSets[0], idf);
  assert.equal(terms, 4);
  assert.ok(score > 0.9, `a full topical match should score high, got ${score}`);
});

// --- end to end ---

test('reports a genuinely uncovered topic as uncovered, not weakly covered', async () => {
  const { dir, articlesPath } = fixture(
    [
      { text: 'I returned my order and the refund has not arrived in my bank account, please investigate', count: 40 },
      // No article covers this.
      { text: 'I want to pay using cryptocurrency wallet transfer for international orders', count: 25 },
    ],
    [
      {
        id: 'a1',
        title: 'How refunds work and when your refund arrives',
        body: 'Returned orders are refunded to your bank account. Refund timelines and bank processing delays.',
        updated_at: '2026-02-01T00:00:00Z',
        views: 900,
      },
    ],
  );

  const { code, summary } = await run(dir, articlesPath);

  assert.equal(code, 0);
  assert.equal(summary.coverage.uncovered, 25, 'the uncovered topic is counted as uncovered');
  assert.equal(summary.coverage.weak, 0, 'generic overlap must not fake weak coverage');
  assert.equal(summary.coverage.covered, 40);

  const gapTerms = summary.top_gap_terms.map((g) => g.term);
  assert.ok(gapTerms.includes('cryptocurrency'), `gap named; got ${gapTerms}`);
  assert.ok(gapTerms.includes('wallet'));
  assert.ok(summary.uncovered_samples.length > 0, 'samples provided for review');
});

test('a single generic term match does not count as coverage', async () => {
  const { dir, articlesPath } = fixture(
    [{ text: 'cryptocurrency wallet transfer settlement latency', count: 10 }],
    [
      {
        id: 'a1',
        title: 'Wallet of receipts',
        body: 'Keep your wallet safe. Unrelated content about physical wallets and lost property.',
        updated_at: '2026-01-01T00:00:00Z',
      },
    ],
  );

  const { summary } = await run(dir, articlesPath);
  assert.equal(summary.coverage.uncovered, 10, 'one shared word is not coverage');
  assert.equal(summary.thresholds.min_terms_weak, 2);
});

test('flags stale articles and orders them by how much they are used', async () => {
  const { dir, articlesPath } = fixture(
    [{ text: 'I cannot log in, the password reset email never arrives in my inbox', count: 30 }],
    [
      {
        id: 'a1',
        title: 'Resetting your password and login access',
        body: 'If the password reset email does not arrive in your inbox, check spam. Login help.',
        updated_at: '2022-01-01T00:00:00Z',
        views: 400,
      },
      {
        id: 'a2',
        title: 'Office opening hours',
        body: 'We are open weekdays.',
        updated_at: '2019-06-01T00:00:00Z',
        views: 3,
      },
    ],
  );

  const { summary } = await run(dir, articlesPath);

  assert.equal(summary.stale_articles.length, 2);
  assert.equal(
    summary.stale_articles[0].id,
    'a1',
    'the stale article people actually hit is listed first',
  );
  assert.ok(summary.stale_articles[0].matched_conversations > 0);
  assert.ok(
    summary.caveats.some((c) => c.includes('grounding answers in it')),
    'explains why a used stale article is the worse problem',
  );
});

test('lists unused articles but warns against deleting them', async () => {
  const { dir, articlesPath } = fixture(
    [{ text: 'I returned my order and want a refund to my bank account', count: 20 }],
    [
      {
        id: 'a1',
        title: 'Refunds and returns',
        body: 'Returned orders are refunded to your bank account.',
        updated_at: '2026-02-01T00:00:00Z',
        views: 500,
      },
      {
        id: 'a2',
        title: 'How to update your marketing preferences',
        body: 'Marketing preference centre and newsletter subscription settings.',
        updated_at: '2026-02-01T00:00:00Z',
        views: 2000,
      },
    ],
  );

  const { summary } = await run(dir, articlesPath);

  assert.equal(summary.unused_articles.length, 1);
  assert.equal(summary.unused_articles[0].id, 'a2');
  assert.equal(summary.unused_articles[0].views, 2000, 'views are surfaced alongside');
  assert.ok(
    summary.caveats.some((c) => c.includes('preventing contacts')),
    'warns that an unmatched article may be doing its job',
  );
});

test('reports missing article metadata rather than assuming', async () => {
  const { dir, articlesPath } = fixture(
    [{ text: 'refund for my returned order please', count: 10 }],
    [{ id: 'a1', title: 'Refunds', body: 'Returned order refunds.' }],
  );

  const { summary } = await run(dir, articlesPath);
  assert.equal(summary.metadata_gaps.articles_without_updated_at, 1);
  assert.equal(summary.metadata_gaps.articles_without_views, 1);
  assert.equal(summary.stale_articles.length, 0, 'no updated_at means no staleness claim');
  assert.ok(summary.caveats.some((c) => c.includes('no view count')));
});

test('warns when only subjects were available for matching', async () => {
  const dir = tempOut('kb-');
  writeFileSync(
    join(dir, 'conversations.jsonl'),
    [conversation(1, 'Refund query'), conversation(2, 'Help')].map((c) => JSON.stringify(c)).join('\n') + '\n',
  );
  const articlesPath = join(dir, 'articles.jsonl');
  writeFileSync(articlesPath, JSON.stringify({ id: 'a1', title: 'Refunds', body: 'Refund query help' }) + '\n');

  const { summary } = await run(dir, articlesPath);
  assert.ok(
    summary.caveats.some((c) => c.includes('subjects are short') || c.includes('Subjects are short')),
    'warns that subject-only matching understates coverage',
  );
});

test('always states that matching is lexical and coverage is not deflection', async () => {
  const { dir, articlesPath } = fixture(
    [{ text: 'refund for returned order', count: 6 }],
    [{ id: 'a1', title: 'Refunds', body: 'Returned order refund process', updated_at: '2026-02-01T00:00:00Z', views: 10 }],
  );

  const { summary } = await run(dir, articlesPath);
  assert.ok(summary.caveats.some((c) => c.includes('not semantic')));
  assert.ok(
    summary.caveats.some((c) => c.includes('wrong article is worse than a missing one')),
    'the AI-grounding caveat is unconditional',
  );
});

test('requires both an export and an articles file', async () => {
  const missingArticles = await runScript(SCRIPT, ['/tmp/does-not-matter', '--json'], {});
  assert.equal(missingArticles.code, 1);
  assert.match(missingArticles.stderr, /--articles is required/);

  const dir = tempOut('kb-');
  writeFileSync(join(dir, 'conversations.jsonl'), JSON.stringify(conversation(1, 'x')) + '\n');
  const emptyArticles = join(dir, 'articles.jsonl');
  writeFileSync(emptyArticles, '');
  const { code, stderr } = await run(dir, emptyArticles);
  assert.equal(code, 1);
  assert.match(stderr, /no articles found/);
});
