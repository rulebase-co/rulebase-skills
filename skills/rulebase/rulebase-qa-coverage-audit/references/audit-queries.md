# Audit query patterns

Shapes to adapt, not to paste. Build the actual field names from
`get_workspace_schema` — the names below are illustrative and will differ by
workspace version and plan.

## Tool selection

| Need | Approach |
| --- | --- |
| Aggregates, correlations, distributions | `query_workspace_data` |
| Scorecard structure and criteria | `list_scorecards`, `get_scorecard` |
| Roster, teams, tenure | `list_employees`, `get_employee` |
| Pre-built performance rollups | `get_qa_performance_summary`, `get_team_performance` |
| SLA outcomes | `get_sla_performance_summary` |
| Complaint outcomes | `list_complaints`, `search_complaints` |
| A specific conversation for context | `get_conversation` |

Reach for the summary tools first when they answer the question directly — they
are cheaper and already reconcile with what the user sees in the product UI. Drop
to `query_workspace_data` when you need a cut the summaries do not offer.

**If your numbers disagree with a summary tool, investigate before reporting.**
A mismatch usually means your eligibility filter differs from the product's, and
presenting a figure that contradicts the dashboard without explaining why destroys
trust in the whole audit.

## Coverage by segment

```sql
-- Coverage by channel. Repeat with team, agent, month, intent.
SELECT c.channel,
       count(DISTINCT c.id)                                   AS conversations,
       count(DISTINCT e.conversation_id)                      AS evaluated,
       round(100.0 * count(DISTINCT e.conversation_id)
             / nullif(count(DISTINCT c.id), 0), 1)            AS coverage_pct
FROM conversations c
LEFT JOIN qa_evaluations e ON e.conversation_id = c.id
WHERE c.created_at >= :period_start
  AND c.created_at <  :period_end
  AND c.eligible_for_qa                    -- state this rule explicitly
GROUP BY 1
ORDER BY conversations DESC;
```

`LEFT JOIN` matters: an inner join silently drops zero-coverage segments, which
are the finding.

Zero-coverage segments on their own:

```sql
SELECT c.channel, c.team_id, count(*) AS unevaluated_conversations
FROM conversations c
WHERE NOT EXISTS (SELECT 1 FROM qa_evaluations e WHERE e.conversation_id = c.id)
  AND c.created_at >= :period_start
GROUP BY 1, 2
HAVING count(*) >= 50
ORDER BY 3 DESC;
```

Coverage over time, to catch a programme that stopped:

```sql
SELECT date_trunc('month', c.created_at) AS month,
       count(DISTINCT e.conversation_id) AS evaluated,
       round(100.0 * count(DISTINCT e.conversation_id)
             / nullif(count(DISTINCT c.id), 0), 1) AS coverage_pct
FROM conversations c
LEFT JOIN qa_evaluations e ON e.conversation_id = c.id
WHERE c.created_at >= now() - interval '12 months'
GROUP BY 1 ORDER BY 1;
```

## Evaluations per agent

```sql
SELECT e.agent_id,
       date_trunc('month', e.evaluated_at) AS period,
       count(*)                            AS n_evals,
       avg(e.score)                        AS mean_score
FROM qa_evaluations e
WHERE e.evaluated_at >= now() - interval '6 months'
GROUP BY 1, 2
ORDER BY n_evals ASC;      -- smallest first: these are the invalid scores
```

Then attach the interval. Wilson, because `n` is small and the normal
approximation breaks at the boundary:

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

# wilson(4, 4)  -> (0.51, 1.00)   a perfect score on four evaluations
# wilson(9, 10) -> (0.60, 0.98)
```

Report the distribution of `n`, not just the mean — a workspace averaging 20
evaluations per agent can still have half its agents under 5.

## Distribution health

```sql
SELECT s.name AS scorecard,
       count(*)                                                 AS evals,
       round(avg(e.score), 1)                                   AS mean,
       round(stddev_samp(e.score), 2)                            AS sd,
       percentile_cont(0.25) WITHIN GROUP (ORDER BY e.score)     AS p25,
       percentile_cont(0.50) WITHIN GROUP (ORDER BY e.score)     AS p50,
       percentile_cont(0.75) WITHIN GROUP (ORDER BY e.score)     AS p75,
       count(*) FILTER (WHERE e.score >= 100)                    AS perfect_scores
