import { Hono } from 'https://deno.land/x/hono@v3.11.12/mod.ts';
import "jsr:@std/dotenv/load"; // needed for deno run; not req for smallweb or valtown
import { ask, LLMError, status, testKeys } from './llm.js';

const app = new Hono();

// Read HTML file
const htmlContent = await Deno.readTextFile(new URL('./index.html', import.meta.url));

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

// ---------------------------------------------------------------------------
// API keys
//
// Keys saved in the hamburger menu live in the browser and are sent with each
// request in the x-groq-key / x-gemini-key headers. Environment variables are
// used when no header is present, so a server-wide key still works.
// ---------------------------------------------------------------------------
const envGroqKey = () => Deno.env.get("GROQ_API_KEY") || "";
const envGeminiKey = () => Deno.env.get("GEMINI_API_KEY") || "";

function keysFrom(c) {
  return {
    groqKey: (c.req.header('x-groq-key') || envGroqKey()).trim(),
    geminiKey: (c.req.header('x-gemini-key') || envGeminiKey()).trim(),
  };
}

// ---------------------------------------------------------------------------
// OAuth routes
// ---------------------------------------------------------------------------
const CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID");
const CLIENT_SECRET = Deno.env.get("GOOGLE_CLIENT_SECRET");

// Start OAuth flow
app.get('/auth', (c) => {
  if (!CLIENT_ID) {
    return c.html('<html><body><h1>Error</h1><p>GOOGLE_CLIENT_ID is required in environment variables</p></body></html>', 500);
  }

  const scopes = [
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/calendar.events",
    "https://www.googleapis.com/auth/drive.readonly",
  ].join(" ");

  // Get the origin from the request URL
  const url = new URL(c.req.url);
  const redirectUri = `${url.origin}/callback`;

  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.set("client_id", CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", scopes);
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("prompt", "consent");

  return c.redirect(authUrl.toString());
});

// OAuth callback
app.get('/callback', async (c) => {
  const code = c.req.query("code");

  if (!code) {
    return c.html('<html><body><h1>Authentication Failed</h1><p>No authorization code received</p><p><a href="/">Go back</a></p></body></html>', 400);
  }

  if (!CLIENT_ID || !CLIENT_SECRET) {
    return c.html('<html><body><h1>Error</h1><p>GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are required</p></body></html>', 500);
  }

  try {
    // Get the origin from the request URL
    const url = new URL(c.req.url);
    const redirectUri = `${url.origin}/callback`;

    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        code,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
    });

    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text();
      return c.html(`<html><body><h1>Authentication Failed</h1><p>Token exchange failed: ${escapeHtml(errorText)}</p><p><a href="/">Go back</a></p></body></html>`, 400);
    }

    const tokenData = await tokenResponse.json();
    // JSON-encode (and neutralise "<") so the token can never break out of the script tag
    const safeToken = JSON.stringify(tokenData.access_token).replace(/</g, '\\u003c');

    // Return page that stores token in localStorage and redirects
    return c.html(`<!DOCTYPE html>
<html>
<head>
  <title>Authentication Successful</title>
  <style>
    body { font-family: system-ui; padding: 2rem; text-align: center; }
    .success { color: #28a745; font-size: 1.2rem; margin: 2rem 0; }
  </style>
</head>
<body>
  <h1>✅ Authentication Successful!</h1>
  <p class="success">Redirecting...</p>
  <script>
    localStorage.setItem('google_token', ${safeToken});
    localStorage.setItem('google_login_time', Date.now().toString());
    window.location.href = '/';
  </script>
</body>
</html>`);
  } catch (err) {
    return c.html(`<html><body><h1>Error</h1><p>${escapeHtml(err.message)}</p><p><a href="/">Go back</a></p></body></html>`, 500);
  }
});

// Serve root with HTML content
app.get('/', (c) => {
  return c.html(htmlContent);
});

// ---------------------------------------------------------------------------
// Key status + connect (used by the hamburger menu / status light)
// ---------------------------------------------------------------------------

// Cheap snapshot, no network calls: which keys exist and whether Groq is cooling down.
app.get('/api/status', async (c) => {
  const keys = keysFrom(c);
  const snapshot = await status(keys);
  return c.json({
    ...snapshot,
    env: { groq: !!envGroqKey(), gemini: !!envGeminiKey() },
    now: Date.now(),
  });
});

// Verify the keys against Groq / Gemini (does not spend tokens).
app.post('/api/connect', async (c) => {
  const keys = keysFrom(c);
  const [tested, snapshot] = await Promise.all([testKeys(keys), status(keys)]);
  return c.json({
    groq: { ...snapshot.groq, ...tested.groq },
    gemini: { ...snapshot.gemini, ...tested.gemini },
    env: { groq: !!envGroqKey(), gemini: !!envGeminiKey() },
    now: Date.now(),
  });
});

// ---------------------------------------------------------------------------
// Connector endpoints: calendar / gmail / drive / omni
// ---------------------------------------------------------------------------
const connector = (labelVar, idVar, defaultLabel, defaultId) => ({
  label: Deno.env.get(labelVar) || defaultLabel,
  id: Deno.env.get(idVar) || defaultId,
});

const CONNECTORS = {
  calendar: () => [connector("CALENDAR_SERVER_LABEL", "CALENDAR_CONNECTOR_ID", "googlecalendar", "connector_googlecalendar")],
  gmail: () => [connector("GMAIL_SERVER_LABEL", "GMAIL_CONNECTOR_ID", "gmail", "connector_gmail")],
  drive: () => [connector("DRIVE_SERVER_LABEL", "DRIVE_CONNECTOR_ID", "google", "connector_googledrive")],
};
CONNECTORS.omni = () => [...CONNECTORS.calendar(), ...CONNECTORS.gmail(), ...CONNECTORS.drive()];

function connectorRoute(kind) {
  return async (c) => {
    try {
      const { input, token, tz } = await c.req.json();
      const { groqKey, geminiKey } = keysFrom(c);

      if (!groqKey && !geminiKey) {
        return c.json({ error: 'No API key configured. Open the menu (☰) and add a Groq and/or Gemini key.' }, 400);
      }
      if (!token) {
        return c.json({ error: 'Please login with Google first' }, 400);
      }

      // Add instruction to avoid tables and use plain text only
      const enhancedInput = input + "\n\nIMPORTANT: Respond with plain text only. Do not use markdown tables. Use simple text formatting like bullet points or numbered lists instead.";

      const out = await ask({
        kind,
        input: enhancedInput,
        token,
        groqKey,
        geminiKey,
        connectors: CONNECTORS[kind](),
        tz,
      });
      return c.json(out);
    } catch (error) {
      if (error instanceof LLMError) {
        console.error(`${kind} error:`, error.message);
        return c.json({
          error: error.message,
          errorDetails: error.details,
          status: error.status,
          retryAt: error.retryAt,
        }, error.status >= 500 ? 500 : error.status);
      }
      console.error(`${kind} API error:`, error);
      return c.json({ error: 'Server error: ' + error.message }, 500);
    }
  };
}

app.post('/api/calendar', connectorRoute('calendar'));
app.post('/api/gmail', connectorRoute('gmail'));
app.post('/api/drive', connectorRoute('drive'));
app.post('/api/omni', connectorRoute('omni'));

// Export app.fetch for Val Town, otherwise export app — this is only for hono apps
export default (typeof Deno !== "undefined" && Deno.env.get("valtown")) ? app.fetch : app;
