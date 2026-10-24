# Installing ats-jobs-mcp (instructions for AI agents such as Cline)

This is a stdio MCP server with zero dependencies. There is nothing to clone or build: `npx` runs it straight from GitHub.

## Requirements
- Node.js 18 or newer (`node --version`).
- Network access to github.com and the public job-board APIs (boards-api.greenhouse.io, api.lever.co, api.ashbyhq.com).

## Steps
1. Add this server to the MCP settings file (for Cline: `cline_mcp_settings.json`):

```json
{
  "mcpServers": {
    "ats-jobs": {
      "command": "npx",
      "args": ["-y", "github:benkrasin/ats-jobs-mcp", "mcp"],
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

2. Use exactly `github:benkrasin/ats-jobs-mcp`. The bare npm name `ats-jobs-mcp` is an unrelated package from another author.
3. No API key is needed for `list_company_jobs` and `detect_ats`.
4. Optional: `search_jobs_all_companies` (keyword search across 16,000+ company career boards) needs an Apify token. Only add it if the user provides one; never invent a value:

```json
"env": { "APIFY_TOKEN": "<the user's token from https://console.apify.com/settings/integrations>" }
```

Apify bills the user's account about $1 per 1,000 jobs returned; `max_results` (default 100) caps the cost. Tell the user this before adding the token.

## Verify
Ask the server: `detect_ats` with `slug: "ramp"`. It should report an Ashby board with open jobs. Or from a terminal:

```sh
npx -y github:benkrasin/ats-jobs-mcp detect ramp
```
