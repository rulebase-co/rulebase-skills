---
name: zendesk-export-conversations
description: Use to bulk-export Zendesk tickets and conversation text for analytics, QA sampling, migrations, or LLM/RAG pipelines. Trigger for "export my Zendesk tickets", "pull Zendesk conversation history", "sync Zendesk to our warehouse", incremental Zendesk sync, or when a Zendesk export is hitting the Search API's 1,000-result cap or 429 rate limits.
metadata:
  author: rulebase
  version: "1.0.0"
  archetype: platform
  platform: zendesk
---

# Zendesk: export tickets and conversations

Export Zendesk ticket metadata and the actual message text, at any volume,
without hitting the traps that make most Zendesk exports silently incomplete.

## Read this before writing any code

Almost every first attempt at a Zendesk export is wrong in one of two ways.

**The Search API cannot page past 1,000 results.** `GET /api/v2/search.json`
returns at most 10 pages of 100. Ask for a year of tickets and you get 1,000 of
them and a `next_page` that stops working, with no error. Any export built on
Search is capped. `GET /api/v2/search/export` lifts the cap but is limited to
100 requests/minute per account, cannot sort, and still excludes archived
tickets.

**Comments are not on the ticket object.** The ticket payload has no message
text. The obvious fix — loop tickets, call `GET /api/v2/tickets/{id}/comments.json`
for each — is one request per ticket. At 200–700 requests/minute (your whole
account budget, shared with the live agent UI), 500,000 tickets is 12+ hours of
sustained saturation, and it will rate-limit your production Zendesk instance.

Use the **Incremental Exports API** for both, as two separate streams:

| Data | Endpoint | Pagination |
| --- | --- | --- |
| Ticket metadata | `/api/v2/incremental/tickets/cursor.json` | Cursor |
| Conversation text | `/api/v2/incremental/ticket_events.json?include=comment_events` | Time-based |

The second line is the non-obvious one. The `comment_events` sideload is
available on the **ticket events** export, not the ticket export, and it returns
comment bodies nested inside each event's `child_events` array. This turns
per-ticket comment fetching into one paged stream.

Full endpoint and field detail: [references/api-notes.md](references/api-notes.md).

## Prerequisites

- Node 20+ (the script has no npm dependencies).
- A Zendesk API token: Admin Center → Apps and integrations → APIs → Zendesk API
  → enable token access, then add a token.
- The token inherits its user's permissions. Use a **read-only** service agent
  where possible; an admin token is not required to export.

Export credentials to the environment. Never pass a token as a CLI argument —
argv shows up in shell history, in `ps`, and in agent transcripts.

```bash
export ZENDESK_SUBDOMAIN=acme        # for acme.zendesk.com
export ZENDESK_EMAIL=svc-export@acme.com
export ZENDESK_API_TOKEN=…
```

## Usage

```bash
node scripts/export-conversations.mjs --start 2026-01-01 --out ./out/zendesk
```

**Arguments**

- `--start <when>` — ISO date (`2026-01-01`), ISO timestamp, Unix epoch seconds,
  or a relative window (`30d`, `12h`, `4w`). Required unless `--resume`.
- `--out <dir>` — output directory. Default `./out/zendesk`.
- `--resume` — continue from `checkpoint.json` in the output directory.
- `--only <both|conversations|messages>` — run one stream. Default `both`.
- `--no-bodies` — export message structure and metadata without text.
- `--max-pages <n>` — stop after n pages per stream. Use this to sample first.

**Run the conversations stream before the messages stream.** The two incremental
streams are independent, and Zendesk puts no role flag on a comment — only an
author id. Author attribution works by comparing that id against the ticket's
requester, which needs `conversations.jsonl` to exist. Running `--only messages`
first leaves every message's `author_type` as `unknown`; the script warns when
this happens. The default `both` handles the ordering for you.

**Always sample before a full run.** A 2-page sample confirms auth, field shape,
and volume ratios in under a minute:

```bash
node scripts/export-conversations.mjs --start 7d --max-pages 2 --out ./out/sample
```

**Resume after an interruption.** The checkpoint is written after every page, so
a killed run loses at most one page:

```bash
node scripts/export-conversations.mjs --resume --out ./out/zendesk
```

## Sizing the run before you start it

Incremental export endpoints allow **10 requests/minute** at 1,000 records per
page — a ceiling of 600,000 records/hour per stream. Estimate both streams
separately:

