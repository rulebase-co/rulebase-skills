---
name: cx-data-quality-monitoring
description: Use to detect a support data sync that has silently stopped, degraded or started lying, before a report does. Trigger for "our sync stopped and nobody noticed", "monitor support data quality", "a channel stopped syncing", freshness and volume alerts on helpdesk data, "the dashboard looked fine but the data was stale", or setting up data tests over conversation data.
metadata:
  author: rulebase
  version: "1.0.0"
  archetype: analysis
---

# Monitoring support data quality

The failure this exists to catch: a sync stops, and every dashboard keeps rendering. Charts
still draw, averages still compute, and the only symptom is that the last few days look
quiet — which is indistinguishable from a quiet few days.

Nobody notices for a fortnight, and then a number that was reported to a customer, a board or
a regulator turns out to have been computed on partial data.

**Support data fails partially far more often than it fails completely**, and partial
failures are invisible to a dashboard. One channel stops, one market's integration loses
authorisation, one field stops being populated — the totals dip slightly and everything
still works.

## Monitor per segment, not in aggregate

This is the single most important design decision. A total volume check will not catch one
channel of six going dark, because the dip sits inside normal variation.

Run every check **per source, per channel, per market and per integration**, and alert on the
segment. Aggregate checks catch total outages, which are the ones you would have found anyway.

## The checks, in order of what they catch

**1. Freshness, per segment.** Time since the most recent record. The cheapest and highest-
yield check.

The threshold must respect seasonality: support volume has a strong day-of-week and intraday
pattern, so a flat "no data for 6 hours" alert fires every weekend and every night, and then
gets muted. Set the threshold from the segment's own historical gap distribution for that hour
of that weekday, and hold a per-market holiday calendar.

**2. Volume against a seasonal baseline, per segment.** Not against yesterday. Compare same
weekday, same hour band, over several recent weeks. Alert in **both directions** — a volume
spike is as likely to be a backfill or a duplicate-ingest bug as it is real demand.

**3. Field population rates.** For each field a metric depends on, the share of records where
it is populated. A field that quietly drops from 98% to 40% populated will not error and will
change every metric using it. **This is the check almost nobody has**, and it catches the
class of failure that corrupts numbers rather than stopping them.

**4. Enum drift.** New values appearing in a status, channel or type field. A new value is
either a legitimate configuration change nobody told you about or a mapping bug, and both
need attention before a dashboard buckets it as "other" or drops it.

**5. Referential integrity.** Messages whose conversation id does not resolve; evaluations
pointing at conversations that are gone. Sample the joins rather than assuming they hold
across systems.

**6. Duplicate detection.** The same source id appearing twice, which usually means a
re-ingest without an upsert key.

**7. Distribution shift on the metrics themselves.** Resolution time, message counts per
conversation, agent counts per conversation. A shift here with stable volume points at a
semantic change — someone redefined something, or a new automation started participating in
conversations.

**8. Reconciliation against source counts.** Where the platform reports its own totals,
compare. The most direct evidence of completeness available, and worth more than any inferred
check.

## Distinguish "no data" from "no activity"

The core ambiguity, and the reason freshness alone is not enough.

Resolve it with a **positive heartbeat**: record that the sync *ran* and what it found,
separately from what it wrote. A run that completed and returned zero records is healthy on a
quiet Sunday; a run that did not happen is not, and both look identical if you only watch the
data.

So monitor the pipeline and the data as two things:

- **Pipeline**: did the run happen, did it complete, how long did it take, how many API errors,
  how much was throttled.
- **Data**: freshness, volume, population, distributions.

A run whose duration halves is a strong early signal — it usually means it processed far less
than usual, and it will show up here before the volume check trips.

## Authorisation expiry, which is the most common real cause

OAuth tokens expire, credentials get rotated, an admin removes an integration user, a scope
gets narrowed. The result is a sync that runs, returns fewer records or none, and logs a 401
somewhere nobody reads.

**Monitor auth explicitly**: a cheap authenticated call per integration, per run, with its own
alert. And monitor **scope**, since a narrowed scope produces a partial export with no error
at all — compare the set of accessible inboxes, queues or channels against the expected set on
every run, and alert on a change.

## Make the alerts survivable

An alert nobody reads is a monitor that does not exist:

- **Forecast the firing rate before deploying**, from historical data. Same discipline as any
  other monitor.
- **Route to an owner**, not a channel.
- **Group correlated alerts.** One integration outage should be one alert, not nine.
- **Suppress during known maintenance**, and alert if maintenance runs long.
- **Review the alerts periodically** and retire the ones nobody acts on.

## Surface data health where the data is consumed

The most valuable output is not the alert. It is that **a dashboard shows when its data was
last complete**, so the reader can tell. A freshness and completeness indicator on the report
itself prevents the specific failure this skill is about — someone acting on partial data
without knowing it is partial.

Where a segment is known incomplete, the honest behaviour is to mark it on the chart rather
than render it as if it were whole.

## Present results to the user

1. **The segment grid** — source × channel × market × integration — since aggregate checks
   miss partial failures.
2. **Freshness thresholds derived from each segment's own seasonal gap distribution**, with the
   holiday calendars used.
3. **Volume baselines**, seasonal, alerting in both directions.
4. **Field population rates** for every field a metric depends on, with the alert threshold.
   The check that catches corrupted numbers rather than stopped pipelines.
5. **Enum drift, integrity, duplicates and distribution shift**, with what each would catch.
6. **Source-count reconciliation**, where the platform exposes its own totals.
7. **The pipeline heartbeat**, separate from the data checks, including run duration.
8. **Auth and scope monitoring per integration** — the most common real cause.
9. **Alert volume forecast, owner and grouping**, so the monitors survive.
10. **The data-health indicator on the reports themselves**, and how known-incomplete segments
    are marked rather than rendered.
