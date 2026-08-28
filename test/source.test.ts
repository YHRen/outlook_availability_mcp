import { describe, expect, it, vi } from "vitest";

import { IcsCalendarSource } from "../src/source.js";

const ics = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:1\r\nDTSTART:20260901T130000Z\r\nDTEND:20260901T140000Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";

describe("IcsCalendarSource", () => {
  it("caches a successful response", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ etag: "test-etag" }),
      text: async () => ics,
    });
    const source = new IcsCalendarSource(
      [{ id: "personal", url: "https://calendar.example/calendar.ics" }],
      60_000,
      new Set(["calendar.example"]),
      fetcher,
    );
    const start = new Date("2026-09-01T00:00:00Z");
    const end = new Date("2026-09-02T00:00:00Z");

    expect(await source.events([], start, end)).toHaveLength(1);
    expect(await source.events([], start, end)).toHaveLength(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(source.health()[0].cached).toBe(true);
  });

  it("rejects an unallowlisted calendar source", () => {
    expect(
      () =>
        new IcsCalendarSource(
          [{ id: "personal", url: "https://not-allowed.example/calendar.ics" }],
          60_000,
          new Set(["allowed.example"]),
        ),
    ).toThrow("not allowed");
  });
});