FROM qa_evaluations e
JOIN scorecards s ON s.id = e.scorecard_id
WHERE e.evaluated_at >= now() - interval '90 days'
GROUP BY 1 ORDER BY evals DESC;
```

`p75 - p25 < 5` is a ceiling effect. A large `perfect_scores` share relative to
`evals` warrants checking whether those evaluations carry criterion-level detail
or were closed without being graded.

## Criterion health

```sql
SELECT s.name AS scorecard,
       r.criterion,
       count(*)                                                          AS graded,
       round(100.0 * count(*) FILTER (WHERE r.verdict = 'not_met')
             / count(*), 2)                                              AS fail_rate_pct
FROM qa_criterion_results r
JOIN qa_evaluations e ON e.id = r.evaluation_id
JOIN scorecards s     ON s.id = e.scorecard_id
WHERE e.evaluated_at >= now() - interval '90 days'
GROUP BY 1, 2
ORDER BY fail_rate_pct ASC;
```

Bottom of this list is dead weight; a criterion at 0% across thousands of
evaluations is ceremony.

## Outcome linkage

```sql
WITH qa AS (
  SELECT agent_id,
         date_trunc('month', evaluated_at) AS period,
         avg(score) AS qa_score,
         count(*)   AS n_evals
  FROM qa_evaluations
  WHERE evaluated_at >= now() - interval '12 months'
  GROUP BY 1, 2
  HAVING count(*) >= 10          -- below this the score is mostly noise
),
outcomes AS (
  SELECT agent_id,
         date_trunc('month', created_at) AS period,
         count(*)                                    AS conversations,
         count(*) FILTER (WHERE complaint_id IS NOT NULL) AS complaints,
         avg(CASE WHEN sla_met THEN 1.0 ELSE 0 END)  AS sla_attainment
  FROM conversations
  GROUP BY 1, 2
)
SELECT corr(q.qa_score, 1.0 * o.complaints / o.conversations) AS r_complaint_rate,
       corr(q.qa_score, o.sla_attainment)                     AS r_sla,
       count(*)                                               AS agent_months,
       count(DISTINCT q.agent_id)                              AS agents
FROM qa q JOIN outcomes o USING (agent_id, period);
```

Report `agent_months` and `agents` alongside every correlation. A correlation over
40 agent-months is suggestive; over 6 it is an anecdote with a decimal point.

Expected: `r_complaint_rate` negative, `r_sla` positive. A correlation in the wrong
direction is worth chasing rather than reporting flatly — it often means the rubric
rewards process compliance that slows resolution.

## Coaching loop closure

```sql
WITH low AS (
  SELECT id, agent_id, evaluated_at
  FROM qa_evaluations
  WHERE score < :coaching_threshold
    AND evaluated_at >= now() - interval '6 months'
)
SELECT count(*)                                                    AS low_evals,
       count(cs.id)                                                AS with_coaching,
       round(100.0 * count(cs.id) / nullif(count(*), 0), 1)         AS followed_up_pct,
       percentile_cont(0.5) WITHIN GROUP (
         ORDER BY extract(epoch FROM cs.created_at - low.evaluated_at) / 86400
       )                                                            AS median_lag_days
FROM low
LEFT JOIN coaching_sessions cs
       ON cs.agent_id = low.agent_id
      AND cs.created_at BETWEEN low.evaluated_at AND low.evaluated_at + interval '30 days';
```

The join is approximate — it attributes any coaching session in the window to the
low score, so it is an upper bound on follow-through. Say so when reporting.

## Reconciliation checks

Before presenting anything, sanity-check against the product:

- Total evaluations for a period against `get_qa_performance_summary`.
- Agent-level means against `get_team_performance`.
- SLA attainment against `get_sla_performance_summary`.

Differences are usually eligibility-filter differences, not bugs. Find the cause
and state the filter you used, rather than reporting a number that silently
contradicts the dashboard the user looks at every day.
