---
name: cx-qa-coverage-economics
description: Use to decide how much QA coverage to buy given what scores are actually used for — coaching, employment decisions, compliance — and to push back on one-size-fits-all targets or industry benchmark percentages. Trigger for "how many QA evaluations do we need", "what coverage should we aim for", QA programme budget, diminishing returns on sampling, or whether the current review volume supports ranking or pay decisions.
metadata:
  author: rulebase
  version: "1.0.0"
  archetype: playbook
---

# QA coverage economics

Coverage conversations usually start with a number someone heard — "industry standard
is X%" — or with whatever volume the current team can physically grade. Neither is a
strategy. **Coverage is a purchase decision**: you are buying precision on a
measurement for a specific use, at a cost in reviewer time and agent attention.

This skill sizes that purchase from **the decision scores support**, **diminishing
returns**, and **what the organisation can actually afford** — without inventing
benchmark percentages that do not exist in your data.

## Step 1: Separate uses — they need different coverage

One coverage target cannot serve every use. Split them explicitly.

| Use | What you need from coverage | Typical failure when under-funded |
| --- | --- | --- |
| **Coaching** | Enough examples per agent to see a recurring pattern; low stakes | Coaching feels arbitrary; agents dismiss feedback |
| **Assurance / compliance** | Enough to detect breach at the required confidence, or census for rare events | False comfort from a thin sample; missed obligations |
| **Employment decisions** (ranking, bonus, probation, termination) | Enough per person for the decision to survive challenge | Noise dressed as rank; legal and morale risk |
| **Programme health** | Stable aggregate trend on a defined frame | Chasing noise month to month |

If one score feeds multiple uses, **size for the strictest use** or split the
instruments. A coaching rubric sampled lightly plus a compliance checklist censused or
heavily risk-weighted is cheaper and more honest than one scorecard doing everything
at 2% coverage.

## Step 2: Write the precision requirement in plain language

Before arithmetic, answer:

- **Whose score must be stable?** Individual agent, team, queue, or organisation only?
- **What change would you act on?** A five-point move, a criterion flipping from pass
  to fail often, a compliance breach rate doubling?
- **Over what period?** One bad week vs a quarter of evidence?
- **What is the cost of being wrong?** A mis-coached 1:1 vs a wrongful dismissal.

Employment decisions need **per-agent** precision. Coaching can tolerate wider
intervals if feedback cites specific conversations. Compliance on rare events needs
**census or deliberate oversampling of risk**, not a flat percentage of all tickets.

If stakeholders cannot answer these, the programme is not ready for gating — say so.

## Step 3: Work from agent exposure, not ticket share

For any use that names individuals:

- Start from **headcount and eligible conversations per agent per period**.
- Set a **minimum evaluations per agent** derived from the precision requirement — not
  from dividing total review budget by total tickets.
- **Agent-equal sampling** (fixed quota or equal rate within each agent's eligible
  set) is the default; ticket-proportional sampling is for population rates only.

High-volume agents will be under-sampled relative to their ticket share; that is the
point. Low-volume agents may hit a ceiling where every eligible conversation is
reviewed — that is also information (small n, wide uncertainty).

## Step 4: Account for diminishing returns

The first few evaluations per agent teach you a lot; the fiftieth teaches less unless
the rubric is very granular or the agent's work is heterogeneous.

- **Coaching** — marginal value drops once recurring themes repeat; extra reviews
  mostly confirm. Redirect spare capacity to calibration, dispute adjudication, or
  rubric maintenance.
- **Aggregate programme metrics** — precision on the overall rate improves with √n;
  doubling reviews does not double insight if the frame is wrong or the rubric is
  noisy.
- **Compliance** — marginal value stays high until the risk stratum is adequately
  observed; do not fund compliance assurance by sampling easy tickets.

When budget is fixed, **prefer fewer agents measured well over more agents measured
badly** — or shrink the stated use to match what you can buy.

## Step 5: Price the programme honestly

Coverage cost is not only grader hours:

- **Grading time per conversation** — channel, language, rubric length, tooling.
- **Calibration and adjudication** — non-optional if humans or models grade; scales
  with grader count and rubric churn.
- **Agent and manager time** — disputes, 1:1s, performance conversations.
- **Opportunity cost** — reviewers taken from production without capacity planning
  create a second quality problem elsewhere.

Compare **total cost** to **decisions actually taken from scores**. Programmes that
produce numbers nobody uses are 0% effective coverage at full price.

## Step 6: Say no to benchmark percentages

"Review 5% of tickets" is not a plan until you know:

- 5% of which frame (channel, queue, window)?
- 5% distributed how (by ticket vs by agent)?
- 5% supporting which decision?

Decline to cite industry norms you cannot verify. Instead, show **the implied
precision** for the stakeholder's chosen coverage under their sampling design, and
whether that precision matches the use. If it does not, the choices are: spend more,
change the use, change the design, or accept documented uncertainty.

## Red flags

| Claim | Problem |
| --- | --- |
| "We review 10% so we're fine" | Ten per cent of what, for whom, supporting which decision? |
| "AI grades everything so coverage is 100%" | Throughput ≠ validity; calibration and drift still cost |
| "Same target for in-house and BPO" | Different frames, turnover, and uses |
| "Rank agents monthly on QA" | Monthly rank needs monthly n per agent; calculate it |
| "Compliance is in the same score as empathy" | Rare events drown in high-volume soft-skill noise |

## Present results to the user

1. **Uses separated** — coaching, assurance, gating, aggregate — and which score feeds
   each.
2. **Minimum per-agent (or per-stratum) evaluation count** implied by the strictest
   use, with plain-language precision statement.
3. **Recommended sampling design** — agent-equal, stratified, risk-weighted, census —
   matched to each use, not one blended target.
4. **Total review volume** for the period — conversations to grade, grader hours,
   calibration overhead — and the main cost drivers.
5. **Diminishing-returns note** — where extra reviews stop changing decisions.
6. **Gap analysis** — current coverage vs required; what must shrink (use, population,
   frequency) if budget is fixed.
7. **Explicit non-recommendation** — any decision the programme cannot support at
   proposed coverage, stated without hedge.
