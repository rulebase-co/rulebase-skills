# AGENTS.md

Guidance for AI coding agents and humans authoring skills in this repository.

## What this repo is

A vendor-neutral catalog of [agent skills](https://skills.sh) for customer service
automation and CX operations. It follows the
[skills standard](https://github.com/vercel-labs/skills): each skill is a directory
containing a `SKILL.md` with YAML frontmatter, discovered by `npx skills`.

The catalog is organised by platform and by practice:

```
skills/
  cx-operations/         Demand, routing, backlog, cost, workforce, channels, reporting
  quality-assurance/     Scorecards, calibration, coverage, AI-in-the-loop
  compliance/            Complaints, erasure, PII, evidence
  revops/                Churn, expansion and revenue signal
  data-and-integration/  Canonical schema and migration fidelity
  zendesk/               Zendesk Support / Suite
  intercom/              Intercom
  freshdesk/             Freshworks (Freshdesk, Freshchat)
  five9/                 Five9 contact centre
  rulebase/              Rulebase
```

## Non-negotiables

Three rules exist because breaking them silently degrades every skill downstream.

**1. Skills install standalone.** `npx skills add rulebase-co/skills --skill <name>`
copies or symlinks *one directory*. A skill may only reference files inside its own
directory. Never link to `../another-skill/`, never link to repo-root docs. If two
skills need the same reference material, duplicate it. The validator enforces this.

**2. The description is the whole product surface.** At startup an agent sees only
`name` and `description` — the body loads only if the agent decides the skill is
relevant. A description that describes the skill without naming its triggers will
never fire. Write both halves: what it does, and the phrases/situations that should
activate it.

**3. Customer service data is production PII.** Every transcript contains names,
emails, addresses, card fragments, health and financial disclosures. Any skill that
touches a live API must follow [Data handling](#data-handling) below. This is the
credibility of the whole repo.

**4. Platform exports emit the canonical schema.** Every skill that *reads*
conversations out of a vendor writes `conversations.jsonl` and `messages.jsonl` in
the shape defined by the `cx-conversation-schema` skill — same field names, same
enum vocabulary, ids stringified, `*_raw` kept beside every normalised value. This
is what makes an analysis portable across helpdesks instead of one implementation
per vendor. A new export skill that invents its own shape is not mergeable.
Voice-only sources (no message bodies) emit `conversations.jsonl` alone.

Skills that push data *into* a system are the mirror image: where the target
accepts structured conversations, consume the canonical schema rather than
inventing an input format, so an export from one vendor feeds an import into
another without a bespoke translation step. Where the target accepts something
else entirely — audio files, a vendor-specific envelope — say so plainly in the
body and document the input format you do take.

## Creating a skill

### Directory structure

```
skills/<category>/<skill-name>/
  SKILL.md              Required. Frontmatter + instructions.
  references/           Optional. Detail loaded on demand.
  scripts/              Optional. Executables. Output doesn't cost context.
  lib/                  Optional. Shared code imported by scripts.
```

`<skill-name>` is kebab-case and **must equal** the frontmatter `name`. Prefix
platform skills with the platform (`zendesk-export-conversations`) and practice
skills with `cx-` (`cx-deflection-analysis`) so names stay unambiguous once
installed alongside skills from other repos.

### Frontmatter

Only these keys are permitted. The validator rejects anything else.

The `description` must sit on one physical line, however long it gets:

```yaml
---
name: zendesk-export-conversations
description: Use to bulk-export Zendesk tickets and conversation text for analytics, QA or LLM pipelines. Trigger for "export my Zendesk tickets", "pull Zendesk data", incremental sync, or when the Search API's 1,000-result cap is blocking work.
metadata:
  author: rulebase
  version: "1.0.0"
  archetype: platform
  platform: zendesk
---
```

| Key | Required | Notes |
| --- | --- | --- |
| `name` | yes | Lowercase kebab-case. Must match the directory name. |
| `description` | yes | 60–1024 chars, one line, includes trigger language. |
| `metadata.archetype` | yes | `platform` \| `playbook` \| `analysis` \| `product` \| `mutation` |
| `metadata.version` | yes | Quoted semver. Bump on behaviour change. |
| `metadata.author` | no | Defaults to `rulebase`. |
| `metadata.platform` | no | Set on `platform` skills. |
| `metadata.internal` | no | `true` hides the skill unless `INSTALL_INTERNAL_SKILLS=1`. |
| `license` | no | Inherits repo MIT. |
| `allowed-tools` | no | Restrict tool access where a skill is destructive. |

Frontmatter is parsed as a small YAML subset: single-line `key: value` scalars and
one level of two-space nesting under `metadata`. No sequences, no `|`/`>` block
scalars, no anchors. Keep descriptions on one physical line.

### The five archetypes

Pick one; it sets the shape of the body.

**`platform`** — operating one vendor's API. Ships working scripts that emit the
canonical schema. Body covers auth, the correct endpoint (and why the obvious one
is wrong), pagination, rate limits, resumability, and the field mapping. The value
is in the non-obvious API knowledge, not in restating the docs.

Before writing one, answer these — they are the skill:

- **The wrong endpoint.** What does a competent person reach for first, and how
  does it fail? Every helpdesk has a different trap: Zendesk's Search API caps at
  1,000 results, Freshdesk's list endpoint stops at page 300, Intercom's list
  endpoints omit message bodies entirely.
- **Silent gaps.** Deleted, archived, redacted, merged, or truncated records.
  Anything the API returns that the UI doesn't, or vice versa.
- **The permission trap.** Scoped API keys and wrong-workspace tokens produce
  partial exports, not errors. Name it.
- **What is checkpointable**, so a multi-hour run survives interruption.

**`playbook`** — a repeatable CX practice with no single right answer (designing a
QA rubric, building a contact taxonomy, running calibration). Body is a decision
procedure: inputs to gather, choices with explicit trade-offs, failure modes to
avoid, and a template output. No scripts, or scripts only for arithmetic.

**`analysis`** — computing a metric that is widely computed *wrongly*. Body must
state the naive definition, why it misleads, the defensible definition, and the
data required. Ships a script when the arithmetic is fiddly.

**`product`** — driving a specific product's tools/MCP server. Body must instruct
the agent to introspect available tools rather than hardcode signatures, so the
skill survives API changes.

**`mutation`** — changes state in a customer's live helpdesk. Merging tickets,
bulk-updating, redacting, deleting, pushing configuration. These carry the
[mutation safety contract](#the-mutation-safety-contract) below, which CI enforces.

---

## The mutation safety contract

A mutation skill runs against a production support system holding real customer
data, usually with no undo. An agent invoking one is acting on a business's
records at scale. Every mutation skill in this catalog must satisfy all seven
rules; the validator checks what it can, and reviewers check the rest.

**1. Dry-run is the default; `--apply` is explicit.** Not the other way around.
A script that writes unless told otherwise will eventually write when nobody
meant it to. The default invocation must be safe to run at any time, on any
account, by mistake.

**2. Separate deciding from doing.** A mutation must consume a **plan file**
produced by a separate read-only step, or print a plan and require a second
invocation to apply it. Never inspect-and-mutate in one pass. This is what makes
the change reviewable by a human before it happens, and it is the single most
valuable property in the contract — an agent can safely generate a plan for
someone else to approve.

**3. Append-only audit log.** One JSONL record per attempted change: target id,
before-state, after-state, timestamp, outcome, and the plan it came from. Written
as the run proceeds, never buffered to the end. This is what makes the change
explainable afterwards, which is a regulatory requirement in several sectors.

**4. Idempotent and resumable.** Re-running after an interruption must not
double-apply. Journal completed ids and skip them. A mutation that is unsafe to
retry cannot be operated safely, because interruptions are certain.

**5. Bounded blast radius.** A conservative `--max-changes` default, and refuse to
exceed it without the operator raising it explicitly. The difference between a
mistake affecting 50 tickets and 500,000 is one flag.

**6. State reversibility plainly.** The body must say what can be undone, what
cannot, and what the recovery path is. "Redaction is irreversible" belongs in the
skill, above the usage section.

**7. Verify after applying.** Re-read the changed records and confirm the change
landed. Report anything that did not.

Required body sections for a mutation skill: a **Safety** (or Guardrails)
section, an explicit reversibility statement, and both `--dry-run` and `--apply`
documented. Consider setting `allowed-tools` in frontmatter to restrict what the
agent can reach.

**Never make destruction the convenient path.** No `--force` that skips the plan,
no flag that combines detect-and-apply, no default that grows the blast radius.
If a reviewer can imagine an agent invoking the skill and regretting it, the
guardrail is missing.

### Body rules

- **Under 500 lines**, ideally under 250. The validator errors above 500 and warns
  above 400. Push detail into `references/`.
- **Progressive disclosure.** Link references inline (`see [references/x.md](references/x.md)`)
  so they load only when needed. References work one level deep; don't nest links.
- **Lead with what breaks.** The most valuable paragraph in a platform skill is the
  one that says "the endpoint you'd reach for first is capped at 1,000 results."
- **Be concrete.** Real endpoints, real limits, real field names, real formulas.
  Cite the vendor doc URL next to any limit that could change.
- **No invented numbers.** Never write a benchmark, industry average, or vendor
  limit you have not verified. Uncited quantitative claims are the fastest way to
  make the catalog untrustworthy.
- **Include a "Present results" section** telling the agent how to report back, so
  output is consistent across skills.

### Script requirements

- Node scripts: `#!/usr/bin/env node`, `.mjs` extension, Node 20+, **no npm
  dependencies** (use `fetch`, `node:fs`). Skills are copied into arbitrary
  projects; a `package.json` requirement makes them fail.
- Bash scripts: `#!/usr/bin/env bash` and `set -euo pipefail`.
- `chmod +x` every script.
- Status/progress to **stderr**; machine-readable data to **stdout**. This lets an
  agent pipe results without parsing around log lines.
- Read credentials from **environment variables only**. Never accept a token as a
  CLI argument — argv is visible in shell history, `ps`, and chat transcripts.
- Checkpoint long runs to disk and support `--resume`. Support exports take hours
  and rate limits are aggressive.
- Exit non-zero on failure with a message that names the fix.

### Data handling

Any skill touching a live customer-service API must:

1. **Read credentials from env vars only**, and document the least-privileged
   scope that works (read-only API token, not admin).
2. **Default to writing exports outside the repo** — `./out/` is gitignored here,
   but state in the skill that transcripts must not be committed.
3. **Never echo transcript bodies into chat.** Report counts, IDs and aggregates.
   If a sample is needed, redact and say so.
4. **Be read-only unless the skill's whole purpose is mutation.** If a skill writes
   (bulk-updating tickets, closing conversations), it must require an explicit
   confirmation step and support `--dry-run` first.
5. **Say what the API does not return.** Deleted tickets, redacted comments and
   archived conversations are common silent gaps that corrupt analyses.

## Validation

```bash
node scripts/validate-skills.mjs          # errors only
node scripts/validate-skills.mjs --strict # warnings fail too (matches CI)
```

CI runs `--strict`, syntax-checks every script, and greps for committed
credentials. Run it before pushing.

## Adding to the catalog manifest

Every skill belongs to a grouping in `skills.sh.json`, which drives ordering on
skills.sh. Add the skill name to the appropriate grouping; the validator warns
about ungrouped skills and errors on unknown or duplicated names.

## Testing a skill before shipping

A skill is not done when it reads well. Verify:

1. **It triggers.** In a fresh session with the skill installed, use a phrase a
   real user would say — not the skill's name. If the agent doesn't load it, the
   description is wrong.
2. **Scripts run.** Against a real sandbox for platform skills. Confirm rate-limit
   backoff and `--resume` actually work; these are the paths that break in
   production and never get exercised in a happy-path test.
3. **A cold agent can follow it.** The body must not assume context from this repo.
