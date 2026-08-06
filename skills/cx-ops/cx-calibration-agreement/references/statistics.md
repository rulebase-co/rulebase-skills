# Input shape, formulas, and how to read the numbers

## Input

JSONL or a JSON array, one record per graded item. Two graders.

```jsonl
{"id":"5982225","rater_a":"met","rater_b":"met","criterion":"resolution","channel":"email"}
{"id":"5982226","rater_a":"met","rater_b":"partial","criterion":"resolution","channel":"voice"}
{"id":"5982227","rater_a":"not_met","rater_b":"not_met","criterion":"tone","channel":"chat"}
```

| Field | Required | Meaning |
| --- | --- | --- |
| `id` | yes | Item identifier. |
| `rater_a`, `rater_b` | yes | The two verdicts. Any labels; declare their order with `--ordinal` if they are ordered. |
| `criterion` | no | Enables the per-criterion breakdown, which is where the actionable findings are. |
| anything else | no | Usable as a segmentation via `--by <field>`. |

Rename the raters for readable output with `--label-a "AI" --label-b "human review"`.

Items where either verdict is missing are excluded and counted, not imputed.

## Ordinal verdicts

Pass `--ordinal not_met,partial,met` in increasing order of favourability. This
enables two things:

- **Weighted agreement.** `--weights linear` (default when ordinal) or `quadratic`.
  A met/partial disagreement counts as a partial agreement rather than a total
  failure, which is the honest treatment for an ordered scale.
- **Direction of severity.** With an order declared, the script can say *which*
  grader was harsher on each disagreement, which is what separates bias from noise.

Without `--ordinal`, verdicts are treated as unordered categories: agreement is
computed, but no severity direction is available.

## Formulas

Let `O` be the confusion matrix over `q` categories, `N` the item count, `r_i` and
`c_j` the row and column marginals, and `w_ij` the agreement weight (`1` on the
diagonal, `0` off it when unweighted).

**Observed agreement**

```
p_o = Σ_ij w_ij · O_ij / N
```

**Cohen's κ** — chance agreement from the product of the two graders' own marginals:

```
p_e(κ) = Σ_ij w_ij · (r_i/N) · (c_j/N)
κ      = (p_o − p_e) / (1 − p_e)
```

**Gwet's AC1** — chance agreement from the average marginal across graders, which
does not blow up under extreme prevalence:

```
π_k    = ((r_k/N) + (c_k/N)) / 2
p_e(AC1) = (1/(q−1)) · Σ_k π_k · (1 − π_k)
AC1    = (p_o − p_e) / (1 − p_e)
```

For binary verdicts this reduces to `p_e = 2·π₁·(1−π₁)`.

**Weighted variants** use the same `w_ij` in both `p_o` and `p_e`.

**Confidence intervals** come from a nonparametric bootstrap over items (seeded, so
reruns are identical). Analytic standard errors for κ exist but are unreliable at the
prevalences and sample sizes QA calibration actually uses.

**Disagreement asymmetry** — among the `d` disagreements, `a_harsher` counts items
where A's verdict is lower on the ordinal scale. Under pure noise this is
`Binomial(d, 0.5)`; the reported p-value is the exact two-sided binomial test. A
small p-value means systematic severity, not ambiguity.

## Reading the combination

Never read one statistic alone. The pattern across all four is the diagnosis:

| p_o | κ | AC1 | Marginal gap | Reading |
| --- | --- | --- | --- | --- |
| high | high | high | small | Working. Ship and monitor. |
| high | **negative or near 0** | high | small | Kappa paradox. Agreement is real; the criterion almost never fails. A scorecard-design finding, not an agreement problem. |
| high | low | low | **large** | Bias. They rank alike but one threshold is harsher. Recalibrate the threshold; rewriting the criterion will not help. |
| low | low | low | small | Noise. Ambiguous criterion. Rewrite it as an observable decision rule. |
| low | low | low | large | Both. Fix the criterion first, then re-measure before touching thresholds. |

Rough bands for AC1 and for κ **when prevalence is moderate**: above 0.80 strong,
0.70–0.80 usable, 0.40–0.70 weak, below 0.40 broken. Do not apply these bands to κ
when a category exceeds ~85% — that is the paradox condition, and the number is
uninterpretable rather than bad.

## Why per-criterion and per-segment matter more than the total

The aggregate figure across all criteria is nearly useless: it averages a handful of
badly specified criteria into a majority of trivially agreeable ones. A programme with
overall AC1 of 0.85 and two criteria at 0.3 has two criteria to rewrite, and the
aggregate hides both.

The same applies to segments. Materially different agreement by channel, language or
market means the instrument varies in reliability across the people it scores, so
their scores are not comparable — and that conclusion outranks the headline number.

## What this does not do

- **Three or more graders.** This handles exactly two. For a panel, use Fleiss' κ or
  Krippendorff's α, and note that α also handles missing verdicts and mixed grader
  counts.
- **Distinguish who is right.** Agreement is symmetric. If one grader is the
  reference standard, that is a validation question — accuracy against a known
  answer — not an agreement question, and it needs a defined ground truth.
- **Fix selection bias.** If items entered the sample non-randomly, no statistic here
  repairs that. Report how they entered.
