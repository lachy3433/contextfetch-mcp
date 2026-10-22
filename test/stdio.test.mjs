// Drives the built server (dist/index.js) over stdio against a local mock ContextFetch API. No network.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const DIST = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const EXT = {
  cache: "miss",
  timingsMs: { recall: 300, fetch: 400, rerank: 100, total: 812 },
  tokens: { raw: 1000, pruned: 100, savedPct: 90 },
  sources: { searxng: 2 },
};
const NOTICE = "Free keyless tier (7/25 remaining today). Get 15,000 full-markdown searches for $15 (Apple Pay / Google Pay): https://api.contextfetch.dev/buy/instant";

let requests = []; // { method, path, body, auth }
let connections = 0;
let handler = () => [200, {}];
const api = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const body = JSON.parse(raw || "{}");
    requests.push({ method: req.method, path: req.url, body, auth: req.headers.authorization });
    const out = handler(req.url, body, requests.length, req, res);
    if (!out) return; // handler took over the socket
    const [status, payload, headers = {}] = out;
    res.writeHead(status, { "Content-Type": "application/json", ...headers }).end(JSON.stringify(payload));
  });
});
api.on("connection", () => connections++);

let client; // keyless
let keyed; // CONTEXTFETCH_API_KEY set
async function connect(key) {
  const c = new Client({ name: "contextfetch-mcp-test", version: "0" });
  await c.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [DIST],
      env: { PATH: process.env.PATH ?? "", CONTEXTFETCH_API_BASE: `http://127.0.0.1:${api.address().port}`, CONTEXTFETCH_API_KEY: key },
    }),
  );
  return c;
}
before(async () => {
  await new Promise((r) => api.listen(0, "127.0.0.1", r));
  [client, keyed] = await Promise.all([connect(""), connect("cf_live_test")]);
});
after(async () => {
  await Promise.all([client.close(), keyed.close()]);
  api.closeAllConnections();
  await new Promise((r) => api.close(r));
});
beforeEach(() => {
  requests = [];
  connections = 0;
});

const textOf = (r) => r.content.map((c) => c.text).join("\n");
const ok = (results, extra = {}) => [200, { results, costDollars: { total: 0.001 }, notice: NOTICE, contextfetch: EXT, ...extra }];

test("tools/list shows 11 tools", async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), [
    "contextfetch_answer",
    "contextfetch_auto_reload",
    "contextfetch_balance",
    "contextfetch_crawl",
    "contextfetch_deep_research",
    "contextfetch_extract_url",
    "contextfetch_find_similar",
    "contextfetch_get_free_key",
    "contextfetch_map",
    "contextfetch_research",
    "contextfetch_search",
  ]);
  const deep = tools.find((t) => t.name === "contextfetch_deep_research");
  assert.match(deep.description, /cited report[\s\S]*10 credits/);
  assert.equal(deep.inputSchema.properties.sub_queries.maxItems, 3);
  const research = tools.find((t) => t.name === "contextfetch_research");
  assert.equal(research.inputSchema.properties.sub_queries.maxItems, 5);
  assert.equal(research.inputSchema.properties.num_results_per_query.maximum, 10);
  assert.match(tools.find((t) => t.name === "contextfetch_answer").description, /never generated/);
});

