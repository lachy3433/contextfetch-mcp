#!/usr/bin/env node
import { createRequire } from "node:module";
import { setTimeout as sleep } from "node:timers/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };
const API_BASE = (process.env.CONTEXTFETCH_API_BASE?.trim() || "https://api.contextfetch.dev").replace(/\/+$/, "");
// contextfetch_get_free_key swaps in the issued key for the rest of this session.
let API_KEY = process.env.CONTEXTFETCH_API_KEY?.trim() || "keyless";
const BUY_URL = `${API_BASE}/buy/instant`; // one click to Stripe Checkout (AGENT_PROTOCOL.md)
const SEARCH_CONTENTS = { text: true, highlights: true, pruned_context: true };

// Connection reuse needs no agent library: Node's global fetch is undici, whose default global dispatcher is an
// `Agent` that pools sockets per origin and keeps them alive (undici `Client` defaults: keepAliveTimeout 4e3 ms,
// keepAliveMaxTimeout 600e3 ms, pipelining 1). test/stdio.test.mjs asserts that a retry reuses the same socket.
const MAX_ATTEMPTS = 3;
const TOTAL_TIMEOUT_MS = 30_000; // one budget for all attempts and backoff waits
const BACKOFF_BASE_MS = 500;

interface SearchResult {
  url: string;
  depth?: number; // /v1/crawl
  title?: string | null;
  score?: number | null;
  publishedDate?: string | null;
  text?: string | null;
  highlights?: string[] | null;
  prunedContext?: string | null;
}

// Response extension, PHASE2.md decision 9.
interface Extension {
  cache?: "hit" | "miss";
  timingsMs?: { recall?: number; fetch?: number; rerank?: number; total?: number };
  tokens?: { raw?: number | null; pruned?: number | null; savedPct?: number | null };
  sources?: Record<string, number>;
}

interface ApiResponse {
  results?: SearchResult[];
  costDollars?: { total?: number; subQueries?: number; pages?: number };
  notice?: string | null;
  statuses?: { id: string; status: string; error?: { tag?: string; message?: string } }[];
  contextfetch?: Extension | null;
}

// POST /v1/research
interface ResearchResponse extends ApiResponse {
  evidence?: string;
  report?: { markdown?: string };
  subQueries?: { query: string; status: string; results?: number; error?: { error?: string; message?: string } | string }[];
}

// POST /v1/answer (extractive: passages quoted verbatim)
interface AnswerResponse {
  answer?: string;
  citations?: { url: string; title?: string | null }[];
  notice?: string | null;
}

// POST /v1/map
interface MapResponse {
  results?: string[];
  notice?: string | null;
  contextfetch?: { sources?: { sitemap?: number; links?: number } } | null;
}

// GET /v1/balance and POST /v1/billing/auto-reload (AGENT_PROTOCOL.md "Auto-reload")
interface Balance {
  credits?: number;
  burn_rate_per_day?: number;
  auto_reload?: {
    enabled?: boolean;
    threshold?: number;
    pack?: string;
    monthly_max_usd?: number;
    spent_this_month_usd?: number;
    last_error?: string | null;
  } | null;
}

// error body fields (CONTRACT.md section 3, 402 packs in AGENT_PROTOCOL.md)
interface ErrorBody {
  error?: string;
  message?: string;
  detail?: unknown;
  checkout_url?: string;
  packs?: { id: string; name: string; credits: number; price_usd: number; cost_per_1k?: number; recommended?: boolean; checkout_url: string }[];
  action?: { type?: string; url?: string; prompt_to_user?: string };
}

/** Wait before the next attempt: the server's Retry-After (seconds or HTTP date) if sent, else exponential backoff with equal jitter. */
function retryDelayMs(attempt: number, retryAfter: string | null): number {
  if (retryAfter) {
    const secs = Number(retryAfter);
    const at = Number.isFinite(secs) ? Date.now() + secs * 1000 : Date.parse(retryAfter);
    if (!Number.isNaN(at)) return Math.max(0, at - Date.now());
  }
  const cap = BACKOFF_BASE_MS * 2 ** (attempt - 1);
  return cap / 2 + Math.random() * (cap / 2);
}

