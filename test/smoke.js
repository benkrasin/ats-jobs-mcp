// Live smoke test: CLI-level library calls + MCP server over stdio. Needs network.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';
import { fetchCompanyJobs, filterJobs, parseCompany, toCsv } from '../src/ats.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let failed = 0;
const check = async (name, fn) => {
  const t = Date.now();
  try { const info = await fn(); console.log(`ok   ${name} ${info ?? ''} (${Date.now() - t}ms)`); }
  catch (e) { failed++; console.log(`FAIL ${name}: ${e.message}`); }
};

// --- offline unit checks
await check('parseCompany', () => {
  assert.deepEqual(parseCompany('https://jobs.lever.co/spotify'), [{ ats: 'lever', slug: 'spotify' }]);
  assert.deepEqual(parseCompany('ashby:ramp'), [{ ats: 'ashby', slug: 'ramp' }]);
  assert.deepEqual(parseCompany('https://job-boards.greenhouse.io/airbnb/jobs/123'), [{ ats: 'greenhouse', slug: 'airbnb' }]);
  assert.equal(parseCompany('figma').length, 3);
  assert.throws(() => parseCompany('../etc'));
});
await check('filterJobs', () => {
  const jobs = [
    { title: 'Backend Engineer', location: 'Remote', remote: true },
    { title: 'Account Executive', location: 'NYC', remote: false, department: 'Sales' },
    { title: 'SRE', location: 'London', remote: false },
  ];
  assert.equal(filterJobs(jobs, { query: 'backend engineer' }).length, 1);
  assert.equal(filterJobs(jobs, { query: 'backend engineer, sre' }).length, 2);
  assert.equal(filterJobs(jobs, { query: 'sales' }).length, 1);
  assert.equal(filterJobs(jobs, { remote: true }).length, 1);
  assert.equal(filterJobs(jobs, { location: 'london' }).length, 1);
});
await check('toCsv escaping', () => {
  assert.equal(toCsv([{ title: 'A, "B"', remote: true }], ['title', 'remote']), 'title,remote\n"A, ""B""",true\n');
});

// --- live API checks
for (const [spec, ats] of [['airbnb', 'greenhouse'], ['palantir', 'lever'], ['ramp', 'ashby']]) {
  await check(`live ${ats}:${spec}`, async () => {
    const r = await fetchCompanyJobs(spec, { ats });
    assert.equal(r.ats, ats);
    assert.ok(r.jobs.length > 0, 'no jobs');
    for (const j of r.jobs) assert.ok(j.title && j.url && j.id, `bad job ${JSON.stringify(j)}`);
    return `jobs=${r.jobs.length} remote=${r.jobs.filter((j) => j.remote).length}`;
  });
}
await check('auto-detect notion', async () => {
  const r = await fetchCompanyJobs('notion');
  assert.ok(r.ats && r.jobs.length > 0);
  return `-> ${r.ats} jobs=${r.jobs.length}`;
});
await check('unknown company', async () => {
  const r = await fetchCompanyJobs('nonexistent-co-xyz-123');
  assert.equal(r.ats, null);
});

// --- MCP server over stdio
await check('mcp stdio', async () => {
  const child = spawn(process.execPath, [join(root, 'bin/cli.js'), 'mcp'], { stdio: ['pipe', 'pipe', 'pipe'] });
  const waiters = new Map();
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      const msg = JSON.parse(line); // every stdout line must be valid JSON-RPC
      waiters.get(msg.id)?.(msg);
    }
  });
  let nextId = 1;
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 60000);
    waiters.set(id, (m) => { clearTimeout(timer); resolve(m); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  try {
    const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } });
    assert.equal(init.result.protocolVersion, '2025-06-18');
    assert.ok(init.result.capabilities.tools);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const list = await rpc('tools/list', {});
    assert.deepEqual(list.result.tools.map((t) => t.name).sort(), ['detect_ats', 'list_company_jobs']);
    const call = await rpc('tools/call', { name: 'list_company_jobs', arguments: { slug: 'ramp', ats: 'ashby', query: 'engineer', limit: 3 } });
    assert.equal(call.result.isError, false);
    const payload = JSON.parse(call.result.content[0].text);
    assert.ok(payload.returned <= 3 && payload.matchingJobs > 0);
    const det = await rpc('tools/call', { name: 'detect_ats', arguments: { slug: 'palantir' } });
    assert.deepEqual(JSON.parse(det.result.content[0].text).found, ['lever']);
    const bad = await rpc('tools/call', { name: 'list_company_jobs', arguments: { slug: 'bad/slug' } });
    assert.equal(bad.result.isError, true);
    const unknown = await rpc('nope/method', {});
    assert.equal(unknown.error.code, -32601);
    return `ramp engineer matches=${payload.matchingJobs}`;
  } finally {
    child.stdin.end();
  }
});

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
