# Front export API notes

Sources:
- [Rate limits](https://dev.frontapp.com/docs/rate-limiting)
- [Pagination](https://dev.frontapp.com/docs/pagination)
- [Conversations](https://dev.frontapp.com/reference/conversations)
- [Search conversations](https://dev.frontapp.com/reference/search-conversations)

## Authentication

```
Authorization: Bearer {api_token}
```

Tokens carry inbox scope. A token without access to an inbox simply omits its
conversations — no error, no warning.

## Rate limits

| Scope | Limit |
| --- | --- |
| Baseline | **50 requests/minute**, varies by plan |
| Enforcement | **Per company**, not per token |
| Burst | 5 requests/second per resource type |
| Burst (exports) | 1 request/second |
| Exceeded | HTTP 429 |

Per-company enforcement is the critical detail. Adding tokens or parallelism does
not increase throughput, and a long export degrades every other Front integration
including the Front app itself. Plan large exports for off-peak hours.

## Pagination

```
GET /conversations?limit=100&sort_by=date&sort_order=desc
```

`limit` maxes out at 100. The response carries:

```jsonc
{
  "_results": [ /* conversations */ ],
  "_pagination": { "next": "https://api2.frontapp.com/conversations?page_token=…" }
}
```

**`_pagination.next` is a full URL.** Follow it verbatim; do not extract the token
and rebuild the request, because Front may include other state in it. When `next`
is absent you have reached the end.

There is no time-filter parameter on the list endpoint, so incremental sync means
sorting newest-first and stopping at a watermark client-side. The Search endpoint
supports a query DSL with date constraints and is an alternative, but it has its
own result limits — verify against your volume before relying on it.

## Conversation object

```jsonc
{
  "id": "cnv_55c8c149",
  "subject": "You broke my heart, Hubert.",
  "status": "archived",             // unassigned | assigned | archived | deleted | spam
  "type": "email",
  "created_at": 1453770984.123,     // Unix seconds, fractional
  "waiting_since": 1453880833.123,
  "last_message": { "created_at": 1453770984.123 },
  "recipient": { "handle": "user@example.com", "contact_id": "crd_55c8c149" },
  "assignee": { "id": "tea_55c8c149" },
  "inbox": { "id": "inb_55c8c149" },
  "tags": [{ "name": "billing" }]
}
```

- **Timestamps are Unix seconds, sometimes fractional.** Multiply by 1000 for JS
  dates and do not assume integers.
- **`recipient.contact_id` is often absent.** Front identifies people by handle
  (email/phone) until a contact record exists. Falling back to the handle keeps
  the conversation joinable, but a handle is a weaker identity — the same person
  with two addresses becomes two customers.
- **The inbox is the closest thing to a team.** There is no separate team field.

## Messages

```
GET /conversations/{conversation_id}/messages?limit=100
```

One call per conversation; no bulk variant.

```jsonc
{
  "id": "msg_55c8c149",
  "type": "email",
  "is_inbound": true,              // true = from the customer
  "created_at": 1453770984.123,
  "author": { "id": "tea_55c8c149" },   // null for automated sends
  "body": "<html>…</html>",
  "text": "…",                      // prefer this
  "attachments": []
}
```

- **`is_inbound` is the author signal.** An outbound message with a null `author`
  is an automated send, not an agent action — attribute it to `system`.
- **Prefer `text` over `body`.** `body` is HTML.

## Comments are not messages

Front *comments* — internal notes on a conversation — live at
`/conversations/{id}/comments`. They are a separate resource and never appear in
the messages list. A messages-only export therefore contains **no internal notes
at all**, which is a different situation from an export where notes are present
but flagged. State the gap explicitly rather than letting a reader assume
completeness.

## Channel / type values

`email`, `tweet`, `sms`, `smooch`, `whatsapp`, `facebook`, `intercom`,
`front_chat`, `phone`, `call`, `voicemail`, `custom`. Map defensively to `other`
and keep `channel_raw`.

## Other useful endpoints

| Need | Endpoint |
| --- | --- |
| Contacts, for identity resolution | `/contacts` |
| Teammates (agents) | `/teammates` |
| Inboxes | `/inboxes` |
| Tags | `/tags` |
| Internal notes | `/conversations/{id}/comments` |
| Bulk async export | `/exports` (burst limit 1/second) |
| Analytics | `/analytics/reports` |

The Exports API is the sanctioned bulk path and avoids the per-conversation N+1.
For very large accounts it is likely a better choice than the walk this script
implements — verify its response shape against your account before committing to
a multi-day run.
