import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { createAppServer } from "../server.js";
import { SummariseError } from "../src/summarise.js";

// Never call the real LLM from these tests.
delete process.env.OPENCODE_API_KEY;
delete process.env.ACCESS_TOKEN;

const LETTER = "Please pay $120.50 by 11 April 2026. Ref IR8A-2026-0043217.";
const SECRET = "LLM returned 401: invalid key sk-live-abc123 at https://upstream.example/v1";
const silent = () => {};

async function start(options) {
  const server = createAppServer({ log: silent, rateLimitMax: 1000, ...options });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, base, close: () => new Promise((r) => server.close(r)) };
}

const post = (base, body, headers = {}) =>
  fetch(`${base}/api/summarise`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

// fetch() normalises "..", so send raw paths with node:http.
const rawGet = (base, path) =>
  new Promise((resolve, reject) => {
    const { hostname, port } = new URL(base);
    request({ hostname, port, path, method: "GET" }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    })
      .on("error", reject)
      .end();
  });

let app;
before(async () => {
  app = await start();
});
after(() => app.close());

test("serves index.html at /", async () => {
  const res = await fetch(`${app.base}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/html/);
  assert.match(await res.text(), /api\/summarise/);
});

test("404 for a missing static file", async () => {
  const res = await fetch(`${app.base}/nope.html`);
  assert.equal(res.status, 404);
});

for (const path of [
  "/../server.js",
  "/%2e%2e/server.js",
  "/%2e%2e%2fserver.js",
  "/..%5cserver.js",
  "/%2e%2e%5c%2e%2e%5cpackage.json",
  "//server.js",
]) {
  test(`path traversal does not escape public/: ${path}`, async () => {
    const res = await rawGet(app.base, path);
    assert.ok([400, 403, 404].includes(res.status), `status ${res.status}`);
    assert.doesNotMatch(res.body, /createServer|summarise as realSummarise|"scripts"/);
  });
}

test("400 for invalid JSON", async () => {
  const res = await post(app.base, "{not json");
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, "bad_input");
});

test("400 for missing text", async () => {
  const res = await post(app.base, { nope: 1 });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error, "bad_input");
  assert.equal(typeof body.message, "string");
});

test("413 for an oversize body", async () => {
  const res = await post(app.base, { text: "x".repeat(250_000) });
  assert.equal(res.status, 413);
  assert.equal((await res.json()).error, "too_large");
});

test("413 for an oversize chunked body (no content-length)", async () => {
  const chunk = new TextEncoder().encode("x".repeat(50_000));
  let n = 0;
  const body = new ReadableStream({
    pull(c) {
      if (n++ < 6) c.enqueue(chunk);
      else c.close();
    },
  });
  const res = await fetch(`${app.base}/api/summarise`, { method: "POST", body, duplex: "half" });
  assert.equal(res.status, 413);
});

test("405 for wrong method on the API", async () => {
  const res = await fetch(`${app.base}/api/summarise`);
  assert.equal(res.status, 405);
  assert.equal(res.headers.get("allow"), "POST");
});

test("405 for non-GET on static paths", async () => {
  const res = await fetch(`${app.base}/`, { method: "DELETE" });
  assert.equal(res.status, 405);
});

test("403 for a cross-origin POST", async () => {
  const res = await post(app.base, { text: LETTER }, { origin: "http://evil.example" });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, "forbidden");
});

test("same-origin POST is allowed through the origin check", async () => {
  const res = await post(app.base, { text: LETTER }, { origin: app.base });
  assert.notEqual(res.status, 403);
});

test("no_key: generic message, no upstream detail (real summarise, no API key)", async () => {
  const res = await post(app.base, { text: LETTER });
  assert.equal(res.status, 500);
  const text = await res.text();
  const body = JSON.parse(text);
  assert.equal(body.error, "no_key");
  assert.equal(body.message, "The summary service is not available right now");
  assert.doesNotMatch(text, /OPENCODE_API_KEY/);
});

test("model_failed and unknown errors never leak upstream details", async () => {
  const logged = [];
  const cases = [
    [new SummariseError("model_failed", SECRET), 502, "model_failed"],
    [new SummariseError("no_key", SECRET), 500, "no_key"],
    [new Error(SECRET), 500, "server_error"],
    [new SummariseError("something_new", SECRET), 500, "server_error"],
  ];
  for (const [err, status, code] of cases) {
    const s = await start({
      log: (e) => logged.push(e),
      summarise: async () => {
        throw err;
      },
    });
    try {
      const res = await post(s.base, { text: LETTER });
      assert.equal(res.status, status);
      const text = await res.text();
      assert.equal(JSON.parse(text).error, code);
      assert.doesNotMatch(text, /sk-live|upstream|401|LLM/);
    } finally {
      await s.close();
    }
  }
  assert.equal(logged.length, cases.length, "full errors are logged server-side");
});

test("success passes the summary through", async () => {
  const s = await start({ summarise: async (t) => ({ summary: `ok:${t.length}` }) });
  try {
    const res = await post(s.base, { text: LETTER });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { summary: `ok:${LETTER.length}` });
  } finally {
    await s.close();
  }
});

test("rate limit returns 429 after the limit", async () => {
  let calls = 0;
  const s = await start({
    rateLimitMax: 2,
    rateLimitWindowMs: 60_000,
    summarise: async () => ({ summary: String(++calls) }),
  });
  try {
    assert.equal((await post(s.base, { text: LETTER })).status, 200);
    assert.equal((await post(s.base, { text: LETTER })).status, 200);
    const res = await post(s.base, { text: LETTER });
    assert.equal(res.status, 429);
    const body = await res.json();
    assert.equal(body.error, "rate_limited");
    assert.ok(Number(res.headers.get("retry-after")) > 0);
    assert.equal(calls, 2, "the model is not called once limited");
  } finally {
    await s.close();
  }
});

test("rate limit window resets", async () => {
  const s = await start({ rateLimitMax: 1, rateLimitWindowMs: 50, summarise: async () => ({ summary: "ok" }) });
  try {
    assert.equal((await post(s.base, { text: LETTER })).status, 200);
    assert.equal((await post(s.base, { text: LETTER })).status, 429);
    await new Promise((r) => setTimeout(r, 80));
    assert.equal((await post(s.base, { text: LETTER })).status, 200);
  } finally {
    await s.close();
  }
});

test("ACCESS_TOKEN: required when set (header, query or cookie)", async () => {
  const s = await start({ accessToken: "t0ken", summarise: async () => ({ summary: "ok" }) });
  try {
    assert.equal((await post(s.base, { text: LETTER })).status, 401);
    assert.equal((await post(s.base, { text: LETTER }, { "x-access-token": "wrong" })).status, 401);
    assert.equal((await post(s.base, { text: LETTER }, { "x-access-token": "t0ken" })).status, 200);
    const q = await fetch(`${s.base}/api/summarise?token=t0ken`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: LETTER }),
    });
    assert.equal(q.status, 200);
    // Opening the page with ?token= sets a cookie the page's fetches then carry.
    const page = await fetch(`${s.base}/?token=t0ken`);
    const cookie = page.headers.get("set-cookie");
    assert.match(cookie, /access_token=t0ken; HttpOnly; SameSite=Strict/);
    const c = await post(s.base, { text: LETTER }, { cookie: cookie.split(";")[0] });
    assert.equal(c.status, 200);
  } finally {
    await s.close();
  }
});

test("ACCESS_TOKEN unset: no token needed", async () => {
  const s = await start({ accessToken: undefined, summarise: async () => ({ summary: "ok" }) });
  try {
    assert.equal((await post(s.base, { text: LETTER })).status, 200);
  } finally {
    await s.close();
  }
});
