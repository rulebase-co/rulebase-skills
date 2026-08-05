---
name: gorgias-export-conversations
description: Use to bulk-export Gorgias tickets and message text for analytics, QA sampling, migrations, or LLM/RAG pipelines. Trigger for "export my Gorgias tickets", "pull Gorgias data", "sync Gorgias to our warehouse", incremental Gorgias sync, or when a Gorgias export is missing message bodies, returning only excerpts, or hitting 429 rate limits.
metadata:
  author: rulebase
  version: "1.0.0"
  archetype: platform
  platform: gorgias
---

# Gorgias: export tickets and messages

Export Gorgias tickets and message text into the canonical
`conversations.jsonl` / `messages.jsonl` shape.

## Read this before writing any code

**There is no time filter on the ticket list.** `GET /api/tickets` accepts
`order_by`, `view_id`, `customer_id`, and a few id filters — but nothing like
`updated_since`. You cannot express "tickets changed since yesterday" as a query.

The only correct incremental strategy is therefore:

1. Order by `updated_datetime:desc` — newest first.
2. Page forward.
3. **Stop as soon as a page contains a ticket older than your watermark.**

That early stop is the whole mechanism. Ordering ascending and paging to the end
works for a first full export but re-reads all history on every subsequent run.

**List tickets returns no message bodies.** The `TicketCompact` object carries
only an `excerpt` — the tail of the last message. Teams routinely build a
pipeline on `excerpt`, get plausible-looking text, and only later discover they
have one truncated fragment per ticket instead of a conversation. Message text
requires `GET /api/tickets/{id}/messages`, one call per ticket.

**Rate limiting is a leaky bucket, and API keys get the smaller bucket.** API key
integrations get 40 requests per 20 seconds; OAuth2 apps get 80. Enterprise
accounts have the same counts over a shorter 10-second window. Bursting into the
bucket wastes the run on 429s, so the script paces to a sustained rate.

Endpoint and field detail: [references/api-notes.md](references/api-notes.md).

## Prerequisites

- Node 20+ (the script has no npm dependencies).
- An API key from Settings → REST API.
- **Auth is Basic with the account email as username and the key as password.**
  Sending the key alone produces a 401 that looks like a bad key.

```bash
export GORGIAS_DOMAIN=acme        # for acme.gorgias.com
export GORGIAS_EMAIL=svc@acme.com
export GORGIAS_API_KEY=…
```

Never pass the key as an argument; argv appears in shell history, `ps`, and agent
transcripts.

## Usage

```bash
node scripts/export-conversations.mjs --start 2026-01-01 --out ./out/gorgias
```

**Arguments**

- `--start <when>` — the watermark. ISO date/timestamp, epoch seconds, or a
  relative window (`30d`, `12h`). Tickets updated before this are skipped.
  Required unless `--resume`. **For a full history export, pass a date before the
  account existed** (`--start 2010-01-01`).
- `--out <dir>` — output directory. Default `./out/gorgias`.
- `--resume` — continue from `checkpoint.json`.
- `--only <both|conversations|messages>` — run one phase.
- `--concurrency <n>` — parallel message fetches. Default 3, max 8.
- `--no-bodies` — message structure and metadata without text.
- `--max-pages <n>` — stop after n list pages. Use to sample.

**Sample first.** This confirms auth and shows the messages-per-ticket ratio that
determines phase 2's cost:

```bash
node scripts/export-conversations.mjs --start 7d --max-pages 1 --out ./out/sample
```

**Resume is per ticket.** Phase 2 journals every fetched id, so an interrupted
run continues rather than repeating the N+1:

```bash
node scripts/export-conversations.mjs --resume --out ./out/gorgias
```

## Sizing the run

```
phase 1 requests ≈ tickets / 100
phase 2 requests ≈ tickets          (one per ticket, more if >100 messages)
```

Phase 2 dominates. At the API-key rate of 40 requests per 20 seconds — 120 per
minute — 100,000 tickets is roughly 14 hours. Use an OAuth2 app if you can; it
doubles the budget.

Set `GORGIAS_RATE_PER_20S=80` when running as an OAuth2 app. Leave it at the
default 40 for API keys. Do not raise it above your actual bucket: the leaky
bucket refills gradually, so over-pacing produces sustained 429s rather than a
faster run.

## What the export will not contain

- **Trashed tickets** unless you request them; the script marks anything with
  `trashed_datetime` as `is_deleted`.
- **Satisfaction survey scores.** A separate resource with an
  account-configurable scale, so `csat` is `null` rather than guessed.
- **Ticket events and rule executions.** Separate endpoints, needed for audit
  trails or automation analysis.
- **Attachment contents.** Only a count is exported.
- **Anything before the watermark.** The stop is on `updated_datetime`, so a
  ticket created long ago but touched recently *is* included — right for
  incremental sync, wrong for reconstructing a fixed historical window.

## Output

Canonical shape, shared with the other platform export skills in this catalog:

```
conversations.jsonl     one ticket per line
messages.jsonl          one message per line, joins on conversation_source_id
conversation-ids.txt    ids discovered in phase 1
fetched-ids.txt         ids completed in phase 2 (resume journal)
checkpoint.json         resume state, including the list cursor
```

Normalisation notes:

- Gorgias has only `open` and `closed` statuses; `status_raw` keeps the original.
- `from_agent` is the author signal — `false` is the customer. It is absent on
  some integration-authored messages, so the script falls back to comparing the
  message sender against the ticket customer.
- `public: false` marks an **internal note** (`visibility: "internal"`).
- `body_text` is preferred over `body_html`.

## Handling the data

Message bodies are production PII — names, addresses, order and payment details.

- Never commit `.jsonl` exports to git.
- Do not paste message bodies into chat. Report counts, IDs, and aggregates.
- If the task only needs volumes or routing, run `--no-bodies`.

## Present results to the user

1. **Completeness** — whether phase 1 reached the watermark or the end of the
   list, and whether phase 2 finished. If not, lead with that and the resume
   command.
2. **Volumes** — tickets, messages, messages per ticket.
3. **Watermark effect** — how many tickets were skipped as older than the
   watermark. A large number on a supposedly incremental run means the watermark
   is wrong.
4. **Cost** — requests and elapsed time, so the next window can be sized.
5. **Reconciliation** — compare the ticket count against the same period in
   Gorgias. Investigate a material gap before using the data.
6. **Where the data is**, plus the PII reminder.

## Troubleshooting

**401** — auth is `email:api_key`, not the key alone.

**Message text is one short fragment per ticket** — you used the list endpoint's
`excerpt` rather than fetching messages. `excerpt` is the tail of the last
message, never the conversation.

**Sustained 429s** — the pacing rate exceeds your bucket. API keys get 40/20s;
lower `GORGIAS_RATE_PER_20S` and re-run. Progress is journalled, so nothing is
lost.

**The export re-reads everything on every run** — the watermark is not being
passed, or `--start` is older than intended. Incremental behaviour depends
entirely on the early stop.

**Tickets appear that you expected to be filtered out** — Gorgias has no
server-side time filter, so all filtering is client-side on
`updated_datetime`. Check the watermark rather than looking for a query
parameter.
