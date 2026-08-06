# Queueing models and forecast method

The formulas behind the staffing script, and the arithmetic worth being able to
check by hand.

## Offered load

Everything starts here. Load is dimensionless, measured in **erlangs**:

```
λ  = contacts / interval_seconds        (arrival rate)
A  = λ × AHT_seconds                    (offered load, erlangs)
```

A is the average number of agents busy at any instant if nobody ever waited. It
is a lower bound on staffing: `N ≤ A` means an unstable queue where waits grow
without bound.

Worked example — 250 contacts per 30 minutes, AHT 300s:

```
λ = 250 / 1800   = 0.1389 contacts/second
A = 0.1389 × 300 = 41.67 erlangs
```

So 42 agents is the theoretical floor and delivers terrible service. Real
staffing for 80/20 is 48.

## Erlang B

The probability a contact is blocked when there is no queue. Needed as an
intermediate for Erlang C.

The textbook form overflows:

```
B(N, A) = (A^N / N!) / Σ(k=0..N) A^k / k!
```

`A^N` and `N!` both exceed float range well before realistic contact-centre
sizes. Use the recurrence instead, which is exact and stable:

```
B(0, A) = 1
B(n, A) = A·B(n−1, A) / (n + A·B(n−1, A))
```

```javascript
function erlangB(agents, load) {
  let b = 1;
  for (let n = 1; n <= agents; n++) b = (load * b) / (n + load * b);
  return b;
}
```

## Erlang C

The probability a contact waits at all — the queue has no blocking, so waiting
replaces being turned away.

```
C(N, A) = B(N, A) / (1 − (A/N)·(1 − B(N, A)))
```

Undefined for `N ≤ A`; treat that case as `C = 1`.

## Service level and ASA

Fraction answered within `t` seconds:

```
SL(t) = 1 − C(N, A) · e^(−(N − A)·t / AHT)
```

Average speed of answer across all contacts, including the ones that never queue:

```
ASA = C(N, A) · AHT / (N − A)
```

Occupancy:

```
occupancy = A / N
```

### Verified worked example

A = 41.67 erlangs, AHT 300s, 20s target:

| N | SL(20s) | P(wait) | ASA | Occupancy |
| --- | --- | --- | --- | --- |
| 43 | 29.2% | 77.4% | 116s | 96.9% |
| 44 | 46.0% | 63.1% | 81s | 94.7% |
| 45 | 59.2% | 51.0% | 46s | 92.6% |
| 46 | 69.5% | 40.7% | 28s | 90.6% |
| 47 | 77.4% | 32.2% | 18s | 88.7% |
| **48** | **83.5%** | **25.2%** | **12s** | **86.8%** |
| 49 | 88.1% | 19.5% | 8s | 85.0% |
| 50 | 91.5% | 15.2% | 5s | 83.3% |

Two things this table teaches better than any prose:

- **The curve is steep near the target.** Agent 47→48 buys 6 points of service
  level. Agent 50→51 buys 2.5. Marginal value collapses quickly.
- **The service-level answer conflicts with the occupancy constraint.** 48 agents
  hits 80/20 but at 86.8% occupancy, above the sustainable ceiling. The honest
  answer is 49–50, and the reason is staff retention rather than queueing.

## Shrinkage

Erlang returns *productive* agents — bodies available to take contacts. Rostered
headcount:

```
rostered = ceil(productive / (1 − shrinkage))
```

At 30% shrinkage, 48 productive → **69 rostered**. Components to account for:

| Category | Typical |
| --- | --- |
| Annual leave | 8–12% |
| Sickness | 3–6% |
| Breaks | 8–10% |
| Training and coaching | 3–8% |
| Meetings, 1:1s | 2–4% |
| System downtime, admin | 1–3% |

Measure your own rather than adopting a benchmark; the total varies widely by
region and contract. What does not vary is that omitting it understates headcount
by roughly 40%.

## Erlang A (abandonment)

Erlang C assumes infinite patience, which is why it over-staffs. Erlang A adds an
abandonment rate parameterised by average patience, and typically reduces the
requirement by 5–15% at long waits.

It needs a patience estimate, which you get from your own abandonment curve:
abandons as a function of wait time. If you have that data, Erlang A is a better
model. If you do not, Erlang C plus the knowledge that it over-states is a
defensible position — just do not present its output as precise.

## Little's Law, for async channels

Email and tickets have no answer-time queue. The governing relation is:

```
L = λ · W
```

where `L` is work in progress, `λ` the arrival rate, `W` the average time in
system. Rearranged for staffing:

```
work_per_second   = λ × AHT
productive_agents = ceil(work_per_second)
rostered          = ceil(productive_agents / (1 − shrinkage))
```

Two properties that matter more than the arithmetic:

- **Throughput must exceed arrivals.** If it does not, the backlog grows without
  bound and no turnaround promise is achievable at any queue discipline. Check
  this before anything else.
- **Steady state ≠ recovery.** These figures hold a stable backlog. Clearing an
  existing one needs capacity above steady state, and how much depends on how far
  behind you are and how fast you want to catch up.

## Chat and concurrency

Erlang C assumes one contact per agent. For chat at concurrency `c`, the common
approximation divides load:

```
A_effective = (λ × AHT) / c
```

This is optimistic, because **AHT per conversation rises with concurrency**. An
agent at 3 concurrent chats is slower on each than at 1 — context switching,
split attention, waiting on multiple customers. The relationship is non-linear
and specific to your team, tooling, and contact mix.

Measure it: compute AHT grouped by the observed concurrency at the time each
conversation was handled. If AHT at c=3 is 1.6× AHT at c=1, the effective
capacity gain is roughly 3/1.6 ≈ 1.9×, not 3×. Using the nominal 3× overstates
capacity by more than 50%.

For high or variable concurrency, discrete-event simulation is the honest tool;
no closed form captures it.

## Forecast accuracy

```
WAPE = Σ|actual − forecast| / Σ actual
```

Prefer WAPE to MAPE for interval-level support forecasting. MAPE's per-interval
division blows up on low-volume intervals, which dominate an intraday series and
make the metric unusable.

Always report error against the **seasonal naive** baseline (same weekday, same
interval, last week). A model that does not beat it should not be deployed —
seasonal naive has no maintenance cost, no training pipeline, and no failure
modes anyone has to debug at 3am.

Track error by interval-of-day as well as in aggregate. A model with good overall
WAPE that is systematically wrong at the morning peak is worse for staffing than
one with slightly worse WAPE and unbiased peaks.
