#!/usr/bin/env node
/**
 * Validates the skill catalog against the authoring rules in AGENTS.md.
 *
 * Zero dependencies on purpose: contributors and CI can run this without an
 * install step. That means frontmatter is parsed as a deliberately small YAML
 * subset (see parseFrontmatter) and anything outside that subset is a hard
 * error rather than a silent misparse.
 *
 * Usage:
 *   node scripts/validate-skills.mjs [--strict] [--json]
 *
 *   --strict  treat warnings as errors
 *   --json    emit machine-readable findings on stdout
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname, basename, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SKILLS_DIR = join(REPO_ROOT, 'skills');
const CATALOG_MANIFEST = join(REPO_ROOT, 'skills.sh.json');

const args = new Set(process.argv.slice(2));
const STRICT = args.has('--strict');
const JSON_OUT = args.has('--json');

/** Frontmatter keys we allow. Anything else is a typo or an unsupported feature. */
const ALLOWED_KEYS = new Set(['name', 'description', 'license', 'allowed-tools', 'metadata']);
const ALLOWED_METADATA_KEYS = new Set([
  'author',
  'version',
  'internal',
  'argument-hint',
  'platform',
  'archetype',
]);

/** Skill archetypes. Every skill declares one so the catalog stays legible. */
const ARCHETYPES = new Set(['platform', 'playbook', 'analysis', 'product', 'mutation']);

const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SEMVER_RE = /^\d+\.\d+\.\d+$/;

const DESCRIPTION_MIN = 60;
const DESCRIPTION_MAX = 1024;
const BODY_LINES_WARN = 400;
const BODY_LINES_MAX = 500;

const findings = [];

function report(level, file, message) {
  findings.push({ level, file: relative(REPO_ROOT, file), message });
}
const error = (file, message) => report('error', file, message);
const warn = (file, message) => report('warning', file, message);

/**
 * Parses a strict subset of YAML frontmatter:
 *   - `key: value` scalars (optionally single- or double-quoted)
 *   - one level of nesting under `metadata:` using two-space indents
 *   - `true` / `false` become booleans; everything else stays a string
 *
 * Rejects tabs, sequences, multiline scalars, anchors and aliases so that a
 * complex-but-valid YAML file fails loudly here instead of parsing differently
 * in the validator than it does in the skills CLI.
 */
function parseFrontmatter(raw, file) {
  if (!raw.startsWith('---\n')) {
    error(file, 'must start with a `---` YAML frontmatter fence on line 1');
    return null;
  }
  const end = raw.indexOf('\n---', 3);
  if (end === -1) {
    error(file, 'frontmatter is not closed with a `---` fence');
    return null;
  }
  const block = raw.slice(4, end);
  const bodyStart = raw.indexOf('\n', end + 1);
  const body = bodyStart === -1 ? '' : raw.slice(bodyStart + 1);

  const data = {};
  let currentParent = null;

  const lines = block.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '' || line.trim().startsWith('#')) continue;

    if (line.includes('\t')) {
      error(file, `frontmatter line ${i + 1}: tabs are not valid YAML indentation`);
      return null;
    }
    if (/^\s*-\s/.test(line)) {
      error(file, `frontmatter line ${i + 1}: YAML sequences are not supported in this repo`);
      return null;
    }

    const indent = line.length - line.trimStart().length;
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line.trim());
    if (!match) {
      error(file, `frontmatter line ${i + 1}: expected \`key: value\`, got \`${line.trim()}\``);
      return null;
    }
    const [, key, rawValue] = match;

    if (/^[|>]/.test(rawValue)) {
      error(file, `frontmatter line ${i + 1}: multiline scalars are not supported; use one line`);
      return null;
    }
    if (/^[&*]/.test(rawValue)) {
      error(file, `frontmatter line ${i + 1}: YAML anchors/aliases are not supported`);
      return null;
    }

    if (indent === 0) {
      currentParent = null;
      if (rawValue === '') {
        data[key] = {};
        currentParent = key;
        continue;
      }
      data[key] = coerce(rawValue);
    } else if (indent === 2 && currentParent) {
      if (typeof data[currentParent] !== 'object' || data[currentParent] === null) {
        error(file, `frontmatter line ${i + 1}: \`${currentParent}\` is not a mapping`);
        return null;
      }
      data[currentParent][key] = coerce(rawValue);
    } else {
      error(
        file,
        `frontmatter line ${i + 1}: unexpected indent of ${indent}; use 0 or 2 spaces under a mapping`,
      );
      return null;
    }
  }

  return { data, body };
}

