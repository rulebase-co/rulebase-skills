# rulebase

CLI for a [Rulebase](https://rulebase.co) workspace.

```bash
npx rulebase doctor
```

## Why `doctor` exists

Rulebase runs separate US and EU deployments with separate credential stores. A valid
API key sent to the wrong region returns:

```json
{ "error": "Unauthorized" }
```

Which is byte-identical to what a revoked or mistyped key returns. Nothing in the
response distinguishes them, so people spend hours debugging a credentials problem they
do not have.

`doctor` does not trust the region you give it. It tries both and tells you which one
answers:

```
  api key   rk_live_…32 chars
  region    us (requested)

  US   api rejected · mcp reachable
  EU   api authenticated · mcp reachable

  Your key belongs to EU.
  You asked for US, which rejected it. That 401 is indistinguishable
  from a bad key, so use --region eu (or RULEBASE_REGION=eu).
```

## Commands

```bash
rulebase doctor [--region us|eu]   # which region your key belongs to, and what is reachable
rulebase whoami [--region us|eu]   # what is knowable about the current credential
rulebase skills [...]              # where to get the CX ops skills
```

Add `--json` to any of them for machine-readable output.

## Credentials

The API key is read from `RULEBASE_API_KEY`, from the environment only — never from a
command-line argument, because argv shows up in shell history, in `ps` output and in chat
transcripts.

```bash
export RULEBASE_API_KEY=rk_live_...
npx rulebase doctor
```

You only need a key to push data in. **Reading a workspace over MCP needs no key at all** —
see [`rulebase-setup`](https://github.com/rulebase-co/rulebase-skills/tree/main/skills/rulebase/rulebase-setup)
for connecting Claude Code, Codex or Cursor.

## What `whoami` can and cannot tell you

It reports the region and whether the key works. It does **not** report the organization,
because no public endpoint exposes one: an API key authenticates as the organization
rather than as a person, and nothing returns which organization that is.

To confirm the workspace, use the MCP server and call `get_current_organization`. The CLI
says this rather than guessing.

## What this does not do yet

There is no `login` and no stored token. MCP already implements OAuth properly, with
discovery, PKCE and a device-code grant, so a second credential store is only worth
maintaining once there is something MCP cannot do — bulk uploads, or scripting in CI.

Skills live in a separate package so the catalog stands on its own:

```bash
npx rulebase-skills list
```

## License

[MIT](../LICENSE)
