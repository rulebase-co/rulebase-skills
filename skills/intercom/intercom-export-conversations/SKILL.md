---
name: intercom-export-conversations
description: Use to bulk-export Intercom conversations and message text for analytics, QA sampling, migrations, or LLM/RAG pipelines. Trigger for "export my Intercom conversations", "pull Intercom data", "sync Intercom to our warehouse", incremental Intercom sync, Fin conversation analysis, or when an Intercom export is missing message bodies or hitting 429 rate limits.
metadata:
  author: rulebase
  version: "1.0.0"
  archetype: platform
  platform: intercom
---

# Intercom: export conversations and messages

Export Intercom conversations and the actual message text into the canonical
`conversations.jsonl` / `messages.jsonl` shape, at any volume.

## Read this before writing any code

**The list and search endpoints do not return message bodies.** Both
`GET /conversations` and `POST /conversations/search` return conversations
*without* the `conversation_parts` object. To get message text you must call
`GET /conversations/{id}` once per conversation.

There is no bulk sideload and no equivalent of Zendesk's events stream. Unlike
Zendesk, **the N+1 here is unavoidable** — the only question is whether you pace
it correctly. Plan the export around request count, not record count.

**A conversation is capped at 500 parts, and truncation is silent.** Past 500,
Intercom returns the 500 *most recent* parts with no error and no flag. Long
conversations quietly lose their beginning — including the customer's original
question, which is usually the part an analysis needs most. The script detects
this by comparing `total_count` against the parts returned, and warns with a
count.

**Unversioned requests drift.** If you don't send `Intercom-Version`, you get the
workspace's default version, which changes over time and differs between
workspaces. Response shapes then change under you. The script pins `2.14` and
lets you override it; always record which version produced an export.

Endpoint and field detail: [references/api-notes.md](references/api-notes.md).

## Prerequisites

- Node 20+ (the script has no npm dependencies).
- An access token from an Intercom app, with the **Read conversations** scope.
  Tokens are workspace-specific — a token for the wrong workspace returns 401,
  not an empty result.

```bash
export INTERCOM_ACCESS_TOKEN=…
```

Never pass the token as an argument; argv appears in shell history, `ps`, and
agent transcripts.

## Usage

```bash
node scripts/export-conversations.mjs --start 2026-01-01 --out ./out/intercom
```

**Arguments**

- `--start <when>` — ISO date, ISO timestamp, epoch seconds, or a relative window
  (`30d`, `12h`, `4w`). Filters on `updated_at`. Required unless `--resume`.
- `--out <dir>` — output directory. Default `./out/intercom`.
- `--resume` — continue from `checkpoint.json`.
- `--only <both|conversations|messages>` — run one phase.
- `--concurrency <n>` — parallel detail fetches in phase 2. Default 6, max 20.
- `--no-bodies` — message structure and metadata without text.
- `--max-pages <n>` — stop phase 1 after n search pages. Use to sample.

**Sample before committing to a full run.** This confirms auth, version, and the
messages-per-conversation ratio that determines the cost of phase 2:

```bash
node scripts/export-conversations.mjs --start 7d --max-pages 1 --out ./out/sample
```

**Resume is per conversation, not per page.** Phase 2 journals every fetched id to
`fetched-ids.txt`, so an interrupted run resumes without repeating the N+1:

```bash
node scripts/export-conversations.mjs --resume --out ./out/intercom
```

## Sizing the run

Phase 1 is cheap: 150 conversations per request. Phase 2 is one request per
conversation and dominates everything.

```
total requests ≈ (conversations / 150) + conversations
```

100,000 conversations is roughly 100,700 requests. Your app's allowance is
generous — thousands of requests per minute — but **it is bucketed into 10-second
windows**, so you cannot burst a minute's budget at once. A run that looks
comfortable against the per-minute figure still 429s if it fires everything in
two seconds.

