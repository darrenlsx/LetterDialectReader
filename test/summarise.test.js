import { test } from "node:test";
import assert from "node:assert/strict";
import { summarise, findMissing, extractCriticalTokens, SummariseError } from "../src/summarise.js";

const LETTER = `INLAND REVENUE AUTHORITY OF SINGAPORE
Date: 12 March 2026  Our Ref: IR8A-2026-0043217
Your income tax payable is $1,284.50. Please pay by 11 April 2026 to avoid a penalty of 5%.
Objection deadline 11 May 2026. Call 1800 356 8300 (8.30am to 5pm).`;

const env = { OPENCODE_API_KEY: "test" };
const reply = (o) => async () => JSON.stringify(o);

const GOOD = {
  summary: "IRAS says you must pay $1,284.50 by 11 April 2026. Ref IR8A-2026-0043217, letter dated 12 March 2026. Object by 11 May 2026. Call 1800 356 8300 (8.30am to 5pm).",
  key_details: [{ type: "amount", text: "$1,284.50" }],
  action_required: true,
  confident: true,
  unclear_parts: [],
};

test("extracts amounts, dates, refs, phone numbers, times", () => {
  const t = extractCriticalTokens(LETTER).join("|");
  for (const x of ["$1,284.50", "11 April 2026", "11 May 2026", "12 March 2026", "IR8A-2026-0043217", "1800 356 8300", "8.30am"]) {
    assert.ok(t.includes(x), `missing ${x} in ${t}`);
  }
});

test("complete summary passes through, confident, nothing missing", async () => {
  const r = await summarise(LETTER, env, reply(GOOD));
  assert.equal(r.confident, true);
  assert.deepEqual(r.missing_details, []);
  assert.equal(r.action_required, true);
});

test("accepts JSON wrapped in a markdown fence", async () => {
  const r = await summarise(LETTER, env, async () => "```json\n" + JSON.stringify(GOOD) + "\n```");
  assert.ok(r.summary.includes("1,284.50"));
});

test("retries once when details are dropped, then succeeds", async () => {
  let calls = 0;
  const call = async () => {
    calls++;
    return JSON.stringify(calls === 1 ? { ...GOOD, summary: "Pay your tax soon.", key_details: [] } : GOOD);
  };
  const r = await summarise(LETTER, env, call);
  assert.equal(calls, 2);
  assert.deepEqual(r.missing_details, []);
  assert.equal(r.confident, true);
});

test("if still missing after retry, appends verbatim and flags not confident", async () => {
  const bad = { ...GOOD, summary: "Pay your tax soon.", key_details: [] };
  const r = await summarise(LETTER, env, reply(bad));
  assert.equal(r.confident, false);
  assert.ok(r.missing_details.length > 0);
  assert.ok(r.summary.includes("$1,284.50"));
  assert.deepEqual(findMissing(LETTER, r.summary), []);
});

test("rejects empty / short input and missing key", async () => {
  await assert.rejects(summarise("hi", env, reply(GOOD)), (e) => e instanceof SummariseError && e.code === "bad_input");
  await assert.rejects(summarise(LETTER, {}, reply(GOOD)), (e) => e.code === "no_key");
});

test("model garbage becomes model_failed", async () => {
  await assert.rejects(summarise(LETTER, env, async () => "not json"), (e) => e.code === "model_failed");
});