function coerce(value) {
  let v = value.trim();
  // Strip a trailing comment only when the value is not quoted.
  if (!/^["']/.test(v)) {
    const hash = v.indexOf(' #');
    if (hash !== -1) v = v.slice(0, hash).trim();
  }
  if (
    (v.startsWith('"') && v.endsWith('"') && v.length > 1) ||
    (v.startsWith("'") && v.endsWith("'") && v.length > 1)
  ) {
    return v.slice(1, -1);
  }
  if (v === 'true') return true;
  if (v === 'false') return false;
  return v;
}

/**
 * Finds SKILL.md files in the layouts the skills CLI walks: `skills/<name>/`,
 * `skills/<category>/<name>/`, and `skills/<category>/<sub>/<name>/`. A
 * SKILL.md found at a shallower level shadows anything nested beneath it, which
 * mirrors the CLI's own shadowing rule.
 */
function findSkills(dir, depth = 1) {
  const found = [];
  if (!existsSync(dir)) return found;

  if (existsSync(join(dir, 'SKILL.md'))) return [join(dir, 'SKILL.md')];
  if (depth >= 3) return found;

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    found.push(...findSkills(join(dir, entry.name), depth + 1));
  }
  return found;
}

/** Collects relative markdown links and bare relative paths in fenced commands. */
function extractLocalRefs(body) {
  const refs = new Set();

  // [text](references/foo.md) — ignore absolute URLs, anchors and mailto.
  for (const m of body.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    const target = m[1];
    if (/^(https?:|mailto:|#|\/)/.test(target)) continue;
    refs.add(target.split('#')[0]);
  }

  // `node scripts/foo.mjs` / `bash scripts/foo.sh` inside the doc or code fences.
  for (const m of body.matchAll(/(?:node|bash|sh|python3?)\s+((?:scripts|lib)\/[\w./-]+)/g)) {
    refs.add(m[1]);
  }

  return [...refs].filter(Boolean);
}

function validateSkill(skillMd, seenNames) {
  const skillDir = dirname(skillMd);
  const raw = readFileSync(skillMd, 'utf8');
  const parsed = parseFrontmatter(raw, skillMd);
  if (!parsed) return null;

  const { data, body } = parsed;

  for (const key of Object.keys(data)) {
    if (!ALLOWED_KEYS.has(key)) {
      error(skillMd, `unknown frontmatter key \`${key}\` (allowed: ${[...ALLOWED_KEYS].join(', ')})`);
    }
  }

  // --- name ---
  const name = data.name;
  if (typeof name !== 'string' || name === '') {
    error(skillMd, 'frontmatter `name` is required and must be a string');
    return null;
  }
  if (!NAME_RE.test(name)) {
    error(skillMd, `name \`${name}\` must be lowercase kebab-case (a-z, 0-9, single hyphens)`);
  }
  const dirName = basename(skillDir);
  if (name !== dirName) {
    error(skillMd, `name \`${name}\` must match its directory name \`${dirName}\``);
  }
  if (seenNames.has(name)) {
    error(skillMd, `duplicate skill name \`${name}\` (also defined in ${seenNames.get(name)})`);
  } else {
    seenNames.set(name, relative(REPO_ROOT, skillDir));
  }

  // --- description ---
  const description = data.description;
  if (typeof description !== 'string' || description === '') {
    error(skillMd, 'frontmatter `description` is required and must be a string');
  } else {
    if (description.length < DESCRIPTION_MIN) {
      error(
        skillMd,
        `description is ${description.length} chars; needs >= ${DESCRIPTION_MIN}. It is the only text an agent sees when deciding whether to load the skill — state what it does AND when to trigger.`,
      );
    }
    if (description.length > DESCRIPTION_MAX) {
      error(skillMd, `description is ${description.length} chars; max ${DESCRIPTION_MAX}`);
    }
    if (!/\b(use|trigger|when|for)\b/i.test(description)) {
      warn(skillMd, 'description has no trigger language ("Use when…", "Trigger for…"); agents will under-select it');
    }
  }

  // --- metadata ---
  const metadata = data.metadata;
  if (metadata !== undefined) {
    if (typeof metadata !== 'object' || metadata === null) {
      error(skillMd, '`metadata` must be a mapping');
    } else {
      for (const key of Object.keys(metadata)) {
        if (!ALLOWED_METADATA_KEYS.has(key)) {
          error(skillMd, `unknown metadata key \`${key}\` (allowed: ${[...ALLOWED_METADATA_KEYS].join(', ')})`);
        }
      }
      if (metadata.version !== undefined && !SEMVER_RE.test(String(metadata.version))) {
        error(skillMd, `metadata.version \`${metadata.version}\` must be quoted semver, e.g. "1.0.0"`);
      }
      if (metadata.archetype === undefined) {
        error(skillMd, `metadata.archetype is required (one of: ${[...ARCHETYPES].join(', ')})`);
      } else if (!ARCHETYPES.has(String(metadata.archetype))) {
        error(
          skillMd,
          `metadata.archetype \`${metadata.archetype}\` is not one of: ${[...ARCHETYPES].join(', ')}`,
        );
      }
    }
  } else {
    error(skillMd, `metadata block is required (needs at least archetype and version)`);
  }

  // --- body size (progressive disclosure) ---
  const bodyLines = body.split('\n').length;
  if (bodyLines > BODY_LINES_MAX) {
    error(
      skillMd,
      `body is ${bodyLines} lines; max ${BODY_LINES_MAX}. Move detail into references/ and link to it.`,
    );
  } else if (bodyLines > BODY_LINES_WARN) {
    warn(skillMd, `body is ${bodyLines} lines; consider moving detail into references/ (soft limit ${BODY_LINES_WARN})`);
  }

  if (!/^#\s+\S/m.test(body)) {
    warn(skillMd, 'body has no top-level `# Heading`');
  }

  // --- local references resolve ---
  for (const ref of extractLocalRefs(body)) {
    const target = join(skillDir, ref);
    if (!existsSync(target)) {
      error(skillMd, `broken local reference \`${ref}\` — no such file in the skill directory`);
      continue;
    }
    if (ref.startsWith('../')) {
      error(
        skillMd,
        `reference \`${ref}\` escapes the skill directory. Skills install standalone, so cross-skill references break at install time.`,
      );
    }
  }

  // --- scripts are runnable ---
  const scriptsDir = join(skillDir, 'scripts');
  if (existsSync(scriptsDir)) {
    for (const entry of readdirSync(scriptsDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const scriptPath = join(scriptsDir, entry.name);
      const head = readFileSync(scriptPath, 'utf8').slice(0, 128);
      if (!head.startsWith('#!')) {
        error(scriptPath, 'script is missing a shebang line');
      }
      if (entry.name.endsWith('.sh') && !/^#!.*\bbash\b/.test(head)) {
        error(scriptPath, 'bash scripts must use a `#!/usr/bin/env bash` (or /bin/bash) shebang');
      }
      if (entry.name.endsWith('.sh') && !/set -[eu]/.test(readFileSync(scriptPath, 'utf8'))) {
        warn(scriptPath, 'bash script does not `set -euo pipefail`');
      }
      if (entry.name.endsWith('.js')) {
        error(scriptPath, 'use the .mjs extension for Node scripts so they load as ES modules');
      }
      const mode = statSync(scriptPath).mode & 0o111;
      if (!mode) {
        warn(scriptPath, 'script is not executable (`chmod +x`)');
      }
    }
  }

  // --- mutation safety contract ---
  if (metadata && String(metadata.archetype) === 'mutation') {
    checkMutationContract(skillMd, skillDir, body);
  }

  return { name, description, path: relative(REPO_ROOT, skillDir), metadata: metadata ?? {} };
}

/**
 * Enforces the machine-checkable parts of the mutation safety contract in
 * AGENTS.md. A mutation skill writes to a customer's live helpdesk, usually with
 * no undo, so these are errors rather than warnings.
 */
function checkMutationContract(skillMd, skillDir, body) {
  const scriptsDir = join(skillDir, 'scripts');
  if (!existsSync(scriptsDir)) {
    error(skillMd, 'mutation skills must ship a script; prose cannot enforce a dry-run default');
    return;
  }

  const scripts = readdirSync(scriptsDir, { withFileTypes: true })
    .filter((e) => e.isFile() && /\.(mjs|sh)$/.test(e.name))
    .map((e) => join(scriptsDir, e.name));
  const source = scripts.map((p) => readFileSync(p, 'utf8')).join('\n');

  // Rule 1: dry-run by default, --apply explicit.
  if (!/--apply/.test(body)) {
    error(skillMd, 'mutation body must document `--apply`; writes must never be the default');
  }
  if (!/dry[ -]run/i.test(body)) {
    error(skillMd, 'mutation body must document the dry-run default');
  }
  if (!/--apply/.test(source)) {
    error(skillMd, 'no `--apply` flag found in scripts/ — the write path must be opt-in');
  }
  // A --force/--yes that bypasses the plan is exactly what the contract forbids.
  if (/--force\b/.test(source)) {
    error(
      skillMd,
      'scripts must not offer `--force`. Destruction must never be the convenient path; ' +
        'raise --max-changes deliberately instead.',
    );
  }

  // Rule 3: append-only audit log.
  if (!/audit/i.test(source)) {
    error(skillMd, 'no audit log found in scripts/ — every attempted change must be recorded');
  }

  // Rule 4: idempotent and resumable.
  if (!/resume|already applied|journal/i.test(source)) {
    error(
      skillMd,
      'scripts show no resume/idempotency handling — an interrupted mutation must not double-apply',
    );
  }

  // Rule 5: bounded blast radius.
  if (!/max-?changes/i.test(source)) {
    error(skillMd, 'scripts must support a bounded `--max-changes` blast radius');
  }

  // Rule 6: reversibility stated in prose.
  if (!/(irreversible|cannot be undone|reversib|not recoverable|unrecoverable)/i.test(body)) {
    error(
      skillMd,
      'mutation body must state plainly what can and cannot be undone, above the usage section',
    );
  }

  // Required Safety section.
  if (!/^##+\s+(safety|guardrails|before you run)/im.test(body)) {
    error(skillMd, 'mutation body needs a `## Safety` (or Guardrails) section');
  }

  // Rule 2: plan-first. Either it consumes a plan file or it emits one to re-apply.
  if (!/plan/i.test(body)) {
    error(
      skillMd,
      'mutation body must describe the plan-first flow: deciding and doing are separate steps',
    );
  }
}

function validateManifest(skills) {
  if (!existsSync(CATALOG_MANIFEST)) {
    warn(CATALOG_MANIFEST, 'skills.sh.json is missing; the catalog will render ungrouped');
    return;
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(CATALOG_MANIFEST, 'utf8'));
  } catch (err) {
    error(CATALOG_MANIFEST, `invalid JSON: ${err.message}`);
    return;
  }

  const known = new Set(skills.map((s) => s.name));
  const grouped = new Set();

  for (const group of manifest.groupings ?? []) {
    if (!group.title) error(CATALOG_MANIFEST, 'a grouping is missing `title`');
    for (const name of group.skills ?? []) {
      if (!known.has(name)) {
        error(CATALOG_MANIFEST, `grouping "${group.title}" lists unknown skill \`${name}\``);
      }
      if (grouped.has(name)) {
        error(CATALOG_MANIFEST, `skill \`${name}\` appears in more than one grouping`);
      }
      grouped.add(name);
    }
  }

  for (const skill of skills) {
    if (!grouped.has(skill.name)) {
      warn(CATALOG_MANIFEST, `skill \`${skill.name}\` is not in any grouping`);
    }
  }
}

// --- run ---

const skillFiles = findSkills(SKILLS_DIR).sort();
if (skillFiles.length === 0) {
  error(SKILLS_DIR, 'no SKILL.md files found under skills/');
}

const seenNames = new Map();
const skills = skillFiles.map((f) => validateSkill(f, seenNames)).filter(Boolean);
validateManifest(skills);

const errors = findings.filter((f) => f.level === 'error');
const warnings = findings.filter((f) => f.level === 'warning');

if (JSON_OUT) {
  console.log(JSON.stringify({ skills, findings }, null, 2));
} else {
  for (const f of findings) {
    const label = f.level === 'error' ? 'error' : 'warn ';
    console.error(`${label}  ${f.file}\n       ${f.message}`);
  }
  console.error('');
  const archetypes = skills.reduce((acc, s) => {
    const a = s.metadata.archetype ?? 'unknown';
    acc[a] = (acc[a] ?? 0) + 1;
    return acc;
  }, {});
  const breakdown = Object.entries(archetypes)
    .sort()
    .map(([k, v]) => `${v} ${k}`)
    .join(', ');
  console.error(
    `${skills.length} skill(s) validated${breakdown ? ` (${breakdown})` : ''} — ${errors.length} error(s), ${warnings.length} warning(s)`,
  );
}

const failed = errors.length > 0 || (STRICT && warnings.length > 0);
process.exit(failed ? 1 : 0);
