---
name: front-export-conversations
description: Use to bulk-export Front conversations and message text for analytics, QA sampling, migrations, or LLM/RAG pipelines. Trigger for "export my Front conversations", "pull Front data", "sync Front to our warehouse", incremental Front sync, or when a Front export is hitting 429 rate limits, running for days, or slowing down other Front integrations.
metadata:
  author: rulebase
  version: "1.0.0"
  archetype: platform
  platform: front
---

# Front: export conversations and messages

Export Front conversations and message text into the canonical
`conversations.jsonl` / `messages.jsonl` shape.

## Read this before writing any code

Front's constraint is not an endpoint quirk. It is the rate limit, and it is
severe enough to change how you plan the whole project.

**The limit starts at 50 requests/minute and is enforced per company, not per
token.** Two consequences most people discover the hard way:

- **Your export cannot be made faster by adding tokens or concurrency.** A second
  token draws from the same bucket.
- **Your export degrades every other Front integration the company runs** —
  helpdesk syncs, CRM connectors, internal tools, and the Front app itself.
  Running a large export during business hours is a production incident waiting
  to happen.

There is also a documented burst ceiling of 5 requests/second per resource type
(1/second for exports), so even a generous plan limit cannot be spent in a rush.

**Message bodies need one request per conversation.** Combined with the rate
limit, this is the sizing story: at 50/minute, 100,000 conversations is about
33 hours of continuous running. The script projects and prints this before phase 2
so the number is visible before you commit, and checkpoints per conversation so a
multi-day run survives interruption.

**There is no time filter on the conversation list.** Sort newest-first and stop
at a watermark, the same shape as Gorgias.

**Internal notes are a separate resource.** Front *comments* are not messages.
This export contains messages only, and reports
`internal_notes_included: false` so nobody mistakes the absence for "this team
doesn't use notes".

Endpoint and field detail: [references/api-notes.md](references/api-notes.md).

## Prerequisites

- Node 20+ (the script has no npm dependencies).
- An API token from Settings → Developers, with read scope for the inboxes you
  need. **A token scoped to a subset of inboxes exports a subset silently** —
  there is no error, just fewer conversations.

```bash
export FRONT_API_TOKEN=…
```

Never pass the token as an argument.

## Usage

```bash
node scripts/export-conversations.mjs --start 2026-01-01 --out ./out/front
```

**Arguments**

- `--start <when>` — the watermark on last activity. ISO date/timestamp, epoch
  seconds, or a relative window (`30d`, `12h`). Required unless `--resume`.
- `--out <dir>` — output directory. Default `./out/front`.
- `--resume` — continue from `checkpoint.json`.
- `--only <both|conversations|messages>` — run one phase.
- `--no-bodies` — message structure and metadata without text.
- `--max-pages <n>` — stop after n list pages. Use to sample.
- `--yes` — silence the long-run notice.

**Set `FRONT_RATE_PER_MIN` to your actual plan limit.** The default of 50 is the
documented floor. Raising it beyond your real limit produces sustained 429s, not
a faster export.

**Always sample first**, then read the projected duration before committing:

```bash
node scripts/export-conversations.mjs --start 7d --max-pages 1 --out ./out/sample
```

**Run large exports off-peak**, and expect to resume across sessions:

```bash
node scripts/export-conversations.mjs --resume --out ./out/front
```

## Planning a large export

At the default 50 requests/minute:

| Conversations | Approximate phase 2 duration |
| --- | --- |
| 1,000 | 20 minutes |
| 10,000 | 3.5 hours |
| 50,000 | 17 hours |
| 100,000 | 33 hours |
| 500,000 | 7 days |

Three ways to make this tractable, in order of preference:

1. **Narrow the window.** Most analyses need 90 days, not all history. Export
   month by month; each run is independently resumable.
2. **Check whether Front's Exports API fits.** Front has an asynchronous export
   endpoint whose burst limit is 1/second but which returns a bulk artifact rather
   than requiring an N+1. For very large accounts it is likely the better path.
   This skill does not implement it because its response shape needs verifying
   against a live account — worth doing before committing to a multi-day N+1.
3. **Run `--no-bodies`** if the analysis only needs volumes, routing, and timing.
   That skips phase 2 entirely and turns days into minutes.

## What the export will not contain

- **Internal notes (comments).** A separate resource, not fetched here.
- **Draft messages**, and message content for conversations in inboxes the token
  cannot read.
- **Attachment contents.** Only a count is exported.
- **CSAT.** Front surveys are a separate resource with a configurable scale, so
  `csat` is `null` rather than guessed.
- **Anything before the watermark.** The stop is on last activity, so an old
  conversation touched recently *is* included.

## Output

Canonical shape, shared with the other platform export skills in this catalog:

```
conversations.jsonl     one conversation per line
messages.jsonl          one message per line, joins on conversation_source_id
conversation-ids.txt    ids discovered in phase 1
fetched-ids.txt         ids completed in phase 2 (resume journal)
checkpoint.json         resume state, including the pagination URL
```

Normalisation notes:

- `archived` → canonical `closed`; `status_raw` keeps Front's own value
  (`unassigned`, `assigned`, `archived`, `deleted`, `spam`).
- `team_id` is the **inbox** id, which is the closest thing Front has to a team.
- **`customer_id` falls back to the recipient handle** (email or phone) when Front
  has no contact record. Losing the handle would make the conversation
  unjoinable, but note that a handle is a weaker identity than a contact id —
  the same person with two addresses becomes two customers.
- `is_inbound` is the author signal. An outbound message with no author is
  attributed to `system`, not `agent`, because that is usually an automated send.

## Handling the data

Message bodies are production PII.

- Never commit `.jsonl` exports to git.
- Do not paste message bodies into chat. Report counts, IDs, and aggregates.
- If the task only needs volumes or routing, run `--no-bodies`.

## Present results to the user

1. **Completeness and duration** — phases finished, elapsed time, and the resume
   command if incomplete. On a multi-day export, say plainly that it is partial.
2. **The rate-limit consequence.** If the run took hours, state that the limit is
   per-company and the export competed with production integrations. This belongs
   in the summary, not a footnote.
3. **Volumes** — conversations, messages, messages per conversation.
4. **Identity quality** — how many conversations fell back to a handle rather
   than a contact id, since that weakens any per-customer analysis.
5. **The internal-notes gap** — state explicitly that comments are not included.
6. **Reconciliation** against Front's own counts for the same window.
7. **Where the data is**, plus the PII reminder.

## Troubleshooting

**Sustained 429s** — either `FRONT_RATE_PER_MIN` exceeds your plan limit, or
another integration is consuming the company budget. Lower it and re-run;
progress is journalled.

**Fewer conversations than expected** — almost always the token's inbox scope.
Check against an admin-scoped token before suspecting the script.

**The export will take days** — that is the expected outcome for a large account
via the N+1. Narrow the window, or evaluate Front's Exports API.

**No internal notes in the output** — correct and by design. Front comments are a
separate resource.

**Pagination stops early** — Front returns `_pagination.next` as a full URL;
follow it verbatim rather than reconstructing it from a token.
