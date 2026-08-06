# rulebase-skills

[![npm](https://img.shields.io/npm/v/rulebase-skills?color=cb3837&logo=npm)](https://www.npmjs.com/package/rulebase-skills)
[![validate](https://github.com/rulebase-co/rulebase-skills/actions/workflows/validate.yml/badge.svg)](https://github.com/rulebase-co/rulebase-skills/actions/workflows/validate.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**149 agent skills for customer support and CX operations.** For Claude Code, Codex,
Cursor, and anything else that reads [`SKILL.md`](https://skills.sh) files.

CX metrics are full of numbers that are computed the easy way and mean nothing. These
skills encode the difference: the containment rate that counts abandonment as a
success, the QA score that is ±29 points of noise, the SLA attainment that looks good
because the slow tickets are still open, the churn signal that can only see customers
who bothered to contact you.

Vendor-neutral by design, with no per-helpdesk exporters. Land your conversation data in
[one canonical shape](skills/data-and-integration/cx-conversation-schema) and every
analysis here runs against it.

> **While this repository is private**, the `npx rulebase-skills` commands below cannot
> reach it — `raw.githubusercontent.com` returns 404 without a token. Use
> `npx skills add rulebase-co/rulebase-skills`, which picks up your `gh auth token`.
> Delete this note when the repository goes public.

## Install

```bash
npx rulebase-skills install cx-metric-movement-decomposition
```

Browse first:

```bash
npx rulebase-skills list
npx rulebase-skills search churn
npx rulebase-skills info cx-churn-signal
```

A whole category, or everything:

```bash
npx rulebase-skills install --category quality-assurance
npx rulebase-skills install --all
```

Installs to `~/.claude/skills/` by default. Other targets:

| Flag | Destination |
| --- | --- |
| `--claude` | `~/.claude/skills/` (default) |
| `--codex` | `~/.codex/skills/` |
| `--cursor` | `<project>/.cursor/skills/` |
| `--project-dir <path>` | install into that project instead of your home directory |
| `--dir <path>` | install straight into a directory, whatever the tool expects |

`--dir` is the escape hatch: agent tools move their skill directories between versions,
so nothing here depends on us guessing right.

<details>
<summary>Other ways in</summary>

The [Vercel `skills` CLI](https://github.com/vercel-labs/skills) also works, and is the
one to use while this repository is private because it can authenticate:

```bash
npx skills add rulebase-co/rulebase-skills
npx skills add rulebase-co/rulebase-skills --skill cx-deflection-analysis
npx skills use rulebase-co/rulebase-skills@cx-metric-movement-decomposition
```

Or copy any skill directory into `~/.claude/skills/` by hand. A skill is a directory with
a `SKILL.md`; there is nothing else to it.

</details>

## Catalog

149 skills. The tables below cover a selection; **[ROADMAP.md](ROADMAP.md) is the complete
index**, with every skill on one line, grouped by the four things a CX organisation is
accountable for.

| Category | Skills | Complete index |
| --- | --- | --- |
| CX operations | 62 | [ROADMAP.md#cx-operations](ROADMAP.md#cx-operations) |
| Quality assurance | 27 | [ROADMAP.md#quality-assurance](ROADMAP.md#quality-assurance) |
| Compliance | 32 | [ROADMAP.md#compliance](ROADMAP.md#compliance) |
| RevOps | 14 | [ROADMAP.md#revops](ROADMAP.md#revops) |
| Data and integration | 10 | [ROADMAP.md#data-and-integration](ROADMAP.md#data-and-integration) |
| Rulebase | 4 | [ROADMAP.md#rulebase](ROADMAP.md#rulebase) |

### CX Operations

Vendor-neutral practice. Useful whichever helpdesk you run.

**Quality**

| Skill | What it's for |
| --- | --- |
| [`cx-qa-scorecard-design`](skills/quality-assurance/cx-qa-scorecard-design) | Design, rebuild, or critique a QA scorecard. Criterion tests, auto-fail separation, weighting, sample sizing with real confidence intervals, calibration with chance-corrected agreement, and validating that the score predicts an outcome. |
| [`cx-voice-qa`](skills/quality-assurance/cx-voice-qa) | Grading calls means grading transcripts, and ASR errors aren't random: they track accent and audio quality, so unvalidated voice QA encodes a bias against certain agents. Which criteria a transcript can support, and which need audio. |
| [`cx-survey-design`](skills/cx-operations/cx-survey-design) | CSAT, NPS and CES: which measures what, and why NPS after a support contact is the most common mis-specification in CX. Ships a response-bias diagnostic that tests whether your respondents resemble your contacts at all. |
| [`cx-satisfaction-export`](skills/cx-operations/cx-satisfaction-export) | The CSAT data every conversation export leaves as `null`. Multi-platform, and normalises a score **only** where the platform fixes the scale: where the account configures it, you get the raw value and a distribution rather than a guess. |
| [`cx-conversation-sampling`](skills/cx-operations/cx-conversation-sampling) | Every manual review is a sample, including the ones nobody calls one. Frame before size: a frame missing a channel can't support an org-wide claim however large the sample. Plus weighting, and why a risk-weighted sample can never produce a population rate. |

**Analytics and planning**

| Skill | What it's for |
| --- | --- |
| [`cx-deflection-analysis`](skills/cx-operations/cx-deflection-analysis) | Measure whether a support bot actually reduces contact volume. Splits sessions into contained / leaked / abandoned / handoff, quantifies how far the vendor's containment number overstates, and covers holdout design for causal claims. |
| [`cx-contact-driver-taxonomy`](skills/cx-operations/cx-contact-driver-taxonomy) | Build categories that name a cause you could remove rather than a topic you could report. Bottom-up derivation, the "Other" rate as your quality metric, and ranking by removable cost instead of volume. |
| [`cx-volume-forecasting`](skills/cx-operations/cx-volume-forecasting) | Forecast contacts and staff to them. Ships an Erlang C / Little's Law calculator that reports which of its own assumptions your scenario violates, and treats occupancy as a constraint, not a number to maximise. |
| [`cx-knowledge-base-audit`](skills/cx-operations/cx-knowledge-base-audit) | What are customers contacting you about that your KB doesn't cover? That gap is the containment ceiling for any AI agent grounded in it, so it's a prerequisite rather than a documentation chore. |

**Reporting and diagnosis**

| Skill | What it's for |
| --- | --- |
| [`cx-recurring-report-spec`](skills/cx-operations/cx-recurring-report-spec) | The weekly report retyped as a long prompt every Monday isn't a series: each retype is a chance for a definition to shift, so nobody can tell whether the business moved or the definition did. Separates parameters that may vary from definitions that may not. |
| [`cx-metric-movement-decomposition`](skills/cx-operations/cx-metric-movement-decomposition) | Why the score moved. Checks noise first (most movements people ask about aren't real), then splits the change exactly into rate, mix, and entrants/exits. Every segment can improve while the total falls, and the worked example does exactly that. |

**Coaching and calibration**

| Skill | What it's for |
| --- | --- |
| [`cx-agent-coaching-pack`](skills/cx-operations/cx-agent-coaching-pack) | Coaching evidence the agent will agree is fair, which is the only kind that gets acted on. Leads with what `n` actually supports, excludes markdowns caused by things outside their control, and requires a counter-example of the behaviour done well. |
| [`cx-calibration-agreement`](skills/quality-assurance/cx-calibration-agreement) | Is the AI grading too harshly, or is the criterion ambiguous? Opposite fixes. Reports Cohen's κ *and* Gwet's AC1 because QA prevalence is extreme enough that the same data gives κ = −0.05 and AC1 = 0.89. Flags per-segment reliability gaps as a fairness finding. |
| [`cx-rubric-false-positive-audit`](skills/quality-assurance/cx-rubric-false-positive-audit) | "Too many false positives, make it more lenient": global leniency adds false negatives on top of the false positives and diagnoses nothing. Classifies each misfire into five causes with five different fixes, and separates a missing exception from a request to lower the bar. |

**Investigation and compliance**

| Skill | What it's for |
| --- | --- |
| [`cx-case-timeline`](skills/compliance/cx-case-timeline) | Reconstruct what happened to a customer across tickets, channels and handoffs for an escalation or complaint. A case is not a ticket. Orders by event time rather than record time: sorting on the wrong timestamp can reverse cause and effect, and marks every gap. |
| [`cx-policy-practice-divergence`](skills/compliance/cx-policy-practice-divergence) | Does what agents tell customers match policy? Four outcomes, not two: the largest bucket is usually "policy silent", where six agents gave six reasonable answers because nothing is documented. Compares against the policy in force at the time, not today's. |
| [`cx-customer-identity-resolution`](skills/cx-operations/cx-customer-identity-resolution) | Link a customer's conversations across channels so per-customer metrics mean anything. Merging two different people is far worse than missing a merge, so thresholds are precision-first, and `support@` shared inboxes are the biggest source of catastrophic merges. |

**Agent assist and AI safety**

| Skill | What it's for |
| --- | --- |
| [`cx-reply-quality-coach`](skills/quality-assurance/cx-reply-quality-coach) | "Can I say this?" Correctness first, commitments second, tone last: most tone feedback on a draft containing a factual error is wasted. Never approves an unverifiable claim, and won't critique phrasing in a language it can't assess. |
| [`cx-bot-safety-audit`](skills/quality-assurance/cx-bot-safety-audit) | Audits a support bot for harm rather than volume: manipulation attempts vs actual successes (two numbers, never collapsed), customers stranded after asking for a human, fabricated answers, and unsafe commitments in normal operation. |
| [`cx-ai-agent-evaluation`](skills/quality-assurance/cx-ai-agent-evaluation) | Support AI usually ships on vibes and breaks three weeks later on a prompt tweak nobody re-tested. A frozen eval set drawn from real traffic, graded on dimensions that fail independently, with the newly-failing cases, not the total, as the release decision. |

**Monitoring and process**

| Skill | What it's for |
| --- | --- |
| [`cx-alert-monitor-spec`](skills/cx-operations/cx-alert-monitor-spec) | Nearly every alert built from a one-off search is muted within a fortnight, because nobody forecast its volume, and the historical sweep that motivated it *is* the forecast. Covers precision targets, spike baselines with real seasonality, state, and a review date. |
| [`cx-performance-documentation`](skills/cx-operations/cx-performance-documentation) | When QA data goes into an employment decision the standard changes. Five mandatory fairness controls, and the plain statement that at n=10 an agent scoring 78 and one scoring 92 are not distinguishable, which is the first thing an appeal will test. |

**Service levels and backlog**

| Skill | What it's for |
| --- | --- |
| [`cx-sla-threshold-simulation`](skills/cx-operations/cx-sla-threshold-simulation) | What would a 2-hour target have delivered? Counting past tickets that closed in 2 hours is too optimistic, because the ones still open are the slow ones. Handles censoring properly and is explicit that a target changes behaviour. |
| [`cx-backlog-triage`](skills/cx-operations/cx-backlog-triage) | "How many open tickets" is the wrong question. Segments by who owes the next action, separates genuinely dropped requests from automated noise, and surfaces customers stranded with a bot who asked for a human, a segment no status view contains. |

**Operational metrics**

| Skill | What it's for |
| --- | --- |
| [`cx-first-contact-resolution`](skills/cx-operations/cx-first-contact-resolution) | If the agent who handled the contact marks it resolved, the metric measures agent optimism and sits in the high eighties forever. Invert it: measure repeat contact and derive FCR. Includes the truncation everyone forgets, which always biases FCR upward. |
| [`cx-handle-time-analysis`](skills/cx-operations/cx-handle-time-analysis) | The mean describes nobody on a distribution this skewed. Decomposes where time actually goes: queue, handling, hold, wrap and third-party wait, before anyone blames an agent, and insists on repeat contact alongside, since AHT is the most gameable metric in support. |
| [`cx-routing-audit`](skills/cx-operations/cx-routing-audit) | Routing failures are invisible in every headline metric and expensive in all of them. Separates designed escalation from misroutes and ping-pong, and tracks catch-all share: the best health metric for a routing config, and one almost nobody tracks. |
| [`cx-escalation-analysis`](skills/cx-operations/cx-escalation-analysis) | Six causes of escalation with six different remedies, end-to-end time measured from the customer's first contact rather than from the handoff, and the return-path gap: work finished in the back office with nobody telling the customer. |

**Workforce and vendors**

| Skill | What it's for |
| --- | --- |
| [`cx-shrinkage-and-adherence`](skills/cx-operations/cx-shrinkage-and-adherence) | Most service-level misses aren't forecast errors: the plan lost the volume between "required" and "actually there at 10:15 on Monday". Shrinkage by interval rather than as an annual percentage, and the `N / (1 − s)` compounding people get backwards. |
| [`cx-onboarding-ramp`](skills/cx-operations/cx-onboarding-ramp) | Time to proficiency, and the three biases that all make new hires look better than they are. The stall point in the curve is the actionable finding: a capability nobody taught. |
| [`cx-outsourcer-scorecard`](skills/cx-operations/cx-outsourcer-scorecard) | The default finding of an unadjusted vendor comparison is "the site given the harder work performs worse". Mix adjustment, per-site grader agreement, and what changes when the numbers become contractual. |
| [`cx-multilingual-quality`](skills/quality-assurance/cx-multilingual-quality) | The measurement is usually weakest in exactly the languages that score worst, so a real gap and an artefact look identical. Never grade tone from a translation, and separate rubric fit, which produces a whole-market offset, from capability. |

**Cost, signal and content**

| Skill | What it's for |
| --- | --- |
| [`cx-cost-to-serve`](skills/cx-operations/cx-cost-to-serve) | Cost per contact, built so it survives a challenge. Automation cases are usually overstated four ways: fixed costs don't fall, headcount is lumpy, bots take the cheap contacts, and deflection isn't avoidance. Separates realisable savings from capacity released. |
| [`cx-contact-spike-detection`](skills/cx-operations/cx-contact-spike-detection) | Customers often notice a failure before monitoring does. Getting that signal needs a baseline that respects day-of-week and intraday seasonality, alerting on count and share together with a floor, and ruling out the backfill that's masquerading as a spike. |
| [`cx-macro-audit`](skills/cx-operations/cx-macro-audit) | A wrong macro is the most efficient way an organisation has of being uniformly wrong, and per-agent QA passes it, because it's consistent. Audits the high-usage head first, and estimates how many customers each error already reached. |
| [`cx-tag-taxonomy-hygiene`](skills/cx-operations/cx-tag-taxonomy-hygiene) | Untagged share bounds every report built on tags. Separates the four jobs one tag list is usually doing, and treats consolidation as history-rewriting: map rather than merge, and check concurrent lifetime to tell a true duplicate from a rename. |

**RevOps: revenue signal in support**

| Skill | What it's for |
| --- | --- |
| [`cx-churn-signal`](skills/revops/cx-churn-signal) | Most churn never appears in support, so the first number is coverage: what share of actual churners contacted you, and it bounds everything else. Plus the base rate (a 90/90 detector at 2% churn has ~15% precision) and lead time as the metric that matters. |
| [`cx-expansion-signal`](skills/revops/cx-expansion-signal) | Optimises for precision on purpose: the customer didn't contact support to be sold to. Ships the frustration test: "I've hit the limit again" is a buying signal from a growing account and a cancellation precursor from one that feels nickel-and-dimed. |
| [`cx-revenue-at-risk`](skills/revops/cx-revenue-at-risk) | "Revenue with a ticket attached" is not risk. Separates exposure from risk, uses uplift over matched accounts rather than the raw conditional rate, and buckets by time to the next decision point. |
| [`cx-renewal-risk-review`](skills/revops/cx-renewal-risk-review) | The cumulative record rather than the last ticket, including commitments made in transcripts and whether they were kept: the section customers raise and nobody prepares. |
| [`cx-customer-health-score`](skills/revops/cx-customer-health-score) | Validate against an outcome before choosing weights. Most candidate signals fail the test, and cutting them is how the score becomes useful. |
| [`cx-win-loss-from-support`](skills/revops/cx-win-loss-from-support) | Competitor mentions and switching language, but the sample is post-purchase and contact-conditioned, so it's evidence about departure, not about lost deals. |
| [`cx-nrr-attribution`](skills/revops/cx-nrr-attribution) | Mostly about what cannot honestly be claimed. An four-rung ladder from unquantified contribution to a holdout, and the one sentence every such figure needs: whether it's additive with other teams' claims. |

**RevOps: commercial process**

| Skill | What it's for |
| --- | --- |
| [`cx-support-to-revenue-handoff`](skills/revops/cx-support-to-revenue-handoff) | One structural rule: agents flag, agents do not sell. Then a never-do list with a specific failure attached to each. Closing the loop back to agents is the fix for the decay that kills these programmes. |
| [`cx-onboarding-friction`](skills/revops/cx-onboarding-friction) | Activation blockers visible in support months before retention shows the consequence. Classifies by failure type, not topic, because discoverability and expectation-mismatch have different owners. |
| [`cx-pricing-objection-analysis`](skills/revops/cx-pricing-objection-analysis) | Four problems arrive in the same words: billing defect, surprise, value objection, affordability, and sending the wrong one to a pricing review wastes a quarter. |
| [`cx-refund-and-goodwill-policy`](skills/revops/cx-refund-and-goodwill-policy) | Most "our goodwill costs too much" findings are redress that was owed and misfiled as generosity. Authority set from the amount distribution, and an audit for the system that pays more to whoever escalates loudest. |
| [`cx-account-escalation-protocol`](skills/revops/cx-account-escalation-protocol) | Follow-through, not intake, is where these fail: attention arrives, the issue returns to a normal queue, and the second escalation is far more damaging than the first. |
| [`cx-support-led-growth`](skills/revops/cx-support-led-growth) | Support drives growth by removing the reasons customers don't grow, not by promoting. With a support-quality guardrail and an agreed stopping condition. |
| [`cx-cost-of-poor-quality`](skills/revops/cx-cost-of-poor-quality) | Four cost layers in descending order of defensibility. Rework is the countable one and usually absent from the business case; the churn estimate goes last, with its interval. |

**Compliance: complaints and conduct**

| Skill | What it's for |
| --- | --- |
| [`cx-complaints-sla`](skills/compliance/cx-complaints-sla) | Regulated deadline clocks that hard-code no deadlines: lengths come from config with a cited source. Ships the business-day arithmetic (per-market holidays, month-end clamping) where every error lands in the optimistic direction. |
| [`cx-complaint-root-cause`](skills/compliance/cx-complaint-root-cause) | Tracks "action completed" and "cause removed" as separate states. The gap between them is why the same themes get rediscovered every year. |
| [`cx-vulnerability-detection`](skills/compliance/cx-vulnerability-detection) | Answers "was a signal present and was it acted on", never "is this customer vulnerable": a model-assigned vulnerable label is the failure to avoid. Leads with the data-protection flag, not the method. |
| [`cx-conduct-risk-monitoring`](skills/compliance/cx-conduct-risk-monitoring) | Structural signals beat keyword lists: contacts-to-completion on a cancellation finds obstruction better than any phrase search, in any language. Checks the incentive before blaming the person. |
| [`cx-consumer-outcome-evidence`](skills/compliance/cx-consumer-outcome-evidence) | Built for negative assurance. "No harm detected" isn't credible; "we tested for these six harms, at these sensitivities, and found two" is. |
| [`cx-redress-consistency`](skills/compliance/cx-redress-consistency) | The central test is whether outcomes correlate with how loudly the customer escalated: a system that pays more to escalators under-compensates everyone least able to advocate. |
| [`cx-emerging-harm-scan`](skills/compliance/cx-emerging-harm-scan) | Every monitor looks for what someone already thought of. This looks for what nobody has categorised: in the "Other" bucket, the long conversations, and agents' internal notes. |

**Compliance: evidence and audit**

| Skill | What it's for |
| --- | --- |
| [`cx-regulatory-reporting-pack`](skills/compliance/cx-regulatory-reporting-pack) | The standard is reproducible-by-a-stranger. The most damaging outcome isn't a bad number, it's one that can't be reproduced or a gap they find that you didn't disclose. |
| [`cx-audit-trail-integrity`](skills/compliance/cx-audit-trail-integrity) | Can you walk a decision backwards from records alone? Version amnesia is the usual break: the score survives and the standard it was measured against is gone. |
| [`cx-quality-attestation`](skills/compliance/cx-quality-attestation) | State the claim precisely: process operation, not "quality was good". The limitations section is the protection, and a qualified attestation is the control working. |
| [`cx-control-testing`](skills/compliance/cx-control-testing) | Build the population independently of the control's own log, or you can only ever conclude the control operates. Plus the three tests that find the most: rubber-stamping, detections with no response, and the population that bypasses it. |
| [`cx-record-retention-audit`](skills/compliance/cx-record-retention-audit) | Over-retention and premature deletion, which is often the more serious and is unrecoverable. Tests what's actually there rather than what's configured. |
| [`cx-third-party-risk`](skills/compliance/cx-third-party-risk) | Test the vendor against the work, not the questionnaire, and check the commercial terms before concluding anything about their culture, because you probably bought the behaviour. |
| [`cx-change-evidence`](skills/compliance/cx-change-evidence) | Four dates, and the decision date is not the effective date. Remediation reported on the wrong one leaves customers affected after the date you said it was fixed. |

**Compliance: data protection**

| Skill | What it's for |
| --- | --- |
| [`cx-subject-access-request`](skills/compliance/cx-subject-access-request) | Support data is full of other people's personal data in the same records, so both under- and over-disclosure are live risks. Includes the employee SAR, which usually arrives inside a dispute. |
| [`cx-disclosure-audit`](skills/compliance/cx-disclosure-audit) | Timing is part of the requirement: a recording notification given three minutes in hasn't notified anyone about the first three minutes. Plus the three ways script-based assurance fails. |
| [`cx-ai-disclosure`](skills/compliance/cx-ai-disclosure) | Three separate obligations, including the one always missed: conversations processed by AI the customer never sees output from. And the direct-question test: a bot deflecting "am I talking to a human?" is the worst failure available. |
| [`cx-data-flow-review`](skills/compliance/cx-data-flow-review) | Where support data actually goes versus what the register says. The AI features inside tools you already pay for are the most commonly unregistered flow, because they arrive as a product update. |
| [`cx-call-recording-governance`](skills/compliance/cx-call-recording-governance) | A recording can't be selectively edited the way text can, so most text-derived policy doesn't transfer. Includes spoken card data, which is a payment-security matter and not only a privacy one. |
| [`cx-training-data-eligibility`](skills/compliance/cx-training-data-eligibility) | Five gating questions before any data moves: sending conversations to a provider to see whether the idea works is itself the processing that needed approving. Redaction is not anonymisation. |
| [`cx-data-minimisation-review`](skills/compliance/cx-data-minimisation-review) | The cheapest way to reduce the impact of a future breach: data you don't hold can't be exposed. Finds the fields written by everyone and read by nothing. |

**Compliance: financial services**

| Skill | What it's for |
| --- | --- |
| [`cx-regulated-advice-boundary`](skills/compliance/cx-regulated-advice-boundary) | Implied recommendations are the largest and least-recognised category, because the agent doesn't experience it as advice. Reports over-caution with equal prominence, since evasive agents are their own harm. |
| [`cx-financial-promotions-audit`](skills/compliance/cx-financial-promotions-audit) | Macros and automated footers are the highest-volume promotional content in the business and go through no approval workflow. Generated bot output can't be pre-approved at all. |
| [`cx-fraud-and-scam-signal`](skills/compliance/cx-fraud-and-scam-signal) | The payment looks legitimate: the only evidence it was a scam is in what the customer said, often days earlier. Coaching the customer to lie is the strongest signal and transaction data can never see it. |
| [`cx-dispute-quality`](skills/compliance/cx-dispute-quality) | Two clocks, and a case can meet the customer timeframe while missing the scheme window: the customer gets an answer and no money. Separates process rejections from merit rejections. |
| [`cx-collections-conduct`](skills/compliance/cx-collections-conduct) | The agent has an objective that can conflict with the customer's interest, so the incentive is checked first. Headline test: did customers who disclosed difficulty end up better or worse off? |

**Data and compliance**

| Skill | What it's for |
| --- | --- |
| [`cx-conversation-schema`](skills/data-and-integration/cx-conversation-schema) | The canonical cross-platform schema every export in this catalog emits, plus a validator that catches orphaned messages, unresolved author types, and the other export faults that look fine and produce wrong answers. |
| [`cx-helpdesk-migration`](skills/data-and-integration/cx-helpdesk-migration) | Plan what not to migrate, then prove what arrived. Ships a fidelity checker that diffs two canonical exports and catches the losses migrations hide: above all `created_at` reset to the import date, which destroys your reporting history and cannot be recovered. |
| [`cx-complaint-classification`](skills/compliance/cx-complaint-classification) | In regulated sectors a complaint is a definition, not a feeling, so sentiment-based detection systematically misses the calm customer stating a factual grievance. Layered detection tuned for recall, with the audit trail regulators ask for. |
| [`cx-duplicate-detection`](skills/compliance/cx-duplicate-detection) | Find the same customer raising the same problem twice, and emit a reviewable merge plan. Candidates must share an identity: a wrong merge discloses one customer's data to another. |
| [`cx-erasure-plan`](skills/compliance/cx-erasure-plan) | GDPR/CCPA erasure planning. Turns on two distinctions everyone gets wrong: requester vs merely-mentioned, and open vs closed. Also enumerates what helpdesk erasure does **not** cover: warehouse, backups and embedding stores. |
| [`cx-pii-redaction-audit`](skills/compliance/cx-pii-redaction-audit) | The gate before support data moves anywhere. Measures how unsafe it still is rather than certifying it safe, checks the fields redaction always misses (HTML bodies, attachment filenames, voice digit strings, internal notes), and states plainly that redaction is not anonymisation. |

### Rulebase

Start with `rulebase-setup` if Claude isn't connected to Rulebase yet.

| Skill | What it's for |
| --- | --- |
| [`rulebase-setup`](skills/rulebase/rulebase-setup) | Get connected: accounts and invitations, working out your data region, installing the MCP server in Claude Code / Claude Desktop / Cursor, and creating an API key. Leads with the mistake everyone makes: the API key and the MCP server are different credentials, and the 401 body tells you which surface you actually hit. |
| [`rulebase-workspace-sql`](skills/rulebase/rulebase-workspace-sql) | Query a workspace without timing out or double-counting. Why `LIMIT` bounds the output and not the work, the slice-and-union patterns that finish, and the evaluation join fan-outs that make criterion counts exceed team counts. |
| [`rulebase-qa-coverage-audit`](skills/rulebase/rulebase-qa-coverage-audit) | Audit QA coverage and scorecard health over MCP. Finds zero-coverage segments, agents whose scores lack the statistical power for how they're being used, ceiling effects, dead criteria, and whether scores relate to SLA or complaint outcomes. |
| [`rulebase-upload-calls`](skills/rulebase/rulebase-upload-calls) | Push call recordings in over the REST API for phone systems with no native connection. Dry-run plan first, because uploads can't be deleted through the API, with roster reconciliation and a check for the transposed caller/called that silently swaps customer and agent on outbound calls. |

## What these do differently

**They lead with what breaks.** The most valuable paragraph in a skill is the one
telling you the metric you're about to report counts customers giving up as a success,
or that the number you're about to explain is inside its own noise interval. Every
skill opens there rather than restating the obvious.

**The numbers are checked.** Confidence intervals are computed, not asserted. Where a
claim can't be verified, it isn't made. There are no invented industry benchmarks here,
and no regulatory deadline stated from memory.

**One schema, whoever produced the data.** The analyses expect a single
`conversations.jsonl` / `messages.jsonl` shape with a fixed enum vocabulary, defined by
[`cx-conversation-schema`](skills/data-and-integration/cx-conversation-schema) and
enforced by a validator. Get your helpdesk's data into that shape however suits you.
The metric is then written once and runs against any source.

**Scripts are tested against the failure paths.** The tests cover business-day and
month-end deadline arithmetic, right-censored SLA attainment, the kappa paradox,
checkpoint/resume, malformed input, and Erlang C verified against an independent
implementation. Those are the paths that break in production and never come up in a
happy-path manual run. Scripts have no npm dependencies and run on stock Node 20+.

**Analyses report what they can't conclude.** The deflection script emits caveats
naming which conclusions your data doesn't support, and refuses to run at all when
the input would only reproduce the number you're trying to audit.

**Customer data is treated as production PII.** Any skill touching a live API reads
credentials from the environment only, documents the least-privileged scope that works,
defaults to read-only, and tells the agent not to echo transcripts into chat.

**Writes are separated from decisions.** Anything that changes a live system consumes a
plan file produced by a separate read-only step, so an agent can propose a bulk change
without being able to perform one. The plan is a diff a human reviews. CI rejects a
mutation skill that lacks a dry-run default, an audit log, a resume journal, a bounded
blast radius, or a stated reversibility, and it rejects any script offering a `--force`.

## Roadmap

149 skills, and the four practice categories plus the data layer are complete as scoped.
[**ROADMAP.md**](ROADMAP.md) is the full index, with every skill on one line.

| Category | Skills |
| --- | --- |
| [CX operations](ROADMAP.md#cx-operations): demand, routing, backlog, cost, workforce, channels | 62 |
| [Quality assurance](ROADMAP.md#quality-assurance): the instrument, coverage, AI in the loop | 27 |
| [Compliance](ROADMAP.md#compliance): complaints, evidence, data protection, FS specifics | 32 |
| [RevOps](ROADMAP.md#revops): churn, expansion and revenue signal sitting in support | 14 |
| [Data and integration](ROADMAP.md#data-and-integration): the schema everything is written against | 10 |
| [Rulebase](ROADMAP.md#rulebase): getting connected, and operating a workspace | 4 |

**Per-vendor helpdesk exporters are deliberately out of scope.** The catalog is
vendor-neutral practice plus the data contract those analyses expect; getting data out of
your own helpdesk is your integration to own, and
[`cx-conversation-schema`](skills/data-and-integration/cx-conversation-schema) tells you the
shape to land it in.

Claiming something is welcome. Open an issue naming the skill and the shape you plan to
give it. [ROADMAP.md](ROADMAP.md#claiming-something) says what makes one land quickly.

## Contributing

Read [AGENTS.md](AGENTS.md). It's the authoring standard, and CI enforces most of it. [CONTRIBUTING.md](CONTRIBUTING.md) covers the workflow.

```bash
npm run check   # strict validation, index freshness, and the tests
```

If you add or remove a skill, regenerate the index and commit it — CI fails on a stale
one, because the published CLI reads it:

```bash
npm run build:index
```

## Standard

Skills follow the [agent skills standard](https://github.com/vercel-labs/skills):
a directory with a `SKILL.md` containing YAML frontmatter, plus optional
`references/` for on-demand detail and `scripts/` for executables. Only the name
and description load at startup; the body loads when the agent decides the skill
is relevant.

## License

[MIT](LICENSE).
