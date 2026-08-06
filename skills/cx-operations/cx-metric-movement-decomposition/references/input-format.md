# Input format and choosing a segmentation

## Shape

One JSON array, one object per segment. Each carries both periods.

```json
[
  { "segment": "email", "n0": 1500, "r0": 0.910, "n1": 1300, "r1": 0.915 },
  { "segment": "chat",  "n0": 800,  "r0": 0.880, "n1": 900,  "r1": 0.885 },
  { "segment": "voice", "n0": 200,  "r0": 0.720, "n1": 700,  "r1": 0.725 }
]
```

| Field | Meaning |
| --- | --- |
| `segment` | Segment label. Must be stable across the two periods. |
| `n0`, `n1` | Observations in the baseline and comparison period. |
| `r0`, `r1` | The segment's metric. A proportion in `0..1` for `--metric rate`, any number for `--metric mean`. |
| `k0`, `k1` | Optional. Numerator counts; if present, `r` is computed as `k/n` and any supplied `r` is ignored. |
| `sd0`, `sd1` | Required for `--metric mean`. Per-segment standard deviations, for the noise interval. |

Omit `n0`/`r0` entirely for a segment that did not exist in the baseline period, and
`n1`/`r1` for one that has gone. The script reports these as entrants and exits
rather than folding them into the rate or mix terms.

CSV is accepted with `--format csv` using the same column names in a header row.

## Percentages vs proportions

Pass proportions (`0.91`), not percentages (`91`). The script rejects rate-mode
values above 1 rather than guessing, because silently treating `91` as a proportion
produces a decomposition that is internally consistent and completely wrong.

## Counts, not rates, where you have them

Supply `k0`/`k1` in preference to `r0`/`r1`. Rounded rates reintroduce error into
the decomposition, and the noise interval needs the raw counts anyway. If your
source can give you numerator and denominator, give them.

## Choosing the segmentation

The segmentation determines what "mix" can mean, so it is the analytical choice in
this method, not a formatting detail.

**Segment on something structural** — a dimension with a genuinely different
baseline that volume can shift between. In CX the ones that usually pay:

- **Channel** (email / chat / voice / messaging). Almost always has the widest
  baseline spread, which makes it the first segmentation to run.
- **Queue or contact reason.** Captures "the work got harder", which is the most
  common real cause of a mix effect.
- **Team, site, or outsourcer.**
- **Agent tenure band.** Captures a hiring wave, which mix effects otherwise hide
  inside "team".
- **Market or language**, where these have different baselines.

**Do not segment on:**

- **The metric's own components.** Decomposing a QA score by criterion is a
  different and legitimate analysis, but it is not a mix decomposition — criteria
  are not volume shares.
- **A dimension that was redefined between the periods.** Reorganised teams are not
  the same segments; the decomposition will report a large mix effect that is really
  a relabelling.
- **Anything with more than ~15 levels**, unless volumes are large. Read the top
  contributors and group the tail into `other`, but keep `other` in the input so the
  totals still reconcile.

**Run several segmentations separately** rather than crossing them. Channel × team ×
tenure produces cells too small to interpret and a mix term dominated by sampling
noise. Each single segmentation answers a different question, and the one with the
largest mix effect is usually the story.

## Worked example

Using the three segments above:

- `R₀ = (1500·0.910 + 800·0.880 + 200·0.720) / 2500 = 2213 / 2500 = 0.8852`
- `R₁ = (1300·0.915 + 900·0.885 + 700·0.725) / 2900 = 2493.5 / 2900 = 0.8598`
- `ΔR = −0.0254`, a 2.54-point fall.

**Every single segment improved** — email 91.0 → 91.5, chat 88.0 → 88.5, voice 72.0
→ 72.5 — and the aggregate fell by two and a half points.

The decomposition says why. Because every segment moved by the same `+0.005`, and
the average weights sum to 1, the rate effect is exactly `+0.005`:

| Channel | rate effect | mix effect |
| --- | --- | --- |
| email | +0.0022 | −0.1384 |
| chat | +0.0016 | −0.0085 |
| voice | +0.0012 | +0.1166 |
| **total** | **+0.0050** | **−0.0304** |

`+0.0050 + (−0.0304) = −0.0254 = ΔR`, exactly.

Voice went from 8% of the mix to 24%. It scores 19 points below email, so tripling
its share drags the aggregate down three points on its own, and a uniform
half-point improvement everywhere recovers only half a point of that.

The correct finding is **"we moved volume into voice"** — a capacity or routing
decision — not "quality declined". Anyone who answered this by naming voice as the
worst-performing channel would have identified the right segment for entirely the
wrong reason, and the remedy they proposed (coach the voice team) would not have
moved the number.

This is the shape of a large share of real QA score movements, and it is why "the
lowest-scoring team is X" is usually not an answer to "why did the score change".