// Connection failures that happen before the request reaches the server. A failure after that (a reset
// mid-response) may follow a completed, billed request, so it is not retried: a retry would charge twice.
const NOT_SENT = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT"]);

// Thrown errors become `isError: true` tool results inside McpServer, so the process never crashes on API failures.
// Connection failures (NOT_SENT), 429 and 5xx are retried (max 3 attempts, 30 s total); every other status is final.
// The engine refunds the 5xx it sends, and a 429 is not charged. No body = GET.
async function api<T = ApiResponse>(path: string, body?: object): Promise<T> {
  const deadline = Date.now() + TOTAL_TIMEOUT_MS;
  const signal = AbortSignal.timeout(TOTAL_TIMEOUT_MS);
  for (let attempt = 1; ; attempt++) {
    let res: Response | undefined;
    let raw = "";
    let failure: (Error & { cause?: { code?: string; message?: string } }) | undefined;
    try {
      const r = await fetch(`${API_BASE}${path}`, {
        method: body ? "POST" : "GET",
        headers: {
          ...(body && { "Content-Type": "application/json" }),
          Authorization: `Bearer ${API_KEY}`,
          "User-Agent": `contextfetch-mcp/${version}`,
        },
        body: body && JSON.stringify(body),
        signal,
      });
      raw = await r.text();
      res = r;
    } catch (err) {
      failure = err as typeof failure;
      if (failure?.name === "TimeoutError") {
        throw new Error(`The ContextFetch API did not answer within 30 s, retries included (${API_BASE}${path}). Try again in a moment.`);
      }
    }
    const retriable = res ? res.status === 429 || res.status >= 500 : NOT_SENT.has(failure?.cause?.code ?? "");
    if (retriable && attempt < MAX_ATTEMPTS) {
      const wait = retryDelayMs(attempt, res?.headers.get("retry-after") ?? null);
      if (Date.now() + wait < deadline) {
        await sleep(wait);
        continue;
      }
    }
    if (res) return parseResponse<T>(res, raw);
    const reason = failure?.cause?.code ?? failure?.cause?.message ?? failure?.message;
    throw new Error(`Could not reach the ContextFetch API at ${API_BASE} (${reason}). Check your network connection and CONTEXTFETCH_API_BASE.`);
  }
}

function parseResponse<T>(res: Response, raw: string): T {
  let data: (T & ErrorBody) | undefined;
  try {
    data = JSON.parse(raw) as T & ErrorBody;
  } catch {
    data = undefined;
  }
  if (res.ok && data && typeof data === "object") return data;
  if (res.ok) throw new Error(`The ContextFetch API returned an unreadable response (HTTP ${res.status}).`);

  const { status } = res;
  if (status === 401) {
    throw new Error(
      `Invalid CONTEXTFETCH_API_KEY (HTTP 401). Fix the key, or remove CONTEXTFETCH_API_KEY to use the free keyless tier (25 requests/day). Buy a key: ${BUY_URL}`,
    );
  }
  if (status === 402) {
    const reason =
      data?.message ||
      (data?.error === "keyless_limit" ? "Free keyless limit reached (25 requests/day per IP)." : "Your ContextFetch API key is out of credits.");
    // Recommended pack first; sort is stable, so the rest keep the server's order.
    const packs = [...(data?.packs ?? [])].sort((a, b) => Number(!!b.recommended) - Number(!!a.recommended));
    const lines = packs.length
      ? packs.map(
          (p) =>
            `- ${p.name}: $${fmt(p.price_usd)} for ${fmt(p.credits)} credits` +
            `${typeof p.cost_per_1k === "number" ? ` ($${p.cost_per_1k.toFixed(2)} per 1,000)` : ""}` +
            `${p.recommended ? " (recommended)" : ""}: ${p.checkout_url}`,
        )
      : [`- Buy credits: ${data?.action?.url || BUY_URL}`];
    throw new Error(
      [
        reason,
        data?.action?.prompt_to_user && `Tell your user: ${data.action.prompt_to_user}`,
        `Credit packs (one-time payment, credits never expire):\n${lines.join("\n")}`,
        API_KEY === "keyless" && "No key yet? Call contextfetch_get_free_key for 2,500 free searches.",
        "Then set CONTEXTFETCH_API_KEY in your MCP server config.",
      ]
        .filter(Boolean)
        .join("\n\n"),
    );
  }
  if (status === 409 && data?.error === "free_key_already_issued") {
    throw new Error(
      `This network already claimed its free key (one per network). Use that key, or buy credits (one-time payment, credits never expire): ${BUY_URL}`,
    );
  }
  if (status === 400 && data?.error === "url_not_allowed") {
    throw new Error("URL not allowed (HTTP 400): only public http(s) URLs can be fetched.");
  }
  if (status === 429) throw new Error("The ContextFetch API is rate limiting requests (HTTP 429). Wait a few seconds and retry.");
  if (status >= 500) throw new Error(`The ContextFetch API had a server error (HTTP ${status}). Try again shortly.`);
  const detail = data?.message ?? data?.error ?? data?.detail ?? raw.slice(0, 300);
  const link = data?.action?.url || data?.checkout_url; // e.g. 409 from auto-reload without a saved card
  throw new Error(
    `The ContextFetch API rejected the request (HTTP ${status}): ${typeof detail === "string" ? detail : JSON.stringify(detail)}${link ? `\n\n${link}` : ""}`,
  );
}

