# Roadmap

The catalog is organised around four things a CX organisation is accountable for.
Every skill — shipped or planned — belongs to exactly one, and platform coverage
cuts across all four.

| Category | Shipped | Planned | What it covers |
| --- | --- | --- | --- |
| [CX operations](#cx-operations) | 26 | 36 | Running the service: demand, routing, backlog, cost, workforce, channels |
| [Quality assurance](#quality-assurance) | 8 | 19 | Measuring and improving how well the work is done |
| [Compliance](#compliance) | 6 | 26 | Proving the service met its obligations |
| [RevOps](#revops) | 0 | 14 | The revenue consequences of support, and the signals support holds |
| [Platforms](#platforms) | 17 | 15 | Getting the data out of, and into, the systems the work happens in |
| [Data and integration](#data-and-integration) | 2 | 8 | The schema everything else is written against |
| **Total** | **59** | **118** | |

RevOps is the largest genuine gap: support conversations are the densest source of
churn, expansion and product-friction signal most companies own, and the catalog does
nothing with it yet.

Legend: **✅ shipped** · **▶︎ next** (well-understood, ready to write) · **◻︎ planned**
(scoped, needs research) · **◇ exploratory** (may not survive contact with reality)

The ordering inside each table is roughly the order we'd build in. Nothing here is
a commitment — it is the outline, so gaps are visible and contributors can claim a
piece without duplicating work.

---

## CX operations

### Demand and capacity

| | Skill | What it's for |
| --- | --- | --- |
| ✅ | `cx-contact-driver-taxonomy` | Categories that name a removable cause, not a reportable topic |
| ✅ | `cx-volume-forecasting` | Forecast contacts and staff to them, with Erlang C |
| ✅ | `cx-shrinkage-and-adherence` | The gap between "required" and "actually there at 10:15" |
| ✅ | `cx-contact-spike-detection` | An incident signal from contact volume, with real seasonality |
| ▶︎ | `cx-intraday-management` | Real-time reforecasting and the intraday decisions that actually recover a day |
| ▶︎ | `cx-seasonal-readiness` | Peak-season planning: what to freeze, what to pre-stage, what to measure daily |
| ◻︎ | `cx-arrival-pattern-analysis` | Arrival distributions, and when the Poisson assumption behind your staffing model fails |
| ◻︎ | `cx-after-hours-coverage` | Follow-the-sun and overnight design, and the handoff quality it depends on |
| ◇ | `cx-demand-driver-attribution` | Tying contact volume to product releases, campaigns and billing events |

### Routing, backlog and flow

| | Skill | What it's for |
| --- | --- | --- |
| ✅ | `cx-routing-audit` | Misroutes, ping-pong, unowned queues, catch-all share |
| ✅ | `cx-backlog-triage` | Who owes the next action, and who is actually waiting |
| ✅ | `cx-sla-threshold-simulation` | What a proposed target would have delivered, with censoring handled |
| ✅ | `cx-escalation-analysis` | Six causes of escalation, and the return-path gap |
| ✅ | `cx-first-contact-resolution` | Repeat contact measured properly, FCR derived from it |
| ✅ | `cx-handle-time-analysis` | Where the time goes, before anyone blames a person |
| ▶︎ | `cx-queue-design` | Designing the queue and skill taxonomy the routing rules depend on |
| ▶︎ | `cx-transfer-protocol` | Handoff standards, and measuring whether context survives a transfer |
| ◻︎ | `cx-abandonment-analysis` | Chat and call abandonment, queue patience, and what a high FCR may be hiding |
| ◻︎ | `cx-wip-limits` | Concurrency and work-in-progress limits, and their quality cost |
| ◇ | `cx-flow-efficiency` | Touch time versus elapsed time across the whole resolution path |

### Channels and customer experience

| | Skill | What it's for |
| --- | --- | --- |
| ✅ | `cx-deflection-analysis` | Whether a bot actually reduces volume |
| ✅ | `cx-survey-design` | CSAT, NPS, CES — which measures what |
| ✅ | `cx-satisfaction-export` | The CSAT data every export leaves null |
| ✅ | `cx-customer-identity-resolution` | Linking a customer across channels, precision-first |
| ▶︎ | `cx-channel-strategy` | Which channels to offer, and the accessibility/cost trade-off nobody states |
| ▶︎ | `cx-self-service-funnel` | Search → article → contact, as a funnel with drop-off you can act on |
| ▶︎ | `cx-effort-score` | Customer effort measured from behaviour rather than from a survey question |
| ◻︎ | `cx-proactive-support` | Designing and measuring outbound contact that prevents inbound |
| ◻︎ | `cx-incident-comms` | Support's playbook during an outage: banners, macros, status page, volume plan |
| ◻︎ | `cx-service-tiering` | VIP and tier design, and whether the tiering is doing anything |
| ◻︎ | `cx-accessibility-review` | Whether your support is reachable by customers with access needs |
| ◇ | `cx-journey-mapping` | Support contact mapped onto the product lifecycle |

### Cost and content

| | Skill | What it's for |
| --- | --- | --- |
| ✅ | `cx-cost-to-serve` | Cost per contact and per resolved issue, built to survive a challenge |
| ✅ | `cx-macro-audit` | A wrong macro is the most efficient way to be uniformly wrong |
| ✅ | `cx-tag-taxonomy-hygiene` | Untagged share bounds every report built on tags |
| ✅ | `cx-knowledge-base-audit` | Coverage against what customers actually contact about |
| ▶︎ | `cx-knowledge-lifecycle` | Ownership, review cadence and deprecation for support content |
| ▶︎ | `cx-article-effectiveness` | Which articles resolve, versus which are merely read |
| ▶︎ | `cx-knowledge-from-conversations` | Mining resolved conversations into the article that was missing |
| ◻︎ | `cx-internal-vs-external-knowledge` | What belongs in the help centre and what belongs in the internal wiki |
| ◻︎ | `cx-translation-workflow` | Keeping localised content current when the source changes |
| ◻︎ | `cx-content-consolidation` | Merging overlapping articles without breaking search or links |

### Workforce

| | Skill | What it's for |
| --- | --- | --- |
| ✅ | `cx-onboarding-ramp` | Time to proficiency, and the three biases that flatter new hires |
| ✅ | `cx-outsourcer-scorecard` | Comparing vendors fairly, before the vendor does it for you |
| ✅ | `cx-agent-coaching-pack` | Evidence an agent will accept as fair |
| ✅ | `cx-performance-documentation` | The stricter standard an employment decision needs |
| ▶︎ | `cx-skills-matrix` | Capability mapping, and multi-skilling plans that account for its cost |
| ▶︎ | `cx-incentive-design` | What happens to a metric once pay is attached to it |
| ◻︎ | `cx-hiring-profile` | What actually predicts support performance, and what people screen for instead |
| ◻︎ | `cx-attrition-early-warning` | Attrition risk from operational signal, ethically bounded |
| ◻︎ | `cx-agent-experience-audit` | Agent-side friction: tooling, permissions, dead ends |
| ◻︎ | `cx-career-pathing` | Progression frameworks for a support org |
| ◇ | `cx-team-topology` | How to split a growing support team, and when |

### Reporting

| | Skill | What it's for |
| --- | --- | --- |
| ✅ | `cx-recurring-report-spec` | Parameters that may vary, definitions that may not |
| ✅ | `cx-metric-movement-decomposition` | Noise first, then rate versus mix versus composition |
| ✅ | `cx-conversation-sampling` | Frame before size |
| ✅ | `cx-alert-monitor-spec` | The volume forecast that decides whether an alert survives |
| ▶︎ | `cx-executive-reporting` | The three numbers a board actually needs, and why the dashboard has forty |
| ▶︎ | `cx-metric-definition-registry` | One definition per metric, versioned, with the owner named |
| ◻︎ | `cx-benchmark-methodology` | How to compare yourself to a published benchmark honestly — usually, you can't |
| ◻︎ | `cx-dashboard-review` | Auditing a dashboard for metrics nobody acts on and definitions nobody agrees with |
| ◇ | `cx-narrative-reporting` | Writing the commentary that makes a number decision-ready |

---

## Quality assurance

### The instrument

| | Skill | What it's for |
| --- | --- | --- |
| ✅ | `cx-qa-scorecard-design` | Criterion tests, auto-fail separation, weighting, real intervals |
| ✅ | `cx-calibration-agreement` | Bias and noise have opposite fixes |
| ✅ | `cx-rubric-false-positive-audit` | Five causes of a misfire, five different fixes |
| ✅ | `cx-voice-qa` | What a transcript can support, and what needs audio |
| ✅ | `cx-multilingual-quality` | The instrument is weakest where the scores are worst |
| ▶︎ | `cx-gold-set-management` | Building, rotating and retiring calibration sets before they're memorised |
| ▶︎ | `cx-scorecard-migration` | Changing the rubric without destroying the series |
| ▶︎ | `cx-auto-fail-governance` | Auto-fails that are recorded and never actioned are a compliance finding |
| ◻︎ | `cx-criterion-library` | A reusable bank of criteria written as observable decision rules |
| ◻︎ | `cx-qa-appeal-process` | Dispute workflow, adjudication standards, second-level consistency |
| ◻︎ | `cx-peer-review-design` | Peer and self-review programmes, and what they measure that audit doesn't |
| ◻︎ | `cx-qa-program-maturity` | Assessing a QA programme end to end against what it's used for |

### Coverage and validity

The shipped skill here is [`rulebase-qa-coverage-audit`](#rulebase), filed under
Rulebase because it operates that product's MCP server.

| | Skill | What it's for |
| --- | --- | --- |
| ▶︎ | `cx-qa-sampling-fairness` | Equalising by agent rather than by ticket, and detecting sampler drift |
| ▶︎ | `cx-outcome-validation` | Whether the QA score predicts anything the business cares about |
| ◻︎ | `cx-qa-coverage-economics` | How much QA to buy, given what the scores are used for |
| ◻︎ | `cx-reviewer-workload` | Reviewer capacity, fatigue effects, and drift over a shift |

### AI in the loop

| | Skill | What it's for |
| --- | --- | --- |
| ✅ | `cx-ai-agent-evaluation` | A frozen eval set, and newly-failing cases as the release decision |
| ✅ | `cx-bot-safety-audit` | Attempts and successes as two numbers |
| ✅ | `cx-reply-quality-coach` | Correctness, then commitments, then tone |
| ▶︎ | `cx-ai-grader-validation` | Validating an AI grader against humans per segment before trusting it |
| ▶︎ | `cx-agent-assist-evaluation` | Measuring a copilot: acceptance rate is not value |
| ▶︎ | `cx-prompt-change-management` | Versioning, staging and rollback for prompts in production |
| ◻︎ | `cx-bot-knowledge-grounding` | Retrieval quality as the ceiling on answer quality |
| ◻︎ | `cx-human-in-the-loop-design` | Where the approval gate goes, and what it costs to put it there |
| ◻︎ | `cx-agentic-action-safety` | Bounding what an AI agent may do to a customer's record |
| ◻︎ | `cx-synthetic-conversation-generation` | Test data that doesn't put production PII in a fixture |
| ◇ | `cx-model-cost-management` | Cost per resolution, and where the tokens actually go |

---

## Compliance

### Complaints and conduct

| | Skill | What it's for |
| --- | --- | --- |
| ✅ | `cx-complaint-classification` | What counts as a regulated complaint, and why the definition is the work |
| ✅ | `cx-policy-practice-divergence` | Four outcomes, not pass/fail — "policy silent" is usually the biggest |
| ▶︎ | `cx-complaints-sla` | Regulated acknowledgement and final-response clocks, and what pauses them |
| ▶︎ | `cx-complaint-root-cause` | RCA and remediation tracking, so the same complaint stops recurring |
| ▶︎ | `cx-vulnerability-detection` | Identifying vulnerable customers in conversations, and the duty that follows |
| ◻︎ | `cx-conduct-risk-monitoring` | Mis-selling, pressure selling and unfair-outcome signals in support text |
| ◻︎ | `cx-consumer-duty-evidence` | Assembling outcome evidence across the four consumer-duty outcomes |
| ◻︎ | `cx-goodwill-consistency` | Whether goodwill and redress decisions are consistent across similar cases |
| ◇ | `cx-foreseeable-harm-scan` | Support signal as an early indicator of harm at portfolio level |

### Evidence and audit

| | Skill | What it's for |
| --- | --- | --- |
| ✅ | `cx-case-timeline` | What happened, ordered by event time, with the gaps marked |
| ▶︎ | `cx-regulatory-reporting-pack` | Assembling the evidence a regulator or auditor asked for |
| ▶︎ | `cx-audit-trail-integrity` | Proving the chain from conversation to evaluation to decision |
| ▶︎ | `cx-quality-attestation` | Signing off a QA period: what you're attesting to, and on what basis |
| ◻︎ | `cx-control-testing` | Testing a support control the way an auditor will, not the way you'd like |
| ◻︎ | `cx-record-retention-audit` | Retention policy versus what is actually still in the system |
| ◻︎ | `cx-third-party-risk` | Reviewing a BPO or vendor's handling of your customer data |
| ◻︎ | `cx-change-evidence` | Proving a process change happened, when, and who was told |

### Data protection

| | Skill | What it's for |
| --- | --- | --- |
| ✅ | `cx-erasure-plan` | Building a reviewable erasure plan before anything is deleted |
| ✅ | `cx-pii-redaction-audit` | Measuring how unsafe data still is, rather than certifying it safe |
| ✅ | `cx-duplicate-detection` | Duplicate conversations, as a prerequisite for erasure and for metrics |
| ▶︎ | `cx-subject-access-request` | Fulfilling a DSAR from support data without over- or under-disclosing |
| ▶︎ | `cx-consent-and-disclosure-audit` | Required disclosures present, in time, and in the right channel |
| ▶︎ | `cx-ai-disclosure` | Telling customers they are talking to AI, and evidencing that you did |
| ◻︎ | `cx-cross-border-transfer-review` | Where support data actually goes, versus where you think it goes |
| ◻︎ | `cx-call-recording-governance` | Consent, retention and redaction for recordings specifically |
| ◻︎ | `cx-training-data-eligibility` | Whether support conversations may lawfully train a model |
| ◇ | `cx-data-minimisation-review` | Fields collected in support that nobody uses and everybody stores |

### Financial services specifics

| | Skill | What it's for |
| --- | --- | --- |
| ▶︎ | `cx-financial-promotions-audit` | Support messaging checked against financial-promotion rules |
| ◻︎ | `cx-fraud-and-sanctions-signal` | Fraud, scam and sanctions language surfacing in support contacts |
| ◻︎ | `cx-dispute-and-chargeback-quality` | Dispute handling against scheme timelines and evidence standards |
| ◻︎ | `cx-collections-conduct` | Arrears and collections conversations against forbearance requirements |
| ◇ | `cx-regulated-advice-boundary` | Where a helpful answer becomes regulated advice |

---

## RevOps

Nothing shipped here yet, and it is the largest genuine gap in the catalog. Support
conversations are the densest source of churn, expansion and product-friction signal
most companies own, and almost nobody routes it anywhere.

| | Skill | What it's for |
| --- | --- | --- |
| ▶︎ | `cx-churn-signal` | Cancellation and downgrade intent in conversations, and what precedes it |
| ▶︎ | `cx-revenue-at-risk` | Quantifying the revenue sitting behind unresolved support failures |
| ▶︎ | `cx-expansion-signal` | Upgrade, seat-growth and new-use-case signals agents hear and discard |
| ▶︎ | `cx-support-to-revenue-handoff` | Routing a revenue signal out of support without turning agents into sellers |
| ▶︎ | `cx-renewal-risk-review` | Account health from the cumulative support experience, not the last ticket |
| ◻︎ | `cx-onboarding-friction` | Activation blockers visible in support before they show in retention |
| ◻︎ | `cx-customer-health-score` | The support contribution to a health score, weighted honestly |
| ◻︎ | `cx-win-loss-from-support` | Competitor mentions and switching language as win/loss input |
| ◻︎ | `cx-pricing-objection-analysis` | Billing and pricing complaint patterns, separated from billing bugs |
| ◻︎ | `cx-refund-and-goodwill-policy` | A decision framework for credits that is consistent and auditable |
| ◻︎ | `cx-support-led-growth` | Where support can drive adoption without becoming a sales channel |
| ◻︎ | `cx-account-escalation-protocol` | Executive escalations: intake, ownership, and the follow-through |
| ◇ | `cx-cost-of-poor-quality` | Tying quality failures to churn and credits, with the causal caveats intact |
| ◇ | `cx-nrr-attribution` | What share of net revenue retention support movement can honestly claim |

---

## Platforms

Every export emits the [canonical schema](skills/cx-ops/cx-conversation-schema), so
a metric written once runs against all of them. Ten shipped.

### Shipped

Thirteen vendor skills across ten platforms: nine conversation exporters
(`zendesk` · `intercom` · `freshdesk` · `freshchat` · `salesforce` · `hubspot` ·
`gorgias` · `front` · `helpscout`), one voice interaction exporter (`five9`), and
three Zendesk write skills under the mutation contract (`config-as-code` ·
`apply-merges` · `apply-erasure`).

### Coverage

| Platform | Export | Beyond export |
| --- | --- | --- |
| Zendesk | ✅ | ✅ config-as-code · ✅ merges · ✅ erasure · ▶︎ SLA metric events · ▶︎ macro usage · ◻︎ bulk update · ◻︎ view audit |
| Intercom | ✅ | ▶︎ Fin performance · ▶︎ bulk tag · ◻︎ conversation attributes |
| Freshdesk | ✅ | ◻︎ SLA export · ◻︎ automations audit |
| Freshchat | ✅ | ◻︎ bot flow export |
| Salesforce Service Cloud | ✅ | ◻︎ omni-channel routing export · ◻︎ Einstein data |
| HubSpot Service Hub | ✅ | ◻︎ pipeline and SLA export |
| Gorgias | ✅ | ◻︎ macro and rule audit |
| Front | ✅ | ◻︎ rule and analytics export |
| Five9 | ✅ | ◻︎ recording retrieval |
| Help Scout | ✅ | ◻︎ satisfaction export · ◻︎ workflow audit |
| **Kustomer** | ▶︎ | ◻︎ |
| **Zoho Desk** | ▶︎ | ◻︎ |
| **Dixa** | ▶︎ | ◻︎ |
| **Aircall** | ▶︎ calls and recordings | ◻︎ |
| **Jira Service Management** | ▶︎ | ◻︎ request-type config |
| **ServiceNow** | ◻︎ | ◻︎ |
| **Talkdesk** | ◻︎ | ◻︎ recordings and transcripts |
| **Genesys Cloud** | ◻︎ | ◻︎ recordings, IVR paths |
| **Amazon Connect** | ◻︎ | ◻︎ Contact Lens data |
| **NICE CXone** | ◻︎ | ◻︎ |
| **Twilio Flex** | ◻︎ | ◻︎ |
| **RingCentral / 8x8** | ◇ | ◇ |
| **LiveChat / Tidio / Crisp** | ◻︎ | ◇ |
| **Zammad / Re:amaze** | ◇ | ◇ |
| **Sprinklr / Khoros** | ◇ social and community | ◇ |
| **WhatsApp Business Platform** | ◻︎ | ◇ |
| **Slack / Teams-based support** | ◻︎ | ◇ shared-channel support |
| **Sierra / Decagon / Ada / Forethought** | ◻︎ containment and transcript data | ◇ |

### Rulebase

| | Skill | What it's for |
| --- | --- | --- |
| ✅ | `rulebase-setup` | Accounts, region, MCP install, API keys |
| ✅ | `rulebase-workspace-sql` | Queries that finish, and don't double-count |
| ✅ | `rulebase-qa-coverage-audit` | Coverage and instrument health |
| ✅ | `rulebase-upload-calls` | Pushing recordings in under the mutation contract |
| ▶︎ | `rulebase-upload-conversations` | Pushing text conversations from an unsupported helpdesk |
| ▶︎ | `rulebase-work-items` | Back-office work with no customer on the line |
| ▶︎ | `rulebase-scorecard-as-code` | Scorecards under version control, diffable and reviewable |
| ◻︎ | `rulebase-dashboard-as-code` | Dashboards and reports defined in a file |
| ◻︎ | `rulebase-agent-authoring` | Building and testing a Rulebase agent from a spec |
| ◻︎ | `rulebase-migration-audit` | Reconciling a migrated workspace against the source system |

---

## Data and integration

| | Skill | What it's for |
| --- | --- | --- |
| ✅ | `cx-conversation-schema` | The canonical shape every export emits |
| ✅ | `cx-helpdesk-migration` | Migration fidelity, measured rather than assumed |
| ▶︎ | `cx-warehouse-modeling` | Modelling the canonical schema for a warehouse, with the grain stated |
| ▶︎ | `cx-streaming-ingest` | Webhooks versus polling, and the gaps each one leaves |
| ▶︎ | `cx-schema-evolution` | Versioning the canonical schema without breaking every downstream metric |
| ◻︎ | `cx-reverse-etl` | Pushing derived attributes back into the helpdesk safely |
| ◻︎ | `cx-data-quality-monitoring` | Detecting a sync that silently stopped, before a report does |
| ◻︎ | `cx-entity-resolution-across-systems` | Joining helpdesk, CRM, billing and product identities |
| ◻︎ | `cx-export-reconciliation` | Proving an export is complete against the source's own counts |
| ◇ | `cx-conversation-embedding-pipeline` | Vectorising transcripts for retrieval, with the PII decisions made first |

---

## Claiming something

Open an issue naming the skill and the shape you plan to give it. Two things make a
contribution land quickly:

- **Answer the archetype's questions first.** [AGENTS.md](AGENTS.md) lists what a
  `platform` skill must establish before it is worth writing — the wrong endpoint, the
  silent gaps, the permission trap, what is checkpointable. If you cannot answer those,
  the skill is not ready.
- **Bring the verified numbers.** Every limit needs a vendor doc URL next to it. A
  plausible-sounding limit that turns out to be wrong costs more than a missing skill.

Nominating a platform is useful even without writing it — say which one, and what
you need out of it.
