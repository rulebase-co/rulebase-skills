#!/usr/bin/env node
/**
 * rulebase — CLI for a Rulebase workspace.
 *
 * Phase 1 is deliberately read-only and stateless. There is no `login` and no
 * token store yet, because MCP already does OAuth properly and a second
 * credential store is only worth maintaining once something needs what MCP
 * cannot do. Credentials come from the environment.
 *
 *   rulebase doctor      which region your key belongs to, and what is reachable
 *   rulebase whoami      what is knowable about the current credential
 *   rulebase skills      pointer to the skills installer
 *
 * Zero dependencies: this runs via npx in someone else's project.
 */

import { readFileSync } from 'node:fs';
import { doctor } from '../lib/commands/doctor.js';
import { whoami } from '../lib/commands/whoami.js';
import { skills } from '../lib/commands/skills.js';

const argv = process.argv.slice(2);

/** Flags that take a value, so a value is never mistaken for a positional. */
const VALUE_FLAGS = new Set(['region']);

function parse(args) {
  const flags = {};
  const positionals = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }
    const name = arg.slice(2);
    if (VALUE_FLAGS.has(name)) {
      const value = args[i + 1];
      if (value === undefined || value.startsWith('--')) {
        process.stderr.write(`error: --${name} requires a value\n`);
        process.exit(2);
      }
      flags[name] = value;
      i += 1;
    } else {
      flags[name] = true;
    }
  }
  return { flags, positionals };
}

function help() {
  return `rulebase — work with a Rulebase workspace from the terminal

Usage
  rulebase doctor [--region us|eu]   Find which region your API key belongs to
  rulebase whoami [--region us|eu]   What is knowable about the current credential
  rulebase skills [...]              Where to get the CX ops skills

Options
  --region us|eu   Skip region detection. Also reads RULEBASE_REGION.
  --json           Machine-readable output
  --version        Print the CLI version

Credentials
  RULEBASE_API_KEY   Read from the environment only, never from an argument.
                     Only needed for pushing data in; reading over MCP needs no key.

Why doctor exists
  A valid key sent to the wrong region returns the same 401 as a revoked one, and
  nothing in the response tells them apart. doctor tries both regions so you stop
  debugging a credential problem you do not have.

Docs  https://github.com/rulebase-co/rulebase-skills
`;
}

const COMMANDS = { doctor, whoami, skills, check: doctor };

const { flags, positionals } = parse(argv);
const command = positionals[0];

// Before the help branch: `rulebase --version` has no command, and would
// otherwise fall through to help.
if (flags.version || flags.v) {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  process.stdout.write(`${pkg.version}\n`);
  process.exit(0);
}

if (!command || flags.help || command === 'help') {
  process.stdout.write(help());
  process.exit(0);
}

const handler = COMMANDS[command];
if (!handler) {
  process.stderr.write(`error: unknown command "${command}"\n\n${help()}`);
  process.exit(2);
}

let result;
try {
  result = await handler(flags, positionals.slice(1));
} catch (err) {
  process.stderr.write(`error: ${err?.message || err}\n`);
  process.exit(2);
}

if (flags.json) {
  process.stdout.write(`${JSON.stringify(result.json, null, 2)}\n`);
} else {
  process.stdout.write(`${result.text}\n`);
}
process.exit(result.exitCode ?? 0);
