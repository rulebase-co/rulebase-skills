---
name: helpscout-export-conversations
description: Use to bulk-export Help Scout conversations and their full thread text for analytics, QA or LLM pipelines, emitting the canonical conversation schema. Trigger for "export my Help Scout conversations", "pull Help Scout data", "Help Scout tickets into a dataset", incremental sync from Help Scout, or when a Help Scout export came back with only a fraction of the expected conversations.
metadata:
  author: rulebase
  version: "1.0.0"
  archetype: platform
  platform: helpscout
---

# Exporting Help Scout conversations

Exports Help Scout Mailbox API v2 conversations and threads into
`conversations.jsonl` and `messages.jsonl` in the canonical schema.

## The trap that silently loses most of your data

**`GET /v2/conversations` defaults to `status=active`.**

Not "all". Active. So the obvious call —

```
GET /v2/conversations
```

— returns only currently-active conversations and silently omits every closed one,
which on any mature account is the overwhelming majority of your history. There is no
error, no warning, and the response looks perfectly healthy. Teams discover this after
building an analysis on it.

Always pass status explicitly:

```
GET /v2/conversations?status=all
```

[The list endpoint documents the default as `?status=active&sortField=createdAt&sortOrder=desc`.](https://developer.helpscout.com/mailbox-api/endpoints/conversations/list/)

Note that `status=all` still does not include spam in some configurations — verify by
requesting `status=spam` separately and comparing counts against the UI before
declaring the export complete.

## The second trap: embedded threads are truncated

`GET /v2/conversations?embed=threads` looks like it saves you an N+1. It does not
give you the data.

The [documentation states plainly](https://developer.helpscout.com/mailbox-api/endpoints/conversations/list/)
that with `embed=threads` **"you will see truncated chat threads. This is by design."**

So an export built on the embed is quietly incomplete on exactly the conversations
with the most content. Use the embed for a cheap conversation-level pass if you like,
but message bodies must come from the dedicated endpoint:

```
GET /v2/conversations/{conversationId}/threads
```

That is one request per conversation. There is no bulk thread endpoint, so the N+1 is
unavoidable and the export's runtime is set by conversation count, not by size. Plan
for it and checkpoint.

## The third trap: `lineitem` threads are not messages

The threads endpoint returns [eight thread types](https://developer.helpscout.com/mailbox-api/endpoints/conversations/threads/list/):
`customer`, `message`, `note`, `chat`, `phone`, `lineitem`, `forwardparent`,
`forwardchild`.

**`lineitem` is a state change** — an assignment, a status update, an inbox move. It
has no body, no to/cc/bcc, and no attachments. Counting these as messages inflates
message counts, distorts response-time calculations, and attributes "messages" to
agents who only reassigned a ticket.

This exporter drops `lineitem` by default and records how many it dropped. `note`
threads *are* real content but are internal-only — they are exported with
`visibility: internal` so downstream analysis can include or exclude them
deliberately rather than by accident.

## Rate limits

The limit is **plan-dependent**, and [Help Scout does not publish a single number](https://developer.helpscout.com/mailbox-api/overview/rate-limiting/) —
do not hard-code one. Read it from the response headers instead:

- `X-RateLimit-Limit-Minute`
- `X-RateLimit-Remaining-Minute`
- `X-RateLimit-Retry-After`

Two things that catch people out:

- **The retry header is `X-RateLimit-Retry-After`, not the standard `Retry-After`.**
  A generic HTTP client's built-in backoff will not find it and will hammer straight
  back into the 429.
- **The limit is per account, not per key.** Every integration on the account shares
  it, so a bulk export competes with production traffic. Throttle deliberately and run
  large exports outside business hours.

Write requests count as two against the limit. This exporter is read-only, so that
only matters if you are sharing the budget with something that writes.

## Auth and permission

OAuth2 client credentials: `POST /v2/oauth2/token` with `grant_type=client_credentials`,
your app's `client_id` and `client_secret`, then use the returned token as
`Authorization: Bearer <token>`. Tokens expire; the script refreshes on 401 rather than
failing a multi-hour run.

**The permission trap:** an app's access is bounded by the inboxes it was granted.
A key scoped to two of five inboxes produces a partial export with no error — the
missing inboxes simply do not appear. Before trusting a run, list inboxes
(`GET /v2/mailboxes`) and confirm the set matches what you expect.

## Usage

```bash
export HELPSCOUT_CLIENT_ID=...
export HELPSCOUT_CLIENT_SECRET=...

node scripts/export-conversations.mjs --out ./out --status all
```

Incremental, after a first full run:

```bash
node scripts/export-conversations.mjs --out ./out --status all --modified-since 2026-07-01T00:00:00Z
```

Useful flags:

- `--status all|active|open|pending|closed|spam` — defaults to `all`, deliberately.
- `--mailbox <id,id>` — restrict to specific inboxes.
- `--modified-since <iso8601>` — incremental sync on `modifiedSince`.
- `--no-bodies` — conversation metadata only; skips the per-conversation thread
  fetch and runs orders of magnitude faster.
- `--include-line-items` — keep state-change threads. Off by default.
- `--resume` — continue from the checkpoint after an interruption.
- `--max-conversations <n>` — bound a trial run.

Output goes to `./out` by default, which is gitignored here. **Transcripts are
production PII and must not be committed.** Credentials are read from the environment
only.

## Incremental sync

`modifiedSince` filters on modification, not creation, so an incremental run returns
conversations that changed — including old ones. That is what you want, but it means:

- **Re-fetch threads for every returned conversation.** A conversation appears because
  something changed, and that something is usually a new message.
- **Upsert on `source_id`**, do not append blindly, or reprocessed conversations
  duplicate.
- **Overlap the window** by a few minutes against your last run to absorb clock skew.

Deletions do not appear in a `modifiedSince` sweep at all. A conversation deleted in
Help Scout stays in your dataset until a full re-sync reconciles it. If deletions
matter, periodically re-list ids and diff.

## Field mapping

| Canonical | Help Scout |
| --- | --- |
| `source_id` | `id` |
| `subject` | `subject` |
| `status` / `status_raw` | `status` — `active`/`open` → `open`, `pending` → `pending`, `closed` → `closed`, `spam` → `closed` with the raw value kept |
| `channel` / `channel_raw` | `type` — `email` → `email`, `chat` → `chat`, `phone` → `voice` |
| `customer_id` | `primaryCustomer.id` |
| `assignee_id` | `assignee.id` |
| `team_id` | `mailboxId` (Help Scout has no separate team object) |
| `created_at` / `updated_at` | `createdAt` / `userUpdatedAt` |
| `resolved_at` | `closedAt` |
| `tags` | `tags[].tag` |
| `csat` | **not exported** — Help Scout satisfaction ratings are a separate resource |

**Thread bodies are HTML.** The canonical schema requires plain text, so the exporter
converts them — dropping script and style content, turning block boundaries into
newlines, and decoding entities. If you need the original markup, capture it upstream;
this export does not carry both.

Message author type comes from `createdBy.type` (`user` → agent, `customer` →
customer), which is more reliable than inferring from the thread type — a `chat`
thread can be authored by either.

`spam` mapping to `closed` is a judgement call, not a fact. `status_raw` always
carries the original, and spam should normally be excluded from contact-volume
analysis rather than counted as resolved work.

## Present results to the user

1. **Counts** — conversations, messages, and the status breakdown. If `status` was
   anything other than `all`, say so prominently.
2. **Inboxes covered**, and whether that matched the account's full list. A permission
   gap is the difference between a partial export and a complete one.
3. **Dropped `lineitem` threads**, as a count, so the message total is explainable.
4. **Internal notes**, counted separately from customer-visible messages.
5. **Rate-limit behaviour** — throttling encountered and time spent waiting.
6. **What is missing** — deletions not visible to an incremental run, CSAT not
   exported, and any conversation whose threads failed to fetch, by id.
