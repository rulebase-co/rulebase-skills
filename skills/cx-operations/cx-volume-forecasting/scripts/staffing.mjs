#!/usr/bin/env node
/**
 * Staffing calculator for support channels, plus an honest account of which of
 * its own assumptions your situation violates.
 *
 * Three modes, because the three channel types are genuinely different problems:
 *
 *   voice   Erlang C — a queue with abandonment ignored. Standard, and wrong in
 *           known ways that this tool reports rather than hides.
 *   chat    Erlang C on concurrency-adjusted capacity. An approximation.
 *   async   Little's Law on backlog and throughput. Email and tickets are not
 *           an Erlang problem at all.
 *
 * Erlang B is computed by the stable recurrence rather than factorials, so large
 * agent counts do not overflow.
 *
 * No npm dependencies. Node 20+.
 */

const MODES = ['voice', 'chat', 'async'];

function parseArgs(argv) {
  const opts = {
    mode: 'voice',
    contacts: null,
    interval: 30,
    aht: null,
    target: 20,
    serviceLevel: 0.8,
    shrinkage: 0.3,
    concurrency: 1,
    agents: null,
    backlogHours: null,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) fail(`${arg} requires a value`);
      return v;
    };
    switch (arg) {
      case '--mode': opts.mode = next(); break;
      case '--contacts': opts.contacts = Number(next()); break;
      case '--interval': opts.interval = Number(next()); break;
      case '--aht': opts.aht = Number(next()); break;
      case '--target': opts.target = Number(next()); break;
      case '--service-level': opts.serviceLevel = Number(next()); break;
      case '--shrinkage': opts.shrinkage = Number(next()); break;
      case '--concurrency': opts.concurrency = Number(next()); break;
      case '--agents': opts.agents = Number(next()); break;
      case '--backlog-hours': opts.backlogHours = Number(next()); break;
      case '--json': opts.json = true; break;
      case '--help': case '-h': usage(); process.exit(0);
      default: fail(`unknown argument: ${arg}`);
    }
  }

  if (!MODES.includes(opts.mode)) fail(`--mode must be one of: ${MODES.join(', ')}`);
  if (!Number.isFinite(opts.contacts) || opts.contacts <= 0) {
    fail('--contacts is required and must be a positive number');
  }
  if (!Number.isFinite(opts.aht) || opts.aht <= 0) {
    fail('--aht is required and must be a positive number of seconds');
  }
  if (!Number.isFinite(opts.interval) || opts.interval <= 0) fail('--interval must be positive');
  if (!(opts.serviceLevel > 0 && opts.serviceLevel < 1)) {
    fail('--service-level must be between 0 and 1 exclusive (e.g. 0.8 for 80%)');
  }
  if (!(opts.shrinkage >= 0 && opts.shrinkage < 1)) {
    fail('--shrinkage must be between 0 and 1 exclusive of 1 (e.g. 0.3 for 30%)');
  }
  if (opts.mode === 'chat' && !(opts.concurrency >= 1)) {
    fail('--concurrency must be at least 1');
  }
  if (opts.mode === 'async' && !Number.isFinite(opts.backlogHours)) {
    // Async mode answers "what throughput do I need"; a target turnaround is
    // required for that to mean anything.
    fail('--backlog-hours is required in async mode (the turnaround you are promising)');
  }
  return opts;
}

