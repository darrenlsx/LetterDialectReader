// Dev server: serves the simulated phone UI and POST /api/summarise.
// Run: npm start   (loads .env via node --env-file)
//
// Env (all optional):
//   PORT                  default 3000
//   HOST                  default 127.0.0.1 (this machine only). Set HOST=0.0.0.0
//                         to open it to the LAN for the real-phone demo.
//   ACCESS_TOKEN          if set, /api/summarise needs it: header x-access-token,
//                         ?token=, or the cookie set by opening /?token=<value>.
//   RATE_LIMIT_MAX        summarise requests per IP per window, default 5
//   RATE_LIMIT_WINDOW_MS  window length in ms, default 60000
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { createHash, timingSafeEqual } from "node:crypto";
import { networkInterfaces } from "node:os";
import { extname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { summarise as realSummarise, SummariseError } from "./src/summarise.js";

const ROOT = fileURLToPath(new URL("./public/", import.meta.url));
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css" };
const BODY_LIMIT = 200_000;
const MAX_TRACKED_IPS = 10_000;

// What the client sees per error code. Upstream details stay in the server log.
// bad_input keeps its own message: it only describes the client's own input.
const PUBLIC_ERRORS = {
  bad_input: { status: 400 },
  no_key: { status: 500, message: "The summary service is not available right now" },
  model_failed: { status: 502, message: "The summary service is not available right now" },
};

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const send = (res, status, body, type = "application/json", headers = {}) => {
  res.writeHead(status, { "content-type": type, ...headers });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};

async function readBody(req, limit = BODY_LIMIT) {
  if (Number(req.headers["content-length"]) > limit) {
    throw new HttpError(413, "too_large", "Request too large.");
  }
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    // Keep draining (without storing) so the client still gets the 413.
    if (size <= limit) chunks.push(c);
  }
  if (size > limit) throw new HttpError(413, "too_large", "Request too large.");
  return Buffer.concat(chunks).toString("utf8");
}

/** Fixed-window per-key counter with bounded memory. */
function createRateLimiter({ max, windowMs, now = Date.now }) {
  const hits = new Map(); // key -> { count, resetAt }
  return (key) => {
    const t = now();
    if (hits.size >= MAX_TRACKED_IPS) {
      for (const [k, v] of hits) if (v.resetAt <= t) hits.delete(k);
      // Still full: drop the oldest entries (Map keeps insertion order).
      for (const k of hits.keys()) {
        if (hits.size < MAX_TRACKED_IPS) break;
        hits.delete(k);
      }
    }
    let entry = hits.get(key);
    if (!entry || entry.resetAt <= t) {
      hits.delete(key);
      entry = { count: 0, resetAt: t + windowMs };
      hits.set(key, entry);
    }
    entry.count++;
    return { ok: entry.count <= max, retryAfterS: Math.ceil((entry.resetAt - t) / 1000) };
  };
}

const sha = (s) => createHash("sha256").update(String(s)).digest();
const tokenMatches = (given, expected) => given != null && timingSafeEqual(sha(given), sha(expected));

function readCookie(req, name) {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}

/** A cross-origin request has an Origin header whose host differs from Host. */
function isCrossOrigin(req) {
  const origin = req.headers.origin;
  if (origin === undefined) return false;
  try {
    return new URL(origin).host !== req.headers.host;
  } catch {
    return true; // "null" or garbage
  }
}