test("search retries 503 then succeeds on a reused keep-alive socket, with stats line", async () => {
  handler = (path, body, n) => (n === 1 ? [503, { error: "busy" }] : ok([{ url: "https://a.dev/x", title: "A doc", score: 0.9, prunedContext: "pruned A" }]));
  const r = await client.callTool({ name: "contextfetch_search", arguments: { query: "q" } });
  const t = textOf(r);
  assert.equal(r.isError, undefined, t);
  assert.equal(requests.length, 2);
  assert.ok(connections <= 1, `undici should reuse the socket, saw ${connections} new connections`);
  assert.match(t, /## 1\. A doc/);
  assert.match(t, /pruned A/);
  assert.match(t, /> Free keyless tier \(7\/25/);
  assert.match(t, /Latency: 812 ms \(recall 300, fetch 400, rerank 100\), cache miss/);
  assert.match(t, /Tokens: 100 tokens instead of 1,000 \(90\.0% saved\)/);
  assert.match(t, /Cost: \$0\.001/);
});

test("a connection dropped after the server got the request is not retried (it may have been billed)", async () => {
  handler = (path, body, n, req) => {
    if (n === 1) return void req.socket.destroy();
    return ok([{ url: "https://a.dev/x", title: "A doc", score: 0.9 }]);
  };
  const r = await client.callTool({ name: "contextfetch_search", arguments: { query: "q" } });
  assert.equal(r.isError, true, textOf(r));
  assert.match(textOf(r), /Could not reach the ContextFetch API/);
  assert.equal(requests.length, 1);
});

test("429 honours Retry-After", async () => {
  handler = (path, body, n) => (n === 1 ? [429, { error: "rate_limited" }, { "Retry-After": "1" }] : ok([]));
  const t0 = Date.now();
  const r = await client.callTool({ name: "contextfetch_search", arguments: { query: "q" } });
  assert.equal(r.isError, undefined, textOf(r));
  assert.equal(requests.length, 2);
  assert.ok(Date.now() - t0 >= 950, `waited only ${Date.now() - t0} ms`);
});

test("5xx gives up after 3 attempts", async () => {
  handler = () => [502, { error: "bad_gateway" }];
  const r = await client.callTool({ name: "contextfetch_search", arguments: { query: "q" } });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /server error \(HTTP 502\)/);
  assert.equal(requests.length, 3);
});

for (const status of [400, 401, 402, 422]) {
  test(`no retry on ${status}`, async () => {
    handler = () => [status, { error: status === 402 ? "keyless_limit" : "nope", checkout_url: "https://contextfetch.dev/#buy" }];
    const r = await client.callTool({ name: "contextfetch_search", arguments: { query: "q" } });
    assert.equal(r.isError, true);
    assert.equal(requests.length, 1);
    if (status === 402) assert.match(textOf(r), /Free keyless limit reached[\s\S]*\/buy\/instant/);
  });
}

const EVIDENCE = [
  "# Evidence pack: what is x",
  "Passages quoted verbatim from the sources (nothing generated). Cite them as [n].",
  '## [1] X best\n\nhttp://x.com/doc · score 0.950 · found by "alpha", "beta"\n\nx from beta',
  '## [2] Y\n\nhttps://y.org/page · score 0.600 · found by "alpha"\n\ny context',
].join("\n\n");
const research = (extra = {}) => [
  200,
  {
    query: "what is x",
    subQueries: [
      { query: "alpha", status: "ok", results: 2 },
      { query: "beta", status: "ok", results: 1 },
    ],
    evidence: EVIDENCE,
    results: [{ url: "http://x.com/doc", title: "X best", score: 0.95 }, { url: "https://y.org/page", title: "Y", score: 0.6 }],
    costDollars: { total: 0.002, subQueries: 2 },
    notice: NOTICE,
    contextfetch: EXT,
    ...extra,
  },
];

test("research is one POST /v1/research and renders the server's evidence pack", async () => {
  handler = () => research();
  const r = await client.callTool({
    name: "contextfetch_research",
    arguments: { query: "what is x", sub_queries: ["alpha", "beta"], num_results_per_query: 4 },
  });
  const t = textOf(r);
  assert.equal(r.isError, undefined, t);
  assert.deepEqual(requests.map(({ path, body }) => ({ path, body })), [
    { path: "/v1/research", body: { query: "what is x", subQueries: ["alpha", "beta"], numResultsPerQuery: 4 } },
  ]);
  assert.ok(t.startsWith("# Evidence pack: what is x\n\n> Free keyless tier (7/25"), t);
  assert.match(t, /- Sub-queries \(2\): "alpha" · "beta"\n- Sources: 2 unique, ranked against the question/);
  assert.match(t, /- Tokens: 100 tokens instead of 1,000 \(90\.0% saved\)/);
  assert.match(t, /- Credits used: 2 \(\$0\.002\)/);
  assert.match(t, /Passages quoted verbatim[\s\S]*## \[1\] X best\n\nhttp:\/\/x\.com\/doc · score 0\.950 · found by "alpha", "beta"\n\nx from beta[\s\S]*## \[2\] Y/);
  assert.equal((t.match(/^# Evidence pack/gm) ?? []).length, 1);
});

test("research rejects more than 5 sub-queries before calling the API", async () => {
  const r = await client.callTool({ name: "contextfetch_research", arguments: { query: "q", sub_queries: ["a", "b", "c", "d", "e", "f"] } });
  assert.equal(r.isError, true);
  assert.equal(requests.length, 0);
});

test("deep_research asks /v1/research for depth deep and returns its report", async () => {
  handler = () => research({ report: { markdown: "# Research: python asyncio timeout\n\n## Summary\n\n> quoted [1]" } });
  const r = await client.callTool({ name: "contextfetch_deep_research", arguments: { query: "python asyncio timeout", num_results_per_query: 25 } });
  assert.equal(r.isError, undefined, textOf(r));
  assert.deepEqual(requests.map(({ path, body }) => ({ path, body })), [
    { path: "/v1/research", body: { query: "python asyncio timeout", numResultsPerQuery: 10, depth: "deep" } },
  ]);
  assert.match(textOf(r), /^# Research: python asyncio timeout/m);
});

test("deep_research surfaces 402 without retrying", async () => {
  handler = () => [402, { error: "keyless_limit", checkout_url: "https://contextfetch.dev/#buy" }];
  const r = await client.callTool({ name: "contextfetch_deep_research", arguments: { query: "q", sub_queries: ["a", "b"] } });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /Free keyless limit reached[\s\S]*\/buy\/instant/);
  assert.equal(requests.length, 1);
});

test("research names failed sub-queries and says when nothing was found", async () => {
  handler = () =>
    research({
      subQueries: [
        { query: "good", status: "ok", results: 0 },
        { query: "bad", status: "failed", error: { error: "recall_unavailable", message: "Web search is temporarily unavailable." } },
      ],
      results: [],
      evidence: "# Evidence pack: q\n\nPassages quoted verbatim from the sources (nothing generated). Cite them as [n].",
      costDollars: { total: 0.001, subQueries: 1 },
    });
  const t = textOf(await client.callTool({ name: "contextfetch_research", arguments: { query: "q", sub_queries: ["good", "bad"] } }));
  assert.match(t, /- Credits used: 1 \(\$0\.001\)\n- Sub-query "bad" failed: Web search is temporarily unavailable\./);
  assert.match(t, /No results\.$/);
});

test("answer is POST /v1/answer and shows the extractive passages with their sources", async () => {
  handler = () => [
    200,
    {
      answer: "Use asyncio.timeout as a context manager. [1]\n\nwait_for raises TimeoutError. [2]",
      type: "extractive",
      citations: [{ id: "1", url: "https://a.dev/t", title: "Timeouts" }, { id: "2", url: "https://b.dev/w", title: null }],
      costDollars: { total: 0.001 },
    },
  ];
  const r = await client.callTool({ name: "contextfetch_answer", arguments: { query: "asyncio timeout" } });
  const t = textOf(r);
  assert.equal(r.isError, undefined, t);
  assert.deepEqual(requests[0].body, { query: "asyncio timeout", numResults: 5 });
  assert.equal(requests[0].path, "/v1/answer");
  assert.ok(t.startsWith("Extractive answer (passages quoted verbatim, nothing generated):\n\nUse asyncio.timeout"), t);
  assert.match(t, /Sources:\n\[1\] Timeouts: https:\/\/a\.dev\/t\n\[2\] https:\/\/b\.dev\/w: https:\/\/b\.dev\/w/);

  handler = () => [200, { answer: "", type: "extractive", citations: [], notice: NOTICE }];
  const none = textOf(await client.callTool({ name: "contextfetch_answer", arguments: { query: "zzz" } }));
  assert.match(none, /^> Free keyless[\s\S]*No passage was relevant enough to quote/);
});

test("crawl is POST /v1/crawl and renders each page as Markdown with its depth", async () => {
  handler = () => [
    200,
    {
      baseUrl: "https://docs.x.dev/",
      results: [
        { url: "https://docs.x.dev/", title: "Home", depth: 0, text: "# Home\n\nwelcome", prunedContext: null },
        { url: "https://docs.x.dev/a", title: "A", depth: 1, text: "# A\n\nall about a", prunedContext: null },
      ],
      costDollars: { total: 0.002, pages: 2 },
    },
  ];
  const r = await keyed.callTool({ name: "contextfetch_crawl", arguments: { url: "https://docs.x.dev/", limit: 5, exclude_paths: ["^/blog"] } });
  const t = textOf(r);
  assert.equal(r.isError, undefined, t);
  assert.deepEqual(requests[0].body, { url: "https://docs.x.dev/", maxDepth: 1, limit: 5, excludePaths: ["^/blog"] });
  assert.equal(requests[0].path, "/v1/crawl");
  assert.ok(t.startsWith("# Crawl: https://docs.x.dev/\n\n- Pages: 2\n- Credits used: 2 ($0.002)"), t);
  assert.match(t, /## 2\. A\n\nhttps:\/\/docs\.x\.dev\/a · depth 1\n\n# A\n\nall about a/);

  const bad = await keyed.callTool({ name: "contextfetch_crawl", arguments: { url: "https://docs.x.dev/", limit: 51 } });
  assert.equal(bad.isError, true);
  assert.equal(requests.length, 1);
});

test("map is POST /v1/map and lists the URLs", async () => {
  handler = () => [200, { results: ["https://x.dev/", "https://x.dev/a"], contextfetch: { sources: { links: 1, sitemap: 1 } }, costDollars: { total: 0.001 } }];
  const t = textOf(await keyed.callTool({ name: "contextfetch_map", arguments: { url: "https://x.dev/" } }));
  assert.deepEqual(requests[0].body, { url: "https://x.dev/", limit: 100 });
  assert.equal(t, "# Site map: https://x.dev/\n\n- URLs: 2 (sitemap 1, page links 1)\n\n- https://x.dev/\n- https://x.dev/a");
});

const API = "https://api.contextfetch.dev";
const PACKS = [
  { id: "instant", name: "Instant", credits: 15000, price_usd: 15, cost_per_1k: 1, checkout_url: `${API}/buy/instant` },
  { id: "builder", name: "Builder", credits: 60000, price_usd: 50, cost_per_1k: 0.83, recommended: true, checkout_url: `${API}/buy/builder` },
  { id: "scale", name: "Scale", credits: 200000, price_usd: 150, cost_per_1k: 0.75, checkout_url: `${API}/buy/scale` },
];

test("402 renders packs (recommended first) with /buy links and the prompt_to_user text", async () => {
  const prompt = `ContextFetch credits ran out. Reload 15,000 searches for $15: ${API}/buy/instant`;
  handler = () => [
    402,
    {
      error: "insufficient_credits",
      message: "Out of credits.",
      checkout_url: "https://contextfetch.dev/#buy",
      packs: PACKS,
      action: { type: "payment_link", url: `${API}/buy/instant`, prompt_to_user: prompt },
    },
    { "X-Payment-URL": `${API}/buy/instant` },
  ];
  const r = await client.callTool({ name: "contextfetch_search", arguments: { query: "q" } });
  const t = textOf(r);
  assert.equal(r.isError, true, t);
  assert.ok(t.includes(prompt), t);
  const lines = t.split("\n").filter((l) => l.startsWith("- "));
  assert.deepEqual(lines, [
    `- Builder: $50 for 60,000 credits ($0.83 per 1,000) (recommended): ${API}/buy/builder`,
    `- Instant: $15 for 15,000 credits ($1.00 per 1,000): ${API}/buy/instant`,
    `- Scale: $150 for 200,000 credits ($0.75 per 1,000): ${API}/buy/scale`,
  ]);
  assert.equal(requests[0].path, "/v1/search");
});

test("balance and auto-reload say they need a key when keyless, without calling the API", async () => {
  for (const [name, args] of [["contextfetch_balance", {}], ["contextfetch_auto_reload", { enabled: false }]]) {
    const r = await client.callTool({ name, arguments: args });
    assert.equal(r.isError, true);
    assert.match(textOf(r), new RegExp(`${name} needs an API key[\\s\\S]*/buy/instant[\\s\\S]*CONTEXTFETCH_API_KEY`));
  }
  assert.equal(requests.length, 0);
});

const BALANCE = {
  credits: 12345,
  burn_rate_per_day: 820,
  auto_reload: { enabled: true, threshold: 1000, pack: "builder", monthly_max_usd: 500, spent_this_month_usd: 50, last_error: null },
};

test("balance is GET /v1/balance with the key", async () => {
  handler = () => [200, BALANCE];
  const r = await keyed.callTool({ name: "contextfetch_balance", arguments: {} });
  const t = textOf(r);
  assert.equal(r.isError, undefined, t);
  assert.deepEqual(requests.map(({ method, path, auth }) => ({ method, path, auth })), [
    { method: "GET", path: "/v1/balance", auth: "Bearer cf_live_test" },
  ]);
  assert.match(t, /Credits: 12,345/);
  assert.match(t, /Burn rate: 820 credits\/day/);
  assert.match(t, /Auto-reload: on, buys the builder pack when credits drop below 1,000; \$50\.00 of \$500\.00 monthly cap spent/);
});

test("balance shows last_error", async () => {
  handler = () => [200, { credits: 10, auto_reload: { enabled: false, last_error: "card_declined" } }];
  const t = textOf(await keyed.callTool({ name: "contextfetch_balance", arguments: {} }));
  assert.match(t, /Auto-reload: off/);
  assert.match(t, /Last auto-reload error: card_declined/);
});

test("auto-reload is POST /v1/billing/auto-reload with the given fields", async () => {
  handler = () => [200, BALANCE];
  const r = await keyed.callTool({
    name: "contextfetch_auto_reload",
    arguments: { enabled: true, threshold: 1000, pack: "builder", monthly_max_usd: 200 },
  });
  assert.equal(r.isError, undefined, textOf(r));
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, "POST");
  assert.equal(requests[0].path, "/v1/billing/auto-reload");
  assert.deepEqual(requests[0].body, { enabled: true, threshold: 1000, pack: "builder", monthly_max_usd: 200 });

  requests = [];
  await keyed.callTool({ name: "contextfetch_auto_reload", arguments: { enabled: false } });
  assert.deepEqual(requests[0].body, { enabled: false });
});

test("auto-reload rejects a monthly cap above $500 and bad packs before calling the API", async () => {
  for (const args of [{ enabled: true, monthly_max_usd: 501 }, { enabled: true, pack: "pro" }, { enabled: true, threshold: 50 }]) {
    const r = await keyed.callTool({ name: "contextfetch_auto_reload", arguments: args });
    assert.equal(r.isError, true, JSON.stringify(args));
  }
  assert.equal(requests.length, 0);
});

test("auto-reload 409 (no saved card) shows the buy link", async () => {
  handler = () => [409, { error: "no_saved_card", message: "Buy a pack with auto-reload on to save a card.", action: { url: `${API}/buy/builder?auto_reload=1` } }];
  const r = await keyed.callTool({ name: "contextfetch_auto_reload", arguments: { enabled: true } });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /HTTP 409\): Buy a pack[\s\S]*\/buy\/builder\?auto_reload=1/);
});

test("get_free_key with a key set does not call the API", async () => {
  const t = textOf(await keyed.callTool({ name: "contextfetch_get_free_key", arguments: {} }));
  assert.match(t, /already has an API key/);
  assert.equal(requests.length, 0);
});

test("get_free_key: 409 explains one per network", async () => {
  handler = () => [409, { error: "free_key_already_issued", message: "x" }];
  const c = await connect("");
  try {
    const r = await c.callTool({ name: "contextfetch_get_free_key", arguments: {} });
    assert.equal(r.isError, true);
    assert.match(textOf(r), /already claimed its free key[\s\S]*\/buy\/instant/);
  } finally {
    await c.close();
  }
});

test("get_free_key issues a key and the session uses it for the next search", async () => {
  handler = (path) => (path === "/v1/keys/free" ? [201, { apiKey: "cf_live_free", credits: 2500 }] : ok([]));
  const c = await connect("");
  try {
    const t = textOf(await c.callTool({ name: "contextfetch_get_free_key", arguments: {} }));
    assert.match(t, /Free API key: cf_live_free[\s\S]*Credits: 2,500/);
    await c.callTool({ name: "contextfetch_search", arguments: { query: "q" } });
    assert.deepEqual(requests.map(({ method, path, auth }) => ({ method, path, auth })), [
      { method: "POST", path: "/v1/keys/free", auth: "Bearer keyless" },
      { method: "POST", path: "/v1/search", auth: "Bearer cf_live_free" },
    ]);
  } finally {
    await c.close();
  }
});
