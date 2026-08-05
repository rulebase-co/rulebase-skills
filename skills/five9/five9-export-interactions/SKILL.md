---
name: five9-export-interactions
description: Use to bulk-export Five9 call log and interaction data for analytics, QA sampling, or warehouse sync. Trigger for "export Five9 call data", "pull Five9 call logs", "Five9 reporting API", "get interaction data out of Five9", Five9 contact centre analytics, or when a Five9 report is truncating at 50,000 records or timing out.
metadata:
  author: rulebase
  version: "1.0.0"
  archetype: platform
  platform: five9
---

# Five9: export interactions

Export Five9 call log data into the canonical `conversations.jsonl` shape by
driving the reporting API, with time windowing that avoids the record cap.

## Before you start: what this skill assumes

Five9 is not like the helpdesk APIs. Read this section fully — several things
here will bite an integration built on helpdesk assumptions.

**There is no REST list endpoint for historical interactions.** Getting call data
out means running a *report*, asynchronously, over SOAP:

```
runReport(folder, report, criteria)  -> identifier
isReportRunning(identifier)          -> poll until false
getReportResultCsv(identifier)       -> CSV payload
```

**A report returns at most 50,000 records.** Beyond that the result is truncated.
Five9's own guidance is to split a large range into months or weeks rather than
requesting it in one call. The script windows the range (default 24 hours per
report) and warns loudly if any window comes back at the cap.

**The endpoint is tenant- and region-specific.** Even Five9's own reference code
builds it from a configured base URI rather than hardcoding one, and the REST
services use distinct regional hosts (`app.five9.com`, `app.ca.five9.com`, and
others). There is no safe default, so `FIVE9_WSDL_URL` is required. A valid user
against the wrong region's host returns 401, which reads like a credentials
problem and isn't.

**Report columns are defined by your tenant, not by the API.** The report named
"Call Log" in your account may have entirely different columns from another
account's. The script is therefore header-driven: it maps known column names
(accepting several spellings), preserves unmapped columns under `extra`, and tells
you which columns it matched. It does not assume a schema.

**One customer call can be several call-log rows.** Transfers, conferences, and
consults each produce a row sharing one call id. Counting rows as calls
overstates volume — often substantially in a transfer-heavy contact centre. The
script collapses rows on call id by default.

**Verification status:** the workflow, the 50,000-record cap, the SOAP method
sequence, Basic auth, and the ADMIN + REPORTING role requirement are from Five9
documentation and reference code. The script's logic is tested against a mock
endpoint, but **it has not been run against a live Five9 tenant.** Expect to
adjust the report folder/name and column aliases on first contact. Run with
`--max-windows 1` first.

## Prerequisites

- Node 20+ (the script has no npm dependencies).
- A Five9 API user holding **both the ADMIN and REPORTING roles**. Reporting alone
  is not enough — the methods live on the administrator service.
- Your tenant's admin web service endpoint.
- A report that contains at minimum a **Call ID** and a **timestamp** column. Add
  Call ID to the report if it is missing; without it, call segments cannot be
  collapsed and the script refuses to guess.

```bash
export FIVE9_USERNAME=svc@acme.com
export FIVE9_PASSWORD=…
export FIVE9_WSDL_URL='https://<your-tenant-host>/wsadmin/<version>/AdminWebService'

# Optional; defaults shown
export FIVE9_REPORT_FOLDER='Call Log Reports'
export FIVE9_REPORT_NAME='Call Log'
```

Never pass credentials as arguments — argv appears in shell history, `ps`, and
agent transcripts.

## Usage

```bash
node scripts/export-interactions.mjs --start 2026-03-01 --end 2026-03-08 --out ./out/five9
```

**Arguments**

- `--start <when>` — ISO date/timestamp, epoch seconds, or a relative window
  (`30d`, `12h`). Required unless `--resume`.
- `--end <when>` — defaults to now.
- `--out <dir>` — output directory. Default `./out/five9`.
- `--window-hours <n>` — hours per report. Default 24.
- `--resume` — continue from `checkpoint.json`; completed windows are skipped.
- `--keep-segments` — keep every call-log row instead of collapsing on call id.
- `--max-windows <n>` — stop after n windows.

**Always start with one window.** This confirms the endpoint, credentials, report
name, and — most importantly — which columns your report actually has:

```bash
node scripts/export-interactions.mjs --start 1d --max-windows 1 --out ./out/sample
```

The run logs `mapped columns: …`. If a field you need is missing from that list,
either add the column to the Five9 report or extend `COLUMN_ALIASES` in the
script.

## Choosing the window size

Set `--window-hours` so no window approaches 50,000 rows. Estimate from daily call
volume, remembering that **rows are segments, not calls**:

