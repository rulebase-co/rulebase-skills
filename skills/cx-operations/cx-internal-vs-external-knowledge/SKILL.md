---
name: cx-internal-vs-external-knowledge
description: Use to separate customer help centre content from internal agent wiki, define what belongs where, and stop wrong internal docs from leaking into customer-facing answers. Trigger for "help centre vs internal wiki", agent documentation duplication, what should be public KB, internal SOP leaking to customers, policy vs procedure split, or grounding AI on the wrong knowledge base.
metadata:
  author: rulebase
  version: "1.0.0"
  archetype: playbook
---

# Internal vs external knowledge

Two libraries that answer the same question differently is worse than one wrong
answer. Customers get the external article; agents read the internal wiki; the AI
agent grounds on whichever was indexed last — **and nobody notices until a fee,
timeline or eligibility mismatch surfaces in complaints.**

The prize is a clean boundary: **customers see outcomes and steps they can take;
agents see authority, escalation and exceptions** — with deliberate links, not
copy-paste duplication.

## What leaks when internal is wrong

Internal docs fail quietly because customers never see them — until something
bridges the gap:

| Leak path | What goes wrong |
| --- | --- |
| Agent paraphrases internal SOP in reply | Customer receives procedure meant for staff |
| Macro copied from internal wiki | Wrong tone, internal links, or pre-release info |
| AI agent indexed internal + external | Confident answer from deprecated internal draft |
| Agent cites "what we usually do" | Tribal knowledge overrides published policy |
| Escalation note pasted to customer | Internal codes, competitor mentions, frustration |
| Search spans both libraries | Customer finds internal page via misconfigured portal |

**Wrong internal content is an agent efficiency problem. Wrong external content is a
customer harm problem. Content that exists in both and diverges is both.**

## Policy vs procedure — the split that holds

| Layer | Audience | Contains | Example |
| --- | --- | --- | --- |
| **Policy** (external) | Customer | What is true — rights, fees, eligibility, timelines | "Refunds process in 5–10 business days" |
| **Procedure** (internal) | Agent | How we execute — systems, codes, escalation, exceptions | "Refund queue in admin → type RFD → attach screenshot" |
| **Guidance** (internal) | Agent | Judgement — when to bend, tone, de-escalation | "If >£500, offer supervisor callback before processing" |

Customers need policy. Agents need procedure. **Never publish procedure as policy**
— it exposes internal tooling, creates security risk, and goes stale on every UI
change.

When agents need to explain *why* a policy exists, external articles get a plain
-language rationale — not internal decision history.

## What belongs where

**External (help centre):**

- Questions customers can fully resolve alone
- Stable product behaviour and customer-visible policy
- Prerequisites written in customer language ("You'll need your order number")
- Links to customer-facing forms and status pages

**Internal (wiki / agent KB):**

- System click paths, admin tools, refund codes
- Escalation matrices and ownership rosters
- Exception handling and compensation bands
- Pre-release, beta, or embargoed information
- Competitive talk, legal strategy, staffing plans
- Draft policy under review

**Both — but linked, not duplicated:**

- Topic exists externally; internal adds "how we handle edge cases"
- External says *what*; internal says *how* with a single link up, not two copies

If you maintain two full copies, **they will diverge**. Pick one source of truth per
fact.

## Duplication audit

For each high-volume contact driver:

1. List external article(s) on the topic.
2. List internal page(s) on the topic.
3. Compare factual claims — fees, timelines, steps customers must take.
4. Flag **contradictions** and **stale pair** (one updated, one not).

| Finding | Action |
| --- | --- |
| Identical content in both | Keep external; internal becomes link + agent-only addendum |
| Internal newer | Update external or deliberately mark internal as ahead of published policy |
| External newer | Update internal; notify agents |
| Only internal exists | Decide: publish customer version or accept agent-only driver |
| Only external exists | Ensure internal has escalation path, not re-copy of external |

Prioritise drivers by contact volume and regulated risk.

## AI and search boundaries

Before grounding any AI on knowledge:

1. **Index separation** — external corpus only for customer-facing bots; internal
   for agent assist if at all.
2. **Access control** — internal wiki must not be web-crawlable or SSO-leakable into
   public search.
3. **Citation rules** — agent assist may cite internal; customer bot must cite
   external URLs customers can open.
4. **Re-index on publish** — policy change updates external first; internal follows
   same day.

An agent assist tool that retrieves internal docs and drafts customer replies is
high-leverage and high-risk. **Human send or explicit "customer-safe excerpt"
mode is mandatory.**

## Governance

| Role | Responsibility |
| --- | --- |
| Policy owner | External factual truth |
| Support ops | Internal procedure currency |
| KB lead | Duplication audits, deprecation, cross-links |
| Localisation | External only unless internal is translated for agents in that market |

When policy changes: **external publishes first** (or simultaneously with agent comms),
internal updated same release, macros and AI corpora refreshed — same change ticket.

## Traps

- **"Agents need everything in one search."** Unified search without labeling
  internal vs external causes leaks. Label and filter.
- **Pasting internal into customer drafts "to save time."** Short-term speed; complaint
  risk.
- **Internal wiki as dumping ground.** Unowned pages become the de facto policy agents
  trust.
- **Customer help centre with agent-only sections.** Sections leak via URL sharing and
  search; use auth-gated internal instead.
- **Assuming SSO equals safe.** Agents forward links; screenshots escape.

## Present results to the user

1. **Boundary definition** — policy / procedure / guidance with examples from their
   catalogue.
2. **Duplication map** — topic pairs (external ↔ internal) with contradiction flags.
3. **Leak-risk paths** — macros, AI indexing, search config, macros.
4. **Remediations** — merge to single source, link-only internal, deprecate duplicate.
5. **AI/search guardrails** — what to index where, citation rules.
6. **Ownership table** — who updates which side when policy changes.
