---
name: zendesk-config-as-code
description: Use to version-control Zendesk configuration — triggers, automations, macros, views, ticket fields, forms, groups — and diff or push changes. Trigger for "put our Zendesk config in git", "what changed in our Zendesk setup", reviewing trigger changes, promoting config from sandbox to production, or auditing who changed a Zendesk automation.
metadata:
  author: rulebase
  version: "1.0.0"
  archetype: mutation
  platform: zendesk
---

# Zendesk configuration as code

Pull Zendesk configuration into versioned files, diff local against live, and push
reviewed changes. Three commands: `pull`, `diff`, `push`.

## Why config is harder than data

Data is independent rows. Configuration is a **graph**:

- A trigger references a group, a field, a macro, and a form.
- **Trigger order is semantic.** Triggers fire in sequence and later ones see the
  state earlier ones produced. Reordering changes behaviour without changing any
  individual trigger.
- Ticket field types cannot be changed after creation on most field kinds.
- Deleting a field silently breaks every trigger, view, macro, and report that
  references it — with no error at deletion time.

So this skill is deliberately narrow about what it will write.

## What can and cannot be undone

**`pull` and `diff` are read-only and completely safe.** Run them whenever.

**`push` changes live configuration and Zendesk has no undo.** Updating a trigger
overwrites its previous definition; there is no version history in the API. Your
committed config directory *is* the version history, which is the main reason to
adopt this pattern at all.

**`push` will never delete and never reorder.** Those are the two changes most
likely to break production silently, so they stay manual:

| Situation | What push does |
| --- | --- |
| Local file has a resource that changed | Updates it |
| Local file has a resource with no id | Creates it |
| Live has a resource not in local files | **Reports it as untracked. Does not delete.** |
| Local has an id that no longer exists live | **Refuses — it was deleted in Zendesk** |
| Resource references a group/field missing locally | **Refuses** |
| SLA policies, schedules | **Never pushed** — pull-only |
| Trigger positions differ | **Ignored** — no reordering |

Removing a file from your config directory does **not** delete anything in
Zendesk. That is intentional: a `git rm` should not silently destroy a production
trigger.

## Safety

**1. Dry-run is the default.** `push` without `--apply` prints the plan and writes
nothing.

**2. Plan-first, with a reviewable artifact.** `pull` produces the files, `diff`
produces the plan, `push` applies it. The config directory is a git diff a human
can review — which is the whole point, and something the Zendesk admin UI cannot
give you.

**3. Computed fields are stripped.** `created_at`, `updated_at`, `url`, usage
counters and similar are removed before writing and before comparing. Without
this, every pull produces a diff and the signal is lost in noise.

**4. Dependency checking.** A trigger referencing a group or custom field absent
from the local config is refused rather than pushed against an unknown target.

**5. Append-only audit log** with before/after for every change, in the config
directory alongside the files.

**6. Bounded blast radius.** `--max-changes` defaults to 10, and applied resources
are journalled so an interrupted push resumes.

**7. No `--force`.** There is no flag that skips the plan or enables deletion.

## Prerequisites

- Node 20+ (no npm dependencies).
- An **admin** API token. Agent tokens cannot read or manage triggers, fields, or
  macros, and the 403 message says so.

```bash
export ZENDESK_SUBDOMAIN=acme
export ZENDESK_EMAIL=admin@acme.com
export ZENDESK_API_TOKEN=…
```

## Usage

```bash
# 1. Snapshot current config, then commit it
node scripts/config.mjs pull --dir ./zendesk-config
git add zendesk-config && git commit -m "Snapshot Zendesk config"

# 2. Edit the JSON files, or pull from sandbox into the same directory

# 3. See what would change
node scripts/config.mjs diff --dir ./zendesk-config

# 4. Dry-run the push, then apply a small batch
node scripts/config.mjs push --dir ./zendesk-config
node scripts/config.mjs push --dir ./zendesk-config --apply --max-changes 3
```

**Arguments**

- `--dir <path>` — config directory. Default `./zendesk-config`.
- `--apply` — actually write (push only). **Without this, nothing is written.**
- `--max-changes <n>` — default 10.
- `--only <list>` — restrict to resource types:
  `groups, ticket_fields, ticket_forms, macros, views, triggers, automations, sla_policies, schedules`

**Pull and commit before you change anything.** The first commit is the baseline
that makes every later diff meaningful, and it is a disaster-recovery artifact in
its own right.

**Use `--only` when iterating.** Pushing one resource type at a time keeps a
mistake contained and the diff readable.

## The highest-value use: drift detection

Run `pull` on a schedule and commit the result. Every configuration change anyone
makes in the Zendesk admin UI then shows up as a git commit, with a diff.

That gives you something Zendesk does not provide:

- **What changed, when.** Trigger conditions edited three weeks ago become
  visible.
- **Correlation with incidents.** "Routing broke on the 14th" becomes answerable.
- **Review.** Config changes can go through a pull request even though the change
  itself is made in the UI.

Drift detection needs no `push` at all, so it is entirely read-only and safe to
adopt immediately. Most teams get more value from this than from pushing.

## Sandbox to production promotion

The obvious next use, with a real caveat: **ids differ between environments.** A
trigger pulled from sandbox references sandbox group and field ids, which do not
exist in production. The dependency check refuses those pushes rather than
creating something misconfigured.

Promotion therefore needs an id-mapping step this skill does not provide. Treat
sandbox pull as a source of the *intended shape*, and expect to remap references
before pushing. Doing it by hand for a handful of triggers is fine; doing it for a
whole instance is a project.

## Present results to the user

1. **Which command ran, and whether it wrote anything.** `pull` and `diff` never
   do.
2. **The diff summary by resource type**, with changed field names. `~ 12345
   [conditions, title]` is reviewable; "1 trigger changed" is not.
3. **Untracked live resources**, explicitly stated as *not deleted*. People expect
   config-as-code to converge state and it deliberately does not.
4. **Everything refused, with the reason.** The dependency and deleted-in-Zendesk
   refusals are the interesting output — they usually mean the local config is
   stale or came from another environment.
5. **What is pull-only** (SLA policies, schedules) if the user changed them
   locally and expected a push.
6. **The audit log path**, and that the committed directory is the only version
   history that exists.
7. **For drift detection**, present the git diff rather than the tool's output.
   That is the artifact people can actually read.

## Troubleshooting

**403 on pull** — the token belongs to an agent, not an admin.

**Every resource shows as changed right after a pull** — a computed field is not in
the strip list for your account (custom apps sometimes add fields). Add it to
`VOLATILE_FIELDS` in the script.

**Push refuses with "missing dependencies"** — the config references a group or
field the local directory does not contain. Either pull again, or you are pushing
sandbox config to production, where those ids do not exist.

**Push refuses with "resurrect something someone removed"** — a local record has
an id that no longer exists live. Someone deleted it in Zendesk. Decide
deliberately: remove it from the local file, or recreate it in the UI.

**A trigger works differently after a push even though the diff looked right** —
check position. Triggers fire in order and this skill does not manage ordering, so
a created trigger lands wherever Zendesk puts it.

**Nothing happened and no error** — `--apply` was omitted. That is the default.
