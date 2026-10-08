// Direct Google API tools used by the Gemini fallback.
//
// Groq's MCP connectors only run on Groq. When Groq is rate limited and we
// fall back to Gemini, Gemini needs its own way to read Calendar, Gmail and
// Drive, so these tools call the Google REST APIs with the user's OAuth token.
// Runtime neutral: only uses fetch, so it works in Deno and Node.

const CAL = "https://www.googleapis.com/calendar/v3";
const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
const DRIVE = "https://www.googleapis.com/drive/v3";

async function gfetch(url, token) {
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(
      res.status === 401
        ? "Google login expired. Please log in with Google again."
        : `Google API ${res.status}: ${text.slice(0, 300)}`,
    );
    err.status = res.status;
    throw err;
  }
  return text ? JSON.parse(text) : {};
}

function clampInt(v, def, min, max) {
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) return def;
  return Math.min(max, Math.max(min, n));
}

// Calendar needs RFC3339 with an offset; accept plain dates from the model.
function toRfc3339(v) {
  if (!v) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return `${v}T00:00:00Z`;
  if (/^\d{4}-\d{2}-\d{2}T[\d:.]+$/.test(v)) return `${v}Z`;
  return v;
}

const escapeDriveQuery = (s) => String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'");

// ---- tool implementations -------------------------------------------------

async function calendarListEvents(args, token) {
  const params = new URLSearchParams({
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: String(clampInt(args.max_results, 10, 1, 25)),
  });
  const min = toRfc3339(args.time_min) || new Date().toISOString();
  params.set("timeMin", min);
  const max = toRfc3339(args.time_max);
  if (max) params.set("timeMax", max);
  if (args.query) params.set("q", String(args.query));

  const data = await gfetch(`${CAL}/calendars/primary/events?${params}`, token);
  return (data.items || []).map((e) => ({
    id: e.id,
    title: e.summary || "(no title)",
    start: e.start?.dateTime || e.start?.date || null,
    end: e.end?.dateTime || e.end?.date || null,
    location: e.location || null,
    link: e.htmlLink || null,
  }));
}

async function gmailSearch(args, token) {
  const params = new URLSearchParams({
    maxResults: String(clampInt(args.max_results, 5, 1, 15)),
  });
  if (args.query) params.set("q", String(args.query));
  const list = await gfetch(`${GMAIL}/messages?${params}`, token);
  const ids = (list.messages || []).map((m) => m.id);

  return await Promise.all(ids.map(async (id) => {
    const m = await gfetch(
      `${GMAIL}/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
      token,
    );
    const h = Object.fromEntries(
      (m.payload?.headers || []).map((x) => [x.name.toLowerCase(), x.value]),
    );
    return {
      id,
      from: h.from || "",
      subject: h.subject || "(no subject)",
      date: h.date || "",
      snippet: m.snippet || "",
      link: `https://mail.google.com/mail/u/0/#all/${id}`,
    };
  }));
}

function decodeB64Url(data) {
  const b64 = data.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function findPart(payload, mime) {
  if (!payload) return null;
  if (payload.mimeType === mime && payload.body?.data) return payload.body.data;
  for (const p of payload.parts || []) {
    const hit = findPart(p, mime);
    if (hit) return hit;
  }
  return null;
}

async function gmailRead(args, token) {
  if (!args.id) throw new Error("id is required");
  const m = await gfetch(`${GMAIL}/messages/${encodeURIComponent(args.id)}?format=full`, token);
  const h = Object.fromEntries(
    (m.payload?.headers || []).map((x) => [x.name.toLowerCase(), x.value]),
  );
  let body = "";
  const plain = findPart(m.payload, "text/plain");
  if (plain) body = decodeB64Url(plain);
  else {
    const html = findPart(m.payload, "text/html");
    if (html) body = decodeB64Url(html).replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ");
  }
  body = (body || m.snippet || "").replace(/\s+\n/g, "\n").trim().slice(0, 6000);
  return {
    id: m.id,
    from: h.from || "",
    to: h.to || "",
    subject: h.subject || "(no subject)",
    date: h.date || "",
    body,
    link: `https://mail.google.com/mail/u/0/#all/${m.id}`,
  };
}

async function driveSearch(args, token) {
  const clauses = ["trashed = false"];
  if (args.query) {
    const q = escapeDriveQuery(args.query);
    clauses.push(`(name contains '${q}' or fullText contains '${q}')`);
  }
  if (args.folder_id) clauses.push(`'${escapeDriveQuery(args.folder_id)}' in parents`);
  if (args.modified_after) {
    clauses.push(`modifiedTime > '${escapeDriveQuery(toRfc3339(args.modified_after))}'`);
  }
  const params = new URLSearchParams({
    q: clauses.join(" and "),
    pageSize: String(clampInt(args.max_results, 10, 1, 25)),
    orderBy: "modifiedTime desc",
    fields: "files(id,name,mimeType,modifiedTime,webViewLink)",
  });
  const data = await gfetch(`${DRIVE}/files?${params}`, token);
  return (data.files || []).map((f) => ({
    id: f.id,
    name: f.name,
    type: f.mimeType,
    modified: f.modifiedTime,
    link: f.webViewLink || null,
  }));
}

// ---- declarations (Gemini function calling schema) ------------------------

const DECLARATIONS = {
  calendar_list_events: {
    description:
      "List events on the user's primary Google Calendar, ordered by start time. Use time_min/time_max to bound a day or week.",
    parameters: {
      type: "object",
      properties: {
        time_min: { type: "string", description: "Start of range, ISO 8601 (e.g. 2026-10-08T00:00:00+02:00). Defaults to now." },
        time_max: { type: "string", description: "End of range, ISO 8601." },
        query: { type: "string", description: "Optional free-text filter." },
        max_results: { type: "integer", description: "1-25, default 10." },
      },
    },
  },
  gmail_search: {
    description:
      "Search the user's Gmail using Gmail search syntax (from:, subject:, is:unread, newer_than:2d, ...). Returns sender, subject, date and snippet. Empty query returns the latest mail.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Gmail search query." },
        max_results: { type: "integer", description: "1-15, default 5." },
      },
    },
  },
  gmail_read: {
    description: "Read the full text of one email by its id (from gmail_search).",
    parameters: {
      type: "object",
      properties: { id: { type: "string", description: "Message id." } },
      required: ["id"],
    },
  },
  drive_search: {
    description:
      "Search the user's Google Drive files, newest first. query matches file name and content. folder_id can be 'root' for the main folder.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Text to look for in name or content." },
        folder_id: { type: "string", description: "Restrict to a folder id, or 'root'." },
        modified_after: { type: "string", description: "ISO 8601 date/time." },
        max_results: { type: "integer", description: "1-25, default 10." },
      },
    },
  },
};

const IMPLEMENTATIONS = {
  calendar_list_events: calendarListEvents,
  gmail_search: gmailSearch,
  gmail_read: gmailRead,
  drive_search: driveSearch,
};

const TOOLSETS = {
  calendar: ["calendar_list_events"],
  gmail: ["gmail_search", "gmail_read"],
  drive: ["drive_search"],
  omni: ["calendar_list_events", "gmail_search", "gmail_read", "drive_search"],
};

export function toolDeclarations(kind) {
  return (TOOLSETS[kind] || TOOLSETS.omni).map((name) => ({ name, ...DECLARATIONS[name] }));
}

export async function runTool(name, args, token) {
  const impl = IMPLEMENTATIONS[name];
  if (!impl) throw new Error(`Unknown tool: ${name}`);
  return await impl(args || {}, token);
}
