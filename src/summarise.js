// Summarisation step: takes OCI-extracted letter text, returns a plain-language
// summary that must not drop critical details (dates, amounts, deadlines,
// reference numbers, phone numbers, required actions).
//
// OpenCode Go (OpenAI-compatible). Same endpoint/model as the other project.
const LLM_BASE_URL = "https://opencode.ai/inference/go/openai/v1";
export const LLM_MODEL = "deepseek-v4.1-flash";
const LLM_TIMEOUT_MS = 30_000;
const MIN_TEXT_CHARS = 20;
const MAX_TEXT_CHARS = 20_000;

const SYSTEM_PROMPT = `You summarise official letters (mostly Singapore government letters) for elderly readers who cannot read English. The text you receive was extracted by OCR and may contain typos, broken lines or stray characters.

Rules:
1. Write the summary in simple, short sentences a 70-year-old can follow. No jargon.
2. NEVER leave out a critical detail. Always keep every: date, deadline, amount of money, reference or account number, phone number, address, name of the sender, and every action the reader must take (pay, reply, attend, bring documents, etc.).
3. Copy numbers, dates, amounts and IDs exactly as written in the letter. Never guess or round.
4. Do not invent anything that is not in the letter. If the OCR text is garbled or unclear at an important point, say so in "unclear_parts" and set "confident" to false.
5. Start the summary with what the letter is and who sent it, then what the reader must do and by when.

Reply with ONLY a JSON object, no markdown, with these keys:
{
  "summary": string,               // the plain-language summary
  "key_details": [                 // every critical detail, one per item
    { "type": "date"|"deadline"|"amount"|"reference"|"contact"|"action"|"other", "text": string }
  ],
  "action_required": boolean,
  "confident": boolean,            // false if you are unsure of any important detail
  "unclear_parts": [string]        // quoted OCR fragments you could not understand
}`;

/**
 * Pull out facts that must survive summarisation (amounts, dates, long
 * numbers/IDs, times). Used as a deterministic check on the model's output.
 */
export function extractCriticalTokens(text) {
  const patterns = [
    /(?:S\$|\$|SGD\s?)\s?\d[\d,]*(?:\.\d{1,2})?/gi, // money
    /\b\d{1,2}(?:st|nd|rd|th)?\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?,?\s+\d{2,4}\b/gi, // 5 March 2026
    /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}\b/gi, // March 5, 2026
    /\b\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}\b/g, // 05/03/2026
    /\b\d{1,2}[:.]\d{2}\s?(?:am|pm)\b/gi, // 3.30pm
    /\b(?=[A-Z0-9-]*\d)[A-Z0-9][A-Z0-9-]{5,}\b/g, // reference/ID with a digit
    /\b\d[\d\s-]{6,}\d\b/g, // phone / long numbers
  ];
  const found = new Map();
  for (const re of patterns) {
    for (const m of text.match(re) ?? []) {
      const token = m.trim().replace(/[.,]$/, "");
      found.set(normalise(token), token);
    }
  }
  // Drop tokens that are fully contained in a longer found token (e.g. a
  // number inside an already-captured date).
  const keys = [...found.keys()];
  return keys
    .filter((k) => !keys.some((o) => o !== k && o.includes(k)))
    .map((k) => found.get(k));
}

function normalise(s) {
  return s.toLowerCase().replace(/[\s,.\-/]/g, "");
}

/** Which critical tokens from the source are absent from the output? */
export function findMissing(sourceText, output) {
  const haystack = normalise(output);
  return extractCriticalTokens(sourceText).filter(
    (t) => !haystack.includes(normalise(t)),
  );
}

function outputText(result) {
  return [
    result.summary,
    ...result.key_details.map((d) => d.text),
  ].join(" ");
}

function parseModelJson(raw) {
  const cleaned = String(raw ?? "")
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  const obj = JSON.parse(cleaned);
  if (typeof obj.summary !== "string" || !obj.summary.trim()) {
    throw new Error("model returned no summary");
  }
  return {
    summary: obj.summary.trim(),
    key_details: Array.isArray(obj.key_details)
      ? obj.key_details
          .filter((d) => d && typeof d.text === "string")
          .map((d) => ({ type: String(d.type ?? "other"), text: d.text }))
      : [],
    action_required: Boolean(obj.action_required),
    confident: obj.confident !== false,
    unclear_parts: Array.isArray(obj.unclear_parts)
      ? obj.unclear_parts.map(String)
      : [],
  };
}

async function callModel(messages, env) {
  const res = await fetch(`${LLM_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.OPENCODE_API_KEY}`,
      "x-opencode-session": crypto.randomUUID(),
    },
    body: JSON.stringify({ model: LLM_MODEL, messages, temperature: 0.1 }),
    signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`LLM returned ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  return data.choices[0].message.content;
}

export class SummariseError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code; // "bad_input" | "no_key" | "model_failed"
  }
}

/**
 * Summarise OCI-extracted letter text.
 *
 * Returns { summary, key_details, action_required, confident, unclear_parts,
 *           missing_details }. `confident` is false whenever the model was
 * unsure OR a critical detail from the source could not be confirmed in the
 * output, so the UI can warn the user instead of silently dropping facts.
 */
export async function summarise(text, env = process.env, call = callModel) {
  if (typeof text !== "string" || text.trim().length < MIN_TEXT_CHARS) {
    throw new SummariseError("bad_input", "Letter text is empty or too short.");
  }
  if (text.length > MAX_TEXT_CHARS) {
    throw new SummariseError("bad_input", "Letter text is too long.");
  }
  if (!env.OPENCODE_API_KEY) {
    throw new SummariseError("no_key", "OPENCODE_API_KEY is not set.");
  }

  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: `Letter text (from OCR):\n"""\n${text}\n"""` },
  ];

  let result;
  try {
    result = parseModelJson(await call(messages, env));
  } catch (err) {
    throw new SummariseError("model_failed", err.message);
  }

  // Deterministic safety net: every amount/date/ID in the source must appear.
  let missing = findMissing(text, outputText(result));
  if (missing.length > 0) {
    try {
      const retry = parseModelJson(
        await call(
          [
            ...messages,
            { role: "assistant", content: JSON.stringify(result) },
            {
              role: "user",
              content: `Your answer left out these details that appear in the letter: ${missing.join(
                " | ",
              )}. Return the full JSON again, including them (in the summary and in key_details) exactly as written.`,
            },
          ],
          env,
        ),
      );
      result = retry;
      missing = findMissing(text, outputText(result));
    } catch {
      // keep the first result; the fallback below still protects the facts
    }
  }

  if (missing.length > 0) {
    // Still missing after the retry. Never drop them: append verbatim.
    for (const t of missing) result.key_details.push({ type: "other", text: t });
    result.summary += ` Also in the letter: ${missing.join("; ")}.`;
    result.confident = false;
  }

  return { ...result, missing_details: missing };
}
