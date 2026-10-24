// Minimal, dependency-free MCP server over stdio (newline-delimited JSON-RPC 2.0).
// Implements: initialize, ping, tools/list, tools/call (+ ignores notifications).
import { createInterface } from 'node:readline';
import { fetchCompanyJobs, filterJobs, detectAts, ATS_LIST } from './ats.js';

const SUPPORTED_PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

const TOOLS = [
  {
    name: 'list_company_jobs',
    title: 'List company jobs',
    description:
      "List a company's open jobs from its public Greenhouse, Lever or Ashby job board. " +
      'Pass the board slug (e.g. "ramp", "airbnb", "spotify") or a board URL. If ats is omitted, all three ' +
      'ATSs are checked and the board with the most jobs is used. Returns normalized jobs ' +
      '(title, company, location, remote, department, url, postedAt, ats, salary when published).',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'Board slug or URL, e.g. "ramp", "ashby:ramp", "https://jobs.lever.co/spotify".' },
        ats: { type: 'string', enum: ATS_LIST, description: 'Optional. Restrict to one ATS.' },
        query: { type: 'string', description: 'Optional keyword filter on title/department/team/location. Spaces = AND, commas = OR (e.g. "backend engineer, sre").' },
        remote: { type: 'boolean', description: 'Optional. true = remote jobs only, false = non-remote only.' },
        location: { type: 'string', description: 'Optional substring match on location, e.g. "New York".' },
        posted_within_days: { type: 'number', description: 'Optional. Only jobs posted in the last N days (where the ATS exposes a date).' },
        include_descriptions: { type: 'boolean', description: 'Optional. Include plain-text job descriptions (much larger output). Default false.' },
        limit: { type: 'number', description: 'Max jobs to return (default 100, max 1000). The total match count is always reported.' },
      },
      required: ['slug'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: 'detect_ats',
    title: 'Detect ATS',
    description:
      'Find which applicant tracking system (Greenhouse, Lever, Ashby) hosts a company job board for a given slug, ' +
      'and how many open jobs each board has.',
    inputSchema: {
      type: 'object',
      properties: { slug: { type: 'string', description: 'Board slug or URL, e.g. "notion" or "https://jobs.ashbyhq.com/notion".' } },
      required: ['slug'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: 'search_jobs_all_companies',
    title: 'Search jobs across 14,000+ companies',
    description:
      'Keyword search across a built-in directory of 14,000+ public company career boards ' +
      '(Greenhouse, Lever, Ashby, SmartRecruiters, Workable, Personio, Recruitee) when you do not have a company list, ' +
      'e.g. "data engineer jobs in Berlin posted this week" or "ML jobs paying $200k+". Rows include published salary ranges. Runs the hosted ATS Jobs Feed actor on Apify and needs an ' +
      'APIFY_TOKEN env var (a free Apify account works). Takes about a minute. Apify bills about $1 per 1,000 jobs returned; max_results caps the cost.',
    inputSchema: {
      type: 'object',
      properties: {
        keywords: { type: 'array', items: { type: 'string' }, description: 'Keep jobs whose title contains any of these, e.g. ["data engineer", "analytics engineer"].' },
        locations: { type: 'array', items: { type: 'string' }, description: 'Optional. Keep jobs whose location contains any of these, e.g. ["Berlin", "Remote"].' },
        remote_only: { type: 'boolean', description: 'Optional. Remote jobs only.' },
        posted_within_days: { type: 'number', description: 'Optional. Only jobs posted/updated in the last N days (default 14).' },
        min_salary_yearly: { type: 'number', description: 'Optional. Only jobs whose published pay range reaches at least this much per year (job currency; hourly/monthly pay annualised), e.g. 150000. Implies only jobs with a published salary.' },
        only_with_salary: { type: 'boolean', description: 'Optional. Only jobs whose employer published a pay range (about a third of directory jobs).' },
        max_results: { type: 'number', description: 'Max jobs to return and bill (default 100, max 1000; 100 jobs is about $0.10).' },
      },
      required: ['keywords'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
];

const ACTOR_URL = 'https://apify.com/krasyn-side/ats-jobs-feed?utm_source=ats-jobs-mcp';

async function searchAllCompanies(args) {
  const token = process.env.APIFY_TOKEN;
  if (!token) {
    return { text: 'search_jobs_all_companies needs an APIFY_TOKEN environment variable. Create a free Apify account, ' +
      'copy the token from https://console.apify.com/settings/integrations and add "env": {"APIFY_TOKEN": "..."} to this ' +
      `server's MCP config. Cost: about $1 per 1,000 jobs, billed by Apify. Or run it in the browser: ${ACTOR_URL}`, isError: true };
  }
  const keywords = (Array.isArray(args.keywords) ? args.keywords : [args.keywords]).filter(Boolean).map(String);
  if (!keywords.length) throw new Error('"keywords" is required.');
  const maxResults = Math.min(Math.max(1, Number(args.max_results) || 100), 1000);
  const input = {
    searchAllBoards: true, keywords, maxResults,
    locations: Array.isArray(args.locations) ? args.locations.map(String) : [],
    remoteOnly: !!args.remote_only,
    postedWithinDays: Number(args.posted_within_days) || 14,
  };
  if (Number(args.min_salary_yearly) > 0) input.minSalaryYearly = Math.round(Number(args.min_salary_yearly));
  if (args.only_with_salary || input.minSalaryYearly) input.onlyWithSalary = true;
  const res = await fetch('https://api.apify.com/v2/acts/krasyn-side~ats-jobs-feed/run-sync-get-dataset-items?timeout=280&clean=true', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(300_000),
  });
  if (!res.ok) throw new Error(`Apify returned HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const jobs = (await res.json()).slice(0, maxResults);
  const out = { source: ACTOR_URL, input, returned: jobs.length, jobs };
  return { text: JSON.stringify(out, null, 2), structured: out };
}

async function callTool(name, args = {}) {
  if (name === 'search_jobs_all_companies') return searchAllCompanies(args);
  if (name === 'list_company_jobs') {
    if (!args.slug) throw new Error('"slug" is required.');
    const r = await fetchCompanyJobs(args.slug, { ats: args.ats, descriptions: !!args.include_descriptions });
    if (!r.ats) {
      return { text: `No Greenhouse, Lever or Ashby job board found for "${r.slug}" (checked: ${r.checked.join(', ')}). ` +
        'Try the exact slug from the company careers URL, e.g. jobs.ashbyhq.com/<slug>.', isError: false };
    }
    const matched = filterJobs(r.jobs, {
      query: args.query, remote: typeof args.remote === 'boolean' ? args.remote : undefined,
      location: args.location, postedWithinDays: args.posted_within_days,
    });
    const limit = Math.min(Math.max(1, Number(args.limit) || 100), 1000);
    const out = {
      ats: r.ats, slug: r.slug, boardUrl: r.boardUrl,
      totalOpenJobs: r.jobs.length, matchingJobs: matched.length, returned: Math.min(limit, matched.length),
      jobs: matched.slice(0, limit),
    };
    return { text: JSON.stringify(out, null, 2), structured: out };
  }
  if (name === 'detect_ats') {
    if (!args.slug) throw new Error('"slug" is required.');
    const results = await detectAts(args.slug);
    const found = results.filter((x) => x.exists);
    const out = { slug: results[0]?.slug, found: found.map((x) => x.ats), boards: results };
    return { text: JSON.stringify(out, null, 2), structured: out };
  }
  const e = new Error(`Unknown tool: ${name}`);
  e.code = -32602;
  throw e;
}

export function startServer({ name = 'ats-jobs-mcp', version = '0.0.0' } = {}) {
  const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
  const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
  const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });
  // Logs must go to stderr; stdout is reserved for protocol messages.
  const log = (...a) => process.stderr.write(`[ats-jobs-mcp] ${a.join(' ')}\n`);

  async function handle(msg) {
    if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
      if (msg && msg.id !== undefined && !('result' in msg) && !('error' in msg)) fail(msg.id ?? null, -32600, 'Invalid Request');
      return;
    }
    const { id, method, params } = msg;
    const isNotification = id === undefined;
    if (isNotification) return; // notifications/initialized, notifications/cancelled, ...
    try {
      switch (method) {
        case 'initialize': {
          const requested = params?.protocolVersion;
          const protocolVersion = SUPPORTED_PROTOCOLS.includes(requested) ? requested : SUPPORTED_PROTOCOLS[0];
          return reply(id, {
            protocolVersion,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name, version },
            instructions: 'Look up open jobs at a company via its public Greenhouse, Lever or Ashby job board. ' +
              'Use detect_ats when unsure which ATS a company uses; list_company_jobs to get the jobs; ' +
              'search_jobs_all_companies to find matching jobs across 14,000+ companies when there is no company list.',
          });
        }
        case 'ping':
          return reply(id, {});
        case 'tools/list':
          return reply(id, { tools: TOOLS });
        case 'tools/call': {
          const tool = TOOLS.find((t) => t.name === params?.name);
          if (!tool) return fail(id, -32602, `Unknown tool: ${params?.name}`);
          try {
            const r = await callTool(params.name, params.arguments || {});
            const result = { content: [{ type: 'text', text: r.text }], isError: !!r.isError };
            if (r.structured) result.structuredContent = r.structured;
            return reply(id, result);
          } catch (e) {
            // Tool execution errors are reported in-band so the model can see them.
            return reply(id, { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true });
          }
        }
        case 'resources/list':
          return reply(id, { resources: [] });
        case 'prompts/list':
          return reply(id, { prompts: [] });
        default:
          return fail(id, -32601, `Method not found: ${method}`);
      }
    } catch (e) {
      log('internal error:', e.stack || e.message);
      return fail(id, -32603, e.message);
    }
  }

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let pending = 0;
  let closed = false;
  const maybeExit = () => { if (closed && pending === 0) process.exit(0); };
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return fail(null, -32700, 'Parse error'); }
    const batch = Array.isArray(msg) ? msg : [msg];
    for (const m of batch) {
      pending++;
      handle(m).finally(() => { pending--; maybeExit(); });
    }
  });
  rl.on('close', () => { closed = true; maybeExit(); });
  log(`${name} ${version} running on stdio`);
}
