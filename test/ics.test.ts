import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { findFreeSlots, mergeBusyEvents } from "../src/availability.js";
import { parseAvailabilityIcs } from "../src/ics.js";

const fixtureUrl = new URL("./fixtures/calendar.ics", import.meta.url);

async function fixture(): Promise<string> {
  return readFile(fileURLToPath(fixtureUrl), "utf8");
}

describe("ICS availability parsing", () => {
  it("expands recurrence while excluding transparent events and private details", async () => {
    const events = parseAvailabilityIcs(
      "personal",
      await fixture(),
      new Date("2026-09-01T00:00:00Z"),
      new Date("2026-09-05T00:00:00Z"),
    );

    expect(events).toHaveLength(5);
    expect(events.map((event) => event.uid)).toEqual(["busy-1", "tentative-1", "daily-1", "daily-1", "daily-1"]);
    expect(events.find((event) => event.start.toISOString() === "2026-09-02T17:00:00.000Z")?.end.toISOString()).toBe(
      "2026-09-02T17:30:00.000Z",
    );
    expect(JSON.stringify(events)).not.toContain("Private meeting");
    expect(JSON.stringify(events)).not.toContain("Secret Room");
  });

  it("returns merged busy time in the caller timezone", async () => {
    const events = parseAvailabilityIcs(
      "personal",
      await fixture(),
      new Date("2026-09-01T00:00:00Z"),
      new Date("2026-09-02T00:00:00Z"),
    );
    const busy = mergeBusyEvents(events, { timezone: "America/New_York", includeTentative: false });

    expect(busy).toEqual([
      {
        start: "2026-09-01T09:00:00-04:00",
        end: "2026-09-01T10:00:00-04:00",
        status: "busy",
        calendars: ["personal"],
      },
      {
        start: "2026-09-01T12:00:00-04:00",
        end: "2026-09-01T12:30:00-04:00",
        status: "busy",
        calendars: ["personal"],
      },
    ]);
  });

  it("finds slots while respecting meetings, working hours, and buffers", async () => {
    const events = parseAvailabilityIcs(
      "personal",
      await fixture(),
      new Date("2026-09-01T00:00:00Z"),
      new Date("2026-09-02T00:00:00Z"),
    );
    const slots = findFreeSlots(events, new Date("2026-09-01T13:00:00Z"), new Date("2026-09-01T21:00:00Z"), {
      timezone: "America/New_York",
      includeTentative: true,
      durationMinutes: 30,
      bufferMinutes: 0,
      workingHours: { start: "09:00", end: "17:00", weekdays: [2] },
    });

    expect(slots).toEqual([
      { start: "2026-09-01T10:00:00-04:00", end: "2026-09-01T11:00:00-04:00", durationMinutes: 60 },
      { start: "2026-09-01T11:30:00-04:00", end: "2026-09-01T12:00:00-04:00", durationMinutes: 30 },
      { start: "2026-09-01T12:30:00-04:00", end: "2026-09-01T17:00:00-04:00", durationMinutes: 270 },
    ]);
  });
});
