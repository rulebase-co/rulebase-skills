---
name: cx-performance-documentation
description: Use when QA data is being assembled for a formal employment process — a performance review, an improvement plan, a promotion case or an HR record — where the evidence standard and fairness controls are stricter than for coaching. Trigger for "document this agent's performance for HR", "build a performance file", "prepare a six-month review", "evidence for a performance improvement plan", or comparing an agent against a peer to show a gap.
metadata:
  author: rulebase
  version: "1.0.0"
  archetype: playbook
---

# Performance documentation from QA data

This is not a coaching pack. When QA data is going into an employment decision, the
evidence standard changes, the fairness controls become mandatory, and the document
will be read later by people who were not in the room — HR, an appeal panel,
sometimes a tribunal or a works council.

**Establish first that this is what is being asked.** "Prepare a review" can mean
either job. Ask, because the two documents look similar and the wrong one used for
the wrong purpose is a serious problem: a coaching pack repurposed as HR evidence
has none of the controls below.

## The constraint everyone works around

**QA scores at typical evaluation volumes cannot support a performance rating, and
saying so is part of the job.**

For a pass rate from `n` evaluations the 95% interval is roughly
`±1.96 × sqrt(p(1−p)/n)`:

| n | ±95% CI at p = 0.90 |
| --- | --- |
| 4 | ±29 pp |
| 10 | ±19 pp |
| 25 | ±12 pp |
| 50 | ±8 pp |
| 100 | ±6 pp |

At n=10, an agent scoring 78 and an agent scoring 92 are not distinguishable. A
document that ranks them, or that describes one as underperforming on that basis, is
making a claim the data does not support — and that is exactly the claim an appeal
will test first.

Write the interval into the document, in plain language, near the top. If the process
needs a firm conclusion the aggregate cannot give, the honest route is **specific
documented incidents** with dates and evidence, not a score. Say that rather than
supplying a number that will not hold.

## Mandatory fairness controls

Run all five. Each one is a question an appeal will ask, and each one is answerable
from data you already have.

**1. Coverage parity.** Was this person evaluated at the same rate as comparable
peers? Under-coverage means their score rests on a smaller sample; over-coverage —
particularly if it began after concerns were raised — looks like targeting and is
very hard to defend. Report evaluations per handled conversation for the person and
for the comparison group.

**2. Mix comparability.** Compare like work. Channel, queue, contact reason,
difficulty and shift pattern all move scores independently of the person. If their
mix differs from the comparison group, either restrict the comparison to comparable
work or state that no fair comparison is available.

**3. Peer benchmark, same cohort and same period.** "Below the team average" is close
to meaningless — roughly half of any team is. The defensible benchmark is the
distribution among peers with similar tenure doing similar work in the same window,
reported as a distribution, not a single number. **Achievability matters**: if no
peer in the cohort reaches the standard being applied, the standard is the finding.

**4. Instrument reliability for their work.** If grader agreement is materially lower
on the channel or language this person works in, they are being measured with a worse
instrument than their colleagues. That is disqualifying for the affected criteria and
must be stated, not buried.

**5. Attribution.** Confirm the person actually did the work being judged. Multi-agent
tickets, reassignments, bot turns misattributed to a human, and evaluations attached
to the wrong employee after a backfill are all common. Verify a sample directly
against transcripts.

## Exclusions, documented

Exclude and record, with counts:

- **Disputed or contested evaluations** where the dispute is unresolved.
- **Superseded evaluations** from re-evaluated work.
- **Work outside the person's control** — a tooling outage, a missing knowledge-base
  answer, an undocumented policy, a queue spike, a scorecard that did not fit the work
  type. These are organisational findings and belong in a separate note to whoever
  owns the process.
- **Periods of absence, training, or changed duties.**
- **Evaluations from before a scorecard change**, if the rubric changed inside the
  window. A trend across a rubric change is not a trend, and presenting it as one is
  the most common technical error in these documents.

The exclusion list is not an appendix. A reader needs to see that the analysis removed
things that were not the person's fault, because that is what makes the remainder
credible.

## Structure

```
Performance documentation — <agent> — <period>
Prepared <date> by <author> from <source> at <version>

1. What this data can and cannot support
   n = <n> evaluations. Score <x> with a 95% interval of ±<y> points.
   Plain statement of the conclusions this does and does not sustain.

2. Basis and scope
   Sources, window, scorecard(s) and version(s), rubric changes inside the window.

3. Fairness controls
   Coverage parity: <this person> vs <cohort>
   Mix comparability: <comparison restricted to / not available because>
   Peer cohort: <definition>, distribution, achievability
   Instrument reliability: <agreement on their channels/languages>
   Attribution: <how verified, sample size>

4. Exclusions
   <category>: <count> — <reason>

5. Findings
   Each with: the specific evidence (ids, dates), what standard applies, and
   whether the finding is supported by aggregate data or by named incidents.

6. Counter-evidence
   Strengths and high-scoring work, from the same data. Required.

7. Limitations
   What could not be assessed and what would change the conclusions.
```

Section 6 is not a courtesy. A document that contains only adverse evidence, when
favourable evidence existed in the same dataset, is a selective record — and once
that is demonstrated the whole document is discounted.

## Guardrails

- **Do not write a disciplinary recommendation, a rating, or a termination
  rationale.** Present evidence and its limits. The decision, and the process it sits
  in, belong to managers and HR. If asked directly for a recommendation, say that the
  analysis supports findings rather than decisions, and hand over the findings.
- **Do not tune the analysis toward a conclusion.** If the request arrives with the
  answer attached — build the case for dismissing X — say plainly that the document
  has to be able to support either outcome to be worth anything, and run it that way.
  A file assembled to reach a predetermined result is the specific thing that loses
  appeals.
- **Employment, data protection and works-council rules vary by jurisdiction**, and
  they constrain what may be collected, retained, and used in a decision — including
  whether an automated or AI-assisted assessment may inform one at all. Flag that HR
  and legal need to confirm this is permissible in the relevant jurisdiction. Do not
  advise on the legal position.
- **Handle the document as confidential personal data.** It concerns an identified
  employee. Do not paste it into shared channels, do not commit it, and note that the
  subject may have a right to see it.
- **No transcript dumps.** Cite ids and quote the minimum a finding rests on. Redact
  customer details.
- **Never invent or reconstruct evidence.** If a transcript could not be retrieved,
  the entry says so.

## Present results to the user

1. **Confirm the purpose** — this is documentation for a formal process, and it is
   built to a different standard than coaching.
2. **What the data supports**, first and unhedged, with the interval.
3. **The document**, in the structure above.
4. **Which fairness controls failed**, if any. A failed control is a finding about the
   process, and it may be the most important output.
5. **Organisational findings routed elsewhere**, with owners.
6. **What is required before this is used in a decision** — HR and legal review,
   jurisdiction check, and the person's own response.