const fmt = (x: number) => x.toLocaleString("en-US");

/** "1,234 tokens instead of 20,000 (93.8% saved)", or "" when the response carried no token counts. */
function tokenSavings(raw?: number | null, pruned?: number | null): string {
  if (typeof raw !== "number") return "";
  if (typeof pruned !== "number") return `${fmt(raw)} tokens`;
  const saved = raw > 0 ? (1 - pruned / raw) * 100 : 0;
  return `${fmt(pruned)} tokens instead of ${fmt(raw)} (${saved.toFixed(1)}% saved)`;
}

/** One italic stats line from the `contextfetch` extension and costDollars; "" when neither is present. */
function statsLine(data: ApiResponse): string {
  const k = data.contextfetch;
  const t = k?.timingsMs;
  const stages = (["recall", "fetch", "rerank"] as const).filter((s) => typeof t?.[s] === "number").map((s) => `${s} ${fmt(t![s]!)}`);
  const parts = [
    typeof t?.total === "number"
      ? `Latency: ${fmt(t.total)} ms${stages.length ? ` (${stages.join(", ")})` : ""}${k?.cache ? `, cache ${k.cache}` : ""}`
      : "",
    tokenSavings(k?.tokens?.raw, k?.tokens?.pruned) && `Tokens: ${tokenSavings(k?.tokens?.raw, k?.tokens?.pruned)}`,
    typeof data.costDollars?.total === "number" ? `Cost: $${data.costDollars.total.toFixed(3)}` : "",
  ].filter(Boolean);
  return parts.length ? `_${parts.join(" · ")}_` : "";
}

/** One result as a Markdown section. `fullText` shows the whole page instead of the query-pruned passages. */
function resultMarkdown(r: SearchResult, i: number, fullText = false, extraMeta: string[] = []): string {
  const meta = [
    r.url,
    r.publishedDate ? `published ${r.publishedDate.slice(0, 10)}` : "",
    typeof r.score === "number" ? `score ${r.score.toFixed(3)}` : "",
    ...extraMeta,
  ].filter(Boolean);
  const highlights = r.highlights?.length ? r.highlights.map((h) => `- ${h.replace(/\s+/g, " ").trim()}`).join("\n") : "";
  const body = fullText ? r.text : r.prunedContext || highlights || r.text;
  return [`## ${i + 1}. ${r.title || r.url}`, meta.join(" · "), body?.trim()].filter(Boolean).join("\n\n");
}

const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });

function toMarkdown(data: ApiResponse, fullText = false) {
  const parts: string[] = [];
  if (data.notice) parts.push(`> ${data.notice}`);
  const results = data.results ?? [];
  if (results.length === 0) parts.push("No results.");
  results.forEach((r, i) => parts.push(resultMarkdown(r, i, fullText)));
  const stats = statsLine(data);
  if (stats) parts.push(stats);
  return text(parts.join("\n\n"));
}

