---
name: cx-qa-sampling-fairness
description: Use to check whether ongoing QA sampling is fair to agents and still representative of the eligible population, and to fix designs that equalise by ticket instead of by person. Trigger for "is our QA sampling fair", "high-volume agents get more reviews", "sampler drift", stratified sampling by queue or team, per-agent evaluation counts, or comparing what was reviewed against what was eligible.
metadata:
  author: rulebase
  version: "1.0.0"
  archetype: analysis
---

# QA sampling fairness

Most QA programmes claim to sample "randomly" while actually sampling **in proportion
to ticket volume**. That is a defensible design for estimating overall defect rates.
It is **not** a defensible design for comparing agents, ranking them, or attaching
scores to individuals.

Ticket-proportional sampling gives high-volume agents narrow intervals and low-volume
agents useless ones — then puts both on the same leaderboard. The high-volume agent's
score reflects a real sample; the low-volume agent's score reflects noise dressed as
measurement.

This skill is about **equalising exposure by agent**, **stratifying when the contact
mix differs**, and **detecting when the sampler has drifted** from what it was supposed
to do.

## Name the use before touching the design

| If scores are used for… | Sampling must… |
| --- | --- |
| Coaching | Give each agent enough evaluations to see a pattern; equalise by agent |
| Ranking or pay | Give each agent enough for the decision; equalise by agent; document minimum n |
| Compliance assurance | Often census or risk-weighted; population rate, not per-agent fairness |
| Finding problems | Risk-weighted is fine; cannot be reported as an overall rate |

If the programme cannot afford equal per-agent volume at the precision the use
requires, the honest conclusion is that **individual scores may not support the
decision** — not that ticket-proportional sampling is close enough.

## Equalise by agent, not by ticket

**Ticket-proportional:** each conversation has equal probability of selection. Agents
who handle more tickets appear more often. Their scores stabilise; others wobble.

**Agent-equal:** each agent receives the same target number of evaluations per period
(or the same sampling rate applied to *their* eligible conversations). High-volume
agents are under-sampled relative to their ticket share; low-volume agents are
over-sampled.

Implementation options:

- **Fixed quota per agent per period** — simplest; set the quota from the use (coaching
  vs gating) and the smallest agent's eligible volume.
- **Equal probability within agent** — sample `k` conversations from each agent's
  eligible set each week. Equivalent to quota when eligibility is stable.
- **Stratified by agent within queue** — when agents serve different queues, equalise
  within `(agent, queue)` cells so a specialist is not compared to a generalist on a
  contact mix they never see.

When reporting an **overall** programme score from agent-equal sampling, **weight
back by each agent's true ticket share** (or by stratum share). Skipping weighting
silently over-weights low-volume agents.

## Stratify when the mix differs

Stratification is not optional when:

- channels or queues differ materially in difficulty or compliance risk;
- some agents work only one queue and others rotate;
- language, region or outsourcer splits the population;
- a small stratum is important but would rarely appear in a simple draw.

**Sample small strata at a higher rate**, then weight when aggregating. If you cannot
weight reliably — because stratum sizes are unknown or unstable — report per-stratum
results only and no blended overall figure.

For per-agent measurement, stratify **within** agent when their own mix shifts: an
agent who moved from email to chat mid-quarter has two incomparable slices unless you
separate them or restrict the window.

## Detect sampler drift

Samplers drift. Rules get edited, a channel drops out of the frame, a team is added
to an exclusion list, an automation starts pre-filtering "interesting" tickets, and
nobody updates the documentation. The sample still runs; it just no longer describes
the population it claims to.

Run a **composition check** on a fixed cadence — monthly is usually enough unless
volume is low:

1. Define the **eligible population** for the window: same rules as the sampler uses.
2. Define what was **actually reviewed**.
3. Compare marginal distributions: channel, queue, team, agent tenure band, language,
   outsourcer, day of week, handle-time band — whatever the programme cares about and
   whatever the sampler is supposed to stratify on.

| Signal | Likely cause |
| --- | --- |
| One channel's share in reviews ≪ eligible share | Channel excluded, sync gap, or reviewer avoidance |
| One team's share drops over two periods | Rule change, headcount move, or manual override |
| Reviews cluster on certain days or hours | Reviewer convenience, not random draw |
| High-risk tags over-represented vs eligible | Risk-weighting crept in without relabelling |
| Per-agent counts wildly uneven despite equalise-by-agent policy | Quota logic broken, or eligibility definition differs by agent |

Drift **invalidates period-on-period comparison** until the frame is restored or the
break is documented and the series restarted.

## Traps

- **Equal quotas with unequal eligibility.** An agent on leave for three weeks should
  not be held to the same count as a full-time peer unless the use explicitly allows
  pro-rating. Document the rule.
- **Replacing "hard to grade" draws.** Swapping unavailable or awkward conversations
  for easier ones reintroduces selection bias. Record non-response and replace with
  another random draw from the same agent's eligible set.
- **Reviewer self-selection.** Even with a correct sampler upstream, reviewers who
  pick which queued item to open next destroy fairness. The draw must bind the
  conversation; reviewers should not browse for substitutes.
- **Conflating fairness with representativeness.** Agent-equal sampling is fair for
  people and biased for population rates unless weighted. Know which question you are
  answering.
- **Stale stratification keys.** Queue renamed, team restructured, agent transferred —
  strata defined on last month's org chart produce silent misclassification.

## Present results to the user

1. **The stated use of scores** — coaching, ranking, compliance, or mixed — and
   whether the current design can support it.
2. **The sampling design in plain terms** — ticket-proportional, agent-equal,
   stratified, risk-weighted, or mixed — and what population each part describes.
3. **Per-agent evaluation counts** for the window — min, median, max, and agents below
   the minimum the use requires.
4. **The composition check** — eligible vs reviewed marginal distributions, with the
   largest gaps flagged and a drift verdict (stable / drifting / broken).
5. **Weighting**, if agent-equal or oversampled strata feed an overall figure — or an
   explicit statement that no overall estimate is valid.
6. **Recommended design change**, scoped to the use — quota adjustment, stratum
   definition fix, weighting rule, or a documented series break if drift cannot be
   unwound.
