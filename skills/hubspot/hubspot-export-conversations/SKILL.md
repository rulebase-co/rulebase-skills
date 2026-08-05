---
name: hubspot-export-conversations
description: Use to bulk-export HubSpot Service Hub conversation threads and messages for analytics, QA sampling, migrations, or LLM/RAG pipelines. Trigger for "export my HubSpot conversations", "pull HubSpot Service Hub data", "sync HubSpot inbox to our warehouse", incremental HubSpot sync, or when HubSpot message bodies look truncated or archived threads are missing.
metadata:
  author: rulebase
  version: "1.0.0"
  archetype: platform
  platform: hubspot
---

# HubSpot Service Hub: export conversations

Export HubSpot conversation threads and messages into the canonical
`conversations.jsonl` / `messages.jsonl` shape.

## Read this before writing any code

**Email message bodies are silently truncated.** This is the one that ruins
analyses. HubSpot truncates reply history in email messages and reports it in a
`truncationStatus` field with three values:

| `truncationStatus` | Meaning |
| --- | --- |
| `NOT_TRUNCATED` | The full body is present |
| `TRUNCATED_TO_MOST_RECENT_REPLY` | Only the latest reply; earlier history removed |
| `TRUNCATED` | The body is cut |

A truncated body is a valid-looking short message. Nothing in the text signals
that content is missing. If you ignore this field you will build a corpus, compute
message lengths, or run an LLM over conversations that are quietly incomplete —
and the error is invisible at every downstream step.

The script records `truncation_status` on every message, counts the totals, warns
on stderr, and sets `bodies_complete: false` in its summary. Full text requires
HubSpot's original-content endpoint, one call per affected message.

**Archived threads are excluded by default and permanently deleted after 30
days.** `--archived` fetches them, but there is no recovering anything older. If
you need archived history, the export window is 30 days wide, permanently.

**You can filter one inbox, not several.** Multiple `inboxId` values are not
supported. Omit the filter for all inboxes; use `--inbox-id` for exactly one.

**Rate limits vary by subscription.** Rather than hardcode a number that is wrong
for most accounts, the script reads the `X-HubSpot-RateLimit-*` response headers
and paces to 80% of the advertised rate, leaving headroom for other integrations.
It also reports the remaining daily allowance, which is the limit large exports
actually hit.

Endpoint and field detail: [references/api-notes.md](references/api-notes.md).

## Prerequisites

- Node 20+ (the script has no npm dependencies).
- A private app access token with the **`conversations.read`** scope. Adding a
  scope requires reinstalling the app — a token that predates the scope change
  keeps returning 403.

```bash
export HUBSPOT_ACCESS_TOKEN=…
```

Never pass the token as an argument.

## Usage

```bash
node scripts/export-conversations.mjs --start 2026-01-01 --out ./out/hubspot
```

**Arguments**

- `--start <when>` — watermark on `latestMessageTimestamp`. ISO date/timestamp,
  epoch seconds, or a relative window (`30d`, `12h`). Required unless `--resume`.
- `--out <dir>` — output directory. Default `./out/hubspot`.
- `--resume` — continue from `checkpoint.json`.
- `--only <both|conversations|messages>` — run one phase.
- `--archived` — include archived threads. Remembered across `--resume`.
- `--inbox-id <id>` — restrict to one inbox.
- `--concurrency <n>` — parallel message fetches. Default 4, max 10.
- `--no-bodies` — message structure and metadata without text.
- `--max-pages <n>` — stop after n list pages. Use to sample.

**Sample first**, and check the truncation counts in the output before planning
anything that depends on full message text:

```bash
node scripts/export-conversations.mjs --start 7d --max-pages 1 --out ./out/sample
```

**Archived threads need their own run**, because the flag changes the result set:

```bash
node scripts/export-conversations.mjs --start 30d --archived --out ./out/hubspot-archived
```

## Sizing the run

```
phase 1 requests ≈ threads / 500      (limit maxes at 500 — generous)
phase 2 requests ≈ threads            (one per thread)
```

Phase 1 is cheap. Phase 2 dominates. The binding constraint on large accounts is
usually the **daily** allowance rather than the per-interval rate, so check
`daily_remaining` in the summary and split very large exports across days using
`--resume`.

## What the export will not contain

- **Full email bodies where `truncationStatus` is not `NOT_TRUNCATED`.** Retrieving
  them needs the original-content endpoint per message. Implementing that fetch is
  a natural follow-up; it is deliberately not done here because the endpoint path
  should be confirmed against a live account first.
- **Archived threads older than 30 days.** Permanently deleted by HubSpot.
- **A channel on the conversation.** Channel lives on messages, not threads, so
  `channel` is `null` on conversations by design. Derive it per conversation from
  `messages.jsonl` if you need it.
- **The associated contact.** Thread objects carry no contact id; associations come
  from the CRM associations API, which this export does not call. `customer_id` is
  therefore `null`, which means **repeat-contact and deflection analysis needs a
  separate association pass**.
- **A subject.** `latestMessagePreview` is a body excerpt, not a subject, so using
  it would mislabel the field.
- **CSAT.** Feedback surveys are a separate API.

## Output

Canonical shape, shared with the other platform export skills in this catalog:

```
conversations.jsonl     one thread per line
messages.jsonl          one message per line, joins on conversation_source_id
conversation-ids.txt    ids discovered in phase 1
fetched-ids.txt         ids completed in phase 2 (resume journal)
checkpoint.json         resume state, including the after cursor
```

Normalisation notes:

- `OPEN` / `CLOSED` → canonical `open` / `closed`; `status_raw` keeps the original.
- **`actorId` prefixes are the author signal**: `V-` visitor → `customer`,
  `A-` agent → `agent`, `I-` integration → `bot`, `S-` system → `system`.
  Unrecognised prefixes become `unknown` rather than defaulting to agent.
- Message `type` of `COMMENT` is an **internal note**
  (`visibility: "internal"`); `MESSAGE` is customer-visible.
- `truncation_status` is a non-canonical field carried on every message. Filter on
  it before any analysis that depends on complete text.

## Handling the data

Message bodies are production PII.

- Never commit `.jsonl` exports to git.
- Do not paste message bodies into chat. Report counts, IDs, and aggregates.
- If the task only needs volumes or routing, run `--no-bodies`.

## Present results to the user

1. **Truncation first.** If any messages are truncated, lead with the count and
   state plainly that those bodies are incomplete. This determines what the export
   can legitimately be used for, so it outranks the volume numbers.
2. **Completeness** — phases finished, and the resume command if not.
3. **Volumes** — threads, messages, messages per thread.
4. **The `customer_id` gap.** State that thread objects carry no contact id, so
   per-customer analysis needs a CRM associations pass. Do not let a reader
   assume the export supports repeat-contact analysis as-is.
5. **Archived scope** — whether archived threads were included, and the 30-day
   limit if the user is trying to reconstruct history.
6. **Daily allowance remaining**, so the next run can be planned.
7. **Where the data is**, plus the PII reminder.

## Troubleshooting

**403 despite a valid-looking token** — the private app lacks
`conversations.read`, or the scope was added without reinstalling the app.

**Message bodies look oddly short** — check `truncation_status`. This is the
expected behaviour for email threads, not a bug in the export.

**No conversations at all** — confirm the account actually uses the conversations
inbox rather than only tickets. Tickets are a different object with a different
API.

**`customer_id` is null everywhere** — by design; see above.

**Archived threads missing** — pass `--archived`. Anything archived more than 30
days ago is gone.

**Hit the daily limit mid-run** — re-run with `--resume` the next day. Progress is
journalled per thread.
