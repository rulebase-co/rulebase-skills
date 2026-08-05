# Output schema and analysis recipes

The export writes newline-delimited JSON so files stream without loading into
memory and append safely across resumed runs.

The shape is the canonical cross-platform conversation schema, so analyses written
against it also run against Intercom, Freshdesk, and Five9 exports.

## `conversations.jsonl`

One record per ticket.

| Field | Type | Notes |
| --- | --- | --- |
| `source` | string | Always `"zendesk"` |
| `source_id` | string | Ticket id, stringified |
| `subject` | string \| null | |
| `status` | enum | `open` `pending` `resolved` `closed` `deleted` |
| `status_raw` | string | Zendesk's own status |
| `channel` | enum \| null | `email` `chat` `messaging` `voice` `social` `web_form` `api` `other` |
| `channel_raw` | string \| null | `via.channel` verbatim |
| `customer_id` | string \| null | Requester |
| `assignee_id` | string \| null | Agent at export time, not necessarily the resolver |
| `team_id` | string \| null | Group |
| `account_id` | string \| null | Organization |
| `created_at` | ISO 8601 | |
| `updated_at` | ISO 8601 \| null | |
| `resolved_at` | ISO 8601 \| null | From `metric_set.solved_at`; only present when the ticket payload carries it |
| `csat` | 1 \| 0 \| null | `good` → 1, `bad` → 0, `offered`/`unoffered` → null |
| `csat_raw` | string \| null | Original score value |
| `priority` | string \| null | |
| `tags` | string[] | |
| `is_deleted` | boolean | True when `status_raw` is `deleted` |

Status mapping detail:

| Zendesk | Canonical | Why |
| --- | --- | --- |
| `new`, `open` | `open` | |
| `pending` | `pending` | Blocked on the customer |
| `hold` | `pending` | Blocked on an agent or third party |
| `solved` | `resolved` | Can still be reopened |
| `closed` | `closed` | Cannot be reopened |
| `deleted` | `deleted` | Soft-deleted; kept so counts reconcile |

**`solved` and `closed` are not interchangeable.** Solved tickets can be reopened,
closed ones cannot, so reopen rate must be computed from `status_raw`.

Deliberately excluded: `description` and `custom_fields`. The description
duplicates the first comment, and custom fields are meaningless without
`/api/v2/ticket_fields.json` to decode ids. Add them to the normaliser if your
analysis needs them.

## `messages.jsonl`

One record per comment, joinable on `conversation_source_id`.

| Field | Type | Notes |
| --- | --- | --- |
| `source` | string | Always `"zendesk"` |
| `conversation_source_id` | string | Join key to `conversations.source_id` |
| `source_id` | string | Comment (child event) id |
| `created_at` | ISO 8601 | Converted from the event's Unix timestamp |
| `author_id` | string \| null | Falls back to the event's `updater_id` |
| `author_type` | enum | `customer` `agent` `unknown` |
| `visibility` | enum | `public` or `internal` |
| `channel` | enum \| null | Channel of this message, which can differ from the conversation's |
| `attachment_count` | number | |
| `body` | string \| null | From `plain_body`; `null` under `--no-bodies` |

### Two things that are easy to get wrong

**`visibility: "internal"` means an internal note.** Including internal notes in
customer-facing analysis — response times, tone scoring, RAG corpora — is a common
and serious error. Filter them out unless you specifically want them.

**`author_type` depends on the conversations file.** Zendesk puts no role flag on
a comment, only an `author_id`. Attribution works by comparing it against the
ticket's requester, which requires `conversations.jsonl` to have been written
first. If you ran `--only messages` on an empty directory, every `author_type` is
`unknown` and any agent-vs-customer analysis is invalid. The script warns when
this happens; the canonical validator reports the `unknown` share.

## Validating before you analyse

The `cx-conversation-schema` skill ships a validator for this shape. Install it
alongside this one and point it at the output directory:

```bash
npx skills add rulebase-co/skills --skill cx-conversation-schema
```

