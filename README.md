# Calendar Availability MCP

A read-only [Model Context Protocol](https://modelcontextprotocol.io/) server that turns one or more ICS calendars into privacy-safe availability queries. It works with any HTTPS ICS feed; published Outlook calendar links are the primary tested source.

It intentionally never returns event titles, descriptions, locations, attendees, organizers, or raw calendar data — only busy/free time intervals.

## Requirements

- Node.js 20.6 or newer (the examples use `--env-file`, added in 20.6).
- An HTTPS URL to an ICS calendar feed.

## Get a calendar URL (Outlook)

1. In Outlook on the web, open **Settings → Calendar → Shared calendars**.
2. Under **Publish a calendar**, pick the calendar, choose **Can view when I'm busy** (this server strips details anyway, but busy-only is the safest link to hold), and click **Publish**.
3. Copy the **ICS** link.

Any other provider's ICS URL works the same way as long as it is served over HTTPS on port 443.

## Install

```bash
git clone https://github.com/YHRen/outlook_availability_mcp.git
cd outlook_availability_mcp
npm install   # also compiles dist/ via the prepare script
```

Verify it runs:

```bash
cp .env.example .env
# Put your calendar URL in CALENDAR_ICS_URL in .env (do not commit it).
node --env-file=.env dist/index.js
```

The server speaks MCP over stdio, so it will sit waiting for a client; press Ctrl-C to exit. Seeing it start without an error means the configuration is valid.

## Connect an MCP client

**Claude Code:**

```bash
claude mcp add calendar-availability \
  --env CALENDAR_ICS_URL="https://outlook.office365.com/owa/calendar/<token>/calendar.ics" \
  --env CALENDAR_ALLOWED_HOSTS="outlook.office365.com" \
  -- node /absolute/path/to/outlook_availability_mcp/dist/index.js
```

**Claude Desktop** (`claude_desktop_config.json`) and other JSON-configured hosts:

```json
{
  "mcpServers": {
    "calendar-availability": {
      "command": "node",
      "args": ["/absolute/path/to/outlook_availability_mcp/dist/index.js"],
      "env": {
        "CALENDAR_ICS_URL": "https://outlook.office365.com/owa/calendar/<token>/calendar.ics",
        "CALENDAR_ALLOWED_HOSTS": "outlook.office365.com"
      }
    }
  }
}
```

Personal (non-work) Microsoft accounts publish from `outlook.live.com`; set the allowlist to match your link's host.

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
npm test        # vitest, synthetic fixtures only
npm run check   # typecheck
npm run build   # compile to dist/
npm run dev     # run from src/ via tsx (export the env vars yourself,
                # or use: node --env-file=.env --import tsx src/index.ts)
```
