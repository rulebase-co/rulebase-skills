# Platform mapping tables

Field-by-field mappings into the canonical schema. Verify each against your own
account: statuses, channels, and CSAT scales are configurable on every one of
these platforms.

## Status

| Canonical | Zendesk | Intercom | Freshdesk | Five9 |
| --- | --- | --- | --- | --- |
| `open` | `new`, `open` | `open` | 2 Open, 6 Waiting on Customer | — |
| `pending` | `pending`, `hold` | — | 3 Pending, 7 Waiting on Third Party | — |
| `resolved` | `solved` | — | 4 Resolved | — |
| `closed` | `closed` | `closed` | 5 Closed | every call-log row |
| `snoozed` | — | `snoozed` | — | — |
| `deleted` | `deleted` | — | via `filter=deleted` | — |

Notes:

- **Zendesk `solved` vs `closed`** is a real distinction: solved tickets can be
  reopened, closed ones cannot. Collapsing them loses the ability to measure
  reopen rate.
- **Zendesk `hold`** is agent-blocked; `pending` is customer-blocked. Both map to
  `pending`, so use `status_raw` if you need to separate agent-caused from
  customer-caused delay.
- **Freshdesk custom statuses** (codes 8+) are account-configurable. Map unknown
  codes to `open` rather than dropping the ticket, and always keep the code in
  `status_raw`.
- **Five9** has no open/closed model — a call-log row is a call that already
  ended. Everything maps to `closed`, and the meaningful distinction (answered,
  abandoned, voicemail) stays in the disposition.

## Channel

| Canonical | Zendesk `via.channel` | Intercom | Freshdesk `source` | Five9 |
| --- | --- | --- | --- | --- |
| `email` | `email` | `email` | 1, 4, 5, 6, 10 | — |
| `chat` | `chat` | `chat`, `desktop` | 7 | — |
| `messaging` | `native_messaging`, `whatsapp`, `sms` | `conversation`, `whatsapp`, `sms`, `push` | 8, 9, 11 | — |
| `voice` | `voice` | `phone_call`, `phone_switch` | 3 | all |
| `social` | `facebook`, `twitter` | `facebook`, `twitter`, `instagram` | 10, 12 | — |
| `web_form` | `web` | — | 2 Portal | — |
| `api` | `api`, `rule`, `system` | `api` | — | — |
| `other` | anything unrecognised | anything unrecognised | anything unrecognised | — |

Freshdesk source codes vary with which channels the account has enabled, so
confirm against your own data. Zendesk's `via.channel` has a long tail of values
(`sample_ticket`, `closed_ticket`, integration-specific ones) — map defensively to
`other` and keep `channel_raw`.

`system` and `rule` in Zendesk mean the ticket was created by automation, not by a
customer. Including those in customer-contact volume overstates demand.

## Author type

| Canonical | Zendesk | Intercom `author.type` | Freshdesk | Five9 |
| --- | --- | --- | --- | --- |
| `customer` | comment author = ticket `requester_id` | `user`, `lead`, `contact` | `incoming: true` | n/a |
| `agent` | author is an agent | `admin`, `team` | `incoming: false` with a `user_id` | agent column |
| `bot` | via integration/automation | `bot`, `operator` | automation-authored | n/a |
| `system` | `via.channel` of `rule`/`system` | — | automation rule | n/a |
| `unknown` | cannot determine | unrecognised type | `incoming` absent | n/a |

**Zendesk gives you no role flag on a comment.** There is only `author_id`. The
reliable method is comparing it against the ticket's `requester_id`; anything else
requires joining the users export.

**Freshdesk `incoming` is not always populated** on older tickets. Fall back to
comparing `user_id` against `requester_id`.

**Intercom author types change between API versions.** New values appear; map
defensively and fall back to the id comparison.

Bot detection is the weakest link on every platform. Where a bot posts through an
integration it often appears as a regular agent, and where it posts as the brand it
may appear as `system`. If bot-vs-agent attribution matters — and it does for any
deflection work — verify against a handful of known bot conversations rather than
trusting the flag. Automated-actor flags are unreliable in both directions.

## CSAT

| Platform | Native scale | Canonical `csat` |
| --- | --- | --- |
| Zendesk | `good` / `bad` (also `offered`, `unoffered`) | `good` → 1, `bad` → 0; `offered`/`unoffered` → `null` |
| Intercom | 1–5 | `(rating - 1) / 4` |
| Freshdesk | Configurable per account | **Do not guess.** Pull `/api/v2/surveys/satisfaction_ratings` and document your own mapping |
| Five9 | Separate post-call survey report | `null` from the call log |

Two easy mistakes:

- **A rating of 1 on a 1–5 scale is `0`, not `null`.** Treating the worst possible
  score as missing data removes exactly the responses an analysis cares about.
- **`offered` and `unoffered` in Zendesk are not scores.** They mean a survey was
  or wasn't sent. Mapping them to 0 fabricates negative feedback.

Always keep `csat_raw`. A 0–1 fraction is comparable across platforms but throws
away the granularity of a 5-point scale, and nobody discusses CSAT in fractions.

## Message body

| Platform | Field to use | Notes |
| --- | --- | --- |
| Zendesk | `plain_body` | `body` includes quoted email history |
| Intercom | `body` (HTML) | Must be stripped to text |
| Freshdesk | `body_text` | `body` is HTML |
| Five9 | n/a | No message bodies in the call log |

Common to all: **strip quoted email history before embedding or measuring
length.** Email replies restate the whole thread, so the last message in a long
thread appears to contain the entire conversation. This inflates token counts and
makes near-duplicate detection useless.

Signatures and automated acknowledgements repeat across every conversation and
will dominate embedding similarity. Remove them before building a RAG corpus.

## Timestamps

| Platform | Native format | Conversion |
| --- | --- | --- |
| Zendesk | ISO 8601 on tickets; **Unix seconds** on ticket events | Multiply event timestamps by 1000 |
| Intercom | **Unix seconds** everywhere | Multiply by 1000 |
| Freshdesk | ISO 8601 | Use as-is |
| Five9 | Report-local, no timezone | **Confirm your tenant's timezone** |

Five9 is the trap. Report timestamps carry no timezone offset, so parsing them as
UTC shifts every call by your tenant's offset. That quietly corrupts any
time-of-day analysis, and worse, misaligns Five9 calls against other channels in a
cross-platform join. Establish the tenant timezone before the first export and
convert explicitly.

The validator flags messages timestamped before their conversation began, which is
the usual symptom of an epoch or timezone bug.

## What each platform will not give you

| Platform | Silent gaps |
| --- | --- |
| Zendesk | Permanently deleted tickets, redacted comment text, voice recordings, side conversations. Archived tickets appear in exports but not in Search |
| Intercom | Parts beyond 500 per conversation (earliest lost, no error), attachment contents |
| Freshdesk | Anything past 30,000 tickets on a single query, tickets older than 30 days without `updated_since`, deleted/spam by default, CSAT |
| Five9 | Recordings, transcripts, digital channels, post-call survey, anything not on the report definition |

Reconcile counts against each platform's own UI before treating an export as
complete. The most common cause of a short export is a permissions scope, not a
bug — a Freshdesk API key belonging to a scoped agent, or an Intercom token for
the wrong workspace.