function usage() {
  process.stderr.write(`
Usage: node scripts/staffing.mjs --mode <voice|chat|async> --contacts <n> --aht <seconds> [options]

  --mode <m>            voice (Erlang C) | chat (concurrency-adjusted) |
                        async (Little's Law). Default voice.
  --contacts <n>        Contacts arriving in the interval.
  --aht <seconds>       Average handling time, including after-contact work.
  --interval <minutes>  Interval length. Default 30.
  --target <seconds>    Answer-time target for the service level. Default 20.
  --service-level <p>   Target service level as a fraction. Default 0.8.
  --shrinkage <p>       Fraction of paid time not available for contacts.
                        Default 0.30.
  --concurrency <n>     Chat mode: simultaneous conversations per agent.
  --agents <n>          Evaluate this staffing level instead of solving for it.
  --backlog-hours <h>   Async mode: the turnaround time you are promising.
  --json                Emit only JSON on stdout.

Examples:
  # 250 calls in 30 minutes, 300s AHT, 80/20 target, 30% shrinkage
  node scripts/staffing.mjs --mode voice --contacts 250 --aht 300

  # What does 40 agents actually deliver?
  node scripts/staffing.mjs --mode voice --contacts 250 --aht 300 --agents 40

  # Chat at 3 concurrent conversations per agent
  node scripts/staffing.mjs --mode chat --contacts 400 --aht 600 --concurrency 3

  # Email: 5,000 tickets/day, 8 minute handle time, 24h promise
  node scripts/staffing.mjs --mode async --contacts 5000 --aht 480 \\
      --interval 1440 --backlog-hours 24
`);
}

function fail(message) {
  process.stderr.write(`error: ${message}\n`);
  process.exit(1);
}

/**
 * Erlang B by the stable recurrence:
 *   B(0, A) = 1
 *   B(n, A) = A·B(n-1, A) / (n + A·B(n-1, A))
 *
 * The textbook A^N/N! form overflows for realistic contact-centre sizes; this
 * form does not.
 */
export function erlangB(agents, load) {
  let b = 1;
  for (let n = 1; n <= agents; n++) {
    b = (load * b) / (n + load * b);
  }
  return b;
}

/** Erlang C — the probability a contact has to wait at all. */
export function erlangC(agents, load) {
  if (agents <= load) return 1; // Unstable: arrivals exceed capacity.
  const b = erlangB(agents, load);
  const denominator = 1 - (load / agents) * (1 - b);
  if (denominator <= 0) return 1;
  return b / denominator;
}

/**
 * Service level: the fraction answered within `targetSeconds`.
 *   SL = 1 - C · e^(-(N-A)·t/AHT)
 */
export function serviceLevel(agents, load, ahtSeconds, targetSeconds) {
  if (agents <= load) return 0;
  const c = erlangC(agents, load);
  return 1 - c * Math.exp((-(agents - load) * targetSeconds) / ahtSeconds);
}

/** Average speed of answer, over all contacts including those not queued. */
export function averageSpeedOfAnswer(agents, load, ahtSeconds) {
  if (agents <= load) return Infinity;
  return (erlangC(agents, load) * ahtSeconds) / (agents - load);
}

function evaluate(agents, load, ahtSeconds, targetSeconds) {
  return {
    agents,
    service_level: Number(serviceLevel(agents, load, ahtSeconds, targetSeconds).toFixed(4)),
    probability_of_waiting: Number(erlangC(agents, load).toFixed(4)),
    average_speed_of_answer_seconds: Number(
      averageSpeedOfAnswer(agents, load, ahtSeconds).toFixed(1),
    ),
    occupancy: Number((load / agents).toFixed(4)),
  };
}

/** Smallest agent count meeting the target service level. */
function solveAgents(load, ahtSeconds, targetSeconds, targetSl) {
  let agents = Math.max(1, Math.floor(load));
  // Guard against a runaway loop on pathological input.
  const ceiling = Math.ceil(load * 10) + 1000;
  while (agents < ceiling) {
    if (serviceLevel(agents, load, ahtSeconds, targetSeconds) >= targetSl) return agents;
    agents++;
  }
  return null;
}

