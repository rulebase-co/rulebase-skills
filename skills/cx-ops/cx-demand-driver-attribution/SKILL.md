---
name: cx-demand-driver-attribution
description: Use to attribute contact volume spikes to product releases, campaigns, billing events and operational changes — with a shared calendar, difference-in-differences thinking and explicit limits on causal claims. Trigger for "what caused the volume spike", demand driver attribution, release drove tickets, campaign contact uplift, billing run volume, event calendar for support, difference in differences volume, or when leadership asks what drove the spike without confounders ruled out.
metadata:
  author: rulebase
  version: "1.0.0"
  archetype: analysis
---

# Demand driver attribution

Leadership sees a spike and asks **why**. Support sees the spike and often answers with
the last thing that changed — a release, a email, a price update. Coincidence is not
attribution.

**The common failure is narrating causality from a line chart.** Volume moved the same
week as a campaign; therefore the campaign caused it. Without a counterfactual, shared
calendar, and confounder check, that story is gossip. This skill ties contacts to business
events defensibly — and states clearly what you cannot conclude.

## Start with a calendar, not a model

Maintain one **demand calendar** owned by ops, fed by product, marketing, billing and
engineering:

| Event type | Examples | Lead/lag to record |
| --- | --- | --- |
| Product release | App version, API change, feature flag | Ship date + same-day hotfix window |
| Marketing | Sends, promotions, lifecycle triggers | Send time + channel |
| Billing | Invoice run, dunning, price change | Run date + retry schedule |
| Policy | Refund rule, shipping change | Effective date |
| Operational | Outage, carrier delay, fraud sweep | Start/end timestamps |
| Seasonal | Known retail peaks | Dates from prior year as hypothesis only |

If an event is not on the calendar, **do not attribute to it retroactively** without
adding it and noting the gap. Missing calendar discipline is the main reason attribution
debates repeat monthly.

## Unit of analysis

Attribute at the granularity decisions use:

- **Contact driver tags** — if taxonomy is trustworthy; audit before trusting spike splits.
- **Product area / queue / SKU** — when release is scoped.
- **Customer segment** — enterprise vs self-serve, region, plan tier.
- **Interval** — day often enough; hour for sends and outages.

Align volume series and event timestamps in **one timezone**, documented. Misaligned clocks
fake attribution.

## Difference-in-differences mindset

You rarely have a randomised experiment. **DiD is the disciplined informal frame:**

- **Treated** — customers or segments exposed to the event (got the email, on the new
  version, billed this cycle).
- **Control** — similar customers not exposed, or the same segment before the event.
- **Before / after** — same group's baseline vs post.
- **Difference of differences** — did treated move *more* than control?

Example structure (not a formula to worship — a checklist):

```
Effect ≈ (After_treated − Before_treated) − (After_control − Before_control)
```

If only treated moves, evidence strengthens. If everyone moves, the event is not the
story — look for seasonality, outage, or macro shock.

### Practical controls when you lack a clean holdout

| Situation | Control strategy |
| --- | --- |
| Email to segment A | Segment B with similar history not emailed |
| Gradual rollout | Regions or flags still on old version |
| Global release | Pre-release baseline of same length as post window |
| Billing run | Cohort billed this month vs cohort billed off-cycle |
| Outage | Same DOW hour from prior weeks (weak — label as approximate) |

Weak controls must be **labelled weak**. A same-week last-year comparison is not DiD; it
is seasonal naive with extra steps.

## Confounders that fake attribution

Check these before presenting a driver:

- **Seasonality and DOW** — Tuesday after a holiday is not "release effect."
- **Overlapping events** — release plus campaign plus billing in one window; default
  answer is **shared uplift, split unproven**.
- **Routing and tagging changes** — volume moved queues or tags, not customers.
- **Deflection and channel shift** — chat down, email up, total contacts flat; channel
  spike is not demand spike.
- **Repeat contact inflation** — policy change causes re-opens; unique customers flat.
- **Internal backlog release** — batch close/open mimics demand.
- **External shocks** — competitor news, weather, regulator — not on your calendar but
  moves everyone.

Report **confounders ruled in or out**, not only the favourite hypothesis.

## What you can and cannot conclude

**Can conclude (with evidence):**

- Treated segment volume rose relative to control over the same window.
- Tagged driver share increased **and** tag quality was stable through the window.
- Event timing aligns with interval-level lift in the expected queue/product.
- Effect decay pattern matches mechanism — send spike fades in days; bug persists until fix.

**Cannot conclude without stronger design:**

- Exact **percentage** of total spike "caused by" event X when events overlap.
- **Long-run churn or revenue impact** from a one-week contact lift.
- Attribution from **coincident spikes** with no control and one historical instance.
- **Per-customer causality** from aggregate counts alone.
- That correlation **will repeat** next time — only that it did once, under stated
  conditions.

Use language that matches strength: **associated with**, **consistent with**, **likely
contributor** — reserve **caused** for randomised or clean natural experiments.

## Workflow

1. **Define the spike** — metric, window, baseline rule (prior 4 weeks same DOW, not
   arbitrary "last month").
2. **Pull calendar events** overlapping window ± lead/lag buffer.
3. **Decompose volume** — channel, driver tag, product, segment — vs baseline.
4. **Run DiD or best available control** for top one to two hypotheses only; ignore the
   long tail until primary candidates fail.
5. **Check confounders** — overlap table, repeat contact, routing changes.
6. **Write attributed / unexplained split** — unexplained is an honest output, not failure.
7. **Recommend calendar or process fix** — owner for next event, forecast adjustment, comms
   timing — separate from the attribution paragraph.

## Traps

- **Single-day baseline** — noise dominates.
- **MAPE-style attribution on small queues** — percentages swing wildly.
- **Trusting driver tags during taxonomy projects** — tag spike may be relabelling.
- **Attributing to release without version exposure data** — customers on old build still
  contacting disprove product cause.
- **Presenting unexplained as zero** — forces false confidence.

## Present results to the user

1. **Spike definition** — metric, window, baseline method.
2. **Event calendar table** for the window — with overlap flags.
3. **Decomposition** — where volume landed (channel, segment, tag, product).
4. **Attribution assessment** for top hypotheses — DiD or control used, confounders
   checked — with strength of evidence language.
5. **Attributed vs unexplained volume** — ranges if overlap prevents point estimates.
6. **What we cannot conclude** — explicit list.
7. **Actions** — forecast calendar update, comms timing, product fix, tagging — owned and
   dated separately from the story.