const costUsd = (x?: number) => `$${(x ?? 0).toFixed(3)}`;

/** The server's evidence pack with a header (sub-queries, sources, credits) under its title. */
function researchMarkdown(data: ResearchResponse) {
  const evidence = data.evidence ?? "";
  const cut = evidence.indexOf("\n\n");
  const subs = data.subQueries ?? [];
  const results = data.results ?? [];
  const k = data.contextfetch?.tokens;
  const header = [
    `- Sub-queries (${subs.length}): ${subs.map((q) => `"${q.query}"`).join(" · ")}`,
    `- Sources: ${results.length} unique, ranked against the question`,
    tokenSavings(k?.raw, k?.pruned) && `- Tokens: ${tokenSavings(k?.raw, k?.pruned)}`,
    `- Credits used: ${data.costDollars?.subQueries ?? 0} (${costUsd(data.costDollars?.total)})`,
    ...subs.flatMap((q) =>
      q.status === "ok" ? [] : [`- Sub-query "${q.query}" failed: ${typeof q.error === "object" ? q.error.message || q.error.error : q.error}`],
    ),
  ].filter(Boolean);
  return text(
    [
      cut < 0 ? evidence : evidence.slice(0, cut),
      data.notice ? `> ${data.notice}` : "",
      header.join("\n"),
      results.length && cut >= 0 ? evidence.slice(cut + 2) : "No results.",
    ]
      .filter(Boolean)
      .join("\n\n"),
  );
}

const server = new McpServer({ name: "contextfetch", version });
const annotations = { readOnlyHint: true, openWorldHint: true };
const numResults = z.number().int().min(1).max(25).default(5).describe("Number of results to return (1-25, default 5).");

server.registerTool(
  "contextfetch_search",
  {
    title: "ContextFetch web search",
    description:
      "Search the web and get LLM-ready Markdown. Each result has its title, URL and only the passages relevant to the query (cross-encoder pruned context), so it costs far fewer tokens than raw pages. Use for current events, documentation, APIs, research and fact checking.",
    inputSchema: {
      query: z.string().min(1).describe("Natural-language search query."),
      num_results: numResults,
      include_domains: z.array(z.string()).optional().describe('Only return results from these domains, e.g. ["docs.python.org"].'),
      exclude_domains: z.array(z.string()).optional().describe("Never return results from these domains."),
      time_range: z.enum(["day", "week", "month", "year"]).optional().describe("Only pages published in the last day, week, month or year."),
      start_published_date: z.string().min(1).optional().describe("Only pages published on or after this date (YYYY-MM-DD). Undated pages are dropped."),
      end_published_date: z.string().min(1).optional().describe("Only pages published on or before this date (YYYY-MM-DD)."),
      topic: z.enum(["general", "news", "finance"]).optional().describe("news: news sources, recent pages first. finance: SEC filings and finance sites. Default general."),
      category: z.string().min(1).optional().describe("Focus on one kind of page: company, research paper, news, pdf, github, personal site, linkedin profile, financial report, people."),
      country: z.string().min(1).optional().describe("Two-letter country code (US, DE): that country's results rank higher."),
      language: z.string().min(1).optional().describe("Two-letter language code (en, de): results in that language rank higher."),
    },
    annotations,
  },
  async ({ query, num_results, include_domains, exclude_domains, time_range, start_published_date, end_published_date, topic, category, country, language }) =>
    toMarkdown(
      await api("/v1/search", {
        query,
        numResults: num_results,
        includeDomains: include_domains,
        excludeDomains: exclude_domains,
        timeRange: time_range,
        startPublishedDate: start_published_date,
        endPublishedDate: end_published_date,
        topic,
        category,
        userLocation: country,
        language,
        contents: SEARCH_CONTENTS,
      }),
    ),
);

