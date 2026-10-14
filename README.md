# ats-jobs-mcp

Look up a company's open jobs from its **Greenhouse, Lever or Ashby** job board, from the command line or from any MCP client (Claude Desktop, Claude Code, Cursor, ...).

- **Zero dependencies.** Plain Node.js 18+, no build step, no API keys.
- **Official public APIs only.** It calls the same public job-board endpoints that the companies' own careers pages use. No HTML scraping, no headless browser, no proxies.
- **One normalized shape** across all three ATSs: `title, company, location, remote, workplaceType, department, team, employmentType, salary, url, postedAt, ats, id`.
- **Slug auto-detect.** Give it `ramp`, `ashby:ramp` or `https://jobs.ashbyhq.com/ramp`; if you don't say which ATS, it checks all three.

Useful for: "which of these 10 companies are hiring a staff backend engineer?", watching a target account's hiring, pulling a company's roles into a spreadsheet, or letting an assistant answer job questions with live data instead of guessing.

## Use it with an MCP client

The server speaks MCP over stdio. It needs Node.js 18+ and network access; `npx` fetches it straight from this GitHub repo.

### Claude Desktop

Add to `claude_desktop_config.json` (Settings -> Developer -> Edit Config), then restart Claude Desktop:

```json
{
  "mcpServers": {
    "ats-jobs": {
      "command": "npx",
      "args": ["-y", "github:benkrasin/ats-jobs-mcp", "mcp"]
    }
  }
}
```

### Claude Code

```sh
claude mcp add ats-jobs -- npx -y github:benkrasin/ats-jobs-mcp mcp
```

### Cursor

Add the same block to `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (per project):

```json
{
  "mcpServers": {
    "ats-jobs": {
      "command": "npx",
      "args": ["-y", "github:benkrasin/ats-jobs-mcp", "mcp"]
    }
  }
}
```

Any other MCP client that can launch a stdio server works the same way.

### Tools

| Tool | Arguments | Returns |
|---|---|---|
| `list_company_jobs` | `slug` (required; slug or board URL), `ats` (`greenhouse`/`lever`/`ashby`), `query`, `remote` (bool), `location`, `posted_within_days`, `include_descriptions`, `limit` (default 100) | Board info, total and matching counts, normalized jobs (newest first) |
| `detect_ats` | `slug` | Which of the three ATSs has a board for that slug, and how many open jobs each has |

`query` matches title, department, team and location. Spaces mean AND, commas mean OR: `"backend engineer, sre"`.

Example prompts: *"Is Ramp hiring remote engineers? Group them by team."* / *"Which ATS does Notion use, and what sales roles are open?"* / *"Compare open data roles at airbnb, palantir and ramp."*

## Use it from the command line

```sh
npx github:benkrasin/ats-jobs-mcp jobs <company-slug|board-url> [--ats greenhouse|lever|ashby] [--q keyword] [--remote] [--location text] [--days n] [--limit n] [--json|--csv]
npx github:benkrasin/ats-jobs-mcp detect <company-slug>
```

Real output (October 2026):

```text
$ npx github:benkrasin/ats-jobs-mcp jobs ramp --ats ashby --q engineer --limit 5
title                                         location                  remote  type     department            postedAt    url
Design Systems Lead                           New York, NY (HQ)         yes     hybrid   Engineering           2026-09-30  https://jobs.ashbyhq.com/ramp/baa94095-...
Tech Lead and Manager (TLM), Production Eng…  New York, NY (HQ)         yes     hybrid   Engineering           2026-09-28  https://jobs.ashbyhq.com/ramp/465799ed-...
Software Engineering Intern, iOS              New York, NY (HQ)         yes     hybrid   Engineering           2026-09-24  https://jobs.ashbyhq.com/ramp/b66be397-...
Software Engineering Intern, Android          New York, NY (HQ)                 onsite   Engineering           2026-09-24  https://jobs.ashbyhq.com/ramp/fcf118cc-...
Software Engineer Internship, Frontend        New York, NY (HQ)         yes     hybrid   Engineering           2026-09-24  https://jobs.ashbyhq.com/ramp/a13ae586-...

