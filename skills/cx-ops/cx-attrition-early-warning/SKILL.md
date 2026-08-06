---
name: cx-attrition-early-warning
description: Use to identify attrition risk from operational signals — occupancy, schedule instability, QA volatility — within ethical bounds, and turn findings into retention design rather than surveillance theatre. Trigger for "attrition risk", "who might leave", "early warning on leavers", "retention signals", "schedule driving quit rates", agent churn analysis, or reviewing whether your people analytics cross a line.
metadata:
  author: rulebase
  version: "1.0.0"
  archetype: analysis
---

# Attrition early warning

Most "attrition prediction" projects fail in one of two ways: they **surveil what they
should not** (private life, health proxies, social graph), or they **produce a list
nobody acts on** — a risk score with no owner, no intervention, and no feedback loop.
Both erode trust and do not reduce leavers.

**The ethical boundary:** use **operational data the organisation already holds for
work management**, aggregated or team-level where possible. The goal is **retention
design** — fixing schedules, load, tooling, and manager capacity — not pre-emptively
managing individuals out or ranking "flight risks" in one-to-ones.

If the user asks for individual prediction to target people, redirect to team-level
diagnostics and voluntary stay interviews. Individual lists belong behind HR, legal,
and union review this skill does not substitute for.

## Signals that are in bounds

These reflect **working conditions**, not private life:

| Signal | What it may indicate | Caveats |
| --- | --- | --- |
| **Occupancy / utilisation trend** | Sustained overload; no recovery time | Confounded by shrinkage misclassification |
| **Schedule instability** | Frequent last-minute changes, split shifts, cancelled rest days | Measure from WFM logs, not judgement |
| **Overtime / involuntary extra hours** | Burnout path; childcare strain via work, not home surveillance | Distinguish voluntary vs mandated |
| **QA score volatility** | Disengagement, confusion after change, or tooling breakage | Also happens on new work types — control mix |
| **Escalation / assist rate shift** | Lost confidence, access gaps, or product change | Not moral failure |
| **Adherence pattern change** | May reflect schedule mismatch or life event affecting work — **do not infer cause** | Use as prompt for team workload review |
| **Training / nesting stall** | Mis-hire or bad ramp — attrition risk for org and individual | Fix ramp, do not label person |
| **Team tenure cliff** | Cohort hired together hitting same frustration | Structural, not individual |

**Out of bounds without explicit policy and legal review:** social media monitoring,
 keystroke or off-queue surveillance beyond agreed WFM scope, health or family status
proxies, age/tenure-based cutoffs presented as risk, sentiment analysis on private
channels, or any feature with **disparate impact** you have not tested.

## Step 1: frame the question as population health

Ask: **"Where is the organisation creating unnecessary leave risk?"** not **"Which
agents should we worry about?"**

Preferred outputs:

- Teams or sites with rising voluntary attrition and concurrent schedule instability
- Cohorts post-ramp with QA volatility spike after a product or policy change
- Roles where occupancy exceeded agreed sustained threshold for N weeks

Individual names may appear in **manager workflow** only when the signal is an
operational fix (e.g. "this agent's schedule has been changed six times in two weeks")
— framed as **schedule repair**, not propensity score.

## Step 2: build a simple signal panel

No black-box model required for most ops teams. For a defined window (e.g. rolling 8
weeks):

1. **Voluntary attrition rate** by team, tenure band, channel — fixed cohort definition
2. **Mean and variance of occupancy** vs agreed target band
3. **Schedule change count** per FTE — definition: any shift start/end change within 48h
4. **QA volatility** — within-agent std dev or range, on comparable mix only
5. **Optional:** repeat internal survey themes (eNPS bucket) if you run one — aggregate
   only

Plot attrition **after** the window against signals **during** the window. You are
looking for **co-movement**, not causal proof. State lags explicitly.

## Step 3: test for confounds before blaming managers

Attrition clusters often trace to:

- **Pay or comp change** in the same quarter
- **Site or vendor contract uncertainty**
- **Product incident** raising handle time and QA markdowns together
- **Roster policy change** (e.g. new weekend mandate)
- **Selection** — low performers managed out vs voluntary (separate populations)

Split voluntary vs involuntary. Mix up QA volatility with performance management unless
you know they are independent.

## Step 4: turn signals into retention design actions

Every flagged pattern needs an **owner and intervention type**:

| Finding | Intervention (examples) |
| --- | --- |
| High occupancy + high QA volatility | Reduce offered load; staff backlog; fix top drivers |
| Schedule instability cluster | WFM policy: minimum notice; change caps; premium for late change |
| Post-change volatility spike | Re-nesting; comms; temporary QA grace with documented rubric hold |
| Ramp cliff at week 8–12 | Training gap or nesting end too early — adjust programme |
| Team manager span overload | Span reduction — attrition driver at scale |

**Stay interviews** on a random sample beat predicting who leaves. Ask leavers and
stayers the same structured questions; aggregate themes.

Do not deliver **risk ranks** to line managers without HR framework. Do deliver **"your
team's schedule instability is in the top quartile; here is the WFM policy fix."**

## Step 5: governance

Document:

- **Data sources** and retention period
- **No use for** performance rating, termination, or comp reduction
- **Review cycle** — quarterly, with attrition outcomes compared to prior period
- **Disparate impact check** if any scoring is used — stop if unexplained gaps appear

Sunset any model that managers game (e.g. avoiding schedule changes by leaving roles
unfilled).

## Traps

- **Prediction theatre** — scores without interventions.
- **Surveillance creep** — expanding signals into private behaviour.
- **Individual targeting** from noisy operational metrics.
- **Ignoring involuntary attrition** — masks management practice.
- **Using tenure alone as risk** — tenure curves vary by labour market; not a proxy for
  engagement.
- **Confusing QA drop with disengagement** when tooling or policy broke.

## Present results to the user

1. **Question framing** — population/team retention design, not individual surveillance
   (or explicit note if HR scoped individual use separately).
2. **Signal panel** — definitions, window, and data you had vs lacked.
3. **Co-movement findings** — teams/cohorts where operational signals and attrition
   moved together, with confounds checked.
4. **Prioritised interventions** — owner, policy or ops change, not "watch list".
5. **Stay/exit interview themes** if available — aggregated.
6. **Governance and boundaries** — what will not be done with this analysis.
7. **What cannot be concluded** — causal claims, individual predictions, or precision
   without sufficient n and clean voluntary/involuntary labels.