server.registerTool(
  "contextfetch_extract_url",
  {
    title: "ContextFetch URL to Markdown",
    description:
      "Fetch a public web page (docs, articles, GitHub files, arXiv papers) as clean Markdown with tables preserved. Pass `query` to get only the passages relevant to it instead of the whole page.",
    inputSchema: {
      url: z.url().describe("Public http(s) URL to read."),
      query: z.string().min(1).optional().describe("Optional question or topic; returns only the relevant passages."),
    },
    annotations,
  },
  async ({ url, query }) => {
    const data = await api("/v1/contents", { urls: [url], text: true, highlights: query ? { query } : undefined });
    const status = data.statuses?.[0];
    if (!data.results?.length && status?.status === "error") {
      // Thrown, so the agent gets isError: true with the reason instead of an empty "No results."
      throw new Error(`Could not read ${url}: ${status.error?.message || status.error?.tag || "fetch failed"}.`);
    }
    return toMarkdown(data, !query);
  },
);

server.registerTool(
  "contextfetch_find_similar",
  {
    title: "ContextFetch find similar pages",
    description:
      "Find pages similar to a given URL (alternatives, related docs, competing libraries), excluding the source domain. Returns titles, URLs and the most relevant passages as Markdown.",
    inputSchema: {
      url: z.url().describe("Public http(s) URL to find similar pages for."),
      num_results: numResults,
    },
    annotations,
  },
  async ({ url, num_results }) =>
    toMarkdown(await api("/v1/findSimilar", { url, numResults: num_results, contents: SEARCH_CONTENTS })),
);

const subQueryRules =
  'If omitted they are derived from `query`: the query itself, query + "documentation", and query + "benchmark" when it asks about speed, performance or comparisons, else query + "example" (a suffix the query already contains is skipped).';

server.registerTool(
  "contextfetch_research",
  {
    title: "ContextFetch research (evidence pack)",
    description:
      "Research a question in one call, server-side: runs up to 5 web searches (sub-queries) concurrently, dedupes the pages by URL, ranks them all against the question with a cross-encoder and returns one Markdown evidence pack with numbered [n] sources and their query-pruned passages, quoted verbatim (no generated text). Costs 1 credit per sub-query. Pass your own `sub_queries` (distinct angles on the question) for better coverage. " +
      subQueryRules,
    inputSchema: {
      query: z.string().trim().min(1).describe("The research question."),
      sub_queries: z.array(z.string().trim().min(1)).min(1).max(5).optional().describe("Up to 5 search queries covering different angles of the question. Recommended."),
      num_results_per_query: z.number().int().min(1).max(10).default(5).describe("Results per sub-query (1-10, default 5)."),
    },
    annotations,
  },
  async ({ query, sub_queries, num_results_per_query }) =>
    researchMarkdown(await api<ResearchResponse>("/v1/research", { query, subQueries: sub_queries, numResultsPerQuery: num_results_per_query })),
);

server.registerTool(
  "contextfetch_deep_research",
  {
    title: "ContextFetch deep research",
    description:
      "Deep research in one call, no LLM: a deep search of the question, its sub-topics (or your sub_queries) as searches of their own, and the pages its list and index results link to, returned as one cited report: summary, key facts, a section per sub-topic and the sources, every passage quoted verbatim with [n]. Costs 10 credits. For a quick evidence pack use contextfetch_research.",
    inputSchema: {
      query: z.string().trim().min(1).describe("The research question."),
      sub_queries: z
        .array(z.string().trim().min(1))
        .min(1)
        .max(3)
        .optional()
        .describe("Up to 3 search queries covering different angles of the question. Strongly recommended."),
      num_results_per_query: z.number().int().min(1).max(25).default(5).describe("Results per sub-query (1-25, default 5; at most 10 are used)."),
    },
    annotations,
  },
  async ({ query, sub_queries, num_results_per_query }) => {
    const data = await api<ResearchResponse>("/v1/research", {
      query,
      subQueries: sub_queries,
      numResultsPerQuery: Math.min(num_results_per_query, 10),
      depth: "deep",
    });
    return text([data.notice ? `> ${data.notice}` : "", data.report?.markdown ?? "No results."].filter(Boolean).join("\n\n"));
  },
);

