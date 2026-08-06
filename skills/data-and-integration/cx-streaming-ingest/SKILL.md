---
name: cx-streaming-ingest
description: Use to choose between webhooks and polling for keeping support data in sync, and to close the gaps each one leaves. Trigger for "should we use webhooks or polling", "our sync is missing tickets", "webhook events are arriving out of order", real-time support data ingestion, missed events, or designing a helpdesk integration that must not lose data.
metadata:
  author: rulebase
  version: "1.0.0"
  archetype: playbook
---

# Webhooks versus polling for support data

Both approaches lose data, in different ways, and the reliable designs use both. Choosing
one and trusting it is the mistake this skill exists to prevent.

- **Webhooks** are fast and lossy. Delivery is best-effort, retries eventually stop, and an
  outage on your side during the retry window means those events are gone with no record
  that they existed.
- **Polling** is slower and complete-ish. It will find anything that changed, but only in
  the fields the list endpoint filters on, and it misses deletions entirely.

**Use webhooks for latency and polling for truth.** Webhooks drive the real-time path;
a scheduled reconciliation sweep catches whatever the webhooks lost. Almost every "our sync
is missing tickets" investigation ends at a missing reconciliation sweep.

## Webhook properties you must design for

Assume all of these, because they are true of most helpdesk platforms and you will not be
told which:

- **At-least-once delivery.** The same event arrives twice. Every handler must be idempotent
  — key on the event id where one exists, otherwise on the resource id plus a version or
  timestamp, and make the write an upsert.
- **Out-of-order delivery.** An "updated" event can arrive before the "created" one, and a
  status change can arrive after the change that superseded it. **Never apply a webhook as a
  delta.** Treat it as a signal that a resource changed, then fetch the current state — that
  single rule removes most ordering bugs.
- **Truncated payloads.** Webhook bodies frequently omit message bodies, custom fields, or
  the full object. Do not build the record from the payload alone; fetch.
- **Retries that give up.** After a bounded number of attempts the platform stops. If your
  endpoint was down for longer, those events are unrecoverable from the platform.
- **No delivery for some changes.** Bulk operations, admin edits, merges, deletions and
  automation-driven changes often fire nothing.
- **Signature verification**, which is a security requirement rather than an optional step,
  and it has to happen before the payload is parsed or trusted.
- **A response deadline.** Slow handlers get treated as failures and retried. **Acknowledge
  immediately, queue the work**, and do the fetch asynchronously — a handler that does the
  fetch inline will start timing out under load, which is exactly when you need it.

## Polling properties you must design for

- **Watermark on the field the API filters on**, and know whether that field is
  modification time or creation time. A `created_since` sweep will never return the ticket
  that was updated today and created last year — a very common silent gap.
- **Overlap the window.** Re-request a few minutes before your last watermark to absorb
  clock skew and in-flight writes. Idempotent upserts make the overlap free.
- **Advance the watermark from the data, not the clock.** Use the maximum timestamp actually
  returned. Advancing to "now" skips anything written during the request.
- **Beware equal timestamps at a page boundary.** Records sharing a timestamp can straddle
  pages and be skipped or repeated. Page on a stable composite of timestamp plus id where
  the API allows it.
- **Cursor invalidation.** Long paginated walks can have their cursor expire mid-run;
  checkpoint so a restart resumes rather than starting over.
- **Rate limits shared with production.** A poll competing with the app's own traffic will
  throttle both. Read the limit headers and back off on the platform's own hint, which is
  frequently not the standard `Retry-After`.

## The reconciliation sweep, which is the part that makes it reliable

Neither mechanism catches deletions, and webhooks lose events silently. So:

- **Periodically re-list ids over a window and diff** against what you hold. Additions are
  missed events; absences are deletions or merges.
- **Compare counts against the source's own totals** where an endpoint reports them. A count
  mismatch is the cheapest possible detector of a broken sync.
- **Run it on a window wide enough to cover your longest plausible outage**, and a slower
  full sweep periodically for anything outside that.
- **Alert on the gap, not on the sweep completing.** A sweep that finds 400 missing records
  every night is working and telling you the webhook path is broken.

## Ordering, and why event-time is not arrival-time

Store both. Arrival time tells you about your pipeline; event time tells you what happened.
Any analysis ordered by arrival time will be wrong after a backfill, and wrong in the most
damaging way — it can reverse cause and effect in a case timeline.

Where you must apply changes in order — status histories, assignment histories — use the
source's own sequence or version field if it has one, and if it does not, fetch current
state rather than reconstructing from the event stream.

## Failure handling

- **A dead-letter queue** for events you cannot process, with the payload retained. Without
  it, a parsing bug silently discards data for as long as it takes to notice.
- **Replay from the dead-letter queue** once the bug is fixed, which is why the payload has
  to be kept.
- **Backpressure**: a queue between the webhook endpoint and the worker, so a slow
  downstream does not turn into failed deliveries and exhausted retries.
- **Monitor the absence of events.** An integration that silently stops looks identical to
  a quiet period. Alert on "no events for longer than expected for this hour of this
  weekday", using a baseline that respects support traffic's strong weekly and intraday
  seasonality — a flat threshold fires every weekend.
- **Track sync lag as a metric**, and put it where the people who trust the data can see it.

## Guardrails

- **Verify webhook signatures before parsing.** An unauthenticated webhook endpoint accepts
  forged support data from anyone who finds the URL.
- **Do not put customer data in a URL or a query string** anywhere in the pipeline.
- **Webhook payloads are production PII** and frequently end up in application logs by
  default. Check what your logging captures.
- **Do not use a webhook to trigger a customer-visible action** without a human in the loop
  or an idempotency guarantee — at-least-once delivery means a duplicate event sends a
  duplicate message.
- **Do not disable the reconciliation sweep because it keeps finding nothing.** That is what
  success looks like right up until the day it is not.

## Present results to the user

1. **The chosen shape** — webhooks for latency, polling for truth, reconciliation for
   completeness — and which of the three is currently missing.
2. **Idempotency**, and the key each handler dedupes on.
3. **The fetch-on-signal rule**, and anywhere the payload is currently trusted as a delta.
4. **The watermark field**, whether it is modification or creation time, and the overlap.
5. **The reconciliation design** — window, cadence, what it diffs, and the alert on the gap.
6. **Deletion handling**, which neither mechanism provides.
7. **Failure paths** — dead-letter queue, replay, backpressure — and the absence-of-events
   alert with its seasonal baseline.
8. **What can still be lost**, stated plainly, and the maximum outage the design survives.