43 matching of 162 open jobs - ashby:ramp (https://jobs.ashbyhq.com/ramp), showing 5

$ npx github:benkrasin/ats-jobs-mcp detect notion
greenhouse  not found
lever       not found
ashby       found       130 jobs  https://jobs.ashbyhq.com/notion

$ npx github:benkrasin/ats-jobs-mcp jobs palantir --q "software engineer" --location london --csv --limit 2
title,company,location,remote,workplaceType,department,team,employmentType,salary,url,postedAt,ats,id
Software Engineer – Query Engines,palantir,"London, United Kingdom",false,hybrid,,Dev,Full-time,,https://jobs.lever.co/palantir/4056c8f6-...,2026-09-22T11:06:34.937Z,lever,4056c8f6-...
Forward Deployed Software Engineer - NATO,palantir,"London, United Kingdom",false,onsite,,Delta,Full-time,,https://jobs.lever.co/palantir/73d1a90c-...,2026-07-23T12:53:46.989Z,lever,73d1a90c-...
```

(UUIDs shortened above.) The table summary line goes to stderr, so `--json` and `--csv` output can be piped cleanly. Exit code is `2` when no board is found.

### As a library

```js
import { fetchCompanyJobs, filterJobs } from 'ats-jobs-mcp';
const { ats, jobs } = await fetchCompanyJobs('ramp');
console.log(ats, filterJobs(jobs, { query: 'engineer', remote: true }).length);
```

## Data sources

| ATS | Endpoint |
|---|---|
| Greenhouse | `https://boards-api.greenhouse.io/v1/boards/{slug}/jobs` (+ `/departments` for department names) |
| Lever | `https://api.lever.co/v0/postings/{slug}?mode=json` |
| Ashby | `https://api.ashbyhq.com/posting-api/job-board/{slug}?includeCompensation=true` |

These are the public, unauthenticated job-board APIs the vendors document for publishing job listings. Requests go directly from your machine to those endpoints; nothing passes through any other server.

## Limitations

- **You need the board slug.** It's usually the company name, but not always (check the careers URL: `jobs.ashbyhq.com/<slug>`, `jobs.lever.co/<slug>`, `boards.greenhouse.io/<slug>`). Companies on other ATSs (Workday, SmartRecruiters, iCIMS, custom pages, ...) are not supported.
- **"remote" is a best effort.** Lever and Ashby expose a workplace type; Greenhouse doesn't, so remote there is inferred from the location text. Ashby marks a job remote when *any* of its locations is remote (e.g. a hybrid NYC role also open to "Remote (US)"); `workplaceType` shows the primary arrangement.
- **Fields vary by ATS.** Greenhouse has no team, employment type or salary in this API; salary only appears when the company publishes it (mostly Ashby, sometimes Lever). `postedAt` is the first-published/created date reported by the ATS, which companies sometimes reset by reposting.
- **Lever EU boards** (`api.eu.lever.co`) aren't queried yet.
- **No caching or rate limiting.** It's meant for interactive lookups of a handful of companies, not crawling thousands. Be polite with the public APIs.
- If the same slug exists on more than one ATS (e.g. an old, empty board), the board with the most open jobs wins; pass `--ats` / `ats` to force one.

## Need the whole market at once?

This tool answers questions about one company at a time. If you want a snapshot across many companies without running lookups yourself, there is a paid dataset built from the same public sources: **[startup-hiring-data](https://benkrasin.github.io/startup-hiring-data/)**

- a $19 normalized CSV of 32,510 open roles from 390 startups, and
- a $49 company-level hiring-signals file aimed at GTM / sales teams.

It's a point-in-time snapshot, not a live feed; see the page for exactly what's included. This repo stays free and MIT-licensed either way.

## Development

```sh
git clone https://github.com/benkrasin/ats-jobs-mcp && cd ats-jobs-mcp
npm test          # live smoke test: three ATSs + an MCP stdio session (needs network)
node bin/cli.js jobs airbnb --limit 5
```

The MCP server (`src/mcp.js`) is a small, dependency-free implementation of the MCP stdio transport (newline-delimited JSON-RPC 2.0: `initialize`, `ping`, `tools/list`, `tools/call`). It has also been checked against the official `@modelcontextprotocol/sdk` client.

## About

Built and maintained by an AI agent (Claude, by Anthropic) as part of an experiment in agent-run open-source projects, on behalf of [@benkrasin](https://github.com/benkrasin). Issues and PRs are welcome; a human reviews the account.

## License

MIT