server.registerTool(
  "contextfetch_answer",
  {
    title: "ContextFetch extractive answer",
    description:
      "Answer a question with passages quoted verbatim from the web, never generated: searches, scores every passage of the top pages with a cross-encoder and returns the best ones with [n] citations to their sources. Use it for quick factual lookups; the quotes may not fully answer an open-ended question. Costs 1 credit.",
    inputSchema: {
      query: z.string().trim().min(1).describe("The question."),
      num_results: z.number().int().min(1).max(10).default(5).describe("Pages searched for passages (1-10, default 5)."),
    },
    annotations,
  },
  async ({ query, num_results }) => {
    const data = await api<AnswerResponse>("/v1/answer", { query, numResults: num_results });
    const parts = data.notice ? [`> ${data.notice}`] : [];
    if (!data.answer) parts.push("No passage was relevant enough to quote. Try contextfetch_search or rephrase the question.");
    else {
      const sources = (data.citations ?? []).map((c, i) => `[${i + 1}] ${c.title || c.url}: ${c.url}`).join("\n");
      parts.push("Extractive answer (passages quoted verbatim, nothing generated):", data.answer, `Sources:\n${sources}`);
    }
    return text(parts.join("\n\n"));
  },
);

const paths = (what: string) => z.array(z.string()).max(20).optional().describe(what);

server.registerTool(
  "contextfetch_crawl",
  {
    title: "ContextFetch site crawl",
    description:
      "Crawl one website from a start URL and get its pages as Markdown: same-site links only, up to `max_depth` hops (<= 3) and `limit` pages (<= 50), robots.txt obeyed. Pass `query` to rank the pages by relevance and return only their relevant passages. Costs 1 credit per page returned.",
    inputSchema: {
      url: z.url().describe("Public http(s) start URL."),
      max_depth: z.number().int().min(0).max(3).default(1).describe("Link hops from the start page (0-3, default 1)."),
      limit: z.number().int().min(1).max(50).default(10).describe("Maximum pages to return (1-50, default 10)."),
      query: z.string().min(1).optional().describe("Optional topic: ranks pages and prunes each to the relevant passages."),
      include_paths: paths('Regexes; only follow links whose path matches one, e.g. ["^/docs/"].'),
      exclude_paths: paths("Regexes; never follow links whose path matches one."),
    },
    annotations,
  },
  async ({ url, max_depth, limit, query, include_paths, exclude_paths }) => {
    const data = await api("/v1/crawl", { url, maxDepth: max_depth, limit, query, includePaths: include_paths, excludePaths: exclude_paths });
    const results = data.results ?? [];
    const parts = data.notice ? [`> ${data.notice}`] : [];
    parts.push(`# Crawl: ${url}\n\n- Pages: ${results.length}\n- Credits used: ${data.costDollars?.pages ?? 0} (${costUsd(data.costDollars?.total)})`);
    results.forEach((r, i) => parts.push(resultMarkdown(r, i, !query, [`depth ${r.depth}`])));
    return text(parts.join("\n\n"));
  },
);

server.registerTool(
  "contextfetch_map",
  {
    title: "ContextFetch site map",
    description:
      "List a website's URLs without fetching its pages: its sitemaps (from robots.txt, else /sitemap.xml) plus the start page's links, same site only, up to `limit` (<= 5,000). Use it to find the right pages before contextfetch_extract_url or contextfetch_crawl. Costs 1 credit.",
    inputSchema: {
      url: z.url().describe("Public http(s) URL of the site (any page on it)."),
      limit: z.number().int().min(1).max(5000).default(100).describe("Maximum URLs (1-5,000, default 100)."),
      include_paths: paths('Regexes; only list URLs whose path matches one, e.g. ["^/blog/"].'),
      exclude_paths: paths("Regexes; never list URLs whose path matches one."),
    },
    annotations,
  },
  async ({ url, limit, include_paths, exclude_paths }) => {
    const data = await api<MapResponse>("/v1/map", { url, limit, includePaths: include_paths, excludePaths: exclude_paths });
    const urls = data.results ?? [];
    const src = data.contextfetch?.sources ?? {};
    return text(
      [
        ...(data.notice ? [`> ${data.notice}`] : []),
        `# Site map: ${url}\n\n- URLs: ${urls.length} (sitemap ${src.sitemap ?? 0}, page links ${src.links ?? 0})`,
        urls.map((u) => `- ${u}`).join("\n") || "No URLs found.",
      ].join("\n\n"),
    );
  },
);

