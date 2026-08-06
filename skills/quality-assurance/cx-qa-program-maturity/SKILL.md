---
name: cx-qa-program-maturity
description: Use to assess a customer-service QA programme end to end against what scores are actually used for — not review volume alone. Trigger for "how mature is our QA programme", "QA maturity assessment", "are we ready to use QA for bonuses", instrument coverage calibration actioning outcome link, or diagnosing a high-volume QA team that changes nothing.
metadata:
  author: rulebase
  version: "1.0.0"
  archetype: playbook
---

# QA programme maturity

High review volume is the most common false signal of maturity. Teams that score
10,000 conversations a month but never calibrate, never action auto-fails, and cannot
link scores to CSAT or repeat contact are **not** mature — they are busy.

Maturity is whether the programme reliably supports the **decisions** leadership
claims to make with QA data.

## Step 1: Name the decisions scores actually drive

Ask explicitly — do not accept the mission statement:

| Decision | Requires what from QA |
| --- | --- |
| Agent coaching | Granular criteria, fair feedback loop, manageable dispute process |
| Team performance management | Stable instrument, enough n, agreed thresholds |
| Bonus / promotion gating | High agreement, audit trail, appeal process, bias checks |
| Compliance assurance | Auto-fail governance, independent review, evidence retention |
| Product / policy feedback | Tagged criteria, trend reporting, route to owners |
| Bot quality | Separate rubric, model version control, human benchmark |

**Mismatch is immaturity.** Using coaching-grade scores for bonus gating without
upgrading the instrument is a maturity failure, not a policy choice.

Document claimed vs actual. Many programmes claim gating; practice is coaching-only
with occasional ad-hoc exceptions — that gap is the assessment starting point.

## Step 2: Score five dimensions

Rate each **1–4** (1 = ad hoc, 4 = reliable and evidenced). No dimension above 2 if
gating decisions run on that layer without upgrade.

### A. Instrument

The scorecard and grading system.

| Level | Characteristics |
| --- | --- |
| 1 | Checklist of adjectives; no version; no auto-fail separation |
| 2 | Written criteria; some observable rules; informal calibration |
| 3 | Versioned scorecard; gold set; agreement measured; AI/human aligned |
| 4 | Validated against outcomes; criterion library; migration discipline |

**Evidence to gather:** scorecard version history, gold set rotation log, last
agreement report (κ/AC1, not raw %), validation study results.

### B. Coverage

Whether sample sizes support the claims made.

| Level | Characteristics |
| --- | --- |
| 1 | Hand-picked tickets; unknown frame |
| 2 | Defined sample; some randomisation; n not tied to decision |
| 3 | Stratified design; random + risk strata reported separately |
| 4 | Coverage matched to use case; CIs stated for agent/team claims |

**Evidence:** sampling frame definition, evaluations per agent per period, stated
confidence for ranking claims.

### C. Calibration

Whether graders apply the same standard.

| Level | Characteristics |
| --- | --- |
| 1 | None, or "we discuss disagreements" |
| 2 | Occasional sessions; no statistics |
| 3 | Regular gold set; chance-corrected agreement; segment checks |
| 4 | Cadence tied to rubric/model changes; differential agreement monitored |

**Evidence:** calibration cadence, stale gold set age, human/AI agreement by channel.

### D. Actioning

Whether findings change anything.

| Level | Characteristics |
| --- | --- |
| 1 | Scores stored; no closed loop |
| 2 | Coaching sometimes happens; auto-fails informal |
| 3 | SLAs on auto-fail; coaching tracked; appeals defined |
| 4 | Recurrence measured; product/policy loop; outcome impact reviewed |

**Evidence:** auto-fail backlog age, coaching completion rate, appeal SLAs, criteria
with zero coaching follow-up.

### E. Outcome link

Whether scores predict or move what matters.

| Level | Characteristics |
| --- | --- |
| 1 | No named outcomes |
| 2 | Outcomes named; never tested |
| 3 | Periodic correlation checks; distribution reviewed |
| 4 | Criterion-level outcome links; validation triggers rebuild |

**Evidence:** last validation date, agent-level QA vs CSAT/repeat contact analysis,
ceiling-effect diagnosis.

## Step 3: Overall maturity — limited by weakest load-bearing dimension

```
Overall = min(dimension scores among those load-bearing for stated use)
```

Examples:

- **Coaching programme** — Instrument and Actioning load-bearing; Coverage can be 2
  if restricted to examples not ranking.
- **Bonus gating** — All five must be ≥3; Instrument and Calibration ≥4 or do not
  gate.
- **Compliance** — Auto-fail governance (Actioning) and Coverage (census on rare
  events) load-bearing.

**Do not average dimensions.** A 4 on volume with 1 on actioning is a 1 for
compliance purposes.

## Step 4: Common maturity illusions

| Illusion | Reality check |
| --- | --- |
| "We review 100% with AI" | Agreement unmeasured → Instrument still 1–2 |
| "We calibrate quarterly" | Same gold set 2 years → Calibration 2 at best |
| "Scores feed dashboards" | No coaching SLAs → Actioning 1 |
| "Leadership sees QA weekly" | No outcome validation → Outcome link 1–2 |
| "We have zero auto-fails" | Either perfect ops or fails not recorded → investigate |
| "Disputes are rare" | May mean agents gave up → check dispute process health |

## Step 5: Roadmap by gap — not by ambition

Prioritise fixes that unlock the **next decision** the business wants to make safely:

| Gap | Typical first fix |
| --- | --- |
| Instrument 1–2 | Scorecard redesign; separate auto-fail |
| Coverage 1–2 | Define frame; stratified sample; stop misreporting risk sample as overall rate |
| Calibration 1–2 | Gold set + agreement measurement |
| Actioning 1–2 | Auto-fail owners/SLAs; coaching link on scored fails |
| Outcome link 1–2 | Name outcomes; 4–8 week validation plan |

Avoid buying tools before Instrument ≥2 — automation scales broken rubrics faster.

## Step 6: Assess AI grading maturity separately

If AI grades production traffic, add:

- Model/version pinned on evaluations
- Human benchmark sample with agreement tracked
- Segment differential agreement (especially voice)
- Contested evaluation workflow includes AI-specific remand reasons

AI without human benchmark is Instrument 2 at ceiling regardless of volume.

## Step 7: Report maturity honestly

Present to leadership:

- Dimension scores with **evidence cited**, not self-assessment workshop votes.
- **Load-bearing dimensions** for each claimed use of QA.
- **Explicit blockers** — "Not ready for bonus gating until Calibration ≥3 and appeal
  process live."
- **90-day priorities** — max 3, sequenced.

Decline to certify maturity from volume metrics alone.

## Present results to the user

1. **Decision map** — claimed vs actual uses of QA scores.
2. **Dimension scorecard** — A–E with 1–4 ratings and evidence for each.
3. **Overall maturity verdict** — min load-bearing score + plain-language label
   (ad hoc / developing / operational / validated).
4. **Illusion check** — which false signals apply to this programme.
5. **Blockers** — what prevents the next intended use (gating, compliance sign-off,
   etc.).
6. **Prioritised roadmap** — sequenced fixes, max 3 for 90 days.
7. **AI grading addendum** — if applicable, separate instrument sub-score.
