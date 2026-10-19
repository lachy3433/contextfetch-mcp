# @contextfetch/mcp

MCP server for [ContextFetch](https://contextfetch.dev): neural web search and clean, LLM-ready Markdown for AI agents from $0.75 per 1,000 searches. Works with zero signup: no key needed for the free tier.

## Install

**Claude Code** (one line, keyless):

```bash
claude mcp add contextfetch -- npx -y @contextfetch/mcp
```

With a paid key:

```bash
claude mcp add contextfetch -e CONTEXTFETCH_API_KEY=your_key -- npx -y @contextfetch/mcp
```

**Cursor**: add to `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (project):

```json
{
  "mcpServers": {
    "contextfetch": {
      "command": "npx",
      "args": ["-y", "@contextfetch/mcp"],
      "env": { "CONTEXTFETCH_API_KEY": "your_key" }
    }
  }
}
```

**Windsurf**: add to `~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "contextfetch": {
      "command": "npx",
      "args": ["-y", "@contextfetch/mcp"],
      "env": { "CONTEXTFETCH_API_KEY": "your_key" }
    }
  }
}
```

To use the free tier, drop the `env` block (or leave `CONTEXTFETCH_API_KEY` empty). The same JSON works in Claude Desktop's `claude_desktop_config.json` and in any other MCP client that launches stdio servers.

Requires Node.js 18 or newer.

## Tools

| Tool | Arguments | What it does | Cost |
|---|---|---|---|
| `contextfetch_search` | `query`, `num_results` (1-25, default 5), `include_domains?`, `exclude_domains?` | Web search. Each result comes back as title, URL and only the passages relevant to your query (cross-encoder pruned Markdown). | 1 credit |
| `contextfetch_extract_url` | `url`, `query?` | Any public page (docs, articles, GitHub files, arXiv) as clean Markdown with tables kept. With `query`, returns only the relevant passages. | 1 credit |
| `contextfetch_find_similar` | `url`, `num_results` (1-25, default 5) | Pages similar to a URL, excluding its own domain. | 1 credit |
| `contextfetch_research` | `query`, `sub_queries?` (up to 5), `num_results_per_query` (1-10, default 5) | Server-side research: runs the sub-queries concurrently, dedupes pages by URL, ranks them all against `query` with the cross-encoder and returns one Markdown evidence pack (numbered `[n]` sources with their query-pruned passages, quoted verbatim; nothing generated), headed by the sub-queries, source count, tokens and credits used. | 1 credit per sub-query (max 5) |
| `contextfetch_deep_research` | `query`, `sub_queries?` (up to 3), `num_results_per_query` (1-25, default 5; at most 10 used) | The earlier name of `contextfetch_research`, kept for existing setups: same server-side evidence pack, up to 3 sub-queries. | 1 credit per sub-query (max 3) |
| `contextfetch_answer` | `query`, `num_results` (1-10, default 5) | Extractive answer: the best-scoring passages of the top pages, quoted verbatim with `[n]` markers and a numbered source list. No text is generated, so it suits factual lookups more than open-ended questions. | 1 credit |
| `contextfetch_crawl` | `url`, `max_depth` (0-3, default 1), `limit` (1-50, default 10), `query?`, `include_paths?`, `exclude_paths?` (regexes on the URL path) | Crawls one site from `url` (same-site links, robots.txt obeyed) and returns each page as Markdown with its depth. With `query`, pages are ranked by relevance and pruned to the relevant passages. | 1 credit per page returned |
| `contextfetch_map` | `url`, `limit` (1-5,000, default 100), `include_paths?`, `exclude_paths?` | Lists a site's URLs from its sitemaps and the start page's links without fetching the pages. | 1 credit |
| `contextfetch_balance` | none | Remaining credits, burn rate (credits/day over the last 7 days) and auto-reload settings, including the last auto-reload error if a payment failed. Needs `CONTEXTFETCH_API_KEY`. | free |
| `contextfetch_get_free_key` | none | Claims the network's free API key (2,500 searches, one per network) and uses it for the rest of the session. Give it to your user to keep in `CONTEXTFETCH_API_KEY`. | free |
| `contextfetch_auto_reload` | `enabled`, `threshold?` (100-100,000), `pack?` (`instant`, `builder`, `scale`), `monthly_max_usd?` (max 500) | Turns auto-reload on or off or changes it: when credits drop below `threshold`, the card saved at checkout buys `pack` again, up to the monthly cap. Needs `CONTEXTFETCH_API_KEY` and a saved card. The cap cannot go above $500 here. | free |

All tools return Markdown text. Without a key, `contextfetch_balance` and `contextfetch_auto_reload` return a short message saying they need one, with the buy link. On the free tier, results start with a one-line notice showing how many free searches are left today. When the API reports them, a closing line shows latency (total and per stage: recall, fetch, rerank), whether the answer came from cache, and token savings (pruned tokens vs raw page tokens).

### `contextfetch_research` sub-queries

Pass your own `sub_queries` (different angles on the question); the tool description tells the calling model to do so. If you omit them, the API derives them from `query` with fixed rules:

1. the query itself;
2. the query + `documentation`;
3. the query + `benchmark` when it mentions speed, performance, latency, memory or a comparison (`vs`, `compare`), otherwise the query + `example`.

A suffix the query already contains is skipped (so `react useActionState example` runs 2 searches, not 3). The whole research runs server-side in one `/v1/research` call that costs 1 credit per sub-query; a sub-query that fails is refunded and named in the header. If all fail, the tool returns the error.

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `CONTEXTFETCH_API_KEY` | unset | Your API key. Unset or empty uses the free keyless tier. |
| `CONTEXTFETCH_API_BASE` | `https://api.contextfetch.dev` | API base URL. Point it at your own engine if you self-host. |

