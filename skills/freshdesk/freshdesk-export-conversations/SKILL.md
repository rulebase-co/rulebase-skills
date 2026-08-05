---
name: freshdesk-export-conversations
description: Use to bulk-export Freshdesk tickets and conversation text for analytics, QA sampling, migrations, or LLM/RAG pipelines. Trigger for "export my Freshdesk tickets", "pull Freshdesk data", "sync Freshdesk to our warehouse", incremental Freshdesk sync, or when a Freshdesk export stops at 30,000 tickets, returns only 30 results, or only covers the last 30 days.
metadata:
  author: rulebase
  version: "1.0.0"
  archetype: platform
  platform: freshdesk
---

# Freshdesk: export tickets and conversations

Export Freshdesk tickets and conversation text into the canonical
`conversations.jsonl` / `messages.jsonl` shape, past the pagination ceiling that
caps most Freshdesk exports.

## Read this before writing any code

Freshdesk has a harder wall than the other major helpdesks, and it fails silently
in three different ways.

**`GET /api/v2/tickets` stops at page 300.** At the maximum `per_page=100` that is
**30,000 tickets**, after which paging simply returns nothing. No error, no
cursor, no warning. Every naive Freshdesk export of a large account is truncated
at exactly 30,000 records and looks complete.

**The Filter/Search API is far worse.** `GET /api/v2/search/tickets` is limited to
10 pages of 30 — **300 results total**. It is useful for finding specific tickets,
never for export.

**Without `updated_since`, you only get the last 30 days.** The list endpoint
defaults to a 30-day window. An export that runs clean and returns a plausible
number is frequently just the last month.

### The way past the ceiling

Page 300 is a ceiling on *one query*, not on the data. So move the query instead
of paging deeper:

1. Request `updated_since=<watermark>`, ordered by `updated_at` **ascending**.
2. Page until results run out, or page 300 is reached.
3. Set the watermark to the last ticket's `updated_at`, reset to page 1, repeat.

**Ascending order is what makes this correct.** It guarantees the watermark always
moves forward and that no ticket is skipped between windows. With Freshdesk's
default descending order the ceiling is inescapable — the newest 30,000 tickets
are all you can ever reach.

The one case this cannot solve is more than 30,000 tickets sharing a single
`updated_at` second. The script detects a non-advancing watermark and fails loudly
rather than looping.

**Conversation text is not on the ticket object,** and Freshdesk has no bulk
sideload, so message bodies are an N+1 over
`GET /api/v2/tickets/{id}/conversations`.

Endpoint and field detail: [references/api-notes.md](references/api-notes.md).

## Prerequisites

- Node 20+ (the script has no npm dependencies).
- An API key from Profile settings.
- **The key inherits its agent's ticket scope.** An agent restricted to their own
  or their group's tickets exports a silent subset. Use a key belonging to an
  agent with permission to view all tickets, and verify the count against the
  admin UI.

```bash
export FRESHDESK_DOMAIN=acme        # for acme.freshdesk.com
export FRESHDESK_API_KEY=…
```

Never pass the key as an argument. Freshdesk uses it as the Basic auth *username*
with any password.

## Usage

```bash
node scripts/export-conversations.mjs --start 2026-01-01 --out ./out/freshdesk
```

**Arguments**

- `--start <when>` — ISO date, ISO timestamp, epoch seconds, or a relative window
  (`30d`, `12h`, `4w`). Becomes `updated_since`. Required unless `--resume`.
- `--out <dir>` — output directory. Default `./out/freshdesk`.
- `--resume` — continue from `checkpoint.json`, including mid-window.
- `--only <both|conversations|messages>` — run one phase.
- `--concurrency <n>` — parallel detail fetches. Default 4, max 10.
- `--no-bodies` — message structure and metadata without text.
- `--max-pages <n>` — stop after n pages. Use to sample.

**Set `--start` deliberately.** For a full history export, pass a date before the
account existed (`--start 2010-01-01`). Omitting it is not an option — the default
30-day window is the most common cause of a "complete" export that isn't.

**Sample first**, which also reveals the replies-per-ticket ratio driving phase 2:

```bash
node scripts/export-conversations.mjs --start 7d --max-pages 2 --out ./out/sample
```

**Resume is watermark-aware**, so an interrupted run continues mid-window rather
than restarting:

```bash
node scripts/export-conversations.mjs --resume --out ./out/freshdesk
```

