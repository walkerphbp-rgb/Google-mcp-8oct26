// Provider routing: Groq first, Gemini 2.5 Flash as fallback.
//
// - Groq runs Google connectors server-side through its MCP /responses API.
// - When Groq runs out of tokens (HTTP 429/413) we remember when it resets,
//   answer with Gemini in the meantime, and switch back to Groq automatically
//   once the reset time has passed.
// Runtime neutral (fetch + WebCrypto only), so it works in Deno and Node.

import { runTool, toolDeclarations } from "./google-tools.js";

const GROQ_RESPONSES = "https://api.groq.com/openai/v1/responses";
const GROQ_MODELS = "https://api.groq.com/openai/v1/models";
const GROQ_MODEL = "openai/gpt-oss-120b";
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
export const GEMINI_MODEL = "gemini-2.5-flash";

const DEFAULT_COOLDOWN_MS = 60_000;
const MAX_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const MAX_TOOL_STEPS = 8;

export class LLMError extends Error {
  constructor(message, { status = 500, details, retryAt } = {}) {
    super(message);
    this.status = status;
    this.details = details;
    this.retryAt = retryAt;
  }
}

// ---- Groq cooldown tracking (per API key, in memory) ----------------------

const cooldowns = new Map(); // keyHash -> { until, reason }

async function keyId(key) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  return Array.from(new Uint8Array(buf)).slice(0, 8)
    .map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function getCooldown(key) {
  if (!key) return null;
  const id = await keyId(key);
  const c = cooldowns.get(id);
  if (!c) return null;
  if (c.until <= Date.now()) {
    cooldowns.delete(id);
    return null;
  }
  return c;
}

async function setCooldown(key, ms, reason) {
  const id = await keyId(key);
  cooldowns.set(id, {
    until: Date.now() + Math.min(Math.max(ms, 1000), MAX_COOLDOWN_MS),
    reason,
  });
}

// "7m12.5s", "1h2m3s", "850ms", "45s" -> milliseconds
export function parseDuration(text) {
  if (!text) return null;
  const re = /(?:(\d+(?:\.\d+)?)\s*h)?\s*(?:(\d+(?:\.\d+)?)\s*m(?!s))?\s*(?:(\d+(?:\.\d+)?)\s*s)?\s*(?:(\d+(?:\.\d+)?)\s*ms)?/i;
  const m = String(text).match(re);
  if (!m || !m[0].trim()) return null;
  const [, h, min, s, ms] = m.map((x) => (x === undefined ? 0 : Number(x)));
  const total = (h * 3600 + min * 60 + s) * 1000 + ms;
  return total > 0 ? total : null;
}

function retryDelayMs(res, bodyText) {
  const header = res.headers.get("retry-after");
  if (header && /^\d+(\.\d+)?$/.test(header.trim())) return Math.ceil(Number(header) * 1000);
  const reset = res.headers.get("x-ratelimit-reset-tokens") || res.headers.get("x-ratelimit-reset-requests");
  const fromHeader = parseDuration(reset);
  if (fromHeader) return fromHeader;
  const msg = /try again in\s+([0-9hms.\s]+?)(?:[.,]|\s*$|\s+Need|\s+Please)/i.exec(bodyText || "");
  return (msg && parseDuration(msg[1])) || DEFAULT_COOLDOWN_MS;
}

