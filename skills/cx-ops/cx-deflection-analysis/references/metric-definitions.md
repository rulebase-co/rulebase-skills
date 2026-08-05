# Metric definitions and SQL

Precise definitions, edge cases, and a warehouse implementation for teams
computing this outside the script.

## Definitions

Let a **bot session** be one continuous automated interaction with one customer.

```
handoff    := escalated to a human within the session
leaked     := not handoff AND ∃ human contact from the same customer
              where session.ended_at < contact.started_at
                ≤ session.ended_at + window
abandoned  := not handoff AND not leaked AND resolved = false
contained  := not handoff AND not leaked AND resolved = true
unknown    := not handoff AND not leaked AND resolved IS NULL
```

```
naive containment  = (total − handoff) / total
true containment   = contained / total
overstatement (pp) = ((total − handoff) − contained) / total × 100
leak rate          = leaked / total
abandon rate       = abandoned / total
```

`unknown` exists so that missing resolution data is visible rather than silently
folded into either success or failure. When `unknown > 0`, true containment is a
floor: the real value lies between `contained` and `contained + unknown`.

## Edge cases

**The handoff's own human contact.** A handed-off session produces a human contact
almost immediately. It must not also count as leakage. Two guards: classify
`handoff` first and exclusively, and only consider human contacts starting strictly
after `ended_at`.

**Missing `ended_at`.** Fall back to `started_at`. This makes leak detection
slightly more aggressive, since a human contact during the session now looks like a
return. Populate `ended_at` for bot sessions where you can.

**Multiple bot sessions before one human contact.** A customer who tries the bot
three times and then calls produces three sessions and one human contact. All
three are leaked under these definitions. That is intended — each session failed
to resolve — but it means leaked sessions can exceed leaked customers. Report both
if the distinction matters, and use the per-customer form for cost work.

**Repeat bot contacts.** A customer returning to the bot on the same intent is
also a failure signal, but it is not leakage and does not belong in the four
buckets. Track it as a separate rate.

**Sessions with no customer identity.** Anonymous pre-auth sessions cannot be
joined to later contacts. Report them as a separate stratum with an explicit note
that their containment is an upper bound. Do not blend them into the main figure.

**Bot sessions where the customer never engaged.** A widget opened and closed with
no customer message is not a support contact. Excluding these tightens the
denominator; document the rule and apply it consistently across periods, because
changing it silently moves the metric.

**Out-of-scope intents.** If the bot is designed to hand off certain intents,
those handoffs are correct behaviour, not failures. Either exclude them from
eligibility or report them separately — otherwise expanding the bot's declared
scope improves the metric with no change in behaviour.

## Identity resolution

Everything here depends on `customer_id` being stable across channels. Common
failure: chat keys on a session cookie, email on address, voice on ANI. Cross-channel
leakage is then invisible and containment is overstated in exactly the way this
analysis exists to detect.

Ranked resolution strategies:

1. Authenticated user id, where the customer is logged in on all channels.
2. Verified email or phone, normalised (lowercase, E.164).
3. Deterministic mapping through a CRM contact record.
4. Probabilistic matching. Usable, but report the match rate and treat unmatched
   sessions as a separate stratum.

Always report the **cross-channel match rate**. If only 60% of bot sessions can be
joined to a customer identity that also appears on human channels, the leak rate
is measured on 60% of the data and the headline needs that caveat attached.

## SQL implementation

Postgres / Snowflake / BigQuery dialect notes are minimal here; adjust interval
syntax as needed.