It checks enum vocabulary, ISO timestamps, orphaned messages, duplicate ids, and
the `unknown` author share — the failures that otherwise surface as an
inexplicable metric weeks later.

## Ordering

Neither file is globally sorted. Conversations arrive in cursor order (roughly by
update time) and messages in event-timestamp order. Sort explicitly before any
sequence-dependent analysis:

```bash
jq -s 'sort_by(.created_at)' messages.jsonl > messages.sorted.json
```

## Recipes

DuckDB reads JSONL directly and is the fastest way to work at this scale.

**Ticket volume by channel and month**

```sql
SELECT strftime(created_at::TIMESTAMP, '%Y-%m') AS month,
       channel,
       count(*) AS conversations
FROM read_json_auto('out/zendesk/conversations.jsonl')
WHERE NOT is_deleted
GROUP BY 1, 2
ORDER BY 1, 3 DESC;
```

**First public agent reply time**

`author_type` makes this straightforward — no join back to the conversation is
needed to tell agent from customer.

```sql
WITH c AS (SELECT * FROM read_json_auto('out/zendesk/conversations.jsonl')),
     m AS (SELECT * FROM read_json_auto('out/zendesk/messages.jsonl')),
     first_agent_reply AS (
       SELECT conversation_source_id, min(created_at::TIMESTAMP) AS replied_at
       FROM m
       WHERE visibility = 'public' AND author_type = 'agent'
       GROUP BY 1
     )
SELECT c.channel,
       median(date_diff('minute', c.created_at::TIMESTAMP, r.replied_at)) AS median_frt_minutes,
       count(*) AS conversations
FROM c JOIN first_agent_reply r ON r.conversation_source_id = c.source_id
WHERE NOT c.is_deleted
GROUP BY 1 ORDER BY 3 DESC;
```

Filtering on `visibility = 'public'` is what makes this correct. Counting internal
notes makes first response time look far better than it is.

This is still an approximation, not Zendesk's own first reply time — Zendesk
excludes some automated messages and can apply business-hours schedules. Use
`/api/v2/ticket_metrics.json` when the number has to match Zendesk reporting.

**Reopen rate, which needs the raw status**

```sql
SELECT count(*) FILTER (WHERE status_raw = 'solved') AS solved_reopenable,
       count(*) FILTER (WHERE status_raw = 'closed') AS closed_final
FROM read_json_auto('out/zendesk/conversations.jsonl')
WHERE NOT is_deleted;
```

**Turn counts, excluding internal notes**

```sql
SELECT conversation_source_id,
       count(*) FILTER (WHERE visibility = 'public')   AS public_messages,
       count(*) FILTER (WHERE visibility = 'internal') AS internal_notes,
       count(*) FILTER (WHERE author_type = 'customer' AND visibility = 'public') AS customer_turns
FROM read_json_auto('out/zendesk/messages.jsonl')
GROUP BY 1 ORDER BY 2 DESC LIMIT 20;
```

High public-message counts are a good first filter for back-and-forth pain and for
QA sampling.

**Build a transcript for one conversation**

```bash
jq -c 'select(.conversation_source_id == "4242" and .visibility == "public")' \
    out/zendesk/messages.jsonl \
  | jq -s 'sort_by(.created_at) | map({at: .created_at, who: .author_type, body: .body})'
```

## Feeding an LLM or RAG pipeline

- Use `body` (populated from `plain_body`), never the HTML.
- Drop `visibility: "internal"` unless the use case needs staff commentary.
- Strip quoted email history. `plain_body` still carries visible reply chains for
  email tickets, so the last message often restates the whole thread. Truncate at
  the first quote marker before embedding, or dedupe near-identical trailing
  blocks.
- Zendesk signatures and automated acknowledgements repeat across every ticket and
  will dominate embedding similarity. Remove them.
- Redact before the text leaves your infrastructure. Bodies routinely contain full
  names, addresses, partial card numbers, and account identifiers.
