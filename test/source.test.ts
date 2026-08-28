import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IcsCalendarSource } from "../src/source.js";

const ics = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:1\r\nDTSTART:20260901T130000Z\r\nDTEND:20260901T140000Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";

const start = new Date("2026-09-01T00:00:00Z");
const end = new Date("2026-09-02T00:00:00Z");

function okResponse(body = ics, headers: Record<string, string> = { etag: "test-etag" }) {
  return { ok: true, status: 200, headers: new Headers(headers), text: async () => body };
}

describe("IcsCalendarSource", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("caches a successful response", async () => {
    const fetcher = vi.fn().mockResolvedValue(okResponse());
    const source = new IcsCalendarSource(
      [{ id: "personal", url: "https://calendar.example/calendar.ics" }],
      60_000,
      new Set(["calendar.example"]),
      fetcher,
    );

    expect((await source.events([], start, end, "UTC")).events).toHaveLength(1);
    expect((await source.events([], start, end, "UTC")).events).toHaveLength(1);
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

  it("validates every redirect hop against the allowlist", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: false,
      status: 302,
      headers: new Headers({ location: "https://attacker.example/calendar.ics" }),
      text: async () => "",
    });
    const source = new IcsCalendarSource(
      [{ id: "personal", url: "https://calendar.example/calendar.ics" }],
      60_000,
      new Set(["calendar.example"]),
      fetcher,
    );

    await expect(source.events([], start, end, "UTC")).rejects.toThrow("not allowed");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("follows redirects to allowed hosts", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 301,
        headers: new Headers({ location: "https://calendar.example/moved.ics" }),
        text: async () => "",
      })
      .mockResolvedValueOnce(okResponse());
    const source = new IcsCalendarSource(
      [{ id: "personal", url: "https://calendar.example/calendar.ics" }],
      60_000,
      new Set(["calendar.example"]),
      fetcher,
    );

    expect((await source.events([], start, end, "UTC")).events).toHaveLength(1);
    expect(fetcher).toHaveBeenLastCalledWith("https://calendar.example/moved.ics", expect.anything());
  });

  it("serves stale data with a stale flag and backs off after a failed refresh", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(okResponse());
    const source = new IcsCalendarSource(
      [{ id: "personal", url: "https://calendar.example/calendar.ics" }],
      60_000,
      new Set(["calendar.example"]),
      fetcher,
    );

    expect((await source.events([], start, end, "UTC")).staleCalendars).toEqual([]);

    vi.advanceTimersByTime(61_000);
    fetcher.mockRejectedValueOnce(new Error("provider down"));
    const staleResult = await source.events([], start, end, "UTC");
    expect(staleResult.events).toHaveLength(1);
    expect(staleResult.staleCalendars).toEqual(["personal"]);
    expect(source.health()[0]).toMatchObject({ cached: true, stale: true, lastError: "provider down" });

    // Within the failure backoff no new fetch is attempted.
    await source.events([], start, end, "UTC");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("reports uncached failures without pretending to be cached", async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error("provider down"));
    const source = new IcsCalendarSource(
      [{ id: "personal", url: "https://calendar.example/calendar.ics" }],
      60_000,
      new Set(["calendar.example"]),
      fetcher,
    );

    await expect(source.events([], start, end, "UTC")).rejects.toThrow("provider down");
    expect(source.health()[0]).toMatchObject({ cached: false, stale: false, lastError: "provider down" });
  });

  it("deduplicates concurrent refreshes", async () => {
    let resolveResponse!: (value: unknown) => void;
    const fetcher = vi.fn(() => new Promise((resolve) => (resolveResponse = resolve)));
    const source = new IcsCalendarSource(
      [{ id: "personal", url: "https://calendar.example/calendar.ics" }],
      60_000,
      new Set(["calendar.example"]),
      fetcher,
    );

    const first = source.events([], start, end, "UTC");
    const second = source.events([], start, end, "UTC");
    resolveResponse(okResponse());
    expect((await first).events).toHaveLength(1);
    expect((await second).events).toHaveLength(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects oversized feeds via content-length before reading the body", async () => {
    const text = vi.fn();
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ "content-length": String(6 * 1024 * 1024) }),
      text,
    });
    const source = new IcsCalendarSource(
      [{ id: "personal", url: "https://calendar.example/calendar.ics" }],
      60_000,
      new Set(["calendar.example"]),
      fetcher,
    );

    await expect(source.events([], start, end, "UTC")).rejects.toThrow("5 MiB");
    expect(text).not.toHaveBeenCalled();
  });
});