## Sizing the run

```
phase 1 requests ≈ tickets / 100
phase 2 requests ≈ tickets          (one per ticket, more if a ticket has >100 replies)
```

Phase 2 dominates. Rate limits are **per minute and plan-dependent**, and the
budget is shared with the agent UI and every installed app — saturating it
degrades live agent work.

Because the limit varies by plan, the script does not assume a local rate. It
sends requests and honours `Retry-After` on 429, which Freshdesk always provides.
If you know your plan's limit, keep `--concurrency` well under it; start at the
default of 4 and only raise it if you see no throttling.

For a large first export, run month-by-month windows in sequence. Each is
independently resumable, and a failure costs you one month rather than the run.

## What the export will not contain

- **Deleted tickets** are excluded from list results by default; spam and trashed
  tickets need explicit filters.
- **Archived tickets** may be excluded depending on account configuration —
  verify against the UI if your account uses archiving.
- **CSAT scores.** Freshdesk surveys are a separate resource and the scale is
  configurable per account, so the script sets `csat` to `null` rather than
  guessing a mapping. Pull `/api/v2/surveys/satisfaction_ratings` separately and
  document your own scale.
- **`resolved_at` unless the stats sideload is present.** The script requests
  `include=stats`; if your plan omits it, that field stays null.
- **Custom field values** are returned but are meaningless without the field
  definitions from `/api/v2/ticket_fields`.
- **Attachment contents.** Only a count is exported.

## Output

Canonical shape, shared with the other platform export skills in this catalog:

```
conversations.jsonl     one ticket per line
messages.jsonl          one reply or note per line, joins on conversation_source_id
conversation-ids.txt    ids discovered in phase 1
fetched-ids.txt         ids completed in phase 2 (resume journal)
checkpoint.json         resume state, including the watermark
```

Freshdesk encodes almost everything as integers, so the normalisation matters:

| Raw | Canonical |
| --- | --- |
| `status` 2/3/4/5 | `open` / `pending` / `resolved` / `closed` |
| `status` 6, 7 | `open` / `pending` |
| `status` custom (8+) | `open`, with `status_raw` preserved |
| `priority` 1–4 | `low` / `medium` / `high` / `urgent` |
| `source` 1/2/3/7 | `email` / `web_form` / `voice` / `chat` |

Unrecognised custom statuses map to `open` rather than being dropped, and
`status_raw` always keeps the original code — so a mis-mapping is auditable
instead of invisible.

On messages: `private: true` is an **internal note** (`visibility: "internal"`),
and `incoming: true` marks a customer message. The script uses `incoming` first
and falls back to comparing the author against the ticket requester, because
`incoming` is not always populated on older tickets. `body_text` is preferred over
the HTML `body`.

## Handling the data

Ticket bodies are production PII.

- Never commit `.jsonl` exports to git.
- Do not paste message bodies into chat. Report counts, IDs, and aggregates.
- If the task only needs volumes or routing, run `--no-bodies`.

## Present results to the user

1. **Window and completeness** — the `--start` used, the final watermark, and
   whether phase 1 reached the end of the stream. If not, lead with that.
2. **Ceiling rollovers** — how many times the watermark advanced at the 300-page
   ceiling. This is the signal that a naive export *would* have been truncated,
   and it is worth naming explicitly.
3. **Volumes** — tickets, messages, replies per ticket.
4. **Cost** — requests and elapsed time.
5. **Reconciliation** — compare against the ticket count in the Freshdesk UI for
   the same window. If the export is short, suspect the agent's ticket scope
   before suspecting the script.
6. **Where the data is**, plus the PII reminder.

## Troubleshooting

**Exactly 30,000 tickets exported** — the classic ceiling truncation. Confirm the
run used ascending order and that watermark rollovers appear in the log.

**Only 30 results** — you used the search/filter endpoint, or omitted `per_page`.
The list default is 30 per page.

**Only the last 30 days** — `updated_since` was missing. It cannot be omitted.

**Export is short and reconciliation fails** — almost always the API key's agent
ticket scope. Check with an admin-scoped key.

**`watermark did not advance`** — more than 30,000 tickets share one `updated_at`
second, usually from a bulk update or migration. Export that period with a
narrower window.

**429s** — plan limit reached, shared with the agent UI. Lower `--concurrency`;
progress is journalled so nothing is lost.