function prettyJson(text) {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

// ---- Groq -----------------------------------------------------------------

function extractGroqText(data) {
  const messages = (data.output || []).filter((i) => i.type === "message");
  if (!messages.length) return "No message found in response";
  const last = messages[messages.length - 1];
  return (last.content || []).filter((c) => c.type === "output_text").map((c) => c.text).join("\n");
}

// Returns { ok: true, text } or { ok: false, kind, status, retryMs, message, details }.
async function callGroq({ key, connectors, token, input }) {
  let res;
  try {
    res = await fetch(GROQ_RESPONSES, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: GROQ_MODEL,
        tools: connectors.map((c) => ({
          type: "mcp",
          server_label: c.label,
          connector_id: c.id,
          authorization: token,
          require_approval: "never",
        })),
        input,
        stream: false,
      }),
    });
  } catch (e) {
    return { ok: false, kind: "unavailable", status: 503, message: `Could not reach Groq: ${e.message}` };
  }

  if (res.ok) return { ok: true, text: extractGroqText(await res.json()) };

  const body = await res.text();
  const base = {
    ok: false,
    status: res.status,
    message: `Groq API error (${res.status}): ${prettyJson(body)}`,
    details: prettyJson(body),
  };
  if (res.status === 429 || res.status === 413) {
    return { ...base, kind: "rate_limit", retryMs: retryDelayMs(res, body) };
  }
  if (res.status === 401 || res.status === 403) return { ...base, kind: "auth" };
  if (res.status >= 500) return { ...base, kind: "unavailable" };
  return { ...base, kind: "error" };
}

// ---- Gemini ---------------------------------------------------------------

