# Freshdesk export API notes

Endpoint, limit, and field detail. Verify limits against the linked docs before
relying on them — Freshdesk rate limits are plan-dependent.

Sources:
- [Freshdesk API v2](https://developers.freshdesk.com/api/)
- [What are my ticket export options?](https://support.freshdesk.com/support/discussions/topics/321689)
- [API filter and pagination](https://support.freshdesk.com/support/discussions/topics/324778)

## Authentication

HTTP Basic, with the API key as the **username** and any string as the password:

```
Authorization: Basic base64("{api_key}:X")
```

The key inherits its agent's permissions, including ticket scope. An agent
restricted to their own or their group's tickets produces a silent partial export
— no error, just fewer tickets. Always reconcile the count against the admin UI.

## The pagination ceilings

| Endpoint | Ceiling |
| --- | --- |
| `GET /api/v2/tickets` | 300 pages × up to 100 per page = **30,000 tickets** |
| `GET /api/v2/search/tickets` (Filter) | 10 pages × 30 per page = **300 tickets** |
| Default `per_page` | 30 (raise to 100 explicitly) |
| Default time window | **last 30 days** unless `updated_since` is set |

All four fail silently. Past the ceiling the API returns an empty array as though
you had reached the end of the data.

## Escaping the ceiling: the moving watermark

```
GET /api/v2/tickets
      ?per_page=100
      &page=1
      &updated_since=2026-01-01T00:00:00Z
      &order_by=updated_at
      &order_type=asc
      &include=stats
```

1. Page until a short page (fewer than `per_page` results) or page 300.
2. On hitting page 300, set `updated_since` to the last ticket's `updated_at`,
   reset to page 1, and continue.
3. Repeat until a short page.

**`order_type=asc` is load-bearing.** Ascending order guarantees the watermark
moves forward monotonically and that nothing between windows is skipped. With
Freshdesk's default descending order, page 300 is a hard wall at the newest
30,000 tickets.

The failure case: more than 30,000 tickets sharing one `updated_at` second, which
happens after a bulk update or a migration. The watermark cannot advance past it.
Detect a non-advancing watermark and fail rather than looping; export that period
with a narrower window.

Note that a watermark boundary can re-return the boundary ticket, so deduplicate
on ticket id downstream. The export script deduplicates its id list before the
detail phase.

## Rate limits

Per minute, per account, and plan-dependent. The budget is shared with the agent
UI and every installed app, so saturating it degrades live agent work.

Response headers:

| Header | Meaning |
| --- | --- |
| `X-RateLimit-Total` | Account allowance per minute |
| `X-RateLimit-Remaining` | Calls left this minute |
| `X-RateLimit-Used-CurrentRequest` | Cost of this call |
| `Retry-After` | Seconds to wait, sent on 429 |

Freshdesk reliably sends `Retry-After` on 429. Because the limit varies by plan,
honouring that header is more robust than pacing to an assumed rate. Read
`X-RateLimit-Total` on the first response if you want to size concurrency.

Some endpoints cost more than one unit per call — check
`X-RateLimit-Used-CurrentRequest` rather than counting requests.

## Conversations (message bodies)

```
GET /api/v2/tickets/{id}/conversations?per_page=100&page=1
```

Not available in bulk; one request per ticket. Entries are replies and notes:

```jsonc
{
  "id": 501,
  "ticket_id": 42,
  "user_id": 77,
  "body": "<div>…</div>",     // HTML
  "body_text": "…",           // plain text — prefer this
  "private": false,           // true = internal note
  "incoming": true,           // true = from the customer
  "source": 0,
  "created_at": "2026-03-01T10:01:00Z",
  "attachments": []
}
```

- **`private: true` is an internal note.** Not customer-visible.
- **`incoming: true` marks a customer message.** It is the primary signal for
  author type, but it is not always populated on older tickets — fall back to
  comparing `user_id` against the ticket's `requester_id`.
- **Prefer `body_text`.** The HTML `body` inflates token counts and breaks length
  and similarity metrics.
- The sub-resource paginates. 100+ replies on one ticket is rare but happens on
  long-running escalations.

## Ticket field encodings

Freshdesk uses integers almost everywhere.

**Status** (custom statuses are configurable above 7, so treat unknown codes as
open and keep the raw value):

| Code | Meaning | Canonical |
| --- | --- | --- |
| 2 | Open | `open` |
| 3 | Pending | `pending` |
| 4 | Resolved | `resolved` |
| 5 | Closed | `closed` |
| 6 | Waiting on Customer | `open` |
| 7 | Waiting on Third Party | `pending` |
| 8+ | Custom | `open` |

**Priority:** 1 Low, 2 Medium, 3 High, 4 Urgent.

**Source:** 1 Email, 2 Portal (web form), 3 Phone, 7 Chat, 9 Feedback widget,
10 Outbound email, plus messaging and social channels. Codes vary by account
configuration and enabled channels — confirm against your own data rather than
assuming, and always keep `channel_raw`.

## Useful query parameters

| Parameter | Effect |
| --- | --- |
| `updated_since` | ISO 8601. Required for anything older than 30 days |
| `order_by`, `order_type` | `created_at` / `updated_at` / `priority` / `status`; `asc` / `desc` |
| `per_page` | Up to 100 |
| `include=stats` | Adds `resolved_at`, `closed_at`, `first_responded_at` |
| `include=requester,company` | Sideloads requester and company detail |
| `filter=deleted` / `filter=spam` | Deleted and spam tickets, excluded by default |

`include=stats` is the only way to get resolution timestamps on the ticket object
and costs extra rate-limit units. Availability varies by plan.

## What is excluded by default

- **Deleted and spam tickets.** Use `filter=deleted` / `filter=spam` explicitly.
- **Archived tickets**, depending on account configuration.
- **CSAT.** Surveys are a separate resource
  (`/api/v2/surveys/satisfaction_ratings`) and the scale is configurable per
  account, so there is no safe generic mapping to a normalised score. Pull it
  separately and document your account's scale.
- **Custom field values** are returned inside `custom_fields` but are
  uninterpretable without `/api/v2/ticket_fields`.

## Other useful endpoints

| Need | Endpoint |
| --- | --- |
| Custom field definitions | `/api/v2/ticket_fields` |
| Agents (for joins) | `/api/v2/agents` |
| Groups / teams | `/api/v2/groups` |
| Contacts, companies | `/api/v2/contacts`, `/api/v2/companies` |
| CSAT responses | `/api/v2/surveys/satisfaction_ratings` |
| Time entries | `/api/v2/tickets/{id}/time_entries` |

Freshchat is a **separate product with a separate API**; Freshdesk endpoints do not
return Freshchat conversations. If the account uses both, plan two exports.
