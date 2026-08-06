---
name: cx-contact-spike-detection
description: Use to detect genuine spikes in support contacts about a topic against a baseline that respects support traffic's strong weekly and intraday seasonality. Trigger for "are complaints about X rising", "detect when an issue spikes", "was that a real increase", "alert us to unusual contact volume", incident early warning from support signal, or a spike alert that fires constantly.
metadata:
  author: rulebase
  version: "1.0.0"
  archetype: analysis
---

# Detecting contact spikes

Support volume is one of the more strongly seasonal series in a business, and almost
every naive spike detector fails on the same thing: it compares a Monday to a Sunday and
declares an incident.

Done properly, support contacts are among the fastest incident signals a company has —
customers frequently notice a failure before monitoring does. That is the prize, and it
is only reachable with a baseline that models the periodicity.

## Model the seasonality, or the detector is noise

At minimum, support traffic has:

- **A day-of-week cycle**, typically large. Weekday and weekend volumes can differ by
  more than any incident you are trying to catch.
- **An intraday cycle**, larger still, and it differs by channel and by market.
- **Public holidays**, which differ per market and break every baseline. A holiday
  calendar is not optional, and a multi-market operation needs one per market.
- **Business-driven cycles** — pay days, billing dates, statement runs, campaign sends,
  release days. These are predictable and produce large recurring spikes that a naive
  detector will flag every month.
- **Trend**, from growth in the customer base.

**Compare like with like**: same weekday and same hour band, over several recent weeks,
or use a baseline that explicitly models the period. Comparing to "the last 7 days
average" bakes the weekly cycle into the residual and produces a detector that fires
every Monday and every Saturday.

## Rate and count, together

A topic's **share** of contacts and its **absolute count** answer different questions
and fail in opposite directions:

- On a quiet night, two extra contacts can double the share. Share alone fires
  constantly at low volume.
- During an unrelated volume surge, a topic's share falls while its count rises. Count
  alone misses a relative shift.

**Alert on both, with a minimum count floor.** The floor is what stops the 3 a.m.
false alarm, and it is the single most effective parameter in the whole detector.

## Set the threshold on the historical distribution

Do not pick a round multiple. "Double the baseline" is arbitrary and will be far too
sensitive for low-volume topics and far too insensitive for high-volume ones.

Instead:

1. Compute the deviation from the seasonal baseline for every historical period.
2. Look at the distribution of that deviation.
3. Choose a threshold at a percentile that yields an acceptable firing rate.
4. **Back-test it**: how often would it have fired historically, and what was happening
   on those days? If you cannot recognise the events it flags, the threshold is wrong.

Report the expected firing rate before deploying anything. A detector that fires more
often than someone can triage is not a detector.

Count data is variance-unstable — a Poisson-like series has larger absolute swings at
higher volume — so a fixed absolute threshold behaves differently across topics.
Thresholding a standardised deviation, or on a variance-stabilising transform, behaves
far better across a range of topic volumes.

## Multiplicity: the trap nobody accounts for

Monitoring 50 topics at a 1-in-100 threshold produces roughly one false alarm every
other period, every period, forever. Then a fortnight later the channel is muted.

- **Control the total alert rate**, not the per-topic rate. Tighten the per-topic
  threshold as the topic count grows.
- **Monitor fewer things.** A curated list of topics where a spike would actually change
  what someone does beats monitoring every category.
- **Group correlated topics.** Five subcategories of one payment failure spiking
  together is one incident; alert once with the group.

## Confirm before escalating

A statistical spike is a hypothesis. Before anyone treats it as an incident:

- **Read a handful of the contacts.** This takes two minutes and resolves most false
  positives immediately.
- **Rule out the boring causes**, in this order: a campaign or notification send, a
  release, a categorisation or tagging change, an integration backfill dumping old
  contacts in at once, or a channel that came online. **Backfills are the most common
  cause of a spike that isn't one** — the contacts are real but they are not new, and
  the giveaway is that their event timestamps are old even though their record
  timestamps are not.
- **Check whether the topic definition changed.** A tag rename or a taxonomy edit
  produces a step change that looks exactly like a spike.
- **Check other channels.** A real customer-facing problem usually shows in more than
  one.

## Onset detection matters more than magnitude

For incident use, the useful output is **when it started**, not how big it got. Report
the first period that deviated, the trajectory, and whether it is still rising —
alongside the earliest few conversation ids, which are what an incident responder
actually wants.

Persistence is a better signal than magnitude: two consecutive elevated periods is
stronger evidence than one large one, and it materially cuts false positives at a small
cost in latency. Where minutes matter, run both — a fast noisy check and a slower
confirming one.

## Present results to the user

1. **The baseline method** — what seasonality is modelled, the comparison window, the
   holiday handling.
2. **The threshold and its expected firing rate**, from the back-test.
3. **Detected spikes**, with onset time, magnitude in both count and share, and whether
   still rising.
4. **Confirmation** — what the sampled contacts actually say, and which boring causes
   you ruled out.
5. **Correlated topics and channels**, grouped into incidents rather than listed
   separately.
6. **The earliest conversation ids**, for whoever picks it up.
7. **What the detector will miss** — topics below the count floor, slow-onset drifts
   that never breach a threshold, and anything the topic definition does not capture.
