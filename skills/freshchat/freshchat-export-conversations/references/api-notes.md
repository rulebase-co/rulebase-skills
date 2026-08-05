# Freshchat export API notes

Sources:
- [Freshchat API reference](https://developers.freshchat.com/api/)
- [How can I fetch the raw data of my chats?](https://crmsupport.freshworks.com/support/solutions/articles/50000004681-how-can-i-fetch-the-raw-data-of-my-chats-)
- [Freshchat API conversations — developer community](https://community.freshworks.dev/t/freshchat-api-conversations/7353)

## Authentication

```
Authorization: Bearer {api_token}
```

Base URL is `https://{domain}.freshchat.com`. Reporting endpoints are gated
separately from conversation reads — an agent-scoped token can do the latter and
not the former.

## The missing list endpoint

| Want | Endpoint | Exists? |
| --- | --- | --- |
| List all conversations | — | **No** |
| Single conversation | `GET /v2/conversations/{id}` | Yes, if you know the id |
| Messages in a conversation | `GET /v2/conversations/{id}/messages` | Yes |
| Raw report (id discovery) | `POST /v2/reports/raw` | Yes |
| Users | `GET /v2/users/{id}` | Yes, by id |
| Agents | `GET /v2/agents` | Yes |

There is no enumerate-conversations operation. Per Freshworks' own guidance, the
route is to generate a raw report (Chat Transcript or Conversation Created),
extract conversation ids from it, and then call the per-conversation endpoints.

## Reports / Extract API

```
POST /v2/reports/raw
{
  "start": "2026-03-01T00:00:00.000Z",
  "end":   "2026-03-08T00:00:00.000Z",
  "event": "Conversation-Created",
  "format": "csv"
}
```

Then poll `GET /v2/reports/raw/{id}` until a download link appears, and fetch the
artifact from that (signed) URL without the auth header.

**Request and response shapes vary by account and Freshworks release.** Field names
for the report id (`id`, `report_id`, `link_id`) and the artifact link (`link`,
`url`, `download_url`) are not stable, and the artifact may be CSV or JSON. Treat
this endpoint as the least reliable part of the integration: handle several shapes,
and provide a manual path (a pre-built id list) for when it does not cooperate.

### Id column names

Accounts label the conversation id differently depending on report definition:
`Conversation ID`, `conversation_id`, `ConversationId`, `Conv ID`,
`Conversation Reference Id`. Match case- and space-insensitively across all of
them, and when nothing matches, **print the columns you did see** — that is what
lets someone fix the report definition rather than guess.

## Conversation object

```jsonc
{
  "conversation_id": "…",
  "status": "resolved",             // new | assigned | resolved | reopened
  "channel_id": "…",
  "assigned_agent_id": "…",
  "assigned_group_id": "…",
  "users": [{ "id": "…" }],
  "created_time": "2026-03-01T10:00:00.000Z",
  "updated_time": "2026-03-01T10:10:00.000Z",
  "labels": [{ "name": "billing" }]
}
```

Freshchat is a messaging product, so the canonical channel is always `chat`.
`channel_id` refers to a Freshchat "channel" (a routing topic), not a
communication medium — keep it in `channel_raw` and do not mistake it for one.

## Messages

```
GET /v2/conversations/{id}/messages?page=1&items_per_page=50
```

`items_per_page` is capped at **50**, lower than most APIs, so long chat
transcripts cost more requests than expected.

```jsonc
{
  "id": "…",
  "conversation_id": "…",
  "actor_type": "user",            // user | agent | bot | system
  "actor_id": "…",
  "message_type": "normal",        // "private" = agent-only note
  "created_time": "2026-03-01T10:01:00.000Z",
  "message_parts": [
    { "text": { "content": "where is my refund" } },
    { "image": { "url": "…" } }
  ]
}
```

Two things to get right:

- **There is no body field.** Text is in `message_parts[].text.content`, and a
  single message can have several parts. Join the text parts; count the image/file
  parts as attachments.
- **`message_type: "private"` is an internal note.** Not customer-visible.

`actor_type` is the author signal but is unreliable for bot-authored messages, so
fall back to comparing `actor_id` against the conversation's user id.

## Rate limits

Freshworks applies per-account, plan-dependent rate limits and returns 429 with
`Retry-After`. Honour the header, run large exports off-peak, and pace rather than
bursting — the reporting endpoints in particular are not designed for high volume.

## Freshchat is not Freshdesk

Separate products, separate APIs, separate tokens, separate domains. Freshdesk's
`/api/v2/tickets` returns nothing from Freshchat and vice versa. An account using
both needs two exports, and joining them requires a shared customer identity that
neither product provides by default.