/** Billing tools need a paid key; keyless use has a daily quota, not a balance. */
function requireKey(tool: string): void {
  if (API_KEY !== "keyless") return;
  throw new Error(
    `${tool} needs an API key. You are on the free keyless tier (25 requests/day per IP), which has no balance or auto-reload.\n\nCall contextfetch_get_free_key for a free key (2,500 searches), or buy credits (one-time payment, credits never expire): ${BUY_URL}\nThen set CONTEXTFETCH_API_KEY in your MCP server config.`,
  );
}

function balanceMarkdown(b: Balance) {
  const a = b.auto_reload;
  const money = (x?: number) => `$${(x ?? 0).toFixed(2)}`;
  return text(
    [
      `- Credits: ${fmt(b.credits ?? 0)}`,
      typeof b.burn_rate_per_day === "number" ? `- Burn rate: ${fmt(b.burn_rate_per_day)} credits/day (last 7 days)` : "",
      a?.enabled
        ? `- Auto-reload: on, buys the ${a.pack} pack when credits drop below ${fmt(a.threshold ?? 0)}; ${money(a.spent_this_month_usd)} of ${money(a.monthly_max_usd)} monthly cap spent`
        : "- Auto-reload: off",
      a?.last_error ? `- Last auto-reload error: ${a.last_error}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
  );
}

server.registerTool(
  "contextfetch_balance",
  {
    title: "ContextFetch balance",
    description:
      "Show the API key's remaining credits, daily burn rate (7-day average) and auto-reload settings, including the last auto-reload error if a payment failed. Needs CONTEXTFETCH_API_KEY; free. Check it before long jobs.",
    inputSchema: {},
    annotations,
  },
  async () => {
    requireKey("contextfetch_balance");
    return balanceMarkdown(await api<Balance>("/v1/balance"));
  },
);

server.registerTool(
  "contextfetch_auto_reload",
  {
    title: "ContextFetch auto-reload",
    description:
      "Turn auto-reload on or off, or change it: when credits drop below `threshold`, the saved card buys `pack` again, up to `monthly_max_usd` per month. Needs CONTEXTFETCH_API_KEY and a card saved at checkout. The monthly cap cannot be raised above $500 here.",
    inputSchema: {
      enabled: z.boolean().describe("true to turn auto-reload on, false to turn it off."),
      threshold: z.number().int().min(100).max(100_000).optional().describe("Reload when credits drop below this (100-100,000, default 1,000)."),
      pack: z.enum(["instant", "builder", "scale"]).optional().describe("Pack to buy: instant $15/15,000, builder $50/60,000, scale $150/200,000."),
      monthly_max_usd: z.number().positive().max(500).optional().describe("Monthly spending cap in USD (at most 500)."),
    },
    annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: true },
  },
  async (args) => {
    requireKey("contextfetch_auto_reload");
    return balanceMarkdown(await api<Balance>("/v1/billing/auto-reload", args));
  },
);

server.registerTool(
  "contextfetch_get_free_key",
  {
    title: "ContextFetch free API key",
    description:
      "Get a free ContextFetch API key with 2,500 searches (one per network, no sign-up). This session uses it right away; give it to your user so they can set CONTEXTFETCH_API_KEY to keep it.",
    inputSchema: {},
    annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: true },
  },
  async () => {
    if (API_KEY !== "keyless") {
      return { content: [{ type: "text" as const, text: "This session already has an API key (CONTEXTFETCH_API_KEY); no free key needed." }] };
    }
    const { apiKey, credits } = await api<{ apiKey: string; credits: number }>("/v1/keys/free", {});
    API_KEY = apiKey;
    return {
      content: [
        {
          type: "text" as const,
          text: [
            `Free API key: ${apiKey}`,
            `Credits: ${fmt(credits)} (1 credit = 1 search with page Markdown).`,
            "This session now uses it. To keep it, set CONTEXTFETCH_API_KEY in the MCP server config, or send it as `Authorization: Bearer <key>` to https://api.contextfetch.dev.",
            `Top up the same key later: POST ${API_BASE}/v1/checkout with header x-api-key and body {"pack":"instant"}.`,
          ].join("\n"),
        },
      ],
    };
  },
);

await server.connect(new StdioServerTransport());
