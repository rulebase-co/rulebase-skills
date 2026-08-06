---
name: aircall-export-calls
description: Use to bulk-export Aircall calls and download their recordings before the URLs expire, emitting the canonical conversation schema. Trigger for "export my Aircall calls", "pull Aircall call data", "download our Aircall recordings", "get Aircall calls into Rulebase", incremental sync from Aircall, or an Aircall export that stopped at 10,000 records.
metadata:
  author: rulebase
  version: "1.0.0"
  archetype: platform
  platform: aircall
---

# Exporting Aircall calls

Exports Aircall calls into `conversations.jsonl` in the canonical schema, and optionally
downloads the recordings. Voice-only, so there is no `messages.jsonl` — a call has no
message list.

Three hard limits shape the whole design, and all three fail quietly.

## Trap 1: 10,000 items, even with pagination

`GET /v1/calls` paginates, and [Aircall caps the result set at 10,000 items regardless of
pagination](https://developers.aircall.io/api-references). You do not get an error. You
page to the end of what it will give you and stop, holding a file that looks complete.

So the export cannot be "walk the pages until they run out". It has to be **windowed**:
request a time range, and if that range contains more than 10,000 calls, split it and
request the halves.

The script does this adaptively — it reads `meta.total` for a window and recursively halves
any window over the cap, so a busy account and a quiet one both export correctly with no
tuning. Windowing by a fixed period instead (a day, a week) works until one day is busier
than the cap, which is exactly when you least want a silent truncation.

## Trap 2: about six months of history, by default

[Historical data is available for only six months](https://developers.aircall.io/api-references)
without a special request to Aircall.

This means **a full-history export is not possible with default access**, and an export of
"everything" silently starts six months ago. If you need more, that is a conversation with
Aircall before you write any code, not a pagination problem to solve.

Always state the earliest call actually retrieved. If it lands suspiciously close to six
months before today, that is the ceiling, not the account's age.

## Trap 3: recording URLs expire while you work

The `recording` field is a direct MP3 URL **valid for one hour**. There is also a
`recording_short_url` valid for three hours.

The consequence is a design constraint rather than an inconvenience: **you cannot collect
URLs during a long export and download them afterwards.** On a multi-hour run the early
URLs are dead before the export finishes.

Either:

- **Download inline**, as each page is processed — what `--recordings` does here; or
- **Store the call ids and re-fetch the call** immediately before downloading, accepting the
  extra request per recording against the rate limit.

An export that persists `recording` URLs into a dataset is persisting values that are
already invalid. Store the call id instead.

## Rate limits: read the header, do not hard-code

The published figures disagree. The [API reference states 120 requests per minute per
company](https://developers.aircall.io/api-references); some help-centre material states 60.
Rather than pick one, read the response headers, which are authoritative for your account:

- `X-AircallApi-Limit`
- `X-AircallApi-Remaining`
- `X-AircallApi-Reset`

Aircall support can raise the limit on request. Recording downloads are the expensive part
of a large export, so plan a long run and throttle deliberately.

## Auth

Two methods: **Basic auth** with `api_id` and `api_token` for Aircall customers, or **OAuth 2.0**
for technology partners. This exporter uses Basic auth, credentials from the environment only.

The permission trap here is narrower than on a helpdesk — an API key is company-scoped —
but check the number and team lists against expectation before trusting the run, because a
key created against the wrong company produces a valid, complete, wrong export.

## Usage

```bash
export AIRCALL_API_ID=...
export AIRCALL_API_TOKEN=...

node scripts/export-calls.mjs --out ./out --from 2026-02-01 --to 2026-08-01
```

With recordings downloaded inline:

```bash
node scripts/export-calls.mjs --out ./out --from 2026-07-01 --to 2026-08-01 \
  --recordings ./out/recordings
```

Flags:

- `--from` / `--to` — required. Dates or ISO timestamps; converted to the UNIX seconds the
  API expects. Windowing happens inside this range.
- `--recordings <dir>` — download recordings and voicemails inline. Off by default.
- `--resume` — continue from the checkpoint. Completed windows are skipped.
- `--max-window-calls <n>` — the cap to split windows at. Defaults to 9,000, deliberately
  under Aircall's 10,000 so a window that grows between the count and the fetch still fits.
- `--min-window-hours <n>` — floor on splitting, so a pathological hour cannot recurse
  forever. If a window this small still exceeds the cap, the script reports it rather than
  silently truncating.

Recordings and transcripts are production PII. Write them outside the repository and do not
commit them.

## Field mapping

| Canonical | Aircall |
| --- | --- |
| `source_id` | `id` |
| `status` / `status_raw` | `status` — `done` → `closed`, `answered` and `initial` → `open`, raw kept |
| `channel` | always `voice`; Aircall has no channel concept, so `channel_raw` is null |
| `customer_id` | `contact.id`, absent for calls from unknown numbers |
| `assignee_id` | `user.id` — the agent who took or made the call |
| `team_id` | first of `teams[]`. **Present on inbound calls only** |
| `created_at` | `started_at` (UNIX seconds) |
| `resolved_at` | `ended_at` |
| `tags` | `tags[].name` |
| `csat` | not available on this endpoint |

Timestamps are **UNIX seconds, not milliseconds and not ISO-8601**. Multiplying by the wrong
factor produces dates in 1970 or in the far future, and both survive a schema validator.

Extra `*_raw` fields carried through because they are the analytically useful part of a call
record: `direction_raw` (`inbound`/`outbound`), `answered` (derived from `answered_at`),
`missed_call_reason_raw`, `duration_seconds`, and `raw_digits_present`.

**`missed_call_reason` is documented with a fixed set of values** — `out_of_opening_hours`,
`short_abandoned`, `abandoned_in_ivr`, `abandoned_in_classic`, `no_available_agent`,
`agents_did_not_answer`. Keep them: they distinguish a customer who hung up in the IVR from
one nobody answered, which is the difference between an abandonment problem and a staffing
problem. Collapsing them into "missed" throws away the finding.

**`raw_digits` can be the literal string `anonymous`.** Do not treat it as a phone number,
and do not let it become a customer identity key.

## Present results to the user

1. **Window coverage** — the requested range, the windows actually fetched, and the earliest
   call retrieved. If the earliest is near six months ago, say that the history ceiling was
   hit rather than implying the account starts there.
2. **Counts** — calls exported, and the breakdown by direction and by answered/missed.
3. **Windows that could not be split below the cap**, if any. These are the only places data
   could be missing, and they are reported explicitly rather than silently truncated.
4. **Recording outcomes** — attempted, downloaded, expired, absent. Recordings are not
   retained for every call, so absence is often normal rather than a failure.
5. **Rate-limit behaviour** — the limit observed from the headers, throttling encountered,
   and time spent waiting.
6. **What is missing** — CSAT, anything beyond the history window, and `team_id` on outbound
   calls.
