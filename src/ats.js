// Fetch open jobs from the official, public job-board APIs of Greenhouse, Lever and Ashby.
// No scraping, no proxies, no API keys. Node >= 18 (global fetch).

export const ATS_LIST = ['greenhouse', 'lever', 'ashby'];

const HEADERS = {
  'user-agent': 'ats-jobs-mcp (+https://github.com/benkrasin/ats-jobs-mcp)',
  accept: 'application/json',
};
const TIMEOUT_MS = 20000;

async function getJson(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { headers: HEADERS, signal: ctrl.signal });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
    return await r.json();
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`${url} -> timed out after ${TIMEOUT_MS / 1000}s`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

const decode = (h) => (h || '')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
const stripHtml = (h) => decode(h).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const looksRemote = (...s) => s.some((x) => /\b(remote|anywhere)\b/i.test(x || ''));
const clean = (s) => (s == null ? null : String(s).replace(/\s+/g, ' ').trim() || null);
const normWorkplace = (w) => {
  const s = String(w || '').toLowerCase().replace(/[^a-z]/g, '');
  return s === 'remote' ? 'remote' : s === 'hybrid' ? 'hybrid' : s === 'onsite' ? 'onsite' : null;
};
const toIso = (v) => {
  if (v == null || v === '') return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

/** Validate a board slug so it can be safely placed in an API URL path. */
export function cleanSlug(slug) {
  const s = String(slug || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(s)) {
    throw new Error(`Invalid company slug "${slug}". Use the board slug, e.g. "ramp" from jobs.ashbyhq.com/ramp.`);
  }
  return s;
}

// Each fetcher returns null if the board does not exist, else an array of normalized jobs.
export const fetchers = {
  async greenhouse(slug, { descriptions = false } = {}) {
    const base = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}`;
    // The jobs list only carries departments when content=true, so fetch the (small) departments index in parallel.
    const [d, deps] = await Promise.all([
      getJson(`${base}/jobs?content=${descriptions}`),
      getJson(`${base}/departments`).catch(() => null),
    ]);
    if (!d || !Array.isArray(d.jobs)) return null;
    const deptOf = new Map();
    for (const dep of deps?.departments || []) for (const j of dep.jobs || []) if (!deptOf.has(j.id)) deptOf.set(j.id, dep.name);
    return d.jobs.map((j) => ({
      ats: 'greenhouse',
      company: j.company_name || slug,
      id: String(j.id),
      title: clean(j.title),
      location: clean(j.location?.name),
      workplaceType: looksRemote(j.location?.name) ? 'remote' : null,
      remote: looksRemote(j.location?.name, j.title),
      department: j.departments?.[0]?.name ?? deptOf.get(j.id) ?? null,
      team: null,
      employmentType: null,
      url: j.absolute_url,
      postedAt: toIso(j.first_published),
      updatedAt: toIso(j.updated_at),
      salary: null,
      ...(descriptions ? { description: stripHtml(j.content) } : {}),
    }));
  },

  async lever(slug, { descriptions = false } = {}) {
    const d = await getJson(`https://api.lever.co/v0/postings/${encodeURIComponent(slug)}?mode=json`);
    if (!Array.isArray(d)) return null;
    return d.map((j) => ({
      ats: 'lever',
      company: slug,
      id: j.id,
      title: clean(j.text),
      location: clean(j.categories?.location),
      workplaceType: normWorkplace(j.workplaceType),
      remote: j.workplaceType === 'remote' || looksRemote(j.categories?.location, ...(j.categories?.allLocations || [])),
      department: j.categories?.department ?? null,
      team: j.categories?.team ?? null,
      employmentType: j.categories?.commitment ?? null,
      url: j.hostedUrl,
      postedAt: toIso(j.createdAt),
      updatedAt: null,
      salary: j.salaryRange
        ? [j.salaryRange.currency, j.salaryRange.min, '-', j.salaryRange.max, j.salaryRange.interval].filter((x) => x != null).join(' ')
        : null,
      ...(descriptions ? { description: j.descriptionPlain ?? stripHtml(j.description) } : {}),
    }));
  },

  async ashby(slug, { descriptions = false } = {}) {
    const d = await getJson(`https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(slug)}?includeCompensation=true`);
    if (!d || !Array.isArray(d.jobs)) return null;
    return d.jobs.filter((j) => j.isListed !== false).map((j) => ({
      ats: 'ashby',
      company: slug,
      id: j.id,
      title: clean(j.title),
      location: clean(j.location),
      workplaceType: normWorkplace(j.workplaceType),
      // Ashby sets isRemote when any of the job's locations is remote (e.g. a hybrid HQ role also open to "Remote (US)").
      remote: !!j.isRemote || j.workplaceType === 'Remote' || looksRemote(j.location),
      department: j.department ?? null,
      team: j.team ?? null,
      employmentType: j.employmentType ?? null,
      url: j.jobUrl,
      postedAt: toIso(j.publishedAt),
      updatedAt: null,
      salary: j.compensation?.compensationTierSummary ?? null,
      ...(descriptions ? { description: j.descriptionPlain ?? stripHtml(j.descriptionHtml) } : {}),
    }));
  },
};

/**
 * Accepts a slug ("ramp"), a prefixed slug ("ashby:ramp") or a board URL
 * ("https://jobs.lever.co/spotify") and returns candidate {ats, slug} pairs.
 */
