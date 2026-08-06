---
name: cx-conversation-schema
description: Use to define or validate a normalised cross-platform schema for support conversations, so analyses work the same across Zendesk, Intercom, Freshdesk, Five9 and others. Trigger for "normalise our support data", "unify conversations from multiple helpdesks", "validate our conversation export", building a support data warehouse or CX data model, migrating between helpdesks, or checking whether an export is safe to analyse.
metadata:
  author: rulebase
  version: "1.0.0"
  archetype: playbook
---

# Canonical conversation schema

One schema for support conversations across every platform, so a metric is
written once and runs anywhere. Includes a validator that catches the export
problems which look fine and produce wrong answers.

## Why normalise at all

Every helpdesk models the same thing differently, and the differences are exactly
where analyses break:

- Zendesk has 7 statuses, Freshdesk has 4 numeric codes plus custom ones,
  Intercom has 3, Five9 has dispositions and no open/closed concept at all.
- "Internal note" is `public: false` in Zendesk, `private: true` in Freshdesk, and
  `part_type: "note"` in Intercom.
- CSAT is good/bad in Zendesk, 1–5 in Intercom, a configurable scale in Freshdesk,
  and a separate report in Five9.
- Message bodies are plain text in one place, HTML in another, and absent from
  list endpoints in a third.

Without a shared schema every metric gets reimplemented per platform, and the
implementations disagree. With one, the platform-specific knowledge lives in the
export step and every analysis downstream is portable.

## The schema

Two newline-delimited JSON files. JSONL because exports stream, append safely
across resumed runs, and never need to fit in memory.

### `conversations.jsonl`

| Field | Type | Notes |
| --- | --- | --- |
| `source` | string | Platform: `zendesk`, `intercom`, `freshdesk`, `five9`, … |
| `source_id` | **string** | Native id. Always a string — see below |
| `subject` | string \| null | |
| `status` | enum | `open` `pending` `resolved` `closed` `snoozed` `deleted` |
| `status_raw` | any | The platform's original value, always preserved |
| `channel` | enum \| null | `email` `chat` `messaging` `voice` `social` `web_form` `api` `other` |
| `channel_raw` | any | Original value |
| `customer_id` | string \| null | Stable customer identity — the most important field |
| `assignee_id` | string \| null | |
| `team_id` | string \| null | Group, queue, or skill |
| `account_id` | string \| null | Organisation or company |
| `created_at` | ISO 8601 | |
| `updated_at` | ISO 8601 \| null | |
| `resolved_at` | ISO 8601 \| null | |
| `csat` | number \| null | **Normalised to 0–1** |
| `csat_raw` | any | Original score on the platform's own scale |
| `priority` | string \| null | `low` `medium` `high` `urgent` |
| `tags` | string[] | |
| `is_deleted` | boolean | |

### `messages.jsonl`

| Field | Type | Notes |
| --- | --- | --- |
| `source` | string | |
| `conversation_source_id` | string | Join key to `conversations.source_id` |
| `source_id` | string | Message id |
| `created_at` | ISO 8601 | |
| `author_id` | string \| null | |
| `author_type` | enum | `customer` `agent` `bot` `system` `unknown` |
| `visibility` | enum | `public` `internal` |
| `channel` | enum \| null | Can differ from the conversation's |
| `attachment_count` | number | |
| `body` | string \| null | **Plain text**, never HTML |

Voice-only sources (Five9) produce `conversations.jsonl` alone — a call has no
message list.

## Four rules that carry all the weight

**1. `source_id` is always a string.** Zendesk and Freshdesk use integers,
Intercom uses numeric strings, Five9 uses opaque call ids. Left as native types
they compare unequal across systems, and large integer ids lose precision in
JavaScript and some warehouse loaders. Stringify at export.

**2. Always keep `*_raw` beside every normalised field.** Normalisation is lossy
and mappings are wrong sometimes — a custom Freshdesk status, a new Intercom
author type. Keeping the original makes a bad mapping auditable rather than
invisible, and lets you re-normalise without re-exporting.

**3. `author_type` is the field most likely to be wrong.** Role flags are
unreliable: they are absent on older records, inconsistent for bot-authored
messages, and change between API versions. Use the platform's flag first, then
**fall back to comparing `author_id` against the conversation's `customer_id`** —
that comparison is stable everywhere. Never default to `agent`; use `unknown` and
let the validator surface the share.

**4. `visibility` must be right or customer-facing metrics are wrong.** Internal
notes are not messages to the customer. Counting them inflates response counts,
corrupts first-response time, and poisons a RAG corpus with staff commentary.

Per-platform mapping tables: [references/platform-mappings.md](references/platform-mappings.md).

## Validate before you analyse

```bash
node scripts/validate-export.mjs ./out/zendesk
node scripts/validate-export.mjs ./out/five9 --no-messages
```

It checks structure — required fields, enum vocabulary, ISO timestamps, `csat` in
range, duplicate ids — and the semantic problems that matter more:

