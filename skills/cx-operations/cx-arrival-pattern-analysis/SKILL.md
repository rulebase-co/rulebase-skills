---
name: cx-arrival-pattern-analysis
description: Use to analyse contact arrival distributions and choose staffing models that match reality — burstiness, batch dumps, abandonment censoring and when Poisson or Erlang assumptions fail. Trigger for "arrival pattern analysis", "are arrivals Poisson", "Erlang assumptions", batch email arrivals, burst traffic, abandonment bias in arrivals, staffing model choice, or when Erlang staffing misses despite a good forecast.
metadata:
  author: rulebase
  version: "1.0.0"
  archetype: analysis
---

# Arrival pattern analysis

Staffing models need two inputs: how many contacts, and **how they arrive**. Forecasting
gets the first; this skill gets the second.

**The common failure is assuming Poisson arrivals because the textbook does.** Poisson
means variance equals the mean — arrivals are independent and evenly random. Support
queues routinely violate this: marketing sends, ticket system batch imports, outage
piling, and retry behaviour create **bursts** and **correlation** that make Erlang C
precise and wrong. Analyse the pattern before trusting any closed-form staffing number.

## What you are testing

For each channel and interval length you schedule to (usually 15 or 30 minutes):

1. **Distribution shape** — mean, variance, coefficient of variation (CV = σ/μ).
2. **Independence across intervals** — does a hot interval predict the next one?
3. **Censoring** — are "arrivals" only contacts that waited, not those that abandoned
   or bounced?
4. **Batch structure** — discrete dumps vs steady drip.

Record findings per queue and per interval. Patterns differ by channel; averaging hides
the violation that breaks your model.

## Poisson and Erlang: when they apply

**Poisson arrivals** are a reasonable working assumption when:

- Contacts arrive from many independent customers without a shared trigger.
- CV is near 1 (variance roughly equals mean) at your scheduling granularity.
- No systematic batch import or campaign aligns to the clock.

**Erlang C** (built on Poisson) is appropriate for **single-skill voice pools** when
patience and abandonment behaviour are stable and you are not in a sustained burst regime.
It answers: how many agents for a service-level target given Poisson arrivals and
exponential service times.

When assumptions hold, Erlang is useful. When they fail, the error direction matters
more than the formula.

| Violation | Typical effect on staffing | Direction |
| --- | --- | --- |
| Burstiness (CV > 1) | Peak intervals hotter than mean implies | Under-staffed if staffed to interval average |
| Batch arrivals | All work lands in one interval | Severe under-staff at dump; over-staff after |
| Abandonment censoring | Observed arrivals under-state demand | Under-staff; queues look "manageable" |
| Correlated intervals | Peaks cluster across intervals | Smoothing forecasts hides consecutive misses |
| Heavy tails (outliers) | Few intervals dominate SLA miss | Mean-based planning misses the bad tail |

Do not cite universal CV thresholds from industry slides. **Compare CV and miss intervals
in your own data** — report where Poisson was rejected and by how much.

## Burstiness

Burstiness means arrivals clump — variance exceeds the mean. Sources:

- **Campaigns and notifications** — email, push, SMS driving simultaneous contact.
- **Outages and status pages** — correlated retries until resolution.
- **Billing and payroll cycles** — predictable calendar bursts, not random noise.
- **Retry behaviour** — customers hammer the channel when unanswered.

Diagnosis:

- Plot **arrivals by interval** for representative weeks; overlay known events.
- Compute **CV by interval length** — if CV drops when you lengthen the interval,
  burstiness is within-interval; if it stays high, correlation spans intervals.
- Compare **missed service intervals** to **mean-arrival intervals** — bursts often
  miss when the daily total was correct.

Staffing implication: staffing to the **interval mean** under-serves burst channels.
Options include staffing to a **high percentile** of interval arrivals (measure which
percentile from historical miss data), overlapping shifts at dump times, or pre-positioning
flex capacity — not assuming one more Erlang agent fixes a marketing send.

## Batch arrivals (especially async)

Email, tickets and back-office queues often arrive as **discrete batches**:

- Mailbox imports overnight.
- API retries dumping failed creates.
- Partner file drops.
- Auto-routing releasing held tickets at hour boundaries.

Poisson describes drip; batches are a different process. Symptoms:

- **Zero or near-zero arrivals** then a spike interval.
- **Handle time and arrival time decoupled** — work arrives at 06:00, SLA clock starts
  at business open.
- **Backlog jumps** without a proportional arrival count in customer-facing metrics.

Staffing implication: use **backlog and throughput** models (Little's Law framing) for
steady async work; use ** surge blocks** for known batch times. Erlang C on batch
channels is the wrong tool.

## Abandonment-censored arrivals

In voice and chat, **only contacts who waited appear in handled-arrival counts**. High
abandonment makes the next interval look lighter than demand was — customers left, they
did not disappear.

Failure mode: intraday management cuts staff because "arrivals dropped" after a long
queue; the drop was hang-ups, not resolved demand.

Analysis:

- Compare **offered contacts** (entered queue) to **handled arrivals** by interval.
- Track **abandon rate vs wait time** — if abandonment rises as wait rises, censoring is
  active.
- Reforecast on **offered** volume when making staffing decisions, not handled alone.

Staffing implication: Erlang C without abandonment **over-states** requirement; Erlang A
or simulation with your measured patience distribution is closer — but only if you feed it
uncensored offered load.

## Implications for model choice

| Channel / pattern | Prefer | Avoid |
| --- | --- | --- |
| Voice, low CV, stable patience | Erlang C or A with offered load | Ignoring abandonment when it is material |
| Voice/chat, campaign-driven CV high | Simulation or percentile staffing | Plain Erlang on interval mean |
| Chat with concurrency | Concurrency-adjusted capacity; measure AHT by load | Raw Erlang C |
| Async drip | Backlog + throughput target | Erlang |
| Async batch | Scheduled surge capacity + backlog model | Flat hourly staffing from daily total |
| Multi-skill routing | Pool simulation or consolidated planning | Single-queue Erlang on fragmented pools |

When in doubt, **simulate with your empirical arrival trace** for a sample of peak days
rather than debating formula elegance.

## Traps

- **Testing Poisson on daily totals** — burstiness hides in aggregation.
- **Using handled contacts as λ** in Erlang when abandonment is non-trivial.
- **One interval length for analysis and another for scheduling** — mismatch invalidates
  the test.
- **Treating marketing calendar as noise** — it is the burst generator; model it explicitly.
- **Assuming batch async is "low priority"** — SLA clocks still run; backlog compounds.

## Present results to the user

1. **Arrival profile by channel and interval** — mean, variance, CV — with charts or
   tables for representative periods.
2. **Poisson verdict per queue** — where it holds, where it fails, and which intervals
   drive the failure.
3. **Burst and batch catalogue** — named sources (campaigns, imports, billing) tied to
   clock time.
4. **Censoring assessment** — offered vs handled gap where abandonment matters.
5. **Staffing model recommendation** — Erlang, percentile, simulation, backlog — per
   channel with assumption list.
6. **Known limitations** — data you did not have (offered vs handled, event calendar gaps)
   and what to collect next.
