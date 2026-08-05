# Gorgias export API notes

Sources:
- [List tickets](https://developers.gorgias.com/reference/list-tickets)
- [The Ticket object](https://developers.gorgias.com/reference/the-ticket-object)
- [List messages of a ticket](https://developers.gorgias.com/reference/list-ticket-messages)
- [Pagination](https://developers.gorgias.com/reference/pagination)
- [Rate limits](https://developers.gorgias.com/reference/limitations)

## Authentication

HTTP Basic, with the **account email** as username and the API key as password:

```
Authorization: Basic base64("{email}:{api_key}")
```

Using the key alone returns 401.

## List tickets

```
GET /api/tickets?limit=100&order_by=updated_datetime:desc&cursor={cursor}
```

| Parameter | Notes |
| --- | --- |
| `limit` | Default 30, max 100 |
| `cursor` | Opaque and **short-lived** — do not persist across runs |
| `order_by` | `created_datetime:asc|desc`, `updated_datetime:asc|desc`. Default `created_datetime:desc` |
| `view_id` | Applies a saved view's filters |
| `customer_id`, `external_id`, `ticket_ids`, `trashed` | Additional filters |

Response envelope:

```jsonc
{
  "data": [ /* TicketCompact */ ],
  "meta": { "prev_cursor": "…", "next_cursor": "…", "total_resources": 1234 }
}
```

**There is no `updated_since` parameter.** `updated_datetime` exists as an
`order_by` option and on the ticket object, but not as a filter. Incremental sync
must be `updated_datetime:desc` plus a client-side stop.

**Cursors expire.** They are documented as short-lived, so a checkpointed cursor
may be dead when a paused run resumes. The script stores it, but if paging fails
after a long pause, restart phase 1 — the watermark stop makes that cheap.

### TicketCompact has no message bodies

The list object carries `excerpt`: "Excerpt of the last message of the ticket".
That is the tail of one message, not the conversation. Building an analysis or a
RAG corpus on `excerpt` yields one truncated fragment per ticket.

## Messages

```
GET /api/tickets/{id}/messages?limit=100&cursor={cursor}
```

One call per ticket; no bulk variant.

```jsonc
{
  "id": 501,
  "ticket_id": 42,
  "sender": { "id": 901, "email": "…" },
  "from_agent": false,        // false = from the customer
  "public": true,             // false = internal note
  "channel": "email",
  "body_text": "…",           // prefer this
  "body_html": "<div>…</div>",
  "created_datetime": "2026-03-01T10:01:00Z",
  "attachments": []
}
```

- **`from_agent` is the author signal.** It is absent on some
  integration-authored messages; fall back to comparing `sender.id` against the
  ticket's customer.
- **`public: false` is an internal note.** Not customer-visible.
- **Prefer `body_text`.** The HTML body inflates token counts and breaks length
  and similarity metrics.

## Rate limits

A leaky bucket that refills gradually:

| Integration type | Budget |
| --- | --- |
| API key | 40 requests per 20 seconds |
| OAuth2 app | 80 requests per 20 seconds |
| Enterprise | Same counts over a 10-second window |

Because the bucket refills rather than resetting, a burst that fits the nominal
budget can still 429. Pace to the sustained rate. On 429, honour `Retry-After`.

## Channel values

Common `channel` values: `email`, `chat`, `api-chat`, `sms`, `whatsapp`,
`facebook`, `facebook-messenger`, `instagram`, `twitter`, `phone`,
`contact_form`, `help-center`, `api`. The set depends on which integrations the
account has enabled, so map defensively to `other` and keep `channel_raw`.

## Other useful endpoints

| Need | Endpoint |
| --- | --- |
| Customers, for joins | `/api/customers` |
| Agents / users | `/api/users` |
| Teams | `/api/teams` |
| Satisfaction surveys | `/api/satisfaction-surveys` |
| Ticket events / audit trail | `/api/events` |
| Views (saved filters) | `/api/views` |
| Custom fields | `/api/custom-fields` |

Satisfaction survey scales are account-configurable, so document your own mapping
before normalising them into a score.