/** Assumptions Erlang C makes, and whether this scenario plausibly breaks them. */
function assumptionWarnings(opts, { load, occupancy }) {
  const warnings = [];

  warnings.push(
    'Erlang C assumes no abandonment: every contact waits indefinitely. Real queues lose ' +
      'customers, so Erlang C over-states the staff needed for voice — often by 5-15% at ' +
      'long wait times. Erlang A models abandonment if you have abandon-rate data.',
  );
  warnings.push(
    'Erlang C assumes Poisson (memoryless, independent) arrivals. Marketing sends, outages ' +
      'and product releases create correlated bursts that no Erlang model captures. Size ' +
      'peaks from your own interval history, not from a daily average.',
  );

  if (occupancy > 0.85) {
    warnings.push(
      `Occupancy is ${(occupancy * 100).toFixed(1)}%. Sustained occupancy above ~85% drives ` +
        'burnout and attrition, which raises both AHT and volume. Treat this result as ' +
        'infeasible rather than efficient.',
    );
  }
  if (opts.mode === 'chat') {
    warnings.push(
      `Chat mode divides required capacity by a concurrency of ${opts.concurrency}. This is an ` +
        'approximation: concurrency raises AHT per conversation, and the relationship is ' +
        'non-linear. Measure your own AHT at each concurrency level rather than assuming it ' +
        'is constant.',
    );
  }
  if (opts.mode === 'async') {
    warnings.push(
      "Async mode uses Little's Law and says nothing about intraday service level. Email and " +
        'tickets are a throughput-and-backlog problem, not a queue-wait problem.',
    );
  }
  if (load < 1) {
    warnings.push(
      `Offered load is only ${load.toFixed(2)} erlangs. Erlang formulas are unreliable at very ` +
        'low volumes; at this scale staffing is driven by coverage (someone must be present) ' +
        'rather than by queueing.',
    );
  }
  if (opts.shrinkage < 0.2) {
    warnings.push(
      `Shrinkage of ${(opts.shrinkage * 100).toFixed(0)}% is low. Real-world shrinkage — holiday, ` +
        'sickness, breaks, training, meetings, coaching, system downtime — is typically 30-35%. ' +
        'Under-stating it is the most common cause of a plan that cannot be met.',
    );
  }

  return warnings;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));

  const intervalSeconds = opts.interval * 60;
  const arrivalRate = opts.contacts / intervalSeconds; // contacts per second
  // Offered load in erlangs. For chat, concurrency divides the load an agent
  // represents rather than changing the work itself.
  const rawLoad = arrivalRate * opts.aht;
  const load = opts.mode === 'chat' ? rawLoad / opts.concurrency : rawLoad;

  const report = {
    inputs: {
      mode: opts.mode,
      contacts: opts.contacts,
      interval_minutes: opts.interval,
      aht_seconds: opts.aht,
      target_seconds: opts.target,
      target_service_level: opts.serviceLevel,
      shrinkage: opts.shrinkage,
      concurrency: opts.mode === 'chat' ? opts.concurrency : null,
    },
    offered_load_erlangs: Number(load.toFixed(3)),
  };

  if (opts.mode === 'async') {
    // Little's Law: L = λW. Required concurrent capacity to hold the promised
    // turnaround, converted to agents via handling time.
    const promisedSeconds = opts.backlogHours * 3600;
    const workSecondsPerSecond = arrivalRate * opts.aht;
    const productiveAgents = Math.ceil(workSecondsPerSecond);
    const rostered = Math.ceil(productiveAgents / (1 - opts.shrinkage));
    const throughputPerAgentPerInterval = intervalSeconds / opts.aht;

    report.async = {
      promised_turnaround_hours: opts.backlogHours,
      contacts_per_hour: Number((arrivalRate * 3600).toFixed(1)),
      throughput_per_agent_per_interval: Number(throughputPerAgentPerInterval.toFixed(1)),
      productive_agents_required: productiveAgents,
      rostered_agents_required: rostered,
      // Steady state only: this says nothing about clearing an existing backlog.
      steady_state_backlog_contacts: Math.ceil(arrivalRate * promisedSeconds),
      note:
        'Throughput must exceed arrivals or the backlog grows without bound. Meeting a ' +
        'turnaround promise on an existing backlog needs extra capacity beyond this figure.',
    };
    report.assumptions = assumptionWarnings(opts, { load, occupancy: 1 });
  } else {
    const solved =
      opts.agents !== null
        ? opts.agents
        : solveAgents(load, opts.aht, opts.target, opts.serviceLevel);

    if (solved === null) {
      fail('could not find a feasible agent count; check --contacts, --aht and --interval');
    }
    if (solved <= load) {
      report.warning =
        `${solved} agents is at or below the offered load of ${load.toFixed(2)} erlangs. The queue ` +
        'is unstable: waits grow without bound and service level is effectively zero.';
    }

    const at = evaluate(solved, load, opts.aht, opts.target);
    report.result = {
      ...at,
      productive_agents_required: solved,
      rostered_agents_required: Math.ceil(solved / (1 - opts.shrinkage)),
      shrinkage_uplift_agents: Math.ceil(solved / (1 - opts.shrinkage)) - solved,
      solved_for: opts.agents !== null ? 'given agent count' : 'target service level',
    };

    // The marginal-agent table is the most decision-useful output: it shows
    // where added headcount stops buying service level.
    report.sensitivity = [];
    for (let delta = -2; delta <= 3; delta++) {
      const n = solved + delta;
      if (n < 1) continue;
      report.sensitivity.push(evaluate(n, load, opts.aht, opts.target));
    }

    report.assumptions = assumptionWarnings(opts, { load, occupancy: at.occupancy });
  }

  if (!opts.json) process.stderr.write(render(report));
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
}