Rather than assume a fixed rate, the script reads `X-RateLimit-Remaining` and
`X-RateLimit-Reset` off every response and waits for the window to roll over when
the remaining count runs low. Published limits differ by plan and have changed
over time, so trust the headers over any number written down — including the ones
in this skill.

Start at the default concurrency of 6. Raise it only if the run is not being
throttled; if you see the window-exhausted message often, lower it.

## What the export will not contain

- **Parts beyond 500 per conversation**, as above. Not retrievable through this
  API at all.
- **Conversations hard-deleted** or removed by a data-deletion request.
- **Attachment contents.** Only a count is exported; files need separate
  authenticated downloads.
- **Ticket-type conversations** follow a different model in newer API versions;
  verify they appear in your search results before assuming full coverage.
- **Events, contact attributes, and company data.** Separate endpoints, needed if
  you want to segment the export by customer properties.
- **Anything outside `--start`.** The filter is on `updated_at`, so a conversation
  created long ago but touched yesterday *is* included. This is usually what you
  want for incremental sync, and wrong if you are trying to reconstruct a fixed
  historical window — filter on `created_at` for that.

## Output

Canonical shape, shared with the other platform export skills in this catalog:

```
conversations.jsonl     one conversation per line
messages.jsonl          one message per line, joins on conversation_source_id
conversation-ids.txt    ids discovered in phase 1
fetched-ids.txt         ids completed in phase 2 (resume journal)
checkpoint.json         resume state
```

Notable normalisations:

- `state` → canonical `status` (`open` / `closed` / `snoozed`), with `status_raw`
  preserved.
- Ratings are 1–5 in Intercom; `csat` is normalised to a 0–1 fraction and
  `csat_raw` keeps the original. A rating of 1 becomes `0`, **not** `null` — do
  not treat it as missing.
- Bodies are HTML in Intercom; `body` is plain text.
- `author.type` → `author_type`: `user`/`lead` → `customer`, `admin`/`team` →
  `agent`, `bot`/`operator` → `bot`. Unrecognised types fall back to comparing
  the author id against the conversation's contact, then to `unknown`.

Only `comment`, `note`, and `note_and_reopen` parts become messages. Assignment,
close, open, and snooze parts are workflow events, not messages — counting them
as messages inflates every turn-count and response-time metric.

`note` parts are **internal** (`visibility: "internal"`). Including them in
customer-facing analysis is a common and serious error.

## Handling the data

Message bodies are production PII — names, addresses, account details, and
financial or health disclosures.

- Never commit `.jsonl` exports to git.
- Do not paste message bodies into chat. Report counts, IDs, and aggregates; if a
  sample is genuinely needed, redact it and say so.
- If the task only needs volumes or routing, run `--no-bodies`.

## Present results to the user

1. **Window, version, and completeness** — the `--start` used, the
   `Intercom-Version` that produced it, and whether both phases finished. If not,
   lead with that and give the resume command.
2. **Volumes** — conversations, messages, and messages per conversation.
3. **Truncation** — if any conversations hit the 500-part cap, report the count
   explicitly and state that the earliest messages are unrecoverable. This
   changes what the data can be used for.
4. **Cost** — requests used and elapsed time, so the next window can be sized.
5. **Reconciliation** — compare the conversation count against the same window in
   Intercom's UI. Investigate a material gap before the data is used.
6. **Where the data is**, plus the reminder that it contains PII.

## Troubleshooting

**401 or 403** — wrong workspace, or the app lacks the Read conversations scope.
Tokens do not span workspaces.

**Messages file is empty** — you ran `--only conversations`, or phase 2 has not
run. The list endpoints never contain bodies; check that `GET /conversations/{id}`
calls are being made.

**429s despite the adaptive limiter** — something else is consuming the app or
workspace budget. Lower `--concurrency` and re-run; progress is journalled so
nothing is lost.

**Response shapes don't match this document** — check `Intercom-Version`. An
unpinned or older version changes field names and nesting.

**Fewer conversations than expected** — the filter is `updated_at >`, exclusive.
Also confirm your search isn't restricted by a workspace-level data-access rule
on the token's app.
