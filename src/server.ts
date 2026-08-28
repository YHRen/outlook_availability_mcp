import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { findFreeSlots, mergeBusyEvents } from "./availability.js";
import type { IcsCalendarSource } from "./source.js";

const isoDateTime = z.string().datetime({ offset: true });
const timezone = z.string().min(1).default("America/New_York");
const calendarIds = z.array(z.string()).optional().default([]);

function parseRange(start: string, end: string): { start: Date; end: Date } {
  const parsedStart = new Date(start);
  const parsedEnd = new Date(end);
  if (parsedEnd <= parsedStart) throw new Error("end must be after start.");
  if (parsedEnd.getTime() - parsedStart.getTime() > 90 * 24 * 60 * 60 * 1_000) {
    throw new Error("Queries may span at most 90 days.");
  }
  return { start: parsedStart, end: parsedEnd };
}

function response(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
    structuredContent: data as Record<string, unknown>,
  };
}

export function createServer(source: IcsCalendarSource): McpServer {
  const server = new McpServer({ name: "calendar-availability-mcp", version: "0.1.0" });

  server.registerTool(
    "get_availability",
    {
      description: "Return privacy-safe busy intervals for the configured calendars. Event names, locations, attendees, and notes are never returned.",
      inputSchema: {
        start: isoDateTime.describe("Inclusive ISO-8601 timestamp with an offset."),
        end: isoDateTime.describe("Exclusive ISO-8601 timestamp with an offset."),
        timezone: timezone.describe("IANA timezone used in the response."),
        calendars: calendarIds.describe("Optional configured calendar ids. Defaults to all calendars."),
        includeTentative: z.boolean().default(true).describe("Whether tentative events block time."),
      },
    },
    async ({ start, end, timezone: zone, calendars, includeTentative }) => {
      const range = parseRange(start, end);
      const events = await source.events(calendars, range.start, range.end);
      const busy = mergeBusyEvents(events, { timezone: zone, includeTentative });
      return response({ timezone: zone, start, end, busy });
    },
  );

  server.registerTool(
    "find_free_slots",
    {
      description: "Find privacy-safe free intervals across configured calendars during stated working hours.",
      inputSchema: {
        start: isoDateTime,
        end: isoDateTime,
        durationMinutes: z.number().int().min(1).max(24 * 60),
        timezone,
        calendars: calendarIds,
        includeTentative: z.boolean().default(true),
        bufferMinutes: z.number().int().min(0).max(240).default(0),
        workingHours: z
          .object({
            start: z.string().default("09:00"),
            end: z.string().default("17:00"),
            weekdays: z.array(z.number().int().min(1).max(7)).min(1).default([1, 2, 3, 4, 5]),
          })
          .default({ start: "09:00", end: "17:00", weekdays: [1, 2, 3, 4, 5] }),
      },
    },
    async ({ start, end, durationMinutes, timezone: zone, calendars, includeTentative, bufferMinutes, workingHours }) => {
      const range = parseRange(start, end);
      const events = await source.events(calendars, range.start, range.end);
      const slots = findFreeSlots(events, range.start, range.end, {
        timezone: zone,
        includeTentative,
        durationMinutes,
        bufferMinutes,
        workingHours,
      });
      return response({ timezone: zone, start, end, durationMinutes, slots });
    },
  );

  server.registerTool(
    "get_calendar_status",
    {
      description: "Return source-health and cache metadata only; it does not reveal calendar content.",
      inputSchema: {},
    },
    async () => response({ calendars: source.health() }),
  );

  return server;
}