| Daily call volume | Suggested `--window-hours` |
| --- | --- |
| under 5,000 | 24 (default) |
| 5,000 – 20,000 | 12 |
| 20,000 – 60,000 | 4 |
| over 60,000 | 1 |

Transfer-heavy operations can produce 2–3× more rows than calls, so halve these if
the sample shows a high `segments_collapsed` count. Smaller windows mean more
reports and a slower run; the trade is worth it, because a capped window silently
loses data.

If a window still caps, the script says so, marks the export incomplete, and names
the flag to change. Do not ignore that warning — a truncated report looks like a
quiet day.

## What the export will not contain

- **Call recordings and transcripts.** Not in the call log. Recordings are
  retrieved separately, and transcription depends on your Five9 configuration.
- **Message text of any kind.** A voice interaction has no message list, so this
  skill produces `conversations.jsonl` only — there is no `messages.jsonl`. Any
  analysis needing conversation content requires transcripts from elsewhere.
- **Post-call survey / CSAT.** A separate report. `csat` is set to `null` rather
  than guessed.
- **Digital channels.** Five9 digital/omnichannel interactions are not in the
  voice call log. If the account uses them, plan a separate export.
- **Agent state and adherence.** Separate reports, needed for occupancy or
  adherence analysis.
- **Anything outside the report's own definition.** The report is the schema. If a
  column is not on the report, it is not in the export.

## Output

```
conversations.jsonl     one interaction per line (canonical shape)
checkpoint.json         resume state, including completed windows
```

Canonical mapping notes:

- `channel` is always `voice`.
- `status` is always `closed` — every call-log row is a call that already ended.
  The interesting distinction lives in `status_raw` (the verbatim disposition) and
  the `abandoned` boolean, which is set from dispositions matching
  abandoned/dropped/no-answer/busy/cancel.
- `customer_id` is the ANI (calling number). It is **not** a stable customer
  identity: it changes when a customer calls from a different phone, and is absent
  or withheld for blocked numbers. Cross-channel joins on ANI will under-match.
- `assignee_id` and `team_id` are the agent name and skill/queue **as strings**,
  because the call log reports names rather than ids. Renaming an agent or skill
  in Five9 breaks historical joins.
- `segment_count` records how many call-log rows were collapsed into the
  interaction.
- `extra` holds every column the mapper did not recognise, so tenant-specific
  fields (wrap-up codes, recording URLs, custom variables) survive the export.

## Handling the data

Call log rows are production PII: phone numbers are direct identifiers, and
dispositions and wrap-up notes frequently contain account details.

- Never commit `.jsonl` exports to git.
- Phone numbers are personal data under GDPR/CCPA even without a name attached.
  Treat ANI as sensitive and hash it if the analysis does not need the raw value.
- Do not paste rows into chat. Report counts and aggregates.

## Present results to the user

1. **Completeness first.** Windows completed vs total, and **whether any window
   hit the 50,000 cap**. If one did, say plainly that the export is incomplete and
   give the smaller `--window-hours` to re-run with.
2. **Mapped columns** — which canonical fields were populated and which were
   missing from the report. This is the most common reason a Five9 export is less
   useful than expected, and it is fixable in the report definition.
3. **Rows vs interactions**, and `segments_collapsed`. If segments are a large
   share of rows, note that any row-based volume figure elsewhere in the business
   is overstating call volume.
4. **Cost** — SOAP calls and elapsed time.
5. **Reconciliation** — compare interaction counts against the same period in
   Five9's own dashboards. Investigate a material gap before using the data.
6. **The identity caveat** — if the analysis will join Five9 data to other
   channels, state that ANI is not a stable customer identity and the join will
   under-match.

## Troubleshooting

**401** — check the ADMIN *and* REPORTING roles, and confirm `FIVE9_WSDL_URL`
points at your tenant's region. Wrong-region hosts return 401.

**SOAP fault "Report not found"** — `FIVE9_REPORT_FOLDER` / `FIVE9_REPORT_NAME`
must match your tenant exactly, including spaces and case. Check the report list
in the Five9 admin UI.

**Report never finishes** — the window is too large. The script times out after
15 minutes and tells you to reduce `--window-hours`.

**`no call id column found`** — the report lacks a Call ID column. Add it, or use
`--keep-segments` and accept that rows are segments rather than calls.

**Columns are all in `extra`** — your report's headers don't match any known
alias. Read the logged header list and extend `COLUMN_ALIASES`.

**Row counts don't match the Five9 dashboard** — most often segments vs calls.
Compare `summary.rows` (segments) against the dashboard's row-based figure and
`summary.conversations` against its call-based figure.
