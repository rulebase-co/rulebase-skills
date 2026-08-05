#!/usr/bin/env node
/**
 * Builds an erasure plan for a data-subject request from a canonical export.
 * Read-only: it decides nothing and changes nothing.
 *
 * The two distinctions that make or break a DSR erasure:
 *
 *   1. Is the subject the REQUESTER of the conversation, or merely MENTIONED in
 *      someone else's? You may erase your own customer's record. You must not
 *      delete a different customer's conversation because this subject appears in
 *      it — that destroys another person's data and your own records. Mentions get
 *      targeted redaction, never deletion.
 *
 *   2. Is the conversation open or closed? On most helpdesks (Zendesk included)
 *      comments in a CLOSED conversation cannot be redacted at all. The only
 *      remedy there is deleting the whole conversation — which is unavailable for
 *      a mention. That combination is a genuine dead end requiring a human
 *      decision, and this plan surfaces it rather than silently skipping it.
 *
 * No npm dependencies. Node 20+.
 *
 *   node scripts/build-erasure-plan.mjs ./out/zendesk --subject-email jo@example.com
 */

import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';

// Statuses where in-place redaction is generally unavailable.
const UNREDACTABLE_STATUSES = new Set(['closed']);

function parseArgs(argv) {
  const opts = {
    dir: null,
    out: './plans',
    ids: [],
    emails: [],
    phones: [],
    subjectsFile: null,
    holdFile: null,
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
      case '--subject-id': opts.ids.push(next()); break;
      case '--subject-email': opts.emails.push(next().toLowerCase()); break;
      case '--subject-phone': opts.phones.push(next()); break;
      case '--subjects-file': opts.subjectsFile = next(); break;
      case '--legal-hold-file': opts.holdFile = next(); break;
      case '--json': opts.json = true; break;
      case '--help': case '-h': usage(); process.exit(0);
      default:
        if (!opts.dir && !arg.startsWith('-')) { opts.dir = arg; break; }
        fail(`unknown argument: ${arg}`);
    }
  }
  if (!opts.dir) fail('a canonical export directory is required');

  if (opts.subjectsFile) {
    if (!existsSync(opts.subjectsFile)) fail(`--subjects-file ${opts.subjectsFile} does not exist`);
    for (const line of readFileSync(opts.subjectsFile, 'utf8').split('\n')) {
      const value = line.trim();
      if (!value || value.startsWith('#')) continue;
      if (value.includes('@')) opts.emails.push(value.toLowerCase());
      else if (/^\+?[\d\s()-]{7,}$/.test(value)) opts.phones.push(value);
      else opts.ids.push(value);
    }
  }

  if (opts.ids.length + opts.emails.length + opts.phones.length === 0) {
    fail(
      'at least one subject identifier is required (--subject-id, --subject-email, ' +
        '--subject-phone, or --subjects-file)',
    );
  }
  return opts;
}

function usage() {
  process.stderr.write(`
Usage: node scripts/build-erasure-plan.mjs <export-dir> [subject...] [options]

  <export-dir>              Canonical export (conversations.jsonl, messages.jsonl).
  --subject-id <id>          Customer id. Repeatable.
  --subject-email <email>    Email address. Repeatable.
  --subject-phone <number>   Phone number. Repeatable.
  --subjects-file <path>     One identifier per line; type inferred.
  --legal-hold-file <path>   Conversation ids that must NOT be erased, one per
                             line. Retention obligations usually override erasure.
  --out <dir>                Where to write the plan. Default ./plans.
  --json                     Emit only JSON on stdout.

Read-only. Produces a plan for legal/compliance review; applying it is a separate
platform skill.
`);
}

