---
name: cx-auto-fail-governance
description: Use to govern auto-fail criteria so every recorded failure has an owner, SLA, evidence trail, and closure — not a backlog auditors will cite. Trigger for "auto-fails nobody actions", "QA compliance failures sitting open", "hard fail vs soft fail", auto-fail backlog audit, regulatory QA findings, or designing workflow for zero-score evaluations.
metadata:
  author: rulebase
  version: "1.0.0"
  archetype: playbook
---

# Auto-fail governance

Auto-fail criteria exist because some failures cannot be averaged into a 92%. The
second failure mode is recording them and doing nothing — which transforms a quality
programme into a **documented compliance gap**.

Auditors and regulators care less about the miss than about **no evidence anyone
acted on it**.

## Diagnose governance failure

| Symptom | Underlying fault |
| --- | --- |
| Auto-fail count rises; closed count flat | No owner or SLA |
| QA logs fails; ops never sees them | Wrong routing or tool silo |
| Everything is "auto-fail" | Criteria are not truly catastrophic — alert fatigue |
| Agents learn fails are symbolic | No consequence linkage; theatre |
| Cannot produce closure evidence at audit | Ticket exists; remediation not linked |
| Hard policy fails treated like coaching notes | Wrong severity tier |

## Step 1: Separate hard fails from soft fails

These must not share a workflow or a name in reporting.

**Hard auto-fail (policy / regulatory / safeguarding)**

- Binary, rare, zero tolerance when confirmed.
- Examples: missed mandatory disclosure, unauthorised refund, identity breach,
  abusive language, mishandled vulnerability disclosure.
- **Outcome:** incident record, not a coaching note. May trigger regulatory reporting.
- **Owner:** compliance or designated risk role — not the agent's team lead alone.

**Soft quality fail (critical but coachable)**

- Serious quality miss that zeroes the evaluation but is not a regulatory event.
- Examples: materially wrong resolution on a non-regulated topic, fabricated
  information to customer.
- **Outcome:** mandatory coaching, possible repeat-offence escalation.
- **Owner:** QA + team lead.

If the scorecard has 15 "auto-fails", most are soft fails miscategorised. Renumber
the rubric: keep 3–6 true hard auto-fails.

## Step 2: Every auto-fail needs five fields at creation

Non-negotiable on the evaluation record:

1. **Criterion id and version** — which rule fired.
2. **Evidence** — quote, timestamp, message id; enough for an independent reviewer.
3. **Severity tier** — hard vs soft.
4. **Named owner** — role + person or queue; never unassigned.
5. **SLA clock** — time to acknowledge and time to resolve.

An auto-fail without owner and SLA is a finding waiting to happen.

## Step 3: Define SLAs by tier

Set SLAs the organisation can actually meet — aspirational SLAs that are missed daily
are worse than no SLA.

| Tier | Acknowledge | Resolve / disposition |
| --- | --- | --- |
| Hard auto-fail | Same business day | Per incident policy — often 24–72 hours to confirmed disposition |
| Soft quality fail | 2 business days | Coaching completed within 5–10 business days |
| Disputed auto-fail | Pause SLA until adjudication | Appeal outcome within defined window |

**Acknowledge** = owner confirms receipt and begins review.
**Resolve** = confirmed outcome recorded with evidence (coaching done, incident closed,
escalated to compliance, overturned with reason).

Escalate automatically when SLA breaches — to QA lead, then compliance for hard
fails.

## Step 4: Build the evidence trail

Each closure needs linked artefacts:

- **Initial evaluation** with evidence.
- **Review notes** — confirm or overturn; if overturn, why ( criterion misfire vs
  factual error).
- **Remediation** — coaching record, policy refresh, system fix, customer remediation.
- **Sign-off** — named approver for hard fails.

Store links, not prose in email. "We talked about it" is not a trail.

For overturns: track **false positive rate per criterion** — high overturn means
rubric or grader problem, not agent problem.

## Step 5: Route and notify correctly

| Tier | Notify | System of record |
| --- | --- | --- |
| Hard | Compliance + QA + team lead | Incident / case management |
| Soft | QA + team lead | QA platform + coaching log |
| Repeat hard on same agent | Add HR / performance pathway per policy | Performance file |

Avoid duplicate tickets across QA tool and helpdesk with no link. One id should
reference the other.

Agents should see **that an auto-fail occurred and what criterion** — not always the
full compliance narrative on hard fails until reviewed.

## Step 6: Audit the unactioned backlog

Run monthly (minimum):

```
For each open auto-fail older than SLA:
  - id, date, tier, criterion, owner, days open
  - last action timestamp
  - blocker (if any)
```

Report:

- **Open count by tier and age bucket** (0–7, 8–30, 31+ days).
- **Closure rate** — closed within SLA / total created.
- **Mean time to acknowledge and resolve** by tier.
- **Top criteria by volume and by open age** — systemic rubric vs process issue.

Present backlog to leadership when hard fails exceed acknowledge SLA — that is a
compliance exposure, not a QA metric.

## Step 7: Connect to outcomes, not only volume

Governance metrics that matter:

- **Recurrence rate** — same criterion, same agent, within 90 days after closure.
- **Customer remediation rate** on hard fails where customer harm possible.
- **Criterion false-positive rate** — overturns / total fails.
- **Time-to-close trend** — improving or degrading.

Volume of auto-fails alone is ambiguous. Rising fails with falling recurrence may
mean the instrument got sharper, not that quality collapsed.

## Step 8: Prevent alert fatigue

- **Cap hard auto-fails** at genuinely catastrophic rules.
- **De-dupe** multiple criteria firing on one root cause — one incident, linked
  evaluations.
- **Suppress re-fire** on same conversation after confirmed disposition unless new
  evidence.
- **Review criteria** that fire frequently — likely belongs in scored set, not
  auto-fail.

## Present results to the user

1. **Governance diagnosis** — which failure modes apply, with backlog stats if data
   available.
2. **Tier definitions** — hard vs soft criteria list (or classification of existing
   auto-fails).
3. **Required fields and SLA table** — acknowledge and resolve times by tier.
4. **Routing and evidence spec** — who gets notified, what artefacts link to closure.
5. **Backlog audit template** — query fields, age buckets, escalation rules.
6. **Reporting cadence** — monthly metrics, leadership triggers, audit pack contents.
7. **Criteria hygiene recommendations** — which auto-fails to demote, dedupe, or
   rewrite based on volume and overturn patterns.
