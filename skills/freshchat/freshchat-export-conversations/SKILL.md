---
name: freshchat-export-conversations
description: Use to bulk-export Freshchat conversations and message text for analytics, QA sampling, migrations, or LLM/RAG pipelines. Trigger for "export my Freshchat conversations", "pull Freshchat data", "list all Freshchat conversations", "sync Freshchat to our warehouse", or when a Freshchat export is blocked because there is no endpoint to enumerate conversations.
metadata:
  author: rulebase
  version: "1.0.0"
  archetype: platform
  platform: freshchat
---

# Freshchat: export conversations and messages

Export Freshchat conversations and message text into the canonical
`conversations.jsonl` / `messages.jsonl` shape.

## Read this before writing any code

**There is no endpoint that lists conversations.** This is not an oversight you
can work around with a clever query — the Freshchat v2 API simply has no
enumerate-conversations operation. `GET /v2/conversations/{id}` requires an id you
must already possess, and nothing hands you the set of ids.

People lose real time to this, because every other helpdesk API starts with a list
endpoint. The workaround is indirect:

1. **Request a raw report** via the Reports/Extract API
   (`POST /v2/reports/raw`) for a time window.
2. **Poll** until it completes, then download the artifact.
3. **Mine the conversation ids** out of the report.
4. **Hydrate** each conversation and fetch its messages.

So this export has three phases, and the completeness of the whole thing is
bounded by the report, not by the API. **If discovery finds zero ids, that almost
always means the report name, window, or column set is wrong — not that there are
no conversations.**

**Report shapes differ by account.** Report definitions are configurable, and the
extract payload can be CSV or JSON. Id discovery is therefore deliberately
tolerant: it accepts several spellings of the id column, handles both formats,
and — when it finds nothing — prints the columns it actually saw so you can fix
the report. `--ids-file` bypasses discovery entirely if you obtained ids another
way.

**Messages page at 50, not 100.** `items_per_page` is capped at 50 for messages,
so chat-heavy conversations cost more requests than you would expect.

**Message text is not in a body field.** It lives in `message_parts[].text.content`
— an array, because a single message can carry several parts plus images and
files. Reading a `body` field returns nothing.

**Freshchat is not Freshdesk.** Different product, different API, different
credentials. Freshdesk endpoints return no Freshchat conversations. If the account
uses both, plan two exports.

Endpoint and field detail: [references/api-notes.md](references/api-notes.md).

## Prerequisites

- Node 20+ (the script has no npm dependencies).
- An API token from Admin → API tokens.
- **Reporting access.** The token must be allowed to request reports. An
  agent-scoped token can read conversations but cannot create the report that
  discovers them, which produces a 403 at phase 1 and looks like a bad token.

```bash
export FRESHCHAT_DOMAIN=acme        # for acme.freshchat.com, or a full host
export FRESHCHAT_API_TOKEN=…
```

Never pass the token as an argument.

## Usage

```bash
node scripts/export-conversations.mjs --start 2026-03-01 --end 2026-03-08 --out ./out/freshchat
```

**Arguments**

- `--start <when>` / `--end <when>` — the report window. ISO date/timestamp, epoch
  seconds, or a relative window (`30d`). `--end` defaults to now. Required unless
  `--resume` or `--ids-file`.
- `--ids-file <path>` — skip report discovery and read ids from a file, one per
  line.
- `--out <dir>` — output directory. Default `./out/freshchat`.
- `--resume` — continue from `checkpoint.json`; discovery is not repeated.
- `--only <both|conversations|messages>` — run one phase.
- `--concurrency <n>` — parallel hydrate/message fetches. Default 3, max 8.
- `--no-bodies` — message structure and metadata without text.
- `--max-ids <n>` — cap discovered ids. Use to sample.

**Always sample first.** The run logs which id column it matched, which is the
thing most likely to need fixing:

```bash
node scripts/export-conversations.mjs --start 2d --max-ids 20 --out ./out/sample
```

**If discovery fails, use `--ids-file`.** Rather than fighting the report API, you
can export a Chat Transcript report from the Freshchat UI, pull the id column out
yourself, and feed it in:

```bash
node scripts/export-conversations.mjs --ids-file ./ids.txt --out ./out/freshchat
```

## Sizing the run

```
phase 1  1 report + polling
phase 2  1 request per conversation
phase 3  ceil(messages / 50) requests per conversation
```

Phase 3 usually dominates, because 50-per-page over long chat transcripts adds
up. Keep report windows to a week or two for large accounts: a smaller report is
faster to generate, and a failed window costs less to redo.

## What the export will not contain

- **Conversations absent from the report.** The report defines the universe. If it
  filters by channel, group, or status, so does your export — silently.
- **Conversations whose ids no longer resolve.** Reports can reference deleted
  conversations; those are counted as `unresolved_ids` and reported, and they set
  `complete: false`.
- **CSAT.** A separate resource with an account-configurable scale, so `csat` is
  `null` rather than guessed.
- **Images and files.** Only a count of non-text parts is exported.
- **Freshdesk tickets.** Different product entirely.

## Output

Canonical shape, shared with the other platform export skills in this catalog:

```
conversations.jsonl     one conversation per line
messages.jsonl          one message per line, joins on conversation_source_id
conversation-ids.txt    ids discovered in phase 1
hydrated-ids.txt        ids completed in phase 2 (resume journal)
messaged-ids.txt        ids completed in phase 3 (resume journal)
checkpoint.json         resume state, including the report id
```

Normalisation notes:

- `channel` is always `chat` — Freshchat is a messaging product.
- `resolved` → canonical `resolved`; `new`/`assigned`/`reopened` → `open`.
  `status_raw` keeps the original.
- `actor_type` is the author signal (`user` → `customer`, `agent`, `bot`,
  `system`), with a fallback comparing the actor id against the conversation's
  user, because `actor_type` is unreliable for bot-authored messages.
- `message_type: "private"` is an **internal note**
  (`visibility: "internal"`).
- Message text is assembled by joining `message_parts[].text.content`.

## Handling the data

Chat transcripts are production PII.

- Never commit `.jsonl` exports to git.
- Do not paste message bodies into chat. Report counts, IDs, and aggregates.
- If the task only needs volumes or timing, run `--no-bodies`.

## Present results to the user

1. **Discovery outcome first.** How many ids the report yielded, and which column
   they came from. Everything downstream is bounded by this, so a low number is
   the headline — not a footnote.
2. **Unresolved ids.** Report the count and state that the export is incomplete
   when it is non-zero.
3. **Volumes** — conversations, messages, messages per conversation.
4. **The report caveat.** Say explicitly that completeness reflects the report
   definition, and that a filtered report produces a filtered export with no
   error. This is the single most likely way a Freshchat export misleads.
5. **Cost** — requests and elapsed time.
6. **Reconciliation** against Freshchat's own conversation counts for the window.
7. **Where the data is**, plus the PII reminder.

## Troubleshooting

**403 at phase 1 but conversations read fine** — the token lacks reporting access.
Reporting and conversation reads are separately gated.

**`no conversation ids found`** — the report has no recognisable id column. The
error prints the columns it saw; add a conversation id column to the report
definition, or use `--ids-file`.

**Zero conversations discovered** — check the window and the report name before
concluding the account is empty. This is the expected symptom of a wrong report.

**Report never completes** — the window is too large. Narrow `--start`/`--end`.

**Messages are empty but the conversation hydrated** — you are reading a `body`
field. Text lives in `message_parts[].text.content`.

**Some ids do not resolve** — expected; reports can reference deleted
conversations. The count is reported and marks the export incomplete.