function fail(message) {
  process.stderr.write(`error: ${message}\n`);
  process.exit(1);
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

/** Digits-only comparison, so +44 20 1234 5678 matches 442012345678. */
const digits = (s) => String(s).replace(/\D/g, '');

/**
 * Finds occurrences of subject identifiers in free text and returns the EXACT
 * substrings present. Redaction APIs take a literal string, so a normalised form
 * would not match anything.
 */
export function findLiterals(text, { emails, phones }) {
  if (typeof text !== 'string' || text === '') return [];
  const found = new Set();
  const lower = text.toLowerCase();

  for (const email of emails) {
    let index = lower.indexOf(email);
    while (index !== -1) {
      found.add(text.slice(index, index + email.length));
      index = lower.indexOf(email, index + 1);
    }
  }

  for (const phone of phones) {
    const target = digits(phone);
    if (target.length < 7) continue;
    // Scan candidate phone-shaped runs and compare on digits only.
    for (const match of text.matchAll(/\+?[\d][\d\s()./-]{5,}\d/g)) {
      if (digits(match[0]).endsWith(target) || target.endsWith(digits(match[0]))) {
        found.add(match[0].trim());
      }
    }
  }

  return [...found];
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  const conversations = await readJsonl(join(opts.dir, 'conversations.jsonl'));
  if (conversations.length === 0) fail(`no conversations found in ${opts.dir}`);
  const messages = await readJsonl(join(opts.dir, 'messages.jsonl'));

  const legalHold = new Set();
  if (opts.holdFile) {
    if (!existsSync(opts.holdFile)) fail(`--legal-hold-file ${opts.holdFile} does not exist`);
    for (const line of readFileSync(opts.holdFile, 'utf8').split('\n')) {
      if (line.trim()) legalHold.add(line.trim());
    }
  }

  const subjectIds = new Set(opts.ids.map(String));
  const matcher = { emails: opts.emails, phones: opts.phones };

  const messagesByConversation = new Map();
  for (const message of messages) {
    const key = String(message.conversation_source_id);
    if (!messagesByConversation.has(key)) messagesByConversation.set(key, []);
    messagesByConversation.get(key).push(message);
  }

  const plan = [];
  const stats = {
    conversations_scanned: conversations.length,
    subject_is_requester: 0,
    subject_mentioned_only: 0,
    on_legal_hold: 0,
    blocked_closed_mention: 0,
  };

  for (const conversation of conversations) {
    const id = String(conversation.source_id);
    const conversationMessages = messagesByConversation.get(id) ?? [];

    const isRequester =
      (conversation.customer_id && subjectIds.has(String(conversation.customer_id))) ||
      conversationMessages.some(
        (m) => m.author_type === 'customer' && m.author_id && subjectIds.has(String(m.author_id)),
      );

    // Collect literal occurrences to redact, per message.
    const redactions = [];
    for (const message of conversationMessages) {
      const literals = findLiterals(message.body, matcher);
      if (literals.length > 0) {
        redactions.push({ message_source_id: String(message.source_id), literals });
      }
    }
    const subjectLiteralsInText = redactions.length > 0;

    // Subject-owned metadata is also a match even when no text mentions them.
    if (!isRequester && !subjectLiteralsInText) continue;

    const status = conversation.status;
    const redactable = !UNREDACTABLE_STATUSES.has(status);

    let action;
    let reason;
    let blocked = false;

    if (legalHold.has(id)) {
      action = 'blocked_legal_hold';
      reason =
        'On legal hold. A retention obligation normally overrides an erasure request; ' +
        'compliance must decide.';
      blocked = true;
      stats.on_legal_hold++;
    } else if (isRequester) {
      stats.subject_is_requester++;
      if (redactable) {
        action = 'redact_messages';
        reason =
          'Subject is the requester and the conversation is open, so identifying text can be ' +
          'redacted in place.';
      } else {
        action = 'delete_conversation';
        reason =
          `Subject is the requester but the conversation is ${status}; comments in a closed ` +
          'conversation cannot be redacted. Deleting the whole conversation is the only remedy.';
      }
    } else {
      // Subject appears in someone else's conversation.
      stats.subject_mentioned_only++;
      if (redactable) {
        action = 'redact_messages';
        reason =
          "Subject is mentioned in another customer's conversation. Redact the mentions only — " +
          'never delete, because the conversation is another data subject\'s record.';
      } else {
        action = 'manual_review';
        reason =
          `Subject is mentioned in another customer's ${status} conversation. Redaction is ` +
          'unavailable on closed conversations and deletion would destroy another data ' +
          "subject's record. There is no automated remedy; escalate to compliance.";
        blocked = true;
        stats.blocked_closed_mention++;
      }
    }

    plan.push({
      source: conversation.source,
      conversation_source_id: id,
      action,
      reason,
      blocked,
      subject_role: isRequester ? 'requester' : 'mentioned',
      status,
      created_at: conversation.created_at,
      customer_id: conversation.customer_id ?? null,
      message_count: conversationMessages.length,
      redactions: action === 'redact_messages' ? redactions : [],
      redaction_literal_count: redactions.reduce((n, r) => n + r.literals.length, 0),
    });
  }

  plan.sort((a, b) => {
    const rank = { manual_review: 0, blocked_legal_hold: 1, delete_conversation: 2, redact_messages: 3 };
    return rank[a.action] - rank[b.action];
  });

  mkdirSync(opts.out, { recursive: true });
  const planPath = join(opts.out, 'erasure-plan.jsonl');
  writeFileSync(planPath, plan.map((p) => JSON.stringify(p)).join('\n') + (plan.length ? '\n' : ''));

  const byAction = {};
  for (const entry of plan) byAction[entry.action] = (byAction[entry.action] ?? 0) + 1;

  const report = {
    export_dir: opts.dir,
    plan_path: planPath,
    subjects: { ids: opts.ids, emails: opts.emails, phones: opts.phones },
    legal_hold_entries: legalHold.size,
    matched_conversations: plan.length,
    by_action: byAction,
    stats,
    out_of_scope: outOfScope(),
    caveats: buildCaveats(stats, plan, messages.length),
  };

  if (!opts.json) process.stderr.write(render(report, plan));
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
}

/**
 * Erasing from the helpdesk is not erasing from your business. Naming these
 * explicitly is the most useful thing this plan does, because a DSR response
 * that only covers the helpdesk is incomplete and the gap is invisible.
 */
function outOfScope() {
  return [
    'Attachments and inline images — files are not text and are not covered by comment redaction.',
    'Voice recordings and their transcripts — separate storage, separate deletion path.',
    'Your data warehouse, BI tool, and any dbt/analytics models built from exported conversations.',
    'Canonical exports on disk, including ones produced by this catalog. Delete those too.',
    'Search indexes and caches, which can retain content after the source is redacted.',
    'Backups and point-in-time snapshots — usually retained under a separate policy.',
    'Any LLM fine-tuning set, embedding store, or RAG index built from conversation text. ' +
      'Embeddings are derived personal data; deleting the source row does not remove the vector.',
    'Downstream integrations: CRM, marketing tools, Slack notifications containing ticket text.',
    'Email: the original inbound messages in your mail provider.',
  ];
}

function buildCaveats(stats, plan, messageCount) {
  const caveats = [];

  if (messageCount === 0) {
    caveats.push(
      'No messages.jsonl was found, so text mentions could not be scanned. Only conversations ' +
        'the subject requested were matched — mentions in other customers\' conversations are ' +
        'invisible. Re-export with message bodies before treating this plan as complete.',
    );
  }
  if (stats.blocked_closed_mention > 0) {
    caveats.push(
      `${stats.blocked_closed_mention} conversation(s) have no automated remedy: the subject is ` +
        'mentioned in another customer\'s closed conversation, where redaction is unavailable and ' +
        'deletion would destroy someone else\'s record. These need a compliance decision, and they ' +
        'are the entries most likely to be quietly dropped by a naive process.',
    );
  }
  if (stats.on_legal_hold > 0) {
    caveats.push(
      `${stats.on_legal_hold} conversation(s) are on legal hold and are excluded from erasure. ` +
        'Confirm the basis for retention is documented in the DSR response.',
    );
  }
  if (stats.subject_mentioned_only > 0) {
    caveats.push(
      `${stats.subject_mentioned_only} conversation(s) mention the subject without them being the ` +
        'requester. These are redact-only. Deleting them would erase another data subject\'s ' +
        'record — the plan never proposes it, and no flag enables it.',
    );
  }
  const deletions = plan.filter((p) => p.action === 'delete_conversation').length;
  if (deletions > 0) {
    caveats.push(
      `${deletions} conversation(s) are closed and can only be erased by deleting the whole ` +
        'conversation, losing the operational record. If that record has value, ask compliance ' +
        'whether redaction-on-reopen is acceptable instead.',
    );
  }
  caveats.push(
    'Identifier matching is literal. A subject referred to by nickname, a misspelt email, or a ' +
      'phone number written unusually will not be found. Supply every known identifier, and treat ' +
      'this as a high-recall aid rather than a guarantee of completeness.',
  );
  caveats.push(
    'Redaction and deletion are irreversible. Review this plan with compliance before applying it.',
  );

  return caveats;
}

function render(report, plan) {
  const lines = [''];
  lines.push(`export:   ${report.export_dir}`);
  lines.push(
    `subjects: ${report.subjects.ids.length} id(s), ${report.subjects.emails.length} email(s), ` +
      `${report.subjects.phones.length} phone(s)`,
  );
  lines.push(`matched:  ${report.matched_conversations} conversations`);
  lines.push('');
  for (const [action, count] of Object.entries(report.by_action)) {
    lines.push(`  ${action.padEnd(22)} ${count}`);
  }
  lines.push('');
  lines.push(`plan written to: ${report.plan_path}`);

  const blocked = plan.filter((p) => p.blocked);
  if (blocked.length > 0) {
    lines.push('');
    lines.push('  NEEDS A HUMAN DECISION');
    for (const entry of blocked.slice(0, 10)) {
      lines.push(`    ${entry.conversation_source_id} (${entry.status}): ${entry.reason}`);
    }
    if (blocked.length > 10) lines.push(`    ... and ${blocked.length - 10} more`);
  }

  lines.push('');
  lines.push('  NOT covered by this plan — erase these separately');
  for (const item of report.out_of_scope) lines.push(`    - ${item}`);

  lines.push('');
  lines.push('  caveats');
  for (const caveat of report.caveats) lines.push(`    - ${caveat}`);
  lines.push('');

  return lines.join('\n');
}

await main();