## Free tier and pricing

| Pack | Price | Credits | Per 1,000 |
|---|---|---|---|
| Keyless trial | $0 | 25 per day per IP | free, no signup |
| Instant | $15 | 15,000 | $1.00 |
| Builder (most popular) | $50 | 60,000 | $0.83 |
| Scale | $150 | 200,000 | $0.75 |

One-time payments; credits never expire. Optional auto-reload re-buys a pack when your balance drops below a threshold, up to a monthly cap.

When credits or the free tier run out (HTTP 402), the tool returns the packs with prices and a one-click buy link each (recommended pack first), plus a line to pass on to your user. Buy links go straight to Stripe Checkout (card, Apple Pay, Google Pay): `https://api.contextfetch.dev/buy/instant`, `/buy/builder`, `/buy/scale`. Then set `CONTEXTFETCH_API_KEY` as shown above.

## Retries and connections

Connection failures before the request is sent (refused, DNS, connect timeout), HTTP 429 and HTTP 5xx are retried with exponential backoff and jitter (about 0.25-0.5 s, then 0.5-1 s), at most 3 attempts per API call and 30 seconds in total, retries included. A 429 or 5xx with a `Retry-After` header waits exactly that long, unless that would pass the 30 second budget. 400, 401, 402, 422 and other 4xx responses are never retried. A connection that drops after the request was sent is not retried either, since the search may already have been billed. Connections are pooled and kept alive by Node's built-in `fetch` (undici), so there is no extra HTTP dependency.

## Errors

Errors never crash the server; they come back as tool results with `isError: true` and a plain explanation: invalid key (401), out of credits or free limit reached (402, lists the packs with their buy links), no saved card for auto-reload (409, with the buy link), URL not allowed (400, only public http(s) URLs), a page `contextfetch_extract_url` could not fetch (with the reason, such as HTTP 404), rate limited (429), server errors (5xx), network failures, and a 30 second limit per call (retries included).

## Develop

```bash
npm install
npm run build          # compiles src/ to dist/ and marks dist/index.js executable
npm test               # builds, then drives dist/index.js over stdio against a local mock API (no network)
CONTEXTFETCH_API_BASE=http://localhost:8000 node dist/index.js
```

## Publish

Publishing `@contextfetch/mcp` needs the npm organization `contextfetch` (create it at npmjs.com and add the publishing account as a member). Then `npm publish` from this folder; `publishConfig.access` is already `public` and `prepublishOnly` builds first.

## License

MIT
