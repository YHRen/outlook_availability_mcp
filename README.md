# Calendar Availability MCP

A read-only [Model Context Protocol](https://modelcontextprotocol.io/) server that turns one or more ICS calendars into privacy-safe availability queries. It works with any HTTPS ICS feed; published Outlook calendar links are the primary tested source.

It intentionally never returns event titles, descriptions, locations, attendees, organizers, or raw calendar data — only busy/free time intervals.

## Requirements

- Node.js 20.6 or newer.
- An HTTPS URL to an ICS calendar feed.

No installation is needed: MCP clients can launch the server straight from this repository with `npx -y github:YHRen/outlook_availability_mcp`. The first launch clones and builds the package (expect several seconds); after that it runs from the npx cache. To get reproducible installs, pin a tag or commit, e.g. `github:YHRen/outlook_availability_mcp#v0.1.0`.

## Get a calendar URL (Outlook)

1. In Outlook on the web, open **Settings → Calendar → Shared calendars**.
2. Under **Publish a calendar**, pick the calendar, choose **Can view when I'm busy** (this server strips details anyway, but busy-only is the safest link to hold), and click **Publish**.
3. Copy the **ICS** link.

Any other provider's ICS URL works the same way as long as it is served over HTTPS on port 443.

## Connect an MCP client

**Claude Code:**

```bash
claude mcp add calendar-availability \
  --env CALENDAR_ICS_URL="https://outlook.office365.com/owa/calendar/<token>/calendar.ics" \
  --env CALENDAR_ALLOWED_HOSTS="outlook.office365.com" \
  -- npx -y github:YHRen/outlook_availability_mcp
```

**Claude Desktop** (`claude_desktop_config.json`) and other JSON-configured hosts:

```json
{
  "mcpServers": {
    "calendar-availability": {
      "command": "npx",
      "args": ["-y", "github:YHRen/outlook_availability_mcp"],
      "env": {
        "CALENDAR_ICS_URL": "https://outlook.office365.com/owa/calendar/<token>/calendar.ics",
        "CALENDAR_ALLOWED_HOSTS": "outlook.office365.com"
      }
    }
  }
}
```

**OpenAI Codex CLI** (`~/.codex/config.toml`):

```toml
[mcp_servers.calendar-availability]
command = "npx"
args = ["-y", "github:YHRen/outlook_availability_mcp"]

[mcp_servers.calendar-availability.env]
CALENDAR_ICS_URL = "https://outlook.office365.com/owa/calendar/<token>/calendar.ics"
CALENDAR_ALLOWED_HOSTS = "outlook.office365.com"
```

**Google Antigravity** (agy CLI and IDE) — add to the shared `~/.gemini/config/mcp_config.json`, or `.agents/mcp_config.json` to scope it to one workspace:

```json
{
  "mcpServers": {
    "calendar-availability": {
      "command": "npx",
      "args": ["-y", "github:YHRen/outlook_availability_mcp"],
      "env": {
        "CALENDAR_ICS_URL": "https://outlook.office365.com/owa/calendar/<token>/calendar.ics",
        "CALENDAR_ALLOWED_HOSTS": "outlook.office365.com"
      }
    }
  }
}
```

Other MCP hosts follow the same pattern: launch `npx -y github:YHRen/outlook_availability_mcp` over stdio with the `CALENDAR_*` environment variables set.

Personal (non-work) Microsoft accounts publish from `outlook.live.com`; set the allowlist to match your link's host.

To sanity-check your calendar URL outside a client, run the server directly — it speaks MCP over stdio, so it will sit waiting for a client; starting without an error means the configuration is valid (Ctrl-C to exit):

```bash
CALENDAR_ICS_URL="https://…/calendar.ics" npx -y github:YHRen/outlook_availability_mcp
```

## Tools

- `get_availability(start, end, timezone?, calendars?, includeTentative?)`: merged busy intervals only.
- `find_free_slots(start, end, durationMinutes, timezone?, calendars?, includeTentative?, bufferMinutes?, workingHours?)`: openings matching a required duration, working hours, and optional meeting buffer.
- `get_calendar_status()`: cache/source health without event content.

Example — `find_free_slots` with `{"start": "2026-09-01T00:00:00-04:00", "end": "2026-09-03T00:00:00-04:00", "durationMinutes": 30}` returns:

```json
{
  "timezone": "America/New_York",
  "start": "2026-09-01T00:00:00-04:00",
  "end": "2026-09-03T00:00:00-04:00",
  "durationMinutes": 30,
  "slots": [
    { "start": "2026-09-01T10:00:00-04:00", "end": "2026-09-01T11:00:00-04:00", "durationMinutes": 60 }
  ]
}
```

Queries use offset-bearing ISO-8601 input timestamps, output the caller's requested IANA timezone, and are capped at 90 days. All-day and floating (TZID-less) events are interpreted in the requested timezone. ICS refreshes are cached for five minutes by default and use conditional HTTP requests when the provider supports them. If a refresh fails, cached data is served with a `staleCalendars` field in the response and retries are backed off for 30 seconds.

## Configuration

Set environment variables through your MCP host's `env` block (or `.env` for local runs):

- `CALENDAR_ICS_URL` — a single calendar feed.
- `CALENDARS_JSON` — multiple named calendars instead, e.g. `[{"id":"personal","url":"https://…/personal.ics"},{"id":"team","url":"https://…/team.ics"}]`. Takes precedence over `CALENDAR_ICS_URL`.
- `CALENDAR_ALLOWED_HOSTS` — optional comma-separated host allowlist; strongly recommended.
- `CALENDAR_CACHE_TTL_SECONDS` — feed cache lifetime, default `300`.
- `CALENDAR_DEFAULT_TIMEZONE` — IANA timezone used when a query does not specify one, default `America/New_York`.

## Privacy and security

A published ICS URL often acts like a bearer link: anyone with it may read the calendar view. Store it only in secret or local environment configuration, do not commit it, and rotate/revoke it if exposed. The server enforces HTTPS, rejects embedded URL credentials and non-443 ports, validates every redirect hop against the same rules and the host allowlist, restricts feed size to 5 MiB, and does not log the source URL or calendar contents.

## Development

```bash
git clone https://github.com/YHRen/outlook_availability_mcp.git
cd outlook_availability_mcp
npm install     # also compiles dist/ via the prepare script
cp .env.example .env   # put your calendar URL in .env (do not commit it)

npm test        # vitest, synthetic fixtures only
npm run check   # typecheck
npm run build   # compile to dist/
node --env-file=.env dist/index.js                  # run the built server
node --env-file=.env --import tsx src/index.ts     # run from source
```

To point an MCP client at a local checkout instead of the npm package, use `node /absolute/path/to/outlook_availability_mcp/dist/index.js` as the command.