async function geminiRequest(key, model, payload) {
  let res;
  try {
    res = await fetch(`${GEMINI_BASE}/${model}:generateContent`, {
      method: "POST",
      headers: { "x-goog-api-key": key, "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    throw new LLMError(`Could not reach Gemini: ${e.message}`, { status: 503 });
  }
  const text = await res.text();
  if (!res.ok) {
    let retryAt;
    if (res.status === 429) {
      const wait = parseDuration((/retry in\s+([0-9hms.]+)/i.exec(text) || [])[1]) || DEFAULT_COOLDOWN_MS;
      retryAt = Date.now() + wait;
    }
    throw new LLMError(`Gemini API error (${res.status}): ${prettyJson(text)}`, {
      status: res.status,
      details: prettyJson(text),
      retryAt,
    });
  }
  return JSON.parse(text);
}

async function callGemini({ key, model = GEMINI_MODEL, kind, token, input, tz }) {
  const now = new Date();
  const system = [
    "You are an assistant with read-only access to the user's Google Calendar, Gmail and Drive through the provided tools.",
    "Always call a tool to get real data; never invent events, emails or files.",
    `Current date and time: ${now.toISOString()} (UTC). The user's timezone is ${tz || "UTC"}; interpret words like today, tomorrow and this week in that timezone and pass ISO 8601 times with the correct offset.`,
    "Respond with plain text only (no markdown tables) unless the request asks for JSON, in which case return only the JSON.",
  ].join("\n");

  const contents = [{ role: "user", parts: [{ text: input }] }];
  const tools = [{ functionDeclarations: toolDeclarations(kind) }];

  for (let step = 0; step < MAX_TOOL_STEPS; step++) {
    const data = await geminiRequest(key, model, {
      systemInstruction: { parts: [{ text: system }] },
      contents,
      tools,
    });
    const content = data.candidates?.[0]?.content;
    if (!content) {
      const reason = data.promptFeedback?.blockReason || data.candidates?.[0]?.finishReason;
      throw new LLMError(`Gemini returned no content${reason ? ` (${reason})` : ""}`, { status: 502 });
    }
    contents.push(content); // keep parts untouched (thought signatures must round-trip)

    const calls = (content.parts || []).filter((p) => p.functionCall).map((p) => p.functionCall);
    if (!calls.length) {
      const text = (content.parts || []).filter((p) => p.text).map((p) => p.text).join("\n").trim();
      return text || "No response";
    }

    const responses = await Promise.all(calls.map(async (call) => {
      try {
        return { functionResponse: { name: call.name, response: { result: await runTool(call.name, call.args, token) } } };
      } catch (e) {
        if (e.status === 401) throw new LLMError(e.message, { status: 401 });
        return { functionResponse: { name: call.name, response: { error: e.message } } };
      }
    }));
    contents.push({ role: "user", parts: responses });
  }
  throw new LLMError("Gemini used too many tool steps without finishing. Try a narrower question.", { status: 508 });
}

// ---- Public API -----------------------------------------------------------

/**
 * Answer a request with Groq, falling back to Gemini.
 * @returns {{result: string, provider: "groq"|"gemini", fallbackReason?: string, groqResetsAt?: number}}
 */
export async function ask({ kind, input, token, groqKey, geminiKey, connectors, tz }) {
  const cooling = await getCooldown(groqKey);
  let groqFailure = null;

  if (groqKey && !cooling) {
    const out = await callGroq({ key: groqKey, connectors, token, input });
    if (out.ok) return { result: out.text, provider: "groq" };
    groqFailure = out;
    if (out.kind === "rate_limit") await setCooldown(groqKey, out.retryMs, "rate_limit");
    else if (out.kind === "auth") await setCooldown(groqKey, 5 * 60_000, "auth");
    else if (out.kind === "unavailable") await setCooldown(groqKey, 30_000, "unavailable");
  }

  const nowCooling = await getCooldown(groqKey);
  const reason = !groqKey ? "no_groq_key" : (groqFailure?.kind || cooling?.reason || "unavailable");
  const groqResetsAt = nowCooling?.until;

  if (!geminiKey) {
    if (groqFailure) {
      throw new LLMError(
        groqFailure.kind === "rate_limit"
          ? `Groq token limit reached${groqResetsAt ? `, resets in about ${Math.ceil((groqResetsAt - Date.now()) / 1000)}s` : ""}. Add a Gemini key in the menu to keep working meanwhile.`
          : groqFailure.message,
        { status: groqFailure.status, details: groqFailure.details, retryAt: groqResetsAt },
      );
    }
    throw new LLMError(
      cooling
        ? `Groq is paused until it resets (about ${Math.ceil((cooling.until - Date.now()) / 1000)}s). Add a Gemini key in the menu to keep working meanwhile.`
        : "No API key configured. Open the menu and add a Groq and/or Gemini key.",
      { status: cooling ? 429 : 400, retryAt: cooling?.until },
    );
  }

  const text = await callGemini({ key: geminiKey, kind, token, input, tz });
  return { result: text, provider: "gemini", fallbackReason: reason, groqResetsAt };
}

/** Cheap, no-network snapshot used by the status light. */
export async function status({ groqKey, geminiKey }) {
  const c = await getCooldown(groqKey);
  return {
    groq: {
      configured: !!groqKey,
      coolingDown: !!c,
      reason: c?.reason || null,
      resetsAt: c?.until || null,
    },
    gemini: { configured: !!geminiKey, model: GEMINI_MODEL },
  };
}

/** Verify keys without spending tokens (list-models endpoints). */
export async function testKeys({ groqKey, geminiKey }) {
  const out = { groq: { ok: false, message: "No key" }, gemini: { ok: false, message: "No key" } };

  if (groqKey) {
    try {
      const r = await fetch(GROQ_MODELS, { headers: { authorization: `Bearer ${groqKey}` } });
      if (r.ok) out.groq = { ok: true, message: "Connected" };
      else if (r.status === 429) out.groq = { ok: true, message: "Key valid (currently rate limited)" };
      else out.groq = { ok: false, message: r.status === 401 ? "Invalid Groq key" : `Groq returned ${r.status}` };
    } catch (e) {
      out.groq = { ok: false, message: `Could not reach Groq: ${e.message}` };
    }
  }

  if (geminiKey) {
    try {
      const r = await fetch(`${GEMINI_BASE}/${GEMINI_MODEL}`, { headers: { "x-goog-api-key": geminiKey } });
      if (r.ok) out.gemini = { ok: true, message: `Connected (${GEMINI_MODEL})` };
      else out.gemini = { ok: false, message: [400, 401, 403].includes(r.status) ? "Invalid Gemini key" : `Gemini returned ${r.status}` };
    } catch (e) {
      out.gemini = { ok: false, message: `Could not reach Gemini: ${e.message}` };
    }
  }
  return out;
}

// exposed for tests
export const _internal = { cooldowns, setCooldown, getCooldown };
