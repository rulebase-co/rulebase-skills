# Zendesk export API notes

Endpoint, limit, and field detail for the Incremental Exports API. Verify limits
against the linked docs before relying on them — Zendesk changes plan limits.

Sources:
- [Incremental Exports API reference](https://developer.zendesk.com/api-reference/ticketing/ticket-management/incremental_exports/)
- [Using the Incremental Exports API](https://developer.zendesk.com/documentation/api-basics/working-with-data/using-the-incremental-export-api/)
- [Side-loading related records](https://developer.zendesk.com/documentation/api-basics/working-with-data/side_loading/)
- [Rate limits](https://developer.zendesk.com/api-reference/introduction/rate-limits/)

## Authentication

API token auth is HTTP Basic with a specific username shape:

```
username: {email_address}/token
password: {api_token}
Authorization: Basic base64("{email}/token:{api_token}")
```

Omitting `/token` produces a 401 that looks like a bad password. OAuth access
tokens use `Authorization: Bearer {token}` instead and are preferable for
anything installed on a customer's behalf.

## Rate limits

| Scope | Limit |
| --- | --- |
| Incremental export endpoints | 10 requests/minute (30/min with the High Volume API add-on) |
| Export Search Results (`/api/v2/search/export`) | 100 requests/minute per account |
| Account-wide Ticketing API — Team | 200 requests/minute |
| Account-wide Ticketing API — Professional | 400 requests/minute |
| Account-wide Ticketing API — Enterprise | 700 requests/minute |
| Account-wide with High Volume add-on | 2,500 requests/minute |

The account-wide budget is shared with everything else hitting your Zendesk,
including the agent UI and installed apps. Saturating it degrades live agent
work, which is the main reason to prefer incremental exports over per-ticket
fetching.

On 429, the response carries `Retry-After` in seconds. `X-Rate-Limit` reports
the account limit. Honour `Retry-After` rather than backing off blindly.

## Incremental ticket export (cursor)

```
GET /api/v2/incremental/tickets/cursor.json?start_time={epoch}
GET /api/v2/incremental/tickets/cursor.json?cursor={after_cursor}
```

Response:

| Field | Meaning |
| --- | --- |
| `tickets[]` | Up to 1,000 tickets |
| `after_cursor` | Pass as `cursor` for the next page |
| `after_url` | Prebuilt next-page URL |
| `before_cursor` / `before_url` | Backwards paging; null at the start |
| `end_of_stream` | `true` once caught up to the present |
| `count` | Records in this page |

Cursor-based export is the recommended form and the only one that is safe
against records sharing a timestamp. The time-based variant
(`/api/v2/incremental/tickets.json?start_time=`) still exists and returns
`end_time` / `next_page` instead; prefer cursor.

Cursor-based incremental export is available for **tickets** and **users**.
Organizations are time-based only.

## Incremental ticket events export (time-based)

```
GET /api/v2/incremental/ticket_events.json?start_time={epoch}&include=comment_events
```

Response:

| Field | Meaning |
| --- | --- |
| `ticket_events[]` | Up to 1,000 events |
| `end_time` | Timestamp of the last event; use as the next `start_time` |
| `next_page` | Prebuilt next-page URL |
| `end_of_stream` | `true` once caught up |

Each event:

```jsonc
{
  "id": 123456789,
  "ticket_id": 4242,
  "timestamp": 1767225600,       // Unix seconds, not ISO
  "updater_id": 987,
  "via": { "channel": "email" },
  "child_events": [ /* … */ ]
}
```

### The comment_events sideload

`include=comment_events` embeds comment data in `child_events` rather than in a
separate top-level array — unusual for a Zendesk sideload and easy to miss.

A comment child event:

```jsonc
{
  "id": 555,
  "event_type": "Comment",       // some responses use "type"
  "author_id": 987,
  "public": true,
  "body": "…",                   // may contain quoted email history
  "plain_body": "…",             // preferred for analysis
  "html_body": "…",
  "attachments": []
}
```

Two things to handle:

1. **`child_events` mixes types.** A single event can carry `Create`, `Change`,
   `Notification`, and `Comment` children. Filter on
   `event_type === 'Comment'` (falling back to `type`) or you will treat status
   changes as messages.
2. **`plain_body` is the analysis field.** `body` frequently includes the
   quoted history of the whole email thread, so naive token counts and
   similarity measures over `body` are badly inflated.

### Why this stream is large

The events export returns every event type, so it is much larger than the ticket
stream for the same window. There is no server-side filter that returns only
comment events — `include=comment_events` adds comment data, it does not
restrict the result set. Filtering happens client-side, which is why the run is
bounded by request count rather than by useful records.

## Time-based pagination hazard

Time-based exports advance by second. If more than one page of events shares a
single timestamp, `end_time` cannot advance past it and the cursor sticks. The
export script detects a non-advancing `end_time` and fails rather than looping
forever. This is the primary reason to use cursor pagination wherever it exists.

## The replication lag rule

Ticket and ticket-event exports do not return data for the most recent minute.
From the Zendesk docs: the start time "must be more than one minute in the past
to avoid missing data." Requesting a window inside that minute wastes a request
against a 10/minute budget and can silently omit records — clamp the start time
back instead.

## Other useful endpoints

| Need | Endpoint | Note |
| --- | --- | --- |
| Users / orgs for joins | `/api/v2/incremental/users/cursor.json`, `/api/v2/incremental/organizations.json` | Users cursor export has its own limit (20/min; 60 with add-on) |
| Custom field definitions | `/api/v2/ticket_fields.json` | Needed to decode `custom_fields` ids |
| Groups, brands | `/api/v2/groups.json`, `/api/v2/brands.json` | Small; fetch once |
| SLA and timing detail | `/api/v2/ticket_metrics.json` | First reply time, full resolution time |
| Satisfaction responses | `/api/v2/satisfaction_ratings.json` | Includes the verbatim comment |
| Voice | Talk API | Recordings/transcripts are not in ticket comments |
| Side conversations | `/api/v2/tickets/{id}/side_conversations.json` | Not in `ticket_events` |

## Archived tickets

Zendesk archives closed tickets after roughly 120 days. Archived tickets are
**included** in incremental exports but **excluded** from Search and from some
list endpoints. This asymmetry is a common cause of "the export has more tickets
than the report" — the export is usually the correct number.
