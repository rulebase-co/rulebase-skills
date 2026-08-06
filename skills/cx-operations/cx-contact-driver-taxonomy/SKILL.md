---
name: cx-contact-driver-taxonomy
description: Use to design, rebuild, or audit a support contact taxonomy — the categories that record why customers contact. Trigger for "build a contact reason taxonomy", "our ticket categories are useless", "too many tickets are tagged Other", contact driver analysis, ticket categorisation or tagging schema, reducing contact volume, or deciding what to fix from support data.
metadata:
  author: rulebase
  version: "1.0.0"
  archetype: playbook
---

# Designing a contact driver taxonomy

A taxonomy exists to answer one question: **what should we fix to remove this
contact?** Most taxonomies cannot answer it, because they were built from the
helpdesk's default categories or the org chart rather than from why customers
actually get in touch. The result is a category list that describes support and
prescribes nothing.

## Diagnose the existing one

| Symptom | Fault |
| --- | --- |
| >10% of contacts in "Other" or "General" | The taxonomy doesn't fit the contacts |
| Categories map to teams, not causes | Built from the org chart |
| Top category is 40% of volume | Too coarse to act on |
| Nobody can name an owner for a category | It describes a topic, not a driver |
| Categories haven't changed in three years | Not maintained; drifted from reality |
| Agents pick the first plausible option | Too many, too deep, or too ambiguous |
| Analysts don't use it | It doesn't predict or explain anything |

## The distinction that makes a taxonomy useful

**A topic is what the contact was about. A driver is the cause you could remove.**

| Topic (weak) | Driver (actionable) |
| --- | --- |
| Billing | Charged twice after a failed-payment retry |
| Delivery | Tracking page shows "delivered" before it arrives |
| Account | Password reset email lands in spam |
| Refunds | Refund ETA in the app contradicts the policy |

Every row on the right names something a specific team could change, and predicts
the contact would stop. Nothing on the left does. This is the whole design
principle — and the reason taxonomies built by asking "what do we get contacts
about?" fail while ones built by asking "why did this contact have to happen?"
work.

**Every driver needs a named owner.** A driver nobody owns is an observation, not
a lever. If the owner would be "support", it is a topic and needs to be broken
down further.

## Step 1: derive it bottom-up from real conversations

Do not start from a template, a vendor list, or the helpdesk defaults. Read
conversations and write down why each one happened.

Sample 150–300 conversations, stratified so you see the whole surface:

- Proportional to volume by channel, so the common cases dominate correctly.
- Deliberately over-sampling repeat contacts, escalations, and low-CSAT
  conversations — those contain the drivers worth removing.
- Spanning at least two months, so you don't build the taxonomy around one
  incident.

For each, write a one-line cause in plain language. Then cluster the lines. The
clusters are your candidate drivers. This is slow and it is the only method that
produces a taxonomy that fits.

## Step 2: structure it in two levels, not four

```
Category  (8–12)   coarse grouping, for reporting
  └─ Driver (2–5 per category)   the actionable cause
```

**Two levels. 15–40 drivers total.** Deep hierarchies fail in a specific way:
agents select a level-one value and stop, so level three is empty and useless.
Beyond roughly 20 visible options at the point of selection, accuracy collapses
regardless of how good the definitions are.

Keep two axes **separate** rather than crossing them into one list:

- **Driver** — why it happened. Single-select, mandatory.
- **Outcome** — what was done. Single-select. (resolved, refunded, escalated,
  refused per policy, no action needed…)

Crossing them multiplies the option count and destroys both. A driver list of 30
and an outcome list of 6 is far more usable than 180 combined categories.

Optional third element: **free tags**, multi-select, unmanaged. These are your
early-warning system for drivers the taxonomy is missing.

## Step 3: test every candidate driver

Drop or rewrite anything that fails.

**Actionable** — a named team could change something to reduce it. If the answer
is "train agents better", it is not a driver.

**Observable** — decidable from the conversation alone. If it needs the CRM,
account state, or the agent's memory, it will be applied inconsistently. This gets
stricter with AI labelling, which sees only what you pass it.

**Mutually exclusive** — a conversation belongs in exactly one driver. Overlapping
drivers guarantee inconsistent labelling and unusable trend data.

**Definable in two sentences** — including one positive and one negative example.
A driver you cannot define crisply cannot be labelled consistently by a human or a
model.

**Material** — worth at least ~1% of volume, or carries outsized cost or risk. A
driver at 0.05% is noise in a dropdown.

## Step 4: instrument the "Other" rate as your quality metric

**The share of contacts landing in "Other" is the single best measure of taxonomy
health.** Target under 5%; above 10% the taxonomy does not fit its contacts.

