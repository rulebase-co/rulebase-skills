# Intercom export API notes

Endpoint, limit, and field detail. Verify limits against the linked docs before
relying on them — Intercom's published rate limits have changed more than once.

Sources:
- [Search conversations](https://developers.intercom.com/docs/references/rest-api/api.intercom.io/conversations/searchconversations)
- [Retrieve a conversation](https://developers.intercom.com/docs/references/rest-api/api.intercom.io/conversations/retrieveconversation)
- [List conversations](https://developers.intercom.com/docs/references/2.0/rest-api/conversations/list-conversations)
- [Rate limiting](https://developers.intercom.com/docs/references/rest-api/errors/rate-limiting)
- [Conversation parts model](https://developers.intercom.com/docs/references/2.8/rest-api/api.intercom.io/models/conversation_parts)

## Authentication and versioning

```
Authorization: Bearer {access_token}
Accept: application/json
Intercom-Version: 2.14
```

Tokens are workspace-scoped; a token from another workspace returns 401 rather
than an empty result set.

**Always send `Intercom-Version`.** Without it you get the workspace default,
which changes over time and differs between workspaces, so response shapes shift
under a working integration. Record the version alongside any export.

## Search conversations

```
POST /conversations/search
```

```jsonc
{
  "query": { "field": "updated_at", "operator": ">", "value": 1767225600 },
  "pagination": { "per_page": 150, "starting_after": "<cursor>" }
}
```

Response:

| Field | Meaning |
| --- | --- |
| `conversations[]` | Up to 150 conversations, **without** `conversation_parts` |
| `pages.next.starting_after` | Cursor for the next page; absent on the last page |
| `pages.per_page`, `pages.page` | Echo of the request |
| `total_count` | Approximate total matching the query |

`per_page` maxes out at 150. Operators include `=`, `!=`, `>`, `<`, `IN`, `NIN`,
and `AND`/`OR` grouping via nested `query` objects.

Filter on `updated_at` for incremental sync and on `created_at` to reconstruct a
fixed historical window. They give materially different result sets: a
conversation created two years ago but touched yesterday matches the first and
not the second.

`GET /conversations?per_page=150` also works and paginates the same way, but it
cannot filter, so it is only useful for a full crawl.

## Retrieve a conversation

```
GET /conversations/{id}
```

This is the **only** endpoint that returns message bodies. One request per
conversation; there is no batch variant and no sideload.

```jsonc
{
  "id": "123",
  "state": "closed",
  "created_at": 1767225600,          // Unix seconds
  "updated_at": 1767225900,
  "admin_assignee_id": 55,
  "team_assignee_id": 7,
  "contacts": { "contacts": [{ "id": "900" }] },
  "conversation_rating": { "rating": 4, "remark": "…" },
  "source": {                         // the opening message
    "type": "conversation",
    "delivered_as": "email",
    "body": "<p>…</p>",
    "author": { "id": "900", "type": "user" }
  },
  "conversation_parts": {
    "total_count": 12,
    "conversation_parts": [ /* … */ ]
  }
}
```

**The opening message is on `source`, not in `conversation_parts`.** Iterating only
over parts drops the customer's original question from every conversation.

### The 500-part cap

The maximum number of conversation parts returned is **500**. Beyond that,
Intercom returns the 500 most recent and gives no error or flag.

Detect it by comparing `conversation_parts.total_count` against the length of
`conversation_parts.conversation_parts`. Truncation removes the *earliest* parts,
so long conversations lose their opening context. There is no API path to the
missing parts — treat those conversations as partial and exclude them from
analyses that depend on how a conversation began.

### Part types

`part_type` covers both messages and workflow events:

| `part_type` | Treat as |
| --- | --- |
| `comment` | Public message |
| `note` | Internal note — not customer-visible |
| `note_and_reopen` | Internal note |
| `assignment`, `close`, `open`, `snoozed`, `unsnoozed`, `away_mode_assignment` | Workflow event, not a message |

Counting workflow parts as messages inflates every turn-count and response-time
metric. A `comment` with an empty `body` is also a state change reusing the type.

### Author types

`author.type` values and their canonical mapping:

| `author.type` | Canonical `author_type` |
| --- | --- |
| `user`, `lead`, `contact` | `customer` |
| `admin`, `team` | `agent` |
| `bot`, `operator` | `bot` |
| anything else | fall back to id comparison, then `unknown` |

`operator` is Intercom's own automation; `bot` covers Fin and custom bots. New
values appear over time, so map defensively and fall back to comparing
`author.id` against the conversation's contact id — that comparison is stable
across versions.

## Rate limits

Documented as **10,000 API calls per minute per app** and **25,000 per minute per
workspace**, with older documentation citing 1,000/minute. Because the figure has
changed and varies by plan, read it at runtime rather than hardcoding it.

The critical operational detail: **the per-minute allowance is distributed across
10-second windows.** You cannot burst a minute's budget at once — roughly a sixth
of it is available per window. A run that looks safe against the per-minute number
will still 429 if it fires everything in two seconds.

Response headers:

| Header | Meaning |
| --- | --- |
| `X-RateLimit-Limit` | Allowance for the current window |
| `X-RateLimit-Remaining` | Calls left in the current window |
| `X-RateLimit-Reset` | When the window resets (Unix timestamp) |

On 429, back off until the window resets. Search endpoints are reported to be
more aggressively limited than others, so treat a 429 on `/search` as normal
rather than as a bug.

## Bodies are HTML

`body`, `source.body`, and part bodies are HTML, not plain text. Store plain text
for analysis: markup inflates token counts, breaks similarity measures, and
corrupts naive length metrics.

Quoted email history appears inside email-delivered bodies, so the final message
in a long email thread often restates the whole conversation. Strip quoted blocks
before embedding.

## Other useful endpoints

| Need | Endpoint |
| --- | --- |
| Contact attributes for segmentation | `/contacts/{id}`, `POST /contacts/search` |
| Company / account data | `/companies` |
| Admin (agent) roster | `/admins` |
| Teams | `/teams` |
| Tags | `/tags` |
| Conversation ratings in bulk | Ratings are on the conversation object |
| Data attributes (custom field definitions) | `/data_attributes` |
| Near-real-time updates instead of polling | Webhooks / topics |

For an ongoing sync, webhooks on conversation events plus a periodic
`updated_at` sweep to catch missed deliveries is cheaper than polling alone.
