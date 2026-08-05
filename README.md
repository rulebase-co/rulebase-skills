# CX Ops Skills

Agent skills for customer service automation and CX operations.

Support platforms are full of APIs that quietly return incomplete data, and CX
metrics are full of numbers that are computed the easy way and mean nothing. These
skills encode the difference: the endpoint that doesn't cap at 1,000 results, the
containment rate that counts abandonment as failure, the QA score that isn't ±29
points of noise.

Built for [Claude Code](https://claude.com/claude-code), Cursor, Copilot, and any
other agent that reads [`SKILL.md`](https://skills.sh) files.

> **Private repository.** Installing requires a GitHub token with read access —
> the `skills` CLI picks up `GITHUB_TOKEN`, `GH_TOKEN`, or your `gh auth token`
> automatically.

## Install

```bash
npx skills add rulebase-co/skills
```

One skill at a time:

```bash
npx skills add rulebase-co/skills --skill cx-deflection-analysis
```

Or use a skill once without installing it:

```bash
npx skills use rulebase-co/skills@zendesk-export-conversations
```

Skills install per-project by default and to `~/` with `-g`. Manual install works
too — copy the directory into `~/.claude/skills/` or your agent's equivalent.

## Catalog

### CX Operations

Vendor-neutral practice. Useful whichever helpdesk you run.

| Skill | What it's for |
| --- | --- |
| [`cx-qa-scorecard-design`](skills/cx-ops/cx-qa-scorecard-design) | Design, rebuild, or critique a QA scorecard. Criterion tests, auto-fail separation, weighting, sample sizing with real confidence intervals, calibration with chance-corrected agreement, and validating that the score predicts an outcome. |
| [`cx-deflection-analysis`](skills/cx-ops/cx-deflection-analysis) | Measure whether a support bot actually reduces contact volume. Splits sessions into contained / leaked / abandoned / handoff, quantifies how far the vendor's containment number overstates, and covers holdout design for causal claims. |

| [`cx-conversation-schema`](skills/cx-ops/cx-conversation-schema) | The canonical cross-platform schema every export in this catalog emits, plus a validator that catches orphaned messages, unresolved author types, and the other export faults that look fine and produce wrong answers. |

### Platform exports

All four emit the same canonical `conversations.jsonl` / `messages.jsonl` shape, so
an analysis written once runs against any of them.

| Skill | The trap it gets you past |
| --- | --- |
| [`zendesk-export-conversations`](skills/zendesk/zendesk-export-conversations) | The Search API caps at 1,000 results, and comments aren't on the ticket object. Uses Incremental Exports with the `comment_events` sideload on `ticket_events` instead of N+1 per-ticket calls. |
| [`intercom-export-conversations`](skills/intercom/intercom-export-conversations) | List and search return no message bodies, so the N+1 is unavoidable — paced by an adaptive limiter reading live rate-limit headers. Detects the silent 500-part truncation that loses a conversation's opening. |
| [`freshdesk-export-conversations`](skills/freshdesk/freshdesk-export-conversations) | Paging stops dead at 30,000 tickets and the default window is 30 days. Escapes both with an ascending-order moving watermark. |
| [`five9-export-interactions`](skills/five9/five9-export-interactions) | No REST list endpoint at all; reports are async SOAP and cap at 50,000 records. Windows the range and collapses call segments so transfers don't inflate call volume. |

### Rulebase

| Skill | What it's for |
| --- | --- |
| [`rulebase-qa-coverage-audit`](skills/rulebase/rulebase-qa-coverage-audit) | Audit QA coverage and scorecard health in a Rulebase workspace over MCP. Finds zero-coverage segments, agents whose scores lack the statistical power for how they're being used, ceiling effects, dead criteria, and whether scores relate to SLA or complaint outcomes. |

## What these do differently

**They lead with what breaks.** The most valuable paragraph in a platform skill is
the one telling you the endpoint you'd naturally reach for is capped, or that the
metric you're about to report counts customers giving up as a success. Every skill
opens there rather than restating vendor documentation.

**The numbers are checked.** Rate limits cite the vendor doc. Confidence intervals
are computed, not asserted. Where a claim can't be verified, it isn't made — no
invented industry benchmarks.

**One schema across every platform.** All exports emit the same
`conversations.jsonl` / `messages.jsonl` shape with the same enum vocabulary, so a
metric is written once and runs against Zendesk, Intercom, Freshdesk, or Five9. The
vendor-specific knowledge stays in the export step. CI proves it: each exporter's
real output is fed through the schema validator on every commit.

**Scripts are tested against the failure paths.** 82 tests cover cursor and
watermark pagination, adaptive rate limiting, checkpoint/resume, RFC 4180 CSV
edge cases, malformed input, and silent-truncation detection — the paths that break
in production and never come up in a happy-path manual run. Scripts have zero npm
dependencies and run on stock Node 20+.

**Analyses report what they can't conclude.** The deflection script emits caveats
naming which conclusions your data doesn't support, and refuses to run at all when
the input would only reproduce the number you're trying to audit.

**Customer data is treated as production PII.** Platform skills read credentials
from the environment only, document the least-privileged scope that works, default
to read-only, and tell the agent not to echo transcripts into chat.

## Roadmap

Next platforms:

- **Salesforce Service Cloud** — Bulk API 2.0, and the governor limits that bite
- **HubSpot Service Hub**, **Gorgias**, **Front**, **Kustomer**
- **Freshchat** — a separate product and API from Freshdesk
- **Genesys Cloud**, **Amazon Connect** — contact centre, plus recording retrieval
- **Talkdesk**, **NICE CXone**

Further CX Ops practice skills:

- Contact-driver taxonomy design
- Volume forecasting and staffing (Erlang C and where it stops working)
- CSAT and NPS survey design, response bias correction
- Complaint identification and regulatory classification
- Voice QA specifics: diarisation and ASR error effects on grading
- Helpdesk migration planning and data-fidelity checks

Contributions in any of these are welcome. Nominate a platform by opening an issue.

## Contributing

Read [AGENTS.md](AGENTS.md) — it's the authoring standard, and CI enforces most of
it. [CONTRIBUTING.md](CONTRIBUTING.md) covers the workflow.

```bash
npm run check   # validate the catalog (strict) and run the tests
```

## Standard

Skills follow the [agent skills standard](https://github.com/vercel-labs/skills):
a directory with a `SKILL.md` containing YAML frontmatter, plus optional
`references/` for on-demand detail and `scripts/` for executables. Only the name
and description load at startup; the body loads when the agent decides the skill
is relevant.

## License

[MIT](LICENSE).
