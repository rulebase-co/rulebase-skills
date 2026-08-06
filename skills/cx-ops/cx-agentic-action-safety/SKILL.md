---
name: cx-agentic-action-safety
description: Use to bound what an AI support agent may do to a customer's record — allowlists, irreversible actions, dry-run, audit trails, and blast-radius limits aligned with mutation-safety practice. Trigger for "what can the bot change on an account", "agent tool permissions", "AI agent safety bounds", "dry run before refund", "limit bot actions", or reviewing tool access before giving an agent write APIs.
metadata:
  author: rulebase
  version: "1.0.0"
  archetype: playbook
---

# Agentic action safety

Tool-enabled agents stop being chatbots and become **actors on customer records**.
The failure mode is not a wrong sentence — it is a refund to the wrong account, a
closed ticket that should stay open, or a data field wiped without recovery.

Design from **mutation safety**: assume the model will eventually call every tool it
can see, under adversarial or confused instructions. **Default deny; allow explicitly.**

## Inventory actions by blast radius

List every tool, API, or integration the agent can invoke. Classify each:

| Class | Mutation | Recovery | Example |
| --- | --- | --- | --- |
| **Observe** | None | N/A | Fetch order status |
| **Annotate** | Low | Easy | Internal note, tag |
| **Adjust reversible** | Medium | Possible with effort | Reschedule, reassign |
| **Financial / entitlement** | High | Hard | Refund, credit, fee waiver |
| **Destructive** | Critical | Impossible or legal | Delete, close account, erasure |

**Blast radius** = customers affected × financial exposure × reversibility. Rank tools
by blast radius; permissions follow the rank.

## Allowlists, not open-ended tools

- **One tool, one narrowly scoped operation** — "add_tag(tag_id)" not "run_admin_sql".
- **Parameter validation server-side** — enums, max amounts, id format; never trust
  model-supplied JSON alone.
- **Separate read and write credentials** — write tools on a service account with
  least privilege.
- **No chained super-tools** — "resolve_ticket_and_refund" bundles decisions that
  should be separate gates.

If a human agent needs a manager for an action, the bot should not have unattended
access to that action.

## Irreversible and high-tier actions

For financial, entitlement, and destructive classes:

- **No silent auto-execute** — human confirm or dual control.
- **Idempotency keys** — duplicate tool calls must not double-refund.
- **Amount and rate limits** per conversation, customer, and day.
- **Cool-down** after policy or prompt change until re-validated.

Document **forbidden actions** explicitly (e.g. change email without verified
identity, bulk export, modify legal hold flag).

## Dry-run mode

Implement **dry-run** (or shadow execution) before first production write:

- Tool returns **what would happen** without committing.
- Log proposed mutations with conversation id and model version.
- Compare dry-run log to human expectation on a labelled set.

Promote to live write only after dry-run review on high-blast tools. Keep **shadow
mode** available for rollback testing after prompt changes.

## Audit trail

Every mutation via agent must log:

- Conversation / session id
- Tool name and parameters (redact secrets)
- Model and prompt version
- Initiating actor (bot vs human-approved)
- Before/after state snapshot or reference
- Timestamp and correlation id for support lookup

Audits are for **incident response and dispute investigation**, not only compliance.
If you cannot reconstruct who changed what, you cannot safely grant write access.

## Bounding blast radius

Additional limits beyond allowlists:

- **Scope to current customer** — tools reject ids not tied to the authenticated
  session.
- **No batch or cross-customer operations** from conversational agents.
- **Circuit breakers** — auto-disable write tools on error-rate or spend spike.
- **Kill switch** — one control to drop all write tools without taking read offline.

Run **red-team scenarios**: injection asking for refund to attacker account, confused
deference after long thread, duplicate tool spam.

## Alignment with human policy

Map each allowed bot action to **documented human authority levels**. If policy says
"agents may credit up to £X", the bot's cap is ≤ £X, not higher because the model
asked nicely.

When tool outcomes disagree with what the bot told the customer, **the customer-facing
message is wrong** even if the tool succeeded. Sync comms and mutation in one
transaction where possible.

## Traps

- **Read tools that leak** — fetch_customer returns PII for adjacent accounts if
  scoped poorly.
- **Write via ticket fields** — custom fields trigger automations; indirect mutation.
- **Staging credentials in prod** — classic cross-environment damage.
- **Prompt-only safety** — "never refund without asking" without server enforcement.

## Present results to the user

1. **Tool inventory** — every action with blast-radius class.
2. **Allowlist proposal** — permitted, confirm-required, forbidden.
3. **Server-side controls** — validation, caps, idempotency, scope rules.
4. **Dry-run / shadow plan** — how to test before and after changes.
5. **Audit schema** — fields logged and retention.
6. **Circuit breakers and kill switch** — who owns them and trigger conditions.
7. **Gap list** — indirect mutations, missing idempotency, policy mismatches.