function render(report) {
  const pct = (v) => `${(v * 100).toFixed(1)}%`;
  const lines = [''];

  lines.push(`mode: ${report.inputs.mode}`);
  lines.push(
    `${report.inputs.contacts} contacts / ${report.inputs.interval_minutes} min, ` +
      `AHT ${report.inputs.aht_seconds}s`,
  );
  lines.push(`offered load: ${report.offered_load_erlangs} erlangs`);
  lines.push('');

  if (report.warning) {
    lines.push(`WARNING: ${report.warning}`);
    lines.push('');
  }

  if (report.async) {
    const a = report.async;
    lines.push(`promised turnaround:      ${a.promised_turnaround_hours}h`);
    lines.push(`contacts per hour:        ${a.contacts_per_hour}`);
    lines.push(`throughput per agent:     ${a.throughput_per_agent_per_interval} per interval`);
    lines.push(`productive agents needed: ${a.productive_agents_required}`);
    lines.push(
      `rostered agents needed:   ${a.rostered_agents_required}  ` +
        `(at ${pct(report.inputs.shrinkage)} shrinkage)`,
    );
    lines.push(`steady-state backlog:     ${a.steady_state_backlog_contacts} contacts`);
    lines.push('');
    lines.push(`  ${a.note}`);
  } else {
    const r = report.result;
    lines.push(`solved for: ${r.solved_for}`);
    lines.push(`productive agents needed: ${r.productive_agents_required}`);
    lines.push(
      `rostered agents needed:   ${r.rostered_agents_required}  ` +
        `(+${r.shrinkage_uplift_agents} for ${pct(report.inputs.shrinkage)} shrinkage)`,
    );
    lines.push('');
    lines.push(
      `  service level:  ${pct(r.service_level)} answered within ${report.inputs.target_seconds}s`,
    );
    lines.push(`  P(wait):        ${pct(r.probability_of_waiting)}`);
    lines.push(`  ASA:            ${r.average_speed_of_answer_seconds}s`);
    lines.push(`  occupancy:      ${pct(r.occupancy)}`);
    lines.push('');
    lines.push('  marginal agents');
    lines.push('    agents   SL      ASA      occupancy');
    for (const row of report.sensitivity) {
      lines.push(
        `    ${String(row.agents).padStart(6)}   ${pct(row.service_level).padStart(6)}  ` +
          `${String(row.average_speed_of_answer_seconds).padStart(7)}s  ` +
          `${pct(row.occupancy).padStart(8)}`,
      );
    }
  }

  lines.push('');
  lines.push('  assumptions and caveats');
  for (const warning of report.assumptions) lines.push(`    - ${warning}`);
  lines.push('');

  return lines.join('\n');
}

if (process.argv[1] && process.argv[1].endsWith('staffing.mjs')) {
  main();
}
