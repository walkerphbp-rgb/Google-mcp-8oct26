# Groq x Google MCP Connectors Demo

A demo application showing how to use [Groq's MCP (Model Context Protocol) integration](https://groq.com) to interact with Google services (Calendar, Gmail, Drive) using natural language queries.

https://github.com/user-attachments/assets/a1c2399e-ff9a-45fc-a364-833bc3500ea6

## Overview

This project demonstrates Groq's new Groq x Google MCP Connectors, which allow AI models to directly access and query your Google services. It includes:

- **CLI demos** — Simple command-line scripts for testing each connector
- **Web app** — Interactive interface with OAuth login for querying all three services

## Quick Start (CLI)

### Install Deno

This project uses Deno: a modern JavaScript/TypeScript runtime. If you don't have Deno installed:

**macOS / Linux:**
```bash
curl -fsSL https://deno.land/install.sh | sh
```

**Windows (PowerShell):**
```powershell
irm https://deno.land/install.ps1 | iex
```

For more installation options, visit [deno.land/manual/getting_started/installation](https://deno.land/manual/getting_started/installation)

### Get OAuth Token

The easiest way to get started is using the [OAuth Playground](https://developers.google.com/oauthplayground/):

1. Visit https://developers.google.com/oauthplayground/
2. Paste these scopes into "Input your own scopes":
   ```
   https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/drive.readonly
   ```
3. Click "Authorize APIs" and log in with your Google account
4. Click "Exchange authorization code for tokens"
5. Copy the access token (starts with `ya29.a0...`)

### Configure Environment

Create a `.env` file:
```bash
GROQ_API_KEY=your_groq_api_key_here
GOOGLE_AUTHORIZATION=ya29.a0ATi6K2...  # Your access token
```

Run the demos:
```bash
deno task calendar  # Query your calendar
deno task gmail     # Search your email
deno task drive     # Browse your files
```

**Note:** Playground tokens expire after 1 hour.

## Web App Setup

### Install Deno

This project uses Deno, a modern JavaScript/TypeScript runtime. If you don't have Deno installed:

**macOS / Linux:**
```bash
curl -fsSL https://deno.land/install.sh | sh
```

**Windows (PowerShell):**
```powershell
irm https://deno.land/install.ps1 | iex
```

For more installation options, visit [deno.land/manual/getting_started/installation](https://deno.land/manual/getting_started/installation)

### 1. Create OAuth Credentials

For a persistent login, set up Google OAuth:

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project (or select an existing one)
3. Enable the APIs:
   - Click **+ Enable APIs and Services**
   - Search for and enable: **Gmail API**, **Google Calendar API**, **Google Drive API**
4. Configure OAuth consent screen:
   - Go to **APIs & Services** → **OAuth consent screen**
   - Choose **External** and click **Create**
   - Fill in the required app information and click **Save and Continue**
5. Add scopes to your app:
   - Click on your app, then go to **Data Access**
   - Click **Add or remove scopes**
   - Scroll down to **Manually add scopes** and paste:
     ```
     https://www.googleapis.com/auth/gmail.modify
     https://www.googleapis.com/auth/userinfo.email
     https://www.googleapis.com/auth/calendar.events
     https://www.googleapis.com/auth/drive.readonly
     ```
   - Click **Update**
6. Create OAuth credentials:
   - Go to **APIs & Services** → **Credentials**
   - Click **Create Credentials** → **OAuth client ID**
   - Choose **Web application**
   - Add authorized redirect URI: `http://localhost:8000/callback`
   - Save and copy your **Client ID** and **Client Secret**

### 2. Configure Environment

Copy `.env.example` to `.env` and fill it in:
```bash
GOOGLE_CLIENT_ID=your_client_id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your_client_secret
GROQ_API_KEY=your_groq_api_key_here        # optional here: can be set in the menu instead
GEMINI_API_KEY=your_gemini_api_key_here    # optional: fallback when Groq runs out of tokens
PORT=8000  # Optional, defaults to 8000
```

The Groq and Gemini keys can also be entered in the app itself (see below), so you don't have to put them in `.env`.

### 3. Run the App

```bash
deno task serve
```

Visit `http://localhost:8000`, click "Login with Google", and start querying your services!

## Menu, Status Light and Gemini Fallback

Open the hamburger menu (☰, top left) to:

- **Save** your Groq and Gemini API keys (stored in this browser's `localStorage`, sent to the server with each request)
- **Connect** to verify both keys (this only lists models, so it costs no tokens)
- **Clear** the saved keys

The light next to the menu button shows the connection state:

| Light | Meaning |
|-------|---------|
| Green | Connected and answering with Groq (or Gemini, if that's the only key) |
| Amber | Groq's token limit was reached; Gemini 2.5 Flash is answering until Groq resets (countdown shown) |
| Red   | Keys invalid, or Groq is limited and there is no Gemini key |
| Grey  | Not connected yet |

**How the fallback works.** Groq goes first. If Groq answers HTTP 429/413 (token or rate limit), the server reads the reset time from the response, switches to Gemini 2.5 Flash, and sends requests straight to Gemini while Groq is paused. Once the reset time passes it automatically goes back to Groq. If Groq has a server error it is paused for 30 seconds; if its key is rejected, for 5 minutes. Each answer is tagged with the provider that produced it.

Groq's connectors only run on Groq, so the Gemini path reads your Calendar, Gmail and Drive itself through the Google REST APIs (`app/google-tools.js`) using Gemini function calling, with the same OAuth token. Requests are read-only.

Environment keys (`GROQ_API_KEY`, `GEMINI_API_KEY`) are used whenever the browser has no saved key.

### Tests

```bash
node --test test/llm.test.mjs
```

The tests mock Groq, Gemini and Google, so they need no keys or network.

## How It Works

Groq's MCP integration allows language models to use tools to interact with external services. When you ask a question:

1. Your query is sent to Groq's `/responses` endpoint with MCP tool configurations
2. The model decides which Google service to call and with what parameters
3. Groq executes the MCP tool call with your OAuth token
4. The model synthesizes the results into a natural language response

Example query: "What's on my schedule today?"
- Model calls Calendar MCP connector
- Retrieves your events
- Returns a formatted summary

## Architecture

```
User Query → Groq API (with MCP tools) → Google APIs → Groq Response
                        ↓
                OAuth Token (your credentials)
```

## Environment Variables

| Variable               | Required | Description                           |
|------------------------|----------|---------------------------------------|
| `GROQ_API_KEY`         | Yes*     | Your Groq API key (*or enter it in the web menu) |
| `GEMINI_API_KEY`       | No       | Gemini key for the fallback (or enter it in the web menu) |
| `GOOGLE_AUTHORIZATION` | CLI only | OAuth access token (short-lived)      |
| `GOOGLE_CLIENT_ID`     | Web app  | OAuth client ID from Google Cloud     |
| `GOOGLE_CLIENT_SECRET` | Web app  | OAuth client secret from Google Cloud |
| `PORT`                 | No       | Server port (default: 8000)           |

## Project Structure

```
groq-google-mcp/
├── calendar.ts         # CLI demo for Calendar
├── gmail.ts           # CLI demo for Gmail
├── drive.ts           # CLI demo for Drive
├── app/
│   ├── main.js         # Web app server: OAuth, status/connect, connector routes
│   ├── llm.js          # Groq first, Gemini 2.5 Flash fallback, rate-limit cooldown
│   ├── google-tools.js # Calendar/Gmail/Drive REST tools used by the Gemini path
│   └── index.html      # UI: hamburger menu, status light, cards
├── test/
│   └── llm.test.mjs    # Fallback tests (mocked, no keys needed)
├── auth.ts            # OAuth utilities
├── auth-server.ts     # Standalone auth server
└── deno.json          # Task configuration
```

## API Reference

All three connectors use the same pattern with Groq's `/responses` endpoint:

```javascript
const response = await fetch("https://api.groq.com/openai/v1/responses", {
  method: "POST",
  headers: {
    "authorization": `Bearer ${GROQ_API_KEY}`,
    "content-type": "application/json",
  },
  body: JSON.stringify({
    model: "openai/gpt-oss-120b",
    tools: [{
      type: "mcp",
      server_label: "gmail",  // or "googlecalendar", "google"
      connector_id: "connector_gmail",
      authorization: googleToken,
      require_approval: "never",
    }],
    input: "your natural language query",
    stream: false,
  }),
});
```

## Examples

**Calendar:**
- "What meetings do I have this week?"
- "Am I free tomorrow afternoon?"

**Gmail:**
- "What was my last email from Groq?"
- "Show me unread emails from today"

**Drive:**
- "List files in my main folder"
- "Find documents modified this week"

## Learn More

- [Groq Documentation](https://console.groq.com/docs)
- [Google Calendar API](https://developers.google.com/calendar)
- [Gmail API](https://developers.google.com/gmail)
- [Google Drive API](https://developers.google.com/drive)

## Contributing

Contributions are welcome! Pull requests are encouraged. Please feel free to submit a PR for any improvements, bug fixes, or new features.

## License

Apache 2.0
