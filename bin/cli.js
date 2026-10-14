#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { fetchCompanyJobs, filterJobs, detectAts, toCsv, CSV_FIELDS, ATS_LIST } from '../src/ats.js';

const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'));

const HELP = `ats-jobs-mcp ${pkg.version} - open jobs from public Greenhouse, Lever and Ashby job boards

Usage:
  ats-jobs-mcp jobs <company-slug|board-url> [options]
  ats-jobs-mcp detect <company-slug|board-url>
  ats-jobs-mcp mcp                       Run as an MCP server over stdio

Options for "jobs":
  --ats <greenhouse|lever|ashby>  Only check this ATS (default: check all, pick the board with most jobs)
  --q, --query <text>             Keyword filter on title/department/team/location
                                  (spaces = AND, commas = OR: "backend engineer, sre")
  --remote                        Remote jobs only
  --location <text>               Location substring, e.g. "London"
  --days <n>                      Only jobs posted in the last n days
  --limit <n>                     Max rows to print
  --json                          JSON output (array of jobs)
  --csv                           CSV output
  --descriptions                  Include plain-text descriptions (JSON/CSV only)

Examples:
  npx github:benkrasin/ats-jobs-mcp jobs ramp --ats ashby
  npx github:benkrasin/ats-jobs-mcp jobs airbnb --q engineer --remote --csv > airbnb.csv
  npx github:benkrasin/ats-jobs-mcp detect notion
`;

function parseArgs(argv) {
  const opts = { _: [] };
  const valued = new Set(['ats', 'q', 'query', 'location', 'days', 'limit']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      let [k, v] = a.slice(2).split(/=(.*)/s);
      if (valued.has(k)) {
        if (v === undefined) v = argv[++i];
        if (v === undefined) throw new Error(`--${k} needs a value`);
        opts[k] = v;
      } else opts[k] = true;
    } else if (a === '-h') opts.help = true;
    else if (a === '-v') opts.version = true;
    else opts._.push(a);
  }
  return opts;
}

function pad(s, n) {
  s = String(s ?? '');
  return s.length > n ? s.slice(0, n - 1) + '…' : s.padEnd(n);
}

function printTable(jobs) {
  const cols = [['title', 44], ['location', 24], ['remote', 6], ['workplaceType', 7], ['department', 20], ['postedAt', 10]];
  console.log(cols.map(([c, n]) => pad(c === 'workplaceType' ? 'type' : c, n)).join('  ') + '  url');
  for (const j of jobs) {
    console.log(cols.map(([c, n]) => pad(c === 'remote' ? (j.remote ? 'yes' : '') : c === 'postedAt' ? (j.postedAt || '').slice(0, 10) : j[c], n)).join('  ') + '  ' + j.url);
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const [cmd, target] = opts._;
  if (opts.version) return console.log(pkg.version);
  if (opts.help || !cmd || cmd === 'help') return process.stdout.write(HELP);

  if (cmd === 'mcp') {
    const { startServer } = await import('../src/mcp.js');
    return startServer({ name: pkg.name, version: pkg.version });
  }

  if (!target) throw new Error(`Missing company slug. Example: ats-jobs-mcp ${cmd} ramp`);
  if (opts.ats && !ATS_LIST.includes(String(opts.ats).toLowerCase())) throw new Error(`--ats must be one of: ${ATS_LIST.join(', ')}`);

  if (cmd === 'detect') {
    const res = await detectAts(target, opts.ats);
    if (opts.json) return console.log(JSON.stringify(res, null, 2));
    for (const r of res) console.log(`${pad(r.ats, 11)} ${r.exists ? `found     ${String(r.jobCount).padStart(5)} jobs  ${r.boardUrl}` : r.error ? `error     ${r.error}` : 'not found'}`);
    if (!res.some((r) => r.exists)) process.exitCode = 2;
    return;
  }

  if (cmd === 'jobs') {
    const r = await fetchCompanyJobs(target, { ats: opts.ats, descriptions: !!opts.descriptions });
    if (!r.ats) {
      console.error(`No Greenhouse, Lever or Ashby job board found for "${r.slug}" (checked: ${r.checked.join(', ')}).`);
      console.error('Tip: use the slug from the careers URL, e.g. jobs.ashbyhq.com/<slug>, jobs.lever.co/<slug>, boards.greenhouse.io/<slug>.');
      process.exitCode = 2;
      return;
    }
    let jobs = filterJobs(r.jobs, { query: opts.q ?? opts.query, remote: opts.remote ? true : undefined, location: opts.location, postedWithinDays: opts.days });
    const matched = jobs.length;
    if (opts.limit) jobs = jobs.slice(0, Math.max(0, Number(opts.limit)));
    if (opts.json) return console.log(JSON.stringify(jobs, null, 2));
    if (opts.csv) return process.stdout.write(toCsv(jobs, opts.descriptions ? [...CSV_FIELDS, 'description'] : CSV_FIELDS));
    printTable(jobs);
    console.error(`\n${matched} matching of ${r.jobs.length} open jobs - ${r.ats}:${r.slug} (${r.boardUrl})${jobs.length < matched ? `, showing ${jobs.length}` : ''}`);
    return;
  }

  throw new Error(`Unknown command "${cmd}". Run with --help.`);
}

main().catch((e) => {
  console.error(`Error: ${e.message}`);
  process.exit(1);
});
