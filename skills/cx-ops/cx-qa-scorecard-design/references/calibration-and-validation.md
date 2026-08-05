# Calibration, sample size, and validation

The measurement mechanics behind the scorecard. Three questions: how many
evaluations do I need, do my graders agree, and does the score predict anything.

## Sample size

For a pass rate `p` estimated from `n` independent evaluations, the normal
approximation gives a 95% interval of `±1.96 * sqrt(p(1-p)/n)`:

| n per agent per period | ±95% CI at p=0.90 | ±95% CI at p=0.80 |
| --- | --- | --- |
| 4 | ±29 pp | ±39 pp |
| 5 | ±26 pp | ±35 pp |
| 10 | ±19 pp | ±25 pp |
| 25 | ±12 pp | ±16 pp |
| 50 | ±8 pp | ±11 pp |
| 100 | ±6 pp | ±8 pp |

At small `n` the normal approximation is optimistic and breaks entirely at the
boundary. Use a Wilson score interval, which is asymmetric and honest:

| Observed | Wilson 95% interval | Width |
| --- | --- | --- |
| 4/4 (100%) | 51% – 100% | 49 pp |
| 3/4 (75%) | 30% – 95% | 65 pp |
| 9/10 (90%) | 60% – 98% | 39 pp |
| 18/20 (90%) | 70% – 97% | 27 pp |

**An agent who scored perfectly on four evaluations has a true pass rate that
could be 51%.** This is the number to put in front of anyone who wants to rank or
gate on a monthly QA score built from a handful of samples.

```python
import math

def wilson(k, n, z=1.96):
    """95% CI for k passes out of n evaluations."""
    if n == 0:
        return (0.0, 1.0)
    p = k / n
    d = 1 + z * z / n
    centre = (p + z * z / (2 * n)) / d
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return (max(0.0, centre - half), min(1.0, centre + half))
```

Two caveats that make real intervals wider still:

- **Evaluations are not independent.** Several conversations from one agent in one
  week share a mood, a shift, a queue mix. Effective `n` is below nominal `n`.
- **Grader variance is not in the interval above.** It only covers sampling error.
  If κ is 0.6, a meaningful share of the observed variance is grader disagreement.

## Sampling strata

Run two strata and report them separately. Collapsing them is a common and
serious error, because risk-weighted sampling deliberately over-selects bad
conversations.

| Stratum | Selection | Used for | Never used for |
| --- | --- | --- | --- |
| Random | Uniform over eligible conversations | Estimating quality rate, trending, agent comparison | Efficient breach detection |
| Risk-weighted | DSAT, reopened, long duration, refund/chargeback, vulnerability or complaint signals, low-confidence bot handoffs | Finding breaches, coaching material, incident detection | Reporting the overall pass rate |

Define eligibility explicitly. Excluding spam, auto-closed, and no-response
tickets is legitimate; excluding transfers or short conversations quietly removes
the cases most likely to have failed.

## Calibration

**Gold set.** 20–30 conversations, spanning channels, intents, and outcomes, with
a deliberate mix of clear passes, clear fails, and genuinely ambiguous cases. The
ambiguous ones are what surface bad criteria. Refresh it quarterly; a memorised
gold set stops measuring anything.

**Procedure.** Graders score the gold set independently, with no discussion.
Compute agreement per criterion. Then discuss only the criteria that scored
poorly, and rewrite the criterion rather than instructing graders to try harder.

**Statistic.** Never use raw percentage agreement — with a 95% pass rate, two
random graders agree about 90% of the time. Use a chance-corrected measure:

| Situation | Statistic |
| --- | --- |
| Two graders, binary or nominal verdicts | Cohen's κ |
| Three or more graders, fixed set | Fleiss' κ |
| Ordinal verdicts (met / partial / not met) | Weighted κ or Krippendorff's α |
| Missing values, mixed grader counts | Krippendorff's α |

Cohen's κ:

```
κ = (p_o - p_e) / (1 - p_e)
```

where `p_o` is observed agreement and `p_e` is agreement expected by chance from
the graders' marginal rates.

| κ | Reading | Action |
| --- | --- | --- |
| > 0.80 | Strong | Ship |
| 0.70 – 0.80 | Usable | Ship, monitor |
| 0.40 – 0.70 | Weak | Rewrite the criterion as a decision rule |
| < 0.40 | Broken | Cut the criterion, or make it observable |

**A low κ is a property of the criterion, not the graders.** Interpret it as a
specification bug.

**Cadence.** Calibrate before launch, again 4 weeks in, then monthly or quarterly.
Recalibrate whenever the rubric changes, a new grader joins, or a new channel is
added — and always after switching to or upgrading an AI grader.

## Validation

Four to eight weeks after launch, test the instrument against the outcomes named
in Step 2. Aggregate to agent-period level first; conversation-level correlations
are dominated by noise.

**Does the score predict the outcome?**

```sql
-- Agent-month QA score against repeat-contact rate.
WITH qa AS (
  SELECT agent_id, date_trunc('month', evaluated_at) AS period,
         avg(score) AS qa_score, count(*) AS n_evals
  FROM qa_evaluations
  GROUP BY 1, 2
  HAVING count(*) >= 10          -- below this the score is mostly noise
),
outcomes AS (
  SELECT agent_id, date_trunc('month', created_at) AS period,
         avg(CASE WHEN repeat_within_7d THEN 1.0 ELSE 0 END) AS repeat_rate,
         avg(CASE WHEN csat_score IS NOT NULL THEN csat_score END) AS csat
  FROM conversations
  GROUP BY 1, 2
)
SELECT corr(qa.qa_score, o.repeat_rate) AS r_repeat,
       corr(qa.qa_score, o.csat)        AS r_csat,
       count(*)                         AS agent_months
FROM qa JOIN outcomes USING (agent_id, period);
```

Interpretation, for agent-month aggregates:

- `r_csat` positive and `r_repeat` negative is the expected direction.
- |r| below about 0.2 means the scorecard is not tracking the outcome. Check
  whether individual criteria correlate before rebuilding the whole instrument —
  usually two or three carry all the signal and the rest are ceremony.
- A *positive* correlation with repeat contact is a red flag worth chasing: it
  often means the rubric rewards process compliance that slows resolution.

**Does the score discriminate?**

```sql
SELECT count(*)                                       AS evals,
       avg(score)                                     AS mean,
       stddev_samp(score)                             AS sd,
       percentile_cont(0.25) WITHIN GROUP (ORDER BY score) AS p25,
       percentile_cont(0.75) WITHIN GROUP (ORDER BY score) AS p75
FROM qa_evaluations
WHERE evaluated_at >= now() - interval '90 days';
```

An interquartile range under about 5 points is a ceiling effect: the scorecard
cannot distinguish anyone from anyone, and no amount of coaching will show up in
it.

**Which criteria are dead weight?**

```sql
SELECT criterion,
       count(*)                                             AS graded,
       avg(CASE WHEN verdict = 'not_met' THEN 1.0 ELSE 0 END) AS fail_rate
FROM qa_criterion_results
GROUP BY 1 ORDER BY fail_rate;
```

Criteria with a fail rate under ~2% carry almost no information. Either promote
them to auto-fail, where rarity is the point, or cut them and give the attention
back to criteria that vary.

## Review triggers

Rebuild rather than tweak when:

- Correlation with named outcomes is near zero after a full validation window.
- κ stays below 0.4 on a criterion after one rewrite.
- The IQR has collapsed below 5 points for two consecutive quarters.
- Channel mix has shifted materially — a rubric built for email rarely survives
  contact with chat or voice unchanged.
