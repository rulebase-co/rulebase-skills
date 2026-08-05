# HubSpot Service Hub export API notes

Sources:
- [Conversations API guide](https://developers.hubspot.com/docs/api-reference/legacy/conversations/guide)
- [API usage details and rate limits](https://developers.hubspot.com/docs/guides/apps/api-usage/usage-details)

## Authentication

```
Authorization: Bearer {private_app_token}
```

Requires the `conversations.read` scope (`conversations.write` for posting).
**Adding a scope requires reinstalling the private app** — an existing token does
not gain the scope, it keeps returning 403.

## Endpoints

| Purpose | Endpoint |
| --- | --- |
| List threads | `GET /conversations/v3/conversations/threads` |
| Single thread | `GET /conversations/v3/conversations/threads/{threadId}` |
| Messages in a thread | `GET /conversations/v3/conversations/threads/{threadId}/messages` |
| Single message | `GET /conversations/v3/conversations/threads/{threadId}/messages/{messageId}` |

## Pagination

Cursor-based:

- Request: `limit` (max **500**), `after`
- Response: `paging.next.after`, absent on the last page

```jsonc
{ "results": [ /* threads */ ], "paging": { "next": { "after": "…" } } }
```

500 per page makes thread listing cheap. Messages are one request per thread, and
that is what dominates a large export.

## Query parameters on the thread list

| Parameter | Notes |
| --- | --- |
| `limit` | Max 500 |
| `after` | Pagination cursor |
| `archived` | `true` to return soft-deleted threads |
| `inboxId` | **A single inbox only** — repeating the parameter is not supported |
| `sort` | e.g. `-latestMessageTimestamp` for newest-first |

## The truncation trap

Email messages carry:

```jsonc
{
  "id": "…",
  "type": "MESSAGE",              // or COMMENT for an internal note
  "text": "…",
  "truncationStatus": "TRUNCATED_TO_MOST_RECENT_REPLY"
}
```

| Value | Meaning |
| --- | --- |
| `NOT_TRUNCATED` | Complete body |
| `TRUNCATED_TO_MOST_RECENT_REPLY` | Only the latest reply; earlier history removed |
| `TRUNCATED` | Body cut |

Reply history is truncated **automatically**. A truncated body is a plausible
short message with no marker in the text, so any pipeline that ignores
`truncationStatus` silently ingests incomplete conversations. Per HubSpot's docs,
the full version is retrievable from the original content endpoint — one request
per message, which is expensive but the only route.

Always carry `truncationStatus` through to your warehouse. Filter on it before
computing message lengths, building embeddings, or asking an LLM to judge a
conversation.

## Archived threads

Excluded from the list by default. `archived=true` returns them, but HubSpot
**permanently removes archived threads after 30 days**. There is no path to
anything older, so archived history cannot be backfilled — only captured going
forward.

## Author identity

Message senders carry an `actorId` whose prefix encodes the actor type:

| Prefix | Actor | Canonical |
| --- | --- | --- |
| `V-` | Visitor | `customer` |
| `A-` | Agent | `agent` |
| `I-` | Integration | `bot` |
| `S-` | System | `system` |

Prefixes are the reliable signal. Map unrecognised prefixes to `unknown` rather
than assuming agent — new actor types appear over time.

## What threads do not carry

- **No channel.** Channel is on messages (`EMAIL`, `LIVE_CHAT`, `FB_MESSENGER`,
  `WHATS_APP`, `SMS`, `CALL`, `FORMS`, `CUSTOM_CHANNEL`).
- **No contact id.** Associated contacts come from the CRM associations API. This
  matters: without it there is no `customer_id`, so repeat-contact, deflection, and
  per-customer analyses need a separate association pass.
- **No subject.** `latestMessagePreview` is a body excerpt, not a subject.

## Rate limits

Published limits vary by subscription tier and have changed over time, so read
them at runtime instead of hardcoding:

| Header | Meaning |
| --- | --- |
| `X-HubSpot-RateLimit-Max` | Requests allowed per interval |
| `X-HubSpot-RateLimit-Remaining` | Remaining in the current interval |
| `X-HubSpot-RateLimit-Interval-Milliseconds` | Interval length |
| `X-HubSpot-RateLimit-Daily` | Daily allowance |
| `X-HubSpot-RateLimit-Daily-Remaining` | Remaining today |

On large accounts the **daily** allowance binds before the per-interval rate. Watch
`Daily-Remaining` and split across days rather than discovering the wall mid-run.
Pace to a fraction of the advertised max so other integrations keep headroom.

## Tickets are a different object

Service Hub tickets are a CRM object with their own API
(`/crm/v3/objects/tickets`) and are **not** returned by the conversations
endpoints. An account that works in tickets rather than the shared inbox will look
empty here. Confirm which the team actually uses before concluding there is no
data.