export function createApp({
  summarise = realSummarise,
  accessToken = process.env.ACCESS_TOKEN || undefined,
  rateLimitMax = Number(process.env.RATE_LIMIT_MAX ?? 5),
  rateLimitWindowMs = Number(process.env.RATE_LIMIT_WINDOW_MS ?? 60_000),
  log = console.error,
} = {}) {
  const limit = createRateLimiter({ max: rateLimitMax, windowMs: rateLimitWindowMs });

  async function handleSummarise(req, res, url) {
    if (isCrossOrigin(req)) throw new HttpError(403, "forbidden", "Cross-origin requests are not allowed.");
    if (accessToken) {
      const given = req.headers["x-access-token"] ?? url.searchParams.get("token") ?? readCookie(req, "access_token");
      if (!tokenMatches(given, accessToken)) throw new HttpError(401, "unauthorized", "Access token missing or wrong.");
    }
    const rl = limit(req.socket.remoteAddress ?? "unknown");
    if (!rl.ok) {
      return send(
        res,
        429,
        { error: "rate_limited", message: "Too many requests. Wait a minute", retry_after_s: rl.retryAfterS },
        "application/json",
        { "retry-after": String(rl.retryAfterS) },
      );
    }
    let text;
    const raw = await readBody(req);
    try {
      text = JSON.parse(raw).text;
    } catch {
      throw new SummariseError("bad_input", "Body must be JSON: { \"text\": string }");
    }
    return send(res, 200, await summarise(text));
  }

  async function handleStatic(req, res, url) {
    let path;
    try {
      path = decodeURIComponent(url.pathname);
    } catch {
      return send(res, 400, "Bad request", "text/plain");
    }
    const full = resolve(ROOT, path === "/" ? "index.html" : "." + path);
    const rel = relative(ROOT, full);
    if (!rel || rel.startsWith("..") || isAbsolute(rel) || path.includes("\0")) {
      return send(res, 403, "Forbidden", "text/plain");
    }
    if (accessToken && tokenMatches(url.searchParams.get("token"), accessToken)) {
      // Lets a phone open /?token=... once; the page's same-origin fetches then carry the cookie.
      res.setHeader("set-cookie", `access_token=${encodeURIComponent(accessToken)}; HttpOnly; SameSite=Strict; Path=/`);
    }
    try {
      const data = await readFile(full);
      return send(res, 200, data, TYPES[extname(full)] ?? "application/octet-stream");
    } catch {
      return send(res, 404, "Not found", "text/plain");
    }
  }

  return async function handler(req, res) {
    try {
      // Concatenate (not new URL(req.url, base)) so "//x" stays a path, not a host.
      const url = new URL(`http://localhost${req.url.startsWith("/") ? "" : "/"}${req.url}`);
      if (url.pathname === "/api/summarise") {
        if (req.method !== "POST") {
          return send(res, 405, { error: "method_not_allowed", message: "Use POST." }, "application/json", { allow: "POST" });
        }
        return await handleSummarise(req, res, url);
      }
      if (req.method === "GET") return await handleStatic(req, res, url);
      send(res, 405, { error: "method_not_allowed", message: "Use GET." }, "application/json", { allow: "GET" });
    } catch (err) {
      if (err instanceof HttpError) {
        return send(res, err.status, { error: err.code, message: err.message });
      }
      const pub = err instanceof SummariseError ? PUBLIC_ERRORS[err.code] : undefined;
      if (!pub || err.code !== "bad_input") log(err);
      if (!pub) return send(res, 500, { error: "server_error", message: "Something went wrong" });
      send(res, pub.status, { error: err.code, message: pub.message ?? err.message });
    }
  };
}

export function createAppServer(options) {
  return createServer(createApp(options));
}

function isMain() {
  try {
    return process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isMain()) {
  const PORT = Number(process.env.PORT ?? 3000);
  const HOST = process.env.HOST || "127.0.0.1";
  const server = createAppServer();
  server.listen(PORT, HOST, () => {
    const { port } = server.address();
    const lan = HOST === "0.0.0.0" || HOST === "::";
    console.log(`http://${lan ? "localhost" : HOST}:${port}`);
    if (lan) {
      for (const addrs of Object.values(networkInterfaces())) {
        for (const a of addrs ?? []) {
          if (a.family === "IPv4" && !a.internal) console.log(`LAN: http://${a.address}:${port}`);
        }
      }
      if (!process.env.ACCESS_TOKEN) {
        console.log("Warning: open to the LAN with no ACCESS_TOKEN set. Anyone on this network can use the API key (rate limited).");
      } else {
        console.log("Open the page once with ?token=<ACCESS_TOKEN> on the phone.");
      }
    }
  });
}
