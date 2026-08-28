import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { findFreeSlots, mergeBusyEvents } from "../src/availability.js";
import { parseAvailabilityIcs } from "../src/ics.js";

const fixtureUrl = new URL("./fixtures/calendar.ics", import.meta.url);

async function fixture(): Promise<string> {
  return readFile(fileURLToPath(fixtureUrl), "utf8");
}

function calendar(vevents: string[]): string {
  return ["BEGIN:VCALENDAR", ...vevents, "END:VCALENDAR"].join("\r\n");
}

describe("ICS availability parsing", () => {
  it("expands recurrence while excluding transparent events and private details", async () => {
    const events = parseAvailabilityIcs(
      "personal",
      await fixture(),
      new Date("2026-09-01T00:00:00Z"),
      new Date("2026-09-05T00:00:00Z"),
      "UTC",
    );

    expect(events).toHaveLength(5);
    expect(events.map((event) => event.uid)).toEqual(["busy-1", "tentative-1", "daily-1", "daily-1", "daily-1"]);
    expect(events.find((event) => event.start.toISOString() === "2026-09-02T17:00:00.000Z")?.end.toISOString()).toBe(
      "2026-09-02T17:30:00.000Z",
    );
    expect(JSON.stringify(events)).not.toContain("Private meeting");
    expect(JSON.stringify(events)).not.toContain("Secret Room");
  });

  it("interprets all-day events in the requested timezone, not the server's", () => {
    const ics = calendar([
      "BEGIN:VEVENT",
      "UID:allday-1",
      "DTSTART;VALUE=DATE:20260902",
      "DTEND;VALUE=DATE:20260903",
      "END:VEVENT",
    ]);
    const range: [Date, Date] = [new Date("2026-09-01T00:00:00Z"), new Date("2026-09-05T00:00:00Z")];

    const [inNewYork] = parseAvailabilityIcs("t", ics, ...range, "America/New_York");
    expect(inNewYork.start.toISOString()).toBe("2026-09-02T04:00:00.000Z");
    expect(inNewYork.end.toISOString()).toBe("2026-09-03T04:00:00.000Z");
    expect(inNewYork.allDay).toBe(true);

    const [inTokyo] = parseAvailabilityIcs("t", ics, ...range, "Asia/Tokyo");
    expect(inTokyo.start.toISOString()).toBe("2026-09-01T15:00:00.000Z");
  });

  it("finds occurrences of long-running series without exhausting the occurrence cap", () => {
    const ics = calendar([
      "BEGIN:VEVENT",
      "UID:old-daily",
      "DTSTART:20000103T150000Z",
      "DTEND:20000103T153000Z",
      "RRULE:FREQ=DAILY",
      "END:VEVENT",
    ]);
    const events = parseAvailabilityIcs(
      "t",
      ics,
      new Date("2026-09-01T00:00:00Z"),
      new Date("2026-09-03T00:00:00Z"),
      "UTC",
    );

    expect(events.map((event) => event.start.toISOString())).toEqual([
      "2026-09-01T15:00:00.000Z",
      "2026-09-02T15:00:00.000Z",
    ]);
  });

  it("keeps the weekday of long-running weekly series", () => {
    // 2000-01-03 was a Monday; the queried week contains Monday 2026-08-31.
    const ics = calendar([
      "BEGIN:VEVENT",
      "UID:old-weekly",
      "DTSTART:20000103T150000Z",
      "DTEND:20000103T160000Z",
      "RRULE:FREQ=WEEKLY",
      "END:VEVENT",
    ]);
    const events = parseAvailabilityIcs(
      "t",
      ics,
      new Date("2026-08-30T00:00:00Z"),
      new Date("2026-09-06T00:00:00Z"),
      "UTC",
    );

    expect(events.map((event) => event.start.toISOString())).toEqual(["2026-08-31T15:00:00.000Z"]);
  });

  it("honors overrides that move an occurrence and cancelled overrides", () => {
    const ics = calendar([
      "BEGIN:VEVENT",
      "UID:rec-1",
      "DTSTART:20260901T090000Z",
      "DTEND:20260901T100000Z",
      "RRULE:FREQ=DAILY;COUNT=3",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:rec-1",
      "RECURRENCE-ID:20260902T090000Z",
      "DTSTART:20260902T150000Z",
      "DTEND:20260902T160000Z",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:rec-1",
      "RECURRENCE-ID:20260903T090000Z",
      "DTSTART:20260903T090000Z",
      "DTEND:20260903T100000Z",
      "STATUS:CANCELLED",
      "END:VEVENT",
    ]);
    const events = parseAvailabilityIcs(
      "t",
      ics,
      new Date("2026-09-01T00:00:00Z"),
      new Date("2026-09-05T00:00:00Z"),
      "UTC",
    );

    expect(events.map((event) => event.start.toISOString())).toEqual([
      "2026-09-01T09:00:00.000Z",
      "2026-09-02T15:00:00.000Z",
    ]);
  });

  it("returns merged busy time in the caller timezone", async () => {
    const events = parseAvailabilityIcs(
      "personal",
      await fixture(),
      new Date("2026-09-01T00:00:00Z"),
      new Date("2026-09-02T00:00:00Z"),
      "America/New_York",
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
      "America/New_York",
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

  it("rejects inverted working hours even when no weekday matches", () => {
    expect(() =>
      findFreeSlots([], new Date("2026-09-01T00:00:00Z"), new Date("2026-09-02T00:00:00Z"), {
        timezone: "UTC",
        includeTentative: true,
        durationMinutes: 30,
        bufferMinutes: 0,
        workingHours: { start: "17:00", end: "09:00", weekdays: [6] },
      }),
    ).toThrow("Working-hours end must be after its start.");
  });
});
