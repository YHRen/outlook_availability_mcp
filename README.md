# Calendar Availability MCP

A reusable, read-only [Model Context Protocol](https://modelcontextprotocol.io/) server that turns one or more ICS calendars into privacy-safe availability queries. Its initial adapter works with a published Outlook ICS link, but the scheduling core is source-neutral.

It intentionally never returns event titles, descriptions, locations, attendees, organizers, or raw calendar data.

## Quick start

```bash
npm install
cp .env.example .env
# Put your calendar URL in CALENDAR_ICS_URL in .env (do not commit it).
node --env-file=.env --import tsx src/index.ts
```

Load environment variables using your MCP host's configuration, then run the server through stdio. For example:

```json
{
  "mcpServers": {
    "calendar-availability": {
      "command": "node",
      "args": ["/absolute/path/to/calendar-availability-mcp/dist/index.js"],
      "env": {
        "CALENDAR_ICS_URL": "https://calendar-provider.example/opaque-calendar-token/calendar.ics",
        "CALENDAR_ALLOWED_HOSTS": "calendar-provider.example"
      }
    }
  }
}
```

Run `npm run build` before using the production command above. During development use `tsx` or your MCP client's equivalent development configuration.

## Tools

- `get_availability`: returns merged busy intervals only.
- `find_free_slots`: returns openings matching a required duration, working hours, and optional meeting buffer.
- `get_calendar_status`: cache/source health without event content.

Queries use offset-bearing ISO-8601 input timestamps, output the caller's requested IANA timezone, and are capped at 90 days. ICS refreshes are cached for five minutes by default and use conditional HTTP requests when the provider supports them.

## Configuration

Use one calendar:

```bash
CALENDAR_ICS_URL=https://example.invalid/calendar.ics
```

Or provide multiple named calendars:

```bash
CALENDARS_JSON='[{"id":"personal","url":"https://example.invalid/personal.ics"},{"id":"team","url":"https://example.invalid/team.ics"}]'
```

`CALENDAR_ALLOWED_HOSTS` is an optional comma-separated allowlist. `CALENDAR_CACHE_TTL_SECONDS` defaults to `300`.

## Privacy and security

A published ICS URL often acts like a bearer link: anyone with it may read the calendar view. Store it only in secret or local environment configuration, do not commit it, and rotate/revoke it if exposed. The server enforces HTTPS, rejects embedded URL credentials and non-443 ports, restricts feed size to 5 MiB, and does not log the source URL or calendar contents.

## Development

```bash
npm test
npm run check
npm run build
```

Tests use only synthetic calendar fixtures.
