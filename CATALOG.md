# Catalog

149 skills, organised around the four things a CX organisation is accountable for, plus
the data contract underneath and the Rulebase corner.

This file is the readable description. For a machine-readable list, or to install, use the
CLI — it reads [`skills-index.json`](skills-index.json), which is generated from the skills
themselves and checked in CI, so it cannot drift from what is actually here:

```bash
npx rulebase-skills list
npx rulebase-skills info <slug>
```

| Category | Skills | What it covers |
| --- | --- | --- |
| [CX operations](#cx-operations) | 62 | Running the service: demand, routing, backlog, cost, workforce, channels, reporting |
| [Compliance](#compliance) | 32 | Proving the service met its obligations |
| [Quality assurance](#quality-assurance) | 27 | Measuring and improving how well the work is done |
| [RevOps](#revops) | 14 | The revenue consequences of support, and the signals support holds |
| [Data and integration](#data-and-integration) | 10 | The contract everything else is written against |
| [Rulebase](#rulebase) | 4 | Getting an agent connected to a Rulebase workspace, and operating it |

---

## CX operations

### Demand and capacity

| Skill | What it's for |
| --- | --- |
| `cx-contact-driver-taxonomy` | Categories that name a removable cause, not a reportable topic |
| `cx-volume-forecasting` | Forecast contacts and staff to them, with Erlang C |
| `cx-shrinkage-and-adherence` | The gap between "required" and "actually there at 10:15" |
| `cx-contact-spike-detection` | An incident signal from contact volume, with real seasonality |
| `cx-intraday-management` | Real-time reforecasting and the intraday decisions that actually recover a day |
| `cx-seasonal-readiness` | Peak-season planning: what to freeze, what to pre-stage, what to measure daily |
| `cx-arrival-pattern-analysis` | Arrival distributions, and when the Poisson assumption behind your staffing model fails |
| `cx-after-hours-coverage` | Follow-the-sun and overnight design, and the handoff quality it depends on |
| `cx-demand-driver-attribution` | Tying contact volume to product releases, campaigns and billing events |

### Routing, backlog and flow

| Skill | What it's for |
| --- | --- |
| `cx-routing-audit` | Misroutes, ping-pong, unowned queues, catch-all share |
| `cx-backlog-triage` | Who owes the next action, and who is actually waiting |
| `cx-sla-threshold-simulation` | What a proposed target would have delivered, with censoring handled |
| `cx-escalation-analysis` | Six causes of escalation, and the return-path gap |
| `cx-first-contact-resolution` | Repeat contact measured properly, FCR derived from it |
| `cx-handle-time-analysis` | Where the time goes, before anyone blames a person |
| `cx-queue-design` | Designing the queue and skill taxonomy the routing rules depend on |
| `cx-transfer-protocol` | Handoff standards, and measuring whether context survives a transfer |
| `cx-abandonment-analysis` | Chat and call abandonment, queue patience, and what a high FCR may be hiding |
| `cx-wip-limits` | Concurrency and work-in-progress limits, and their quality cost |
| `cx-flow-efficiency` | Touch time versus elapsed time across the whole resolution path |

### Channels and customer experience

| Skill | What it's for |
| --- | --- |
| `cx-deflection-analysis` | Whether a bot actually reduces volume |
| `cx-survey-design` | CSAT, NPS, CES, and which measures what |
| `cx-satisfaction-export` | The CSAT data every export leaves null |
| `cx-customer-identity-resolution` | Linking a customer across channels, precision-first |
| `cx-channel-strategy` | Which channels to offer, and the accessibility/cost trade-off nobody states |
| `cx-self-service-funnel` | Search → article → contact, as a funnel with drop-off you can act on |
| `cx-effort-score` | Customer effort measured from behaviour rather than from a survey question |
| `cx-proactive-support` | Designing and measuring outbound contact that prevents inbound |
| `cx-incident-comms` | Support's playbook during an outage: banners, macros, status page, volume plan |
| `cx-service-tiering` | VIP and tier design, and whether the tiering is doing anything |
| `cx-accessibility-review` | Whether your support is reachable by customers with access needs |
| `cx-journey-mapping` | Support contact mapped onto the product lifecycle |

### Cost and content

| Skill | What it's for |
| --- | --- |
| `cx-cost-to-serve` | Cost per contact and per resolved issue, built to survive a challenge |
| `cx-macro-audit` | A wrong macro is the most efficient way to be uniformly wrong |
| `cx-tag-taxonomy-hygiene` | Untagged share bounds every report built on tags |
| `cx-knowledge-base-audit` | Coverage against what customers actually contact about |
| `cx-knowledge-lifecycle` | Ownership, review cadence and deprecation for support content |
| `cx-article-effectiveness` | Which articles resolve, versus which are merely read |
| `cx-knowledge-from-conversations` | Mining resolved conversations into the article that was missing |
| `cx-internal-vs-external-knowledge` | What belongs in the help centre and what belongs in the internal wiki |
| `cx-translation-workflow` | Keeping localised content current when the source changes |
| `cx-content-consolidation` | Merging overlapping articles without breaking search or links |

### Workforce

| Skill | What it's for |
| --- | --- |
| `cx-onboarding-ramp` | Time to proficiency, and the three biases that flatter new hires |
| `cx-outsourcer-scorecard` | Comparing vendors fairly, before the vendor does it for you |
| `cx-agent-coaching-pack` | Evidence an agent will accept as fair |
| `cx-performance-documentation` | The stricter standard an employment decision needs |
| `cx-skills-matrix` | Capability mapping, and multi-skilling plans that account for its cost |
| `cx-incentive-design` | What happens to a metric once pay is attached to it |
| `cx-hiring-profile` | What actually predicts support performance, and what people screen for instead |
| `cx-attrition-early-warning` | Attrition risk from operational signal, ethically bounded |
| `cx-agent-experience-audit` | Agent-side friction: tooling, permissions, dead ends |
| `cx-career-pathing` | Progression frameworks for a support org |
| `cx-team-topology` | How to split a growing support team, and when |

### Reporting

| Skill | What it's for |
| --- | --- |
| `cx-recurring-report-spec` | Parameters that may vary, definitions that may not |
| `cx-metric-movement-decomposition` | Noise first, then rate versus mix versus composition |
| `cx-conversation-sampling` | Frame before size |
| `cx-alert-monitor-spec` | The volume forecast that decides whether an alert survives |
| `cx-executive-reporting` | The three numbers a board actually needs, and why the dashboard has forty |
| `cx-metric-definition-registry` | One definition per metric, versioned, with the owner named |
| `cx-benchmark-methodology` | How to compare yourself to a published benchmark honestly. Usually you can't |
| `cx-dashboard-review` | Auditing a dashboard for metrics nobody acts on and definitions nobody agrees with |
| `cx-narrative-reporting` | Writing the commentary that makes a number decision-ready |

---

## Quality assurance

### The instrument

| Skill | What it's for |
| --- | --- |
| `cx-qa-scorecard-design` | Criterion tests, auto-fail separation, weighting, real intervals |
| `cx-calibration-agreement` | Bias and noise have opposite fixes |
| `cx-rubric-false-positive-audit` | Five causes of a misfire, five different fixes |
| `cx-voice-qa` | What a transcript can support, and what needs audio |
| `cx-multilingual-quality` | The instrument is weakest where the scores are worst |
| `cx-gold-set-management` | Building, rotating and retiring calibration sets before they're memorised |
| `cx-scorecard-migration` | Changing the rubric without destroying the series |
| `cx-auto-fail-governance` | Auto-fails that are recorded and never actioned are a compliance finding |
| `cx-criterion-library` | A reusable bank of criteria written as observable decision rules |
| `cx-qa-appeal-process` | Dispute workflow, adjudication standards, second-level consistency |
| `cx-peer-review-design` | Peer and self-review programmes, and what they measure that audit doesn't |
| `cx-qa-program-maturity` | Assessing a QA programme end to end against what it's used for |

### Coverage and validity

The shipped skill here is [`rulebase-qa-coverage-audit`](#rulebase), filed under
Rulebase because it operates that product's MCP server.

| Skill | What it's for |
| --- | --- |
| `cx-qa-sampling-fairness` | Equalising by agent rather than by ticket, and detecting sampler drift |
| `cx-outcome-validation` | Whether the QA score predicts anything the business cares about |
| `cx-qa-coverage-economics` | How much QA to buy, given what the scores are used for |
| `cx-reviewer-workload` | Reviewer capacity, fatigue effects, and drift over a shift |

### AI in the loop

| Skill | What it's for |
| --- | --- |
| `cx-ai-agent-evaluation` | A frozen eval set, and newly-failing cases as the release decision |
| `cx-bot-safety-audit` | Attempts and successes as two numbers |
| `cx-reply-quality-coach` | Correctness, then commitments, then tone |
| `cx-ai-grader-validation` | Validating an AI grader against humans per segment before trusting it |
| `cx-agent-assist-evaluation` | Measuring a copilot: acceptance rate is not value |
| `cx-prompt-change-management` | Versioning, staging and rollback for prompts in production |
| `cx-bot-knowledge-grounding` | Retrieval quality as the ceiling on answer quality |
| `cx-human-in-the-loop-design` | Where the approval gate goes, and what it costs to put it there |
| `cx-agentic-action-safety` | Bounding what an AI agent may do to a customer's record |
| `cx-synthetic-conversation-generation` | Test data that doesn't put production PII in a fixture |
| `cx-model-cost-management` | Cost per resolution, and where the tokens actually go |

---

## Compliance

Complete as scoped. The design decision running through all of these: they produce
**evidence** and explicitly do not make the determination. Reportability, whether a duty
applies, whether remediation is required, and where a regulatory line sits are compliance
and legal calls, not analytical outputs, and none of these skills states a jurisdictional
requirement.

### Complaints and conduct

| Skill | What it's for |
| --- | --- |
| `cx-complaint-classification` | What counts as a regulated complaint: the definition is the work |
| `cx-complaints-sla` | Deadline clocks with no hard-coded deadlines; ships the business-day arithmetic |
| `cx-complaint-root-cause` | "Action completed" is not "cause removed", and this tracks both |
| `cx-vulnerability-detection` | Was a signal present and acted on, never "is this customer vulnerable" |
| `cx-conduct-risk-monitoring` | Structural signals beat keyword lists; check the incentive first |
| `cx-policy-practice-divergence` | Four outcomes, and "policy silent" is usually the largest |
| `cx-consumer-outcome-evidence` | Built for negative assurance rather than averages |
| `cx-redress-consistency` | Does outcome correlate with how loudly the customer escalated? |
| `cx-emerging-harm-scan` | Harm you have no category for, found in the "Other" bucket and the long tail |

### Evidence and audit

| Skill | What it's for |
| --- | --- |
| `cx-case-timeline` | What happened, ordered by event time, with the gaps marked |
| `cx-regulatory-reporting-pack` | Reproducible by a stranger; disclose your own gaps first |
| `cx-audit-trail-integrity` | Whether the chain from conversation to decision can be walked backwards |
| `cx-quality-attestation` | State the claim precisely: the limitations section is the value |
| `cx-control-testing` | Build the population independently of the control's own log |
| `cx-record-retention-audit` | Over-retention and premature deletion, which is often the worse one |
| `cx-third-party-risk` | Test the vendor against the work, not the questionnaire |
| `cx-change-evidence` | Four dates, and the decision date is not the effective date |

### Data protection

| Skill | What it's for |
| --- | --- |
| `cx-subject-access-request` | Support data is full of other people's data; two failure directions |
| `cx-erasure-plan` | A reviewable plan before anything is deleted |
| `cx-pii-redaction-audit` | Measures how unsafe data still is rather than certifying it safe |
| `cx-duplicate-detection` | Duplicate conversations, as a prerequisite for erasure and for metrics |
| `cx-disclosure-audit` | Timing is part of the requirement; three ways script-based assurance fails |
| `cx-ai-disclosure` | Three separate obligations, including the invisible-processing one |
| `cx-data-flow-review` | Where support data actually goes, versus what the register says |
| `cx-call-recording-governance` | A recording cannot be selectively edited the way text can |
| `cx-training-data-eligibility` | Five gating questions before any data moves; redaction is not anonymisation |
| `cx-data-minimisation-review` | The cheapest way to reduce the impact of a future breach |

### Financial services

| Skill | What it's for |
| --- | --- |
| `cx-regulated-advice-boundary` | Implied recommendations are the largest unrecognised category, and over-caution counts too |
| `cx-financial-promotions-audit` | Macros and footers are the highest-volume promotional content nobody reviews |
| `cx-fraud-and-scam-signal` | The only evidence a payment was a scam is in what the customer said |
| `cx-dispute-quality` | Two clocks, and process rejections separated from merit rejections |
| `cx-collections-conduct` | Whether disclosing difficulty made things better or worse |

---

## RevOps

Complete as scoped. Support conversations are the densest source of churn, expansion and
product-friction signal most companies own; every skill here leads with the reason the
obvious version of the analysis is wrong.

### Revenue signal

| Skill | What it's for |
| --- | --- |
| `cx-churn-signal` | Coverage first: most churn never appears in support, and that bounds everything |
| `cx-expansion-signal` | Precision-first, plus the frustration test on limit signals |
| `cx-revenue-at-risk` | Exposure and risk are different quantities; uplift over matched accounts |
| `cx-win-loss-from-support` | Post-purchase and contact-conditioned: evidence about departure, not lost deals |
| `cx-customer-health-score` | Validate against an outcome before choosing weights |
| `cx-renewal-risk-review` | The cumulative record, including commitments made and not kept |
| `cx-nrr-attribution` | Mostly about what cannot honestly be claimed |

### Commercial process

| Skill | What it's for |
| --- | --- |
| `cx-support-to-revenue-handoff` | Agents flag, agents do not sell, and closing the loop is what stops it decaying |
| `cx-onboarding-friction` | Activation blockers visible in support before retention shows them |
| `cx-pricing-objection-analysis` | Four problems arriving in the same words, split before counting |
| `cx-refund-and-goodwill-policy` | Owed versus goodwill, and authority set from the amount distribution |
| `cx-account-escalation-protocol` | Follow-through, not intake, is where executive escalations fail |
| `cx-support-led-growth` | Remove the reasons customers don't grow; don't promote |
| `cx-cost-of-poor-quality` | Rework is the defensible layer; the churn estimate goes last |

---

## Rulebase

The one product-specific corner. Everything else is vendor-neutral.

| Skill | What it's for |
| --- | --- |
| `rulebase-setup` | Accounts, region, MCP install, API keys |
| `rulebase-workspace-sql` | Queries that finish, and don't double-count |
| `rulebase-qa-coverage-audit` | Coverage and instrument health |
| `rulebase-upload-calls` | Pushing recordings in under the mutation contract |

## Why there are no helpdesk exporters

The catalog used to ship eleven of them: Zendesk, Intercom, Freshdesk, Freshchat,
Salesforce, HubSpot, Gorgias, Front, Five9, Help Scout and Aircall, plus Zendesk write
skills. They have been removed deliberately.

The reasoning, so nobody re-adds them by accident:

- **Vendor APIs date faster than anything else here.** A limit, an endpoint or a default
  changes and the skill is now confidently wrong. A stale exporter is worse than no
  exporter, because it is trusted.
- **Getting data out of your own helpdesk is an integration you own**, and you have
  context the skill cannot: your scopes, your volumes, your existing pipeline.
- **The portable part is the contract, not the extraction.** That is what
  `cx-conversation-schema` is, and it is what makes an analysis run against any source.

So: land your conversation data in the canonical shape however suits you, and every
analysis in the catalog works against it.

The one exception is `cx-satisfaction-export`, which does touch vendor APIs, because CSAT
sits outside the conversation object on every platform and has no portable source. If it
goes stale it should be cut rather than patched.

---

## Data and integration

Complete as scoped. The canonical schema is the contract every export honours; these are the
pipeline concerns around it.

| Skill | What it's for |
| --- | --- |
| `cx-conversation-schema` | The canonical shape every export emits |
| `cx-helpdesk-migration` | Migration fidelity, measured rather than assumed |
| `cx-export-reconciliation` | Internal consistency is not completeness, and this ships the reconciler |
| `cx-data-quality-monitoring` | Catching the sync that stopped while every dashboard kept rendering |
| `cx-warehouse-modeling` | State the grain of every table, or two people join it two ways |
| `cx-streaming-ingest` | Webhooks for latency, polling for truth, reconciliation for completeness |
| `cx-schema-evolution` | The worst change is the one that breaks nothing and means something new |
| `cx-cross-system-joins` | Grain, keys and as-of timing when joining CRM, billing and product |
| `cx-reverse-etl` | The helpdesk is not a display surface: it has automations |
| `cx-conversation-embedding-pipeline` | Chunk on turn boundaries; deletion has to reach the index |

---

## Still to build

Everything in the four practice categories and the data layer is complete as scoped. What
remains is the Rulebase corner:

| Skill | What it would do |
| --- | --- |
| `rulebase-work-items` | Back-office work with no customer on the line |
| `rulebase-scorecard-as-code` | Scorecards under version control, diffable and reviewable |
| `rulebase-dashboard-as-code` | Dashboards and reports defined in a file |
| `rulebase-agent-authoring` | Building and testing a Rulebase agent from a spec |
| `rulebase-migration-audit` | Reconciling a migrated workspace against the source system |

---

## Claiming something

Open an issue naming the skill and the shape you plan to give it. Two things make a
contribution land quickly:

- **Lead with what breaks.** [AGENTS.md](AGENTS.md) is the authoring standard. The most
  valuable paragraph in a skill is the one naming the thing that goes wrong; if you cannot
  write that paragraph, the skill is not ready.
- **Bring the verified numbers.** Confidence intervals computed rather than asserted, and
  no limit or regulatory deadline stated from memory. A plausible-sounding figure that
  turns out to be wrong costs more than a missing skill.