```sql
WITH contacts AS (
  SELECT id,
         customer_id,
         started_at,
         coalesce(ended_at, started_at) AS ended_at,
         handled_by,
         channel,
         coalesce(handed_off, false)    AS handed_off,
         intent,
         resolved
  FROM support_contacts
  WHERE started_at >= :period_start
    AND started_at <  :period_end
),
bot AS (SELECT * FROM contacts WHERE handled_by = 'bot'),
human AS (SELECT * FROM contacts WHERE handled_by = 'human'),

-- A return is a human contact starting after the bot session ended, inside the
-- window. EXISTS avoids fanning out when a customer has several later contacts.
classified AS (
  SELECT b.id,
         b.intent,
         b.channel,
         b.resolved,
         b.handed_off,
         EXISTS (
           SELECT 1
           FROM human h
           WHERE h.customer_id = b.customer_id
             AND h.started_at >  b.ended_at
             AND h.started_at <= b.ended_at + (:window_days * interval '1 day')
             -- Same-intent variant: uncomment for the lower bound on leakage.
             -- AND h.intent = b.intent
         ) AS returned
  FROM bot b
),
bucketed AS (
  SELECT *,
         CASE
           WHEN handed_off        THEN 'handoff'
           WHEN returned          THEN 'leaked'
           WHEN resolved IS TRUE  THEN 'contained'
           WHEN resolved IS FALSE THEN 'abandoned'
           ELSE 'unknown'
         END AS bucket
  FROM classified
)
SELECT bucket,
       count(*) AS sessions,
       round(100.0 * count(*) / sum(count(*)) OVER (), 1) AS pct
FROM bucketed
GROUP BY bucket
ORDER BY sessions DESC;
```

Headline rates from the same CTE:

```sql
SELECT count(*)                                                        AS total,
       round(100.0 * count(*) FILTER (WHERE bucket <> 'handoff')
             / count(*), 1)                                            AS naive_containment,
       round(100.0 * count(*) FILTER (WHERE bucket = 'contained')
             / count(*), 1)                                            AS true_containment,
       round(100.0 * count(*) FILTER (WHERE bucket IN ('leaked', 'abandoned'))
             / count(*), 1)                                            AS overstatement_pp,
       round(100.0 * count(*) FILTER (WHERE bucket = 'unknown')
             / count(*), 1)                                            AS unclassified_pct
FROM bucketed;
```

By intent, with a floor so small cells are not reported as findings:

```sql
SELECT intent,
       count(*) AS sessions,
       round(100.0 * count(*) FILTER (WHERE bucket <> 'handoff') / count(*), 1) AS naive,
       round(100.0 * count(*) FILTER (WHERE bucket = 'contained') / count(*), 1) AS true_containment,
       round(100.0 * count(*) FILTER (WHERE bucket = 'leaked') / count(*), 1)   AS leak_rate
FROM bucketed
GROUP BY intent
HAVING count(*) >= 30
ORDER BY sessions DESC;
```

Where leaked customers go — the result most likely to change a decision, because
it shows cost moving rather than falling:

```sql
SELECT h.channel AS returned_via, count(*) AS returns
FROM bot b
JOIN human h
  ON h.customer_id = b.customer_id
 AND h.started_at >  b.ended_at
 AND h.started_at <= b.ended_at + (:window_days * interval '1 day')
WHERE NOT b.handed_off
GROUP BY 1 ORDER BY 2 DESC;
```

Note this last query fans out by design — a session with two later contacts
contributes twice. Use it for channel proportions, not for the leak rate.

## Choosing the window empirically

Rather than defaulting to 7 days, plot the gap distribution and find the elbow:

```sql
SELECT width_bucket(
         extract(epoch FROM h.started_at - b.ended_at) / 3600.0,
         0, 336, 48
       ) AS hour_bucket,
       count(*) AS returns
FROM bot b
JOIN human h
  ON h.customer_id = b.customer_id
 AND h.started_at > b.ended_at
 AND h.started_at <= b.ended_at + interval '14 days'
WHERE NOT b.handed_off
GROUP BY 1 ORDER BY 1;
```

Genuine returns cluster early, usually inside 48 hours. Beyond the elbow the
counts flatten into the customer's background contact rate — that flat region is
unrelated contacts, and a window extending into it inflates the leak rate.

## Companion metrics

Containment alone is easy to improve by making escalation harder. Always report
alongside:

| Metric | Why |
| --- | --- |
| Human contacts per active customer per period | The only volume metric immune to channel shifting |
| CSAT / DSAT by bucket | Detects containment bought with experience |
| Time to final resolution, end to end | Catches automation that delays rather than resolves |
| Escalation request rate | Customers asking for a human and not getting one |
| Repeat bot contact rate | Failure the four buckets do not capture |
| Cost per resolved contact, marginal | The number the business case actually needs |