| Check | Why it matters |
| --- | --- |
| Orphaned messages | A message whose conversation is missing means the two phases are out of sync; joins silently drop rows |
| Conversations with no messages | Usually an interrupted export, not a real empty conversation |
| `author_type: unknown` share | Above 5%, response-time and turn-count metrics are unreliable |
| Zero customer messages | The author mapping is inverted or broken |
| Messages predating their conversation | Timezone or epoch-conversion bug |
| Missing `customer_id` share | Those rows cannot join for repeat-contact or deflection work |

Exits non-zero on errors, and prints a distribution summary that is itself a good
sanity check — a channel breakdown with everything in `other`, or a status
breakdown that is 100% `closed`, usually means a mapping is wrong.

Run it on every export, including incremental ones. It is cheap and it catches
the failures that otherwise surface as an inexplicable metric three weeks later.

## Deriving analysis inputs

The canonical export is the base layer. Most analyses need a derived view.

**Deflection / containment analysis** needs one row per contact with
`handled_by`, `handed_off`, and `resolved`. Derive it by aggregating messages:

```sql
-- contacts.jsonl input for cx-deflection-analysis
SELECT c.source_id                                            AS id,
       c.customer_id,
       c.created_at                                           AS started_at,
       coalesce(c.resolved_at, c.updated_at)                  AS ended_at,
       c.channel,
       CASE WHEN bool_or(m.author_type = 'bot')
             AND NOT bool_or(m.author_type = 'agent')
            THEN 'bot' ELSE 'human' END                       AS handled_by,
       bool_or(m.author_type = 'bot') AND bool_or(m.author_type = 'agent')
                                                              AS handed_off,
       -- Substitute your own resolution signal; see the caveat below.
       NULL::boolean                                          AS resolved
FROM conversations c
LEFT JOIN messages m ON m.conversation_source_id = c.source_id
WHERE NOT c.is_deleted
GROUP BY c.source_id, c.customer_id, c.created_at, c.resolved_at, c.updated_at, c.channel;
```

Two caveats on that query. A bot session that ends with an agent message is a
handoff, which is why `handed_off` requires both author types present. And
`resolved` is deliberately null: the canonical schema has no resolution signal,
because none of these platforms provides a reliable one. Supply your own or accept
that contained and abandoned sessions cannot be separated.

**First response time** needs the first public agent message:

```sql
SELECT c.channel,
       median(date_diff('minute', c.created_at::TIMESTAMP, r.replied_at)) AS median_frt_minutes
FROM conversations c
JOIN (
  SELECT conversation_source_id, min(created_at::TIMESTAMP) AS replied_at
  FROM messages
  WHERE visibility = 'public' AND author_type IN ('agent', 'bot')
  GROUP BY 1
) r ON r.conversation_source_id = c.source_id
WHERE NOT c.is_deleted
GROUP BY 1;
```

Filtering on `visibility = 'public'` is what makes this correct. Including
internal notes makes first response time look far better than it is — one of the
most common reporting errors in support analytics.

## Cross-platform identity

The hardest part of a multi-platform model, and the one that quietly invalidates
analyses.

`customer_id` must mean the same person across sources, or cross-channel work is
impossible. Common failure: Zendesk keys on its own user id, Intercom on its
contact id, Five9 on a phone number. Three ids, one human, no join.

Resolution strategies, best first:

1. **Your own application user id**, written into each platform as an external id
   or custom field. The only approach that fully works, and it has to be set up
   before the data is created.
2. **Verified email**, normalised to lowercase. Good across digital channels,
   useless for voice.
3. **Phone in E.164**, for voice. Note that a phone number is not a stable
   identity: it changes, is shared within households, and is withheld for blocked
   calls.
4. **CRM contact record** as the join hub.
5. **Probabilistic matching.** Workable, but report the match rate and treat
   unmatched records as a separate stratum.

Whatever you use, **report the cross-platform match rate**. If only 60% of Five9
calls resolve to a customer who also appears in Zendesk, every cross-channel
finding is measured on 60% of the data and needs that caveat attached.

Prefix ids when merging sources so an accidental collision is impossible:
`zendesk:12345`, `five9:c-abc`. Keep `source` and `source_id` separate as well, so
you can always get back to the native record.

## Present results to the user

1. **Validator verdict first** — pass, pass-with-warnings, or fail. If it failed,
   the export is not ready and no numbers should be quoted from it.
2. **Distribution summary** — sources, statuses, channels, author types. Call out
   anything degenerate: everything in `other`, no customer messages, all one
   status.
3. **Coverage gaps** — the share of conversations with no messages, missing
   `customer_id`, or `unknown` author type, and which analyses each blocks.
4. **Mapping decisions you made**, especially any status or channel you mapped to
   a fallback. These are the assumptions someone will need to check.
5. **Identity match rate**, if more than one source is in play.
