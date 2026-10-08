// Run with: node --test test/
// Mocks global fetch so no network or real keys are needed.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { ask, status, testKeys, parseDuration, _internal, LLMError } from "../app/llm.js";

const realFetch = globalThis.fetch;
let calls;

function json(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status || 200,
    headers: { "content-type": "application/json", ...(init.headers || {}) },
  });
}

const groqOk = (text) => json({ output: [{ type: "message", content: [{ type: "output_text", text }] }] });
const groqLimited = () =>
  json(
    { error: { message: "Rate limit reached ... Please try again in 7m12.5s. Need more tokens?", type: "tokens", code: "rate_limit_exceeded" } },
    { status: 429, headers: { "retry-after": "432" } },
  );
const geminiText = (text) => json({ candidates: [{ content: { role: "model", parts: [{ text }] } }] });

function install(handler) {
  calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    calls.push(u);
    return handler(u, init);
  };
}

beforeEach(() => {
  _internal.cooldowns.clear();
  globalThis.fetch = realFetch;
});

const base = {
  kind: "calendar",
  input: "what's on today",
  token: "ya29.test",
  connectors: [{ label: "googlecalendar", id: "connector_googlecalendar" }],
  tz: "Africa/Johannesburg",
};

test("parseDuration handles Groq formats", () => {
  assert.equal(parseDuration("7m12.5s"), 432_500);
  assert.equal(parseDuration("1h2m3s"), 3_723_000);
  assert.equal(parseDuration("850ms"), 850);
  assert.equal(parseDuration("45s"), 45_000);
  assert.equal(parseDuration("nonsense"), null);
});

test("uses Groq when healthy", async () => {
  install((u) => (u.includes("api.groq.com") ? groqOk("groq answer") : assert.fail("gemini should not be called")));
  const out = await ask({ ...base, groqKey: "gk", geminiKey: "mk" });
  assert.equal(out.provider, "groq");
  assert.equal(out.result, "groq answer");
});

test("falls back to Gemini on Groq 429 and remembers the reset time", async () => {
  install((u) => {
    if (u.includes("api.groq.com")) return groqLimited();
    return geminiText("gemini answer");
  });
  const before = Date.now();
  const out = await ask({ ...base, groqKey: "gk", geminiKey: "mk" });
  assert.equal(out.provider, "gemini");
  assert.equal(out.fallbackReason, "rate_limit");
  assert.equal(out.result, "gemini answer");
  assert.ok(out.groqResetsAt >= before + 431_000 && out.groqResetsAt <= before + 434_000);

  // While cooling down, Groq must not be called at all.
  const groqCallsBefore = calls.filter((u) => u.includes("api.groq.com")).length;
  const again = await ask({ ...base, groqKey: "gk", geminiKey: "mk" });
  assert.equal(again.provider, "gemini");
  assert.equal(calls.filter((u) => u.includes("api.groq.com")).length, groqCallsBefore);

  const s = await status({ groqKey: "gk", geminiKey: "mk" });
  assert.equal(s.groq.coolingDown, true);
});

test("switches back to Groq once the cooldown has passed", async () => {
  install((u) => (u.includes("api.groq.com") ? groqOk("groq is back") : assert.fail("gemini should not be called")));
  await _internal.setCooldown("gk", 1000, "rate_limit");
  // force-expire it
  for (const [k, v] of _internal.cooldowns) _internal.cooldowns.set(k, { ...v, until: Date.now() - 1 });
  const out = await ask({ ...base, groqKey: "gk", geminiKey: "mk" });
  assert.equal(out.provider, "groq");
});

test("rate limited with no Gemini key gives a helpful error", async () => {
  install(() => groqLimited());
  await assert.rejects(
    () => ask({ ...base, groqKey: "gk", geminiKey: "" }),
    (e) => e instanceof LLMError && e.status === 429 && /Gemini key/.test(e.message) && e.retryAt > Date.now(),
  );
});

test("Gemini only (no Groq key) works", async () => {
  install((u) => (u.includes("generativelanguage") ? geminiText("only gemini") : assert.fail("groq should not be called")));
  const out = await ask({ ...base, groqKey: "", geminiKey: "mk" });
  assert.equal(out.provider, "gemini");
  assert.equal(out.fallbackReason, "no_groq_key");
});

test("Gemini runs Google tools and returns the final answer", async () => {
  let geminiTurn = 0;
  install((u, init) => {
    if (u.includes("api.groq.com")) return groqLimited();
    if (u.includes("generativelanguage")) {
      geminiTurn++;
      if (geminiTurn === 1) {
        const body = JSON.parse(init.body);
        assert.equal(body.tools[0].functionDeclarations[0].name, "calendar_list_events");
        return json({
          candidates: [{
            content: {
              role: "model",
              parts: [{ functionCall: { name: "calendar_list_events", args: { time_min: "2026-10-08", time_max: "2026-10-09" } } }],
            },
          }],
        });
      }
      const body = JSON.parse(init.body);
      const last = body.contents.at(-1).parts[0].functionResponse;
      assert.equal(last.name, "calendar_list_events");
      assert.equal(last.response.result[0].title, "Standup");
      return geminiText("You have Standup at 09:30.");
    }
    if (u.includes("googleapis.com/calendar")) {
      assert.match(u, /timeMin=2026-10-08T00%3A00%3A00Z/);
      return json({ items: [{ id: "e1", summary: "Standup", start: { dateTime: "2026-10-08T09:30:00+02:00" }, end: { dateTime: "2026-10-08T09:45:00+02:00" } }] });
    }
    assert.fail("unexpected url " + u);
  });
  const out = await ask({ ...base, groqKey: "gk", geminiKey: "mk" });
  assert.equal(out.provider, "gemini");
  assert.equal(out.result, "You have Standup at 09:30.");
  assert.equal(geminiTurn, 2);
});

test("expired Google login surfaces as 401, not a silent tool error", async () => {
  install((u) => {
    if (u.includes("api.groq.com")) return groqLimited();
    if (u.includes("generativelanguage")) {
      return json({ candidates: [{ content: { role: "model", parts: [{ functionCall: { name: "gmail_search", args: {} } }] } }] });
    }
    return new Response("unauthorized", { status: 401 });
  });
  await assert.rejects(
    () => ask({ ...base, kind: "gmail", groqKey: "gk", geminiKey: "mk" }),
    (e) => e instanceof LLMError && e.status === 401 && /log in/i.test(e.message),
  );
});

test("testKeys reports each provider", async () => {
  install((u, init) => {
    if (u.includes("api.groq.com")) return json({ data: [] });
    return new Response("bad key", { status: 400 });
  });
  const r = await testKeys({ groqKey: "gk", geminiKey: "bad" });
  assert.equal(r.groq.ok, true);
  assert.equal(r.gemini.ok, false);
  assert.match(r.gemini.message, /Invalid Gemini key/);
});
