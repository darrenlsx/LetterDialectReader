// Dev server: serves the simulated phone UI and POST /api/summarise.
// Run: npm start   (loads .env via node --env-file)
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { summarise, SummariseError } from "./src/summarise.js";

const ROOT = fileURLToPath(new URL("./public/", import.meta.url));
const PORT = Number(process.env.PORT ?? 3000);
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css" };

const send = (res, status, body, type = "application/json") => {
  res.writeHead(status, { "content-type": type });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
};

async function readBody(req, limit = 200_000) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new SummariseError("bad_input", "Request too large.");
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString("utf8");
}

createServer(async (req, res) => {
  try {
    if (req.method === "POST" && req.url === "/api/summarise") {
      let text;
      try {
        text = JSON.parse(await readBody(req)).text;
      } catch (e) {
        if (e instanceof SummariseError) throw e;
        throw new SummariseError("bad_input", "Body must be JSON: { \"text\": string }");
      }
      return send(res, 200, await summarise(text));
    }

    if (req.method === "GET") {
      const path = req.url.split("?")[0];
      const file = normalize(path === "/" ? "index.html" : path.slice(1));
      if (file.startsWith("..")) return send(res, 403, "Forbidden", "text/plain");
      try {
        const data = await readFile(join(ROOT, file));
        return send(res, 200, data, TYPES[extname(file)] ?? "application/octet-stream");
      } catch {
        return send(res, 404, "Not found", "text/plain");
      }
    }
    send(res, 405, { error: "method_not_allowed" });
  } catch (err) {
    const known = err instanceof SummariseError;
    const status = !known ? 500 : err.code === "bad_input" ? 400 : err.code === "no_key" ? 500 : 502;
    if (!known || err.code !== "bad_input") console.error(err);
    send(res, status, { error: known ? err.code : "server_error", message: known ? err.message : "Unexpected error." });
  }
}).listen(PORT, () => console.log(`http://localhost:${PORT}`));
