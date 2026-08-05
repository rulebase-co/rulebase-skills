# Output schema and analysis recipes

The export writes newline-delimited JSON so files stream without loading into
memory and append safely across resumed runs.

## `tickets.jsonl`

One record per ticket.

| Field | Type | Notes |
| --- | --- | --- |
| `id` | number | Zendesk ticket id |
| `subject` | string \| null | |
| `status` | string | `new`, `open`, `pending`, `hold`, `solved`, `closed`, `deleted` |
| `channel` | string \| null | From `via.channel`: `email`, `web`, `api`, `chat`, `native_messaging`, `voice`… |
| `requester_id` | number \| null | End user; join to the users export |
| `assignee_id` | number \| null | Agent at time of export, not necessarily the resolver |
| `group_id` | number \| null | |
| `organization_id` | number \| null | |
| `created_at` | string | ISO 8601 |
| `updated_at` | string | ISO 8601 |
| `solved_at` | string \| null | Only present when the ticket payload carries `metric_set` |
| `satisfaction_rating` | string \| null | `good`, `bad`, `offered`, `unoffered` |
| `tags` | string[] | |
| `priority` | string \| null | |
| `ticket_form_id` | number \| null | |
| `is_deleted` | boolean | `true` when `status === "deleted"` |

Deliberately excluded: `description` and `custom_fields`. The description
duplicates the first comment, and custom fields are meaningless without
`/api/v2/ticket_fields.json` to decode ids. Add them in the normaliser if your
analysis needs them.

## `comments.jsonl`

One record per comment, joinable to tickets on `ticket_id`.

| Field | Type | Notes |
| --- | --- | --- |
| `ticket_id` | number | Join key |
| `event_id` | number | Parent ticket-event id |
| `comment_id` | number \| null | Child event id |
| `created_at` | string | ISO 8601, converted from the event's Unix timestamp |
| `author_id` | number \| null | Falls back to the event's `updater_id` |
| `public` | boolean \| null | `false` = internal note, invisible to the customer |
| `via_channel` | string \| null | Channel of this message, which can differ from the ticket's |
| `attachment_count` | number | |
| `body` | string \| null | `plain_body` where available; `null` under `--no-bodies` |
| `html_body` | string \| null | `null` under `--no-bodies` |

**`public: false` means internal note.** Including internal notes in customer-facing
analysis — response times, tone scoring, RAG corpora — is a common and serious
error. Filter them out unless you specifically want them.

## Ordering

Neither file is globally sorted. Tickets arrive in cursor order (roughly by
update time) and comments in event-timestamp order. Sort explicitly before any
sequence-dependent analysis:

```bash
jq -s 'sort_by(.created_at)' comments.jsonl > comments.sorted.json
```

## Recipes

DuckDB reads JSONL directly and is the fastest way to work at this scale.

**Ticket volume by channel and month**

```sql
SELECT strftime(created_at::TIMESTAMP, '%Y-%m') AS month,
       channel,
       count(*) AS tickets
FROM read_json_auto('out/zendesk/tickets.jsonl')
WHERE NOT is_deleted
GROUP BY 1, 2
ORDER BY 1, 3 DESC;
```

**First public agent reply time**

Requester messages and agent messages are distinguished by comparing the comment
author to the ticket requester.

```sql
WITH t AS (SELECT * FROM read_json_auto('out/zendesk/tickets.jsonl')),
     c AS (SELECT * FROM read_json_auto('out/zendesk/comments.jsonl')),
     first_agent_reply AS (
       SELECT c.ticket_id, min(c.created_at::TIMESTAMP) AS replied_at
       FROM c JOIN t ON t.id = c.ticket_id
       WHERE c.public AND c.author_id IS DISTINCT FROM t.requester_id
       GROUP BY 1
     )
SELECT t.channel,
       median(date_diff('minute', t.created_at::TIMESTAMP, r.replied_at)) AS median_frt_minutes,
       count(*) AS tickets
FROM t JOIN first_agent_reply r ON r.ticket_id = t.id
WHERE NOT t.is_deleted
GROUP BY 1 ORDER BY 3 DESC;
```

This is an approximation, not Zendesk's own first reply time — Zendesk excludes
some automated messages and can apply business-hours schedules. Use
`/api/v2/ticket_metrics.json` when the number has to match Zendesk reporting.

**Turn counts, excluding internal notes**

```sql
SELECT ticket_id,
       count(*) FILTER (WHERE public) AS public_messages,
       count(*) FILTER (WHERE NOT public) AS internal_notes
FROM read_json_auto('out/zendesk/comments.jsonl')
GROUP BY 1 ORDER BY 2 DESC LIMIT 20;
```

High public-message counts are a good first filter for back-and-forth pain and
for QA sampling.

**Build a transcript for one ticket**

```bash
jq -c 'select(.ticket_id == 4242 and .public)' out/zendesk/comments.jsonl \
  | jq -s 'sort_by(.created_at) | map({at: .created_at, author: .author_id, body: .body})'
```

## Feeding an LLM or RAG pipeline

- Use `body` (populated from `plain_body`), not `html_body`.
- Drop internal notes unless the use case needs them.
- Strip quoted email history. `plain_body` still carries visible reply chains for
  email tickets, so the last message often restates the whole thread. Truncate at
  the first quote marker before embedding, or dedupe near-identical trailing
  blocks.
- Zendesk signatures and automated acknowledgements repeat across every ticket
  and will dominate embedding similarity. Remove them.
- Redact before the text leaves your infrastructure. Ticket bodies routinely
  contain full names, addresses, partial card numbers, and account identifiers.