Crucially: **keep "Other" and require a free-text note with it.** Teams that
delete "Other" to force a choice do not improve their data, they corrupt it —
agents pick the nearest wrong option and the error becomes invisible. A healthy
"Other" bucket with notes is your pipeline for the next taxonomy revision.

Review "Other" notes monthly. Recurring themes become new drivers.

## Step 5: normalise before you compare anything

**Raw contact counts per driver are almost always misleading**, because they track
business growth. A driver rising 20% while the customer base rises 25% is
improving.

Report **contacts per 1,000 active customers** (or per 1,000 orders, shipments,
transactions — whatever unit the driver attaches to). This is the metric that
tells you whether a fix worked, and it is the one most taxonomies never produce.

Then rank drivers by **removable cost**, not volume:

```
priority = contacts_per_1k × marginal_cost_per_contact × estimated_removable_share
```

The last term is the judgement call and it is where the conversation with
engineering happens. A 5,000-contact driver that is 10% removable matters less
than an 800-contact driver that is 90% removable.

## Step 6: validate that it discriminates and agrees

- **Inter-rater agreement.** Have 3+ people independently label the same 30
  conversations. Use a chance-corrected statistic (Cohen's or Fleiss' κ), not raw
  agreement. Below κ 0.6, the driver definitions are ambiguous — fix the
  definitions, not the labellers.
- **Distribution.** No driver above ~25% of volume (too coarse) and few below 1%
  (noise).
- **Explanatory power.** When total volume moves, can you attribute the move to
  specific drivers? If not, the taxonomy is not tracking causes.
- **Stability.** Driver shares should be stable week to week absent a real change.
  Wild swings indicate labelling inconsistency.

## Step 7: version it, and never renumber

Taxonomies must evolve, and every change breaks comparability if handled badly.

- **Add** new drivers freely; the volume simply appears.
- **Deprecate** rather than delete. Stop offering it, keep it readable historically.
- **Never renumber or reuse an id.** A reused id silently merges two different
  things across time — the worst possible outcome, because it is invisible.
- **Version the taxonomy** and record which version labelled each contact.
  Cross-version trends need an explicit mapping table, and some are simply not
  comparable. Say so rather than drawing the line anyway.

## AI labelling changes the economics, not the principles

100% labelling coverage becomes affordable, which means you can afford more
granularity than a human-selected dropdown allows. It does not relax the design
rules — it tightens two of them:

- **Definitions must be text.** A model gets the definition you write and nothing
  else. Tribal knowledge that made a vague driver workable for humans is
  unavailable.
- **Observability is stricter.** A model sees only the conversation you pass it.

And it adds obligations: validate per-driver agreement against a human gold set
(not overall accuracy, which hides compensating errors), pin the model version,
and hold a continuous human audit sample to detect drift. Label distribution
shifting after a model upgrade is a common and easily-missed failure.

## Deliverable

1. **Taxonomy spec** — categories, drivers, definitions with examples, and the
   **named owner** for each driver.
2. **Outcome list**, separate from drivers.
3. **Labelling guidance** — how to choose when two drivers seem to apply, and
   when to use "Other".
4. **Measurement plan** — normalisation unit, the priority formula, review cadence.
5. **Validation plan** — agreement target, distribution checks, and what result
   would trigger a rebuild.
6. **Version and changelog**.

## Present results to the user

1. **The top drivers by removable cost**, not by volume. This is the output that
   changes what gets built.
2. **The owner for each top driver.** A driver list without owners produces no
   action.
3. **The "Other" rate**, as the honest measure of how well the taxonomy fits.
4. **Normalised trend** — per 1,000 customers, with the raw count alongside so
   nobody thinks you hid growth.
5. **What you cut from an existing taxonomy and which test it failed.** This is
   the contested part; be specific.
6. **Agreement scores**, if measured, and any driver too ambiguous to label
   consistently. Flag those rather than shipping them.
7. **What is not comparable across versions**, explicitly.

## Troubleshooting

**"Other" is 30%** — the taxonomy was built top-down. Read the "Other" notes and
rebuild from them; they are exactly the bottom-up sample you needed.

**Top category is half of volume** — too coarse. Split it by reading a sample of
just that category.

**Two analysts get different driver mixes from the same data** — ambiguous
definitions. Measure κ per driver and rewrite the worst.

**Volume rose but no driver rose** — labelling is lagging or defaulting. Check
whether the increase landed in "Other".

**Nobody acts on the taxonomy** — usually missing owners, or reporting volume
instead of removable cost.

**Trends broke after a taxonomy update** — expected if drivers were renamed or
merged. Publish the mapping and mark the break on the chart.
