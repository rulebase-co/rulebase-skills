---
name: cx-peer-review-design
description: Use to design peer or self-review QA programmes that complement — not replace — audit QA, with clear purpose, bias controls, and separate reporting. Trigger for "peer review programme", "agents reviewing each other", "self-QA", "peer QA vs central QA team", when peer review helps culture vs when it substitutes for audit, or bias risks in peer scoring.
metadata:
  author: rulebase
  version: "1.0.0"
  archetype: playbook
---

# Peer review design

Central QA teams measure against a standard. Peer review measures something else:
whether agents **share** that standard, notice quality in others' work, and apply
criteria when the evaluator has no audit authority.

The failure mode is deploying peer review to **replace** audit QA because it is
cheaper — peers optimise for collegiality, audit scores inflate, and leadership
believes quality is covered.

**Peer review is complementary instrumentation, not a substitute audit sample.**

## What peer review measures that audit does not

| Signal | Audit QA | Peer review |
| --- | --- | --- |
| Compliance against standard | Primary | Weak — bias toward leniency |
| Shared mental model of quality | Indirect | Primary |
| Culture of quality attention | No | Yes — if designed honestly |
| Cross-team perspective | Yes | Limited to peer pool |
| Defensible gating / regulatory evidence | Yes | No |

Peer review answers: *"Do we see quality the same way?"* Audit answers: *"Did we meet
the standard?"* Only the second belongs in compliance and bonus files.

## Diagnose misfit

| Symptom | Likely design error |
| --- | --- |
| Peer scores 15 points higher than audit | Lenience, vague criteria, or social pressure |
| Peer review dropped after launch | No time budget; treated as volunteer work |
| Used for performance ratings | Gaming and retaliation risk |
| Same conversations peer-reviewed and audited | Contamination — not independent |
| Managers cherry-pick peer pairs | Bias by construction |

## Step 1: Name the purpose — pick one primary

**Development (recommended default)**

- Low stakes, frequent, rich comments.
- Output: discussion prompts, team retros, calibration input.
- **Not** input to individual performance scores.

**Calibration support**

- Peers score blind on shared sample; results feed team calibration sessions.
- Output: disagreement patterns, not individual peer grades.

**Coverage extension (use cautiously)**

- Peers sample additional conversations audit cannot reach.
- Requires **same rubric, same training, audit spot-check** — peers are extra graders,
  not a different instrument.

If asked to replace audit with peers, decline and propose split: audit for
measurement, peers for development.

## Step 2: Design the peer loop

Minimum viable loop:

1. **Assign** — rotate pairs; no permanent buddies.
2. **Blind where possible** — reviewer should not know agent identity on sensitive
   criteria; mask names in UI.
3. **Short rubric subset** — 3–5 criteria max per peer pass; comments required.
4. **Timebox** — 15–20 minutes per review; programme must budget this as work, not
   extra.
5. **Debrief** — optional dyad or team huddle; not mandatory score comparison with
   names attached in group settings.

Cadence: weekly or fortnightly for development; monthly for calibration support.

Volume: **1–2 conversations per agent per month** as reviewer — enough to stay
practised, not so much it becomes a second job.

## Step 3: Self-review — when and how

Self-review before audit or peer review can improve reflection **if**:

- Agent scores privately first, then compares to external verdict in 1:1.
- Self scores are **not** averaged into official QA.
- Criteria are concrete enough that self-assessment is possible.

Self-review fails when agents predict audit scores for gamification. Use it for
coaching conversations, not reporting.

## Step 4: Bias risks and controls

| Bias | Control |
| --- | --- |
| Lenience (friendship) | Rotate pairs; anonymous where feasible; compare peer vs audit distributions |
| Severity (rivalry) | Same rotation; monitor outlier reviewers |
| Reciprocity ("I'll pass you if you pass me") | Never pair-only scoring; audit spot-check |
| Hierarchy pressure | Peers exclude team leads reviewing direct reports for scored output |
| Cultural / language | Same-segment peers only when criterion is language-sensitive |
| Anchoring on one bad message | Require full conversation review; criterion-level not vibe |

**Audit spot-check:** central QA re-scores 10–20% of peer-reviewed conversations
monthly. Large systematic gap → pause peer programme metrics, fix training.

## Step 5: Separate reporting lines

| Output | Audience | May include individual names? |
| --- | --- | --- |
| Peer development comments | Agent + team lead in 1:1 | Yes |
| Team aggregate peer/audit gap | Team lead | No individual peer scores |
| Calibration disagreement themes | QA programme | Anonymised |
| Official QA score | Performance, compliance | Per policy |

Never plot peer scores on the same dashboard series as audit scores without labelling
and without explaining expected offset.

## Step 6: When peer review substitutes audit — say no

Peer-only QA is inappropriate when:

- Scores gate pay, promotion, or termination.
- Regulators or contracts require independent review.
- Dispute volume is already high — peers will not adjudicate fairly.
- Criteria include compliance auto-fails.
- Team is remote/multi-site with weak trust.

Offer: **audit maintains the record; peers supply qualitative commentary** on a
development rubric subset.

## Step 7: Launch and evaluate

First 90 days, track:

- **Participation rate** — reviews completed / assigned.
- **Peer vs audit delta** on spot-check sample — mean and by criterion.
- **Comment quality** — specific evidence vs generic praise.
- **Agent survey** — felt useful vs surveillance.

Success: stable participation, audit-spot-check gap within agreed band, qualitative
feedback in coaching. Failure: participation collapse or gap widening — redesign before
expanding scope.

## Present results to the user

1. **Purpose decision** — development, calibration support, or cautious coverage — and
   explicit statement if audit substitution was correctly rejected.
2. **Programme design** — cadence, volume, rubric subset, time budget per agent.
3. **Assignment and blinding rules** — rotation, anonymity, exclusions.
4. **Bias control table** — risks and mitigations specific to their context.
5. **Reporting separation** — what is published where; what never feeds performance.
6. **Audit spot-check plan** — sample rate, gap thresholds, pause triggers.
7. **Launch metrics** — 90-day evaluation criteria and success/failure thresholds.
