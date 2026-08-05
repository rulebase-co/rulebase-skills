# Response bias and sampling method

The statistics behind the diagnostic, and how to interpret them without
overclaiming.

## Two different uncertainties

| Uncertainty | Shrinks with sample size? | Fix |
| --- | --- | --- |
| **Sampling error** — your sample happened to differ | Yes, as 1/√n | Collect more responses |
| **Non-response bias** — responders differ systematically | **No** | Change who responds, or weight |

This is the distinction that matters. A 12% response rate on 50,000 contacts gives
6,000 responses and a very tight confidence interval around a number that may be
several points from the truth. Precision and accuracy are not the same thing, and
survey dashboards only ever show you precision.

## Standardised mean difference

For a numeric covariate, compare respondents (group A) and non-respondents
(group B):

```
SMD = (mean_A − mean_B) / √((var_A + var_B) / 2)
```

Scale-free, so a covariate in seconds and one in message counts are comparable
against a single threshold.

| |SMD| | Reading |
| --- | --- |
| < 0.1 | Balanced by convention |
| 0.1 – 0.25 | Meaningful imbalance |
| > 0.25 | Substantial; segment-level conclusions are unsafe |

```javascript
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

function variance(xs) {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1);
}

function smd(a, b) {
  const pooled = Math.sqrt((variance(a) + variance(b)) / 2);
  return pooled === 0 ? 0 : (mean(a) - mean(b)) / pooled;
}
```

For categorical covariates the interpretable form is **response rate per level**.
"Email responds at 51%, chat at 7.5%" tells you immediately that your CSAT is
substantially an email metric. A 10-percentage-point shift in composition is the
rough categorical analogue of the 0.1 SMD threshold.

## Covariates worth testing

Anything observable for respondents *and* non-respondents:

| Covariate | Why it matters |
| --- | --- |
| Channel | The largest driver of response rate differences |
| Handle time / message count | Proxies for complexity; long contacts respond differently |
| Repeat contact | Customers still unresolved respond differently |
| Agent / team | Detects solicitation influence |
| Resolution outcome | Granted vs refused requests |
| Customer tenure, plan, value | Detects a skew toward engaged customers |
| Language, region | Response propensity varies culturally |
| Time of day, day of week | Interacts with channel and staffing |

Sentiment is the one covariate you can never test, because it is only observed for
respondents. That gap is structural and no amount of covariate balance closes it.

## The bimodality signature

A self-selected support survey typically produces a **U-shaped** distribution:
delighted customers and furious customers respond, and the indifferent middle —
usually most of them — does not.

Consequences:

- **The mean is a poor summary.** It sits in a valley where few actual responses
  are, and it moves with the ratio of the two peaks rather than with any central
  tendency.
- **Top-box and bottom-box rates are better**, and the bottom-box rate is usually
  the more actionable of the two.
- **A rising mean can mean fewer angry responders**, not more satisfied customers.
  Always look at both tails.

When more than ~70% of responses sit at the scale extremes, report the
distribution and drop the mean.

## Weighting, when balance fails

If a covariate is imbalanced, post-stratification weighting can partially correct
it. Weight each respondent by the inverse of the response rate in their stratum:

```
weight(stratum) = contacts(stratum) / respondents(stratum)
weighted rate   = Σ (weight · positive) / Σ weight
```

Three honest caveats:

1. It only corrects the covariates you weight on. Unobserved drivers — including
   sentiment — are untouched.
2. Small strata get large weights, so a handful of respondents can dominate.
   Suppress strata below ~30 respondents rather than weighting them heavily.
3. Weighting widens the effective confidence interval. Report that it did.

Weighting is an improvement, not a fix. Fixing solicitation and raising response
rate beats weighting every time.

## Confidence intervals

Normal approximation for a proportion:

```
±1.96 · √(p(1−p)/n)
```

| n | ±95% CI at p = 0.85 | ±95% CI at p = 0.60 |
| --- | --- | --- |
| 30 | ±12.8 pp | ±17.5 pp |
| 100 | ±7.0 pp | ±9.6 pp |
| 400 | ±3.5 pp | ±4.8 pp |
| 1,000 | ±2.2 pp | ±3.0 pp |

Near the boundary — a top-box rate of 0.95, say — use Wilson instead; the normal
approximation produces intervals that extend past 1.

```python
import math

def wilson(k, n, z=1.96):
    if n == 0:
        return (0.0, 1.0)
    p = k / n
    d = 1 + z * z / n
    centre = (p + z * z / (2 * n)) / d
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return (max(0.0, centre - half), min(1.0, centre + half))
```

Two adjustments that widen real intervals further:

- **Responses are not independent.** One customer surveyed repeatedly, or a batch
  of contacts about the same incident, share variance. Effective `n` is below
  nominal `n`.
- **The interval covers sampling error only.** It says nothing about the bias
  measured above.

## Raising response rate

In rough order of effect:

1. **Ask on the interaction channel.** In-channel beats email by a wide margin.
2. **Ask one question.** Every additional field costs responses.
3. **Ask promptly.** Response propensity decays quickly after the interaction.
4. **Cap frequency.** Repeatedly surveyed customers stop answering entirely.
5. **Close the loop visibly.** "You told us X, we changed Y" is the only durable
   lever, and it is the one nobody does.

Do not incentivise responses. Incentives change *who* answers and *how*, replacing
one bias with a less predictable one.

## Companion metrics

A survey score should never be the only quality measure, because it inherits every
problem above. Pair it with metrics computed over **all** contacts:

| Metric | Why |
| --- | --- |
| Repeat contact rate within 7 days | Behavioural, unbiased, no response needed |
| Reopen / escalation rate | Same |
| Time to final resolution | Same |
| Complaint rate | Same |

These are measured on everyone. When they disagree with the survey score, believe
them — they have no response bias.