- **Tickets**: 1 record per ticket. 1M tickets ≈ 1.7 hours.
- **Comment events**: the events stream returns *every* event type — status
  changes, tag edits, notifications — not just comments. Expect several times
  more events than tickets. This stream is almost always the long pole.

Run the sample, read the reported `events -> comments` ratio, and multiply. If
the projection is over ~8 hours, narrow `--start`, or run month-by-month windows
in sequence so each run is independently resumable.

## What the export will not contain

Reconcile these before anyone treats the output as complete:

- **Permanently deleted tickets** are gone. Soft-deleted tickets do appear, with
  `status: "deleted"` — the script keeps them and flags `is_deleted` so counts
  reconcile against the Zendesk UI.
- **Redacted comment text** is irreversibly removed from the API.
- **Voice recordings and transcripts** are not in comments; Talk exposes them
  through separate endpoints.
- **Side conversations** (the internal email/Slack threads on a ticket) live in
  a separate API and are not in `ticket_events`.
- **The most recent ~60 seconds** is withheld by Zendesk to prevent race
  conditions. The script clamps `--start` back 90s rather than requesting a
  window that returns nothing.
- **`end_of_stream: true` means "caught up to now"**, not "you have all
  history". History depth is governed by your `--start`.

## Output

Canonical shape, shared with the other platform export skills in this catalog:

```
conversations.jsonl   one conversation per line
messages.jsonl        one message per line, joins on conversation_source_id
checkpoint.json       resume state
```

Notable normalisations:

- `solved` → `resolved` and `hold` → `pending`, with `status_raw` preserved. The
  solved/closed distinction matters — solved tickets can be reopened — so use
  `status_raw` when measuring reopen rate.
- `satisfaction_rating` → `csat` as 1 (`good`) or 0 (`bad`). **`offered` and
  `unoffered` become `null`, not 0** — they mean a survey was or wasn't sent, and
  mapping them to zero fabricates negative feedback.
- `plain_body` → `body`. `body` carries quoted email history, which inflates
  length and token metrics.
- `public: false` → `visibility: "internal"`.
- Ids are stringified, because large integer ids lose precision in JavaScript and
  some warehouse loaders.

Field-by-field schema and analysis recipes:
[references/normalized-schema.md](references/normalized-schema.md).

The script writes a JSON summary to stdout and all progress to stderr, so you
can capture the summary cleanly:

```bash
node scripts/export-conversations.mjs --start 30d > summary.json
```

## Handling the data

Transcripts are production PII — names, addresses, card fragments, account
details, and financial or health disclosures.

- Never commit `.jsonl` exports to git.
- Write exports outside any repo, or to a gitignored path.
- Do not paste transcript bodies into chat. Report counts, IDs, and aggregates.
  If you must show an example, redact it and say that you did.
- If the task only needs volumes, routing, or timing, run `--no-bodies` and
  avoid handling message text at all.

## Present results to the user

After a run, report:

1. **Window and completeness** — the `--start` used, and whether each stream
   reached `end_of_stream`. If either is incomplete, say so first and give the
   resume command.
2. **Volumes** — tickets, comments, and the events-to-comments ratio.
3. **Cost** — requests used and elapsed time, so the next window can be sized.
4. **Reconciliation** — compare the ticket count against the same window in the
   Zendesk UI. A gap larger than the deleted-ticket count needs investigation
   before the data is used.
5. **Where the data is**, and an explicit reminder that it contains PII and is
   not to be committed.

Do not summarise ticket content unless that was the actual request.

## Troubleshooting

**401 or 403** — token access is disabled in Admin Center, the email/token pair
is wrong, or the user lacks export permission. The email must be the token
owner's, and auth is `{email}/token:{api_token}`, not `{email}:{api_token}`.

**429s despite the built-in throttle** — something else is consuming the account
budget (a live integration, another export). The script honours `Retry-After`
and continues; if it persists, run outside business hours.

**`end_time did not advance`** — more than 1,000 ticket events share a single
second, so the time-based cursor cannot move. The script fails loudly rather
than looping. Export that period with a narrower window, or fall back to
per-ticket comment fetching for the affected range.

**Comment count far below expectations** — check whether `--no-bodies` was set,
and confirm the `include=comment_events` sideload is present in the URL. Without
it the events stream returns events with no comment bodies at all.

**Tickets present but no comments for them** — the two streams are paged
independently, so a partial run can leave them out of sync. Let both reach
`end_of_stream` before joining.
