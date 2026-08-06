---
name: cx-knowledge-from-conversations
description: Use to mine resolved support conversations for missing or weak help articles, extracting reusable answers without copying PII. Trigger for "what articles should we write from tickets", conversation mining for KB, turn agent replies into help content, high-repeat contact drivers needing docs, knowledge creation from support, or closing KB gaps from real resolutions.
metadata:
  author: rulebase
  version: "1.0.0"
  archetype: playbook
---

# Building knowledge from resolved conversations

The best article briefs already exist — in tickets your agents closed correctly
last week. Most teams instead brainstorm from a conference room, write content
customers never asked for, and wonder why deflection flatlines.

The prize: **articles grounded in language customers use and answers agents already
proved work**, published through a review gate that strips PII and policy risk.

## Start from repeat drivers, not random samples

Do not mine "interesting tickets." Mine **high-volume, high-repeat contact drivers**
where resolved conversations show a stable answer:

1. Rank drivers from taxonomy or unsupervised clustering on conversation exports.
2. Filter to drivers with **consistent resolution** — same steps, same policy, same
   outcome in most sampled closes.
3. Exclude drivers that are account-specific, one-off incidents, or require human
   judgement every time — those rarely become articles.

| Driver shape | Article candidate? |
| --- | --- |
| Same question, same fix, many tickets | Yes — top priority |
| Same question, variable outcome | Policy article + "contact us if" boundary |
| Account-specific data every time | No — keep agent-only |
| Bug or outage | No — fix the product; article is temporary |
| Emotional / complaint-heavy | Careful — process yes, transcript no |

Sample **20–40 resolved conversations per candidate driver**, stratified across
agents and tenure so you capture the team norm, not one hero agent's wording.

## What to extract from each conversation

For each sample, record:

- **Customer question** — first message, verbatim phrasing (this becomes title and
  H2 search terms).
- **Resolution steps** — the minimum path that worked, stripped of names, IDs, amounts
  unless genericised.
- **Boundary conditions** — when the standard answer does not apply.
- **Links and artefacts** — forms, settings paths, screenshots needed.
- **Macro or snippet used** — if agents already have a reusable block, start there.

Cluster extractions across the sample. **Disagreement between agents is a finding** —
either the policy is unclear or the driver label is too broad. Resolve before writing.

## Draft structure before prose

Do not paste agent replies into the help centre. Convert to customer-facing structure:

```
Title — customer's question as they ask it
Short answer — 1–2 sentences, outcome first
Steps — numbered, one action per step
When this doesn't apply — boundaries
Related — links to policy, not duplicate articles
```

Agent replies optimise for speed and warmth. Articles optimise for scanability and
self-service without a thread context. **Rewrite, do not transcribe.**

## PII and compliance gate (mandatory before publish)

Every draft from conversations must pass:

| Risk | Rule |
| --- | --- |
| Customer names, emails, phones | Remove or replace with generic placeholders |
| Order IDs, account numbers | Genericise ("your order" not `#4829103`) |
| Internal-only URLs or admin paths | Replace with customer-facing paths only |
| Agent names | Remove — article is brand voice, not personal |
| Commitments made in one ticket | Verify against policy; do not canonise exceptions |
| Regulated advice | Legal/compliance review if the topic is regulated |

Run automated PII scan if available; always **human-read the draft** — regex misses
context. If the best resolution in the sample depended on looking up private account
state, the article is "how to check your status" not "here is your status."

## Review before publish

Minimum reviewers:

1. **Topic owner** (policy/product) — facts correct.
2. **Support lead or senior agent** — matches what we actually tell customers.
3. **Optional: customer-facing editor** — readability and findability.

Review questions:

- Would this have deflected the sampled tickets if it existed?
- Does title match search terms customers used?
- Does any step assume knowledge only agents have?
- Does it contradict an existing article? If yes, merge or deprecate — do not add a
  third version.

Publish with **measurement hooks** — tag the driver, note baseline contact volume,
plan a contact-after-view check in 30 days.

## Ongoing mining rhythm

| Activity | Cadence |
| --- | --- |
| Top 5 drivers without article coverage | Monthly |
| New product/feature launch | Within two weeks of launch contacts appearing |
| Post-rewrite validation | 30 days — did contacts on driver drop? |
| Agent macro heavily edited before send | Weekly triage — edit pattern is a draft |

Agents who repeatedly write the same bespoke reply are writing your next article.
Promote those patterns deliberately.

## Traps

- **Copy-paste from tickets.** Includes PII, tone mismatch, and non-reusable detail.
- **One ticket, one article.** Single outliers become policy; sample breadth matters.
- **Writing before taxonomy clarity.** "Billing" articles multiply; driver-first keeps
  one canonical page.
- **Skipping negative cases.** Articles that only say "yes" without "when no" drive
  contacts after false hope.
- **Publishing internal procedure as customer article.** Escalation paths belong in
  internal wiki; customers need outcomes.
- **No deprecation of superseded drafts.** Mining creates overlap; merge aggressively.

## Present results to the user

1. **Driver shortlist** — ranked by volume × resolution consistency, with sample size.
2. **Article briefs** — title candidates, outline, boundary conditions, source ticket
   count (not ticket IDs in customer deliverables).
3. **Draft articles** — customer-facing prose, PII-scrubbed.
4. **Review checklist** — who must sign off and open factual questions.
5. **Overlap map** — existing articles to update, merge or deprecate instead of net-new.
6. **Measurement plan** — baseline contact volume and effectiveness check date.