export function parseCompany(input, ats) {
  let s = String(input || '').trim();
  let m = s.match(/^(greenhouse|lever|ashby):(.+)$/i);
  if (m) return [{ ats: m[1].toLowerCase(), slug: cleanSlug(m[2]) }];
  m = s.match(/(?:boards|job-boards)(?:\.eu)?\.greenhouse\.io\/(?:embed\/job_board\?for=)?([\w.-]+)/i);
  if (m) return [{ ats: 'greenhouse', slug: cleanSlug(m[1]) }];
  m = s.match(/jobs(?:\.eu)?\.lever\.co\/([\w.-]+)/i);
  if (m) return [{ ats: 'lever', slug: cleanSlug(m[1]) }];
  m = s.match(/jobs\.ashbyhq\.com\/([\w.-]+)/i);
  if (m) return [{ ats: 'ashby', slug: cleanSlug(m[1]) }];
  if (/^https?:\/\//i.test(s)) s = s.replace(/^https?:\/\/(www\.)?/i, '').split(/[./]/)[0];
  const slug = cleanSlug(s);
  if (ats) {
    const a = String(ats).toLowerCase();
    if (!ATS_LIST.includes(a)) throw new Error(`Unknown ATS "${ats}". Use one of: ${ATS_LIST.join(', ')}.`);
    return [{ ats: a, slug }];
  }
  return ATS_LIST.map((a) => ({ ats: a, slug }));
}

/** Check every candidate board in parallel. Returns [{ats, slug, exists, jobCount, error?}]. */
export async function detectAts(input, ats) {
  const candidates = parseCompany(input, ats);
  return Promise.all(candidates.map(async (c) => {
    try {
      const jobs = await fetchers[c.ats](c.slug);
      return { ...c, exists: jobs !== null, jobCount: jobs ? jobs.length : 0, boardUrl: boardUrl(c) };
    } catch (e) {
      return { ...c, exists: false, jobCount: 0, error: e.message };
    }
  }));
}

export function boardUrl({ ats, slug }) {
  return {
    greenhouse: `https://job-boards.greenhouse.io/${slug}`,
    lever: `https://jobs.lever.co/${slug}`,
    ashby: `https://jobs.ashbyhq.com/${slug}`,
  }[ats];
}

/**
 * Fetch jobs for a company. If no ATS is given, every ATS is checked and the
 * board with the most open jobs wins (a slug can exist on several, e.g. an old, empty board).
 * Returns {ats, slug, boardUrl, jobs, checked}.
 */
export async function fetchCompanyJobs(input, { ats, descriptions = false } = {}) {
  const candidates = parseCompany(input, ats);
  const errors = [];
  const results = await Promise.all(candidates.map(async (c) => {
    try {
      return { ...c, jobs: await fetchers[c.ats](c.slug, { descriptions }) };
    } catch (e) {
      errors.push(`${c.ats}: ${e.message}`);
      return { ...c, jobs: null };
    }
  }));
  const found = results.filter((r) => r.jobs !== null).sort((a, b) => b.jobs.length - a.jobs.length);
  if (!found.length) {
    if (errors.length) throw new Error(`Could not fetch jobs for "${input}". ${errors.join('; ')}`);
    return { ats: null, slug: candidates[0].slug, boardUrl: null, jobs: [], checked: candidates.map((c) => c.ats) };
  }
  const best = found[0];
  best.jobs.sort((a, b) => (Date.parse(b.postedAt || '') || 0) - (Date.parse(a.postedAt || '') || 0));
  return { ats: best.ats, slug: best.slug, boardUrl: boardUrl(best), jobs: best.jobs, checked: candidates.map((c) => c.ats) };
}

/** Filter by keyword(s) (title, department, team, location), remote flag, location substring, recency. */
export function filterJobs(jobs, { query, remote, location, postedWithinDays } = {}) {
  // "a b" = must contain a AND b; "a b, c" = (a AND b) OR c.
  const groups = String(query || '').toLowerCase().split(/[,|]/)
    .map((g) => g.split(/\s+/).filter(Boolean)).filter((g) => g.length);
  const loc = String(location || '').toLowerCase();
  const cutoff = postedWithinDays ? Date.now() - Number(postedWithinDays) * 864e5 : null;
  return jobs.filter((j) => {
    const hay = [j.title, j.department, j.team, j.location].filter(Boolean).join(' ').toLowerCase();
    if (groups.length && !groups.some((g) => g.every((t) => hay.includes(t)))) return false;
    if (remote === true && !j.remote) return false;
    if (remote === false && j.remote) return false;
    if (loc && !(j.location || '').toLowerCase().includes(loc)) return false;
    if (cutoff) {
      const t = Date.parse(j.postedAt || j.updatedAt || '');
      if (!Number.isFinite(t) || t < cutoff) return false;
    }
    return true;
  });
}

export const CSV_FIELDS = ['title', 'company', 'location', 'remote', 'workplaceType', 'department', 'team', 'employmentType', 'salary', 'url', 'postedAt', 'ats', 'id'];

export function toCsv(jobs, fields = CSV_FIELDS) {
  const esc = (v) => {
    if (v == null) return '';
    const s = String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [fields.join(','), ...jobs.map((j) => fields.map((f) => esc(j[f])).join(','))].join('\n') + '\n';
}
