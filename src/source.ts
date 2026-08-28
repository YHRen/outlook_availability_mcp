import { parseAvailabilityIcs } from "./ics.js";
import type { CalendarConfig, CalendarHealth, NormalizedEvent } from "./types.js";

const MAX_ICS_BYTES = 5 * 1024 * 1024;

interface CachedCalendar {
  ics: string;
  fetchedAt: number;
  etag?: string;
  lastModified?: string;
  lastSuccessAt: string;
  lastError?: string;
}

export interface FetchLikeResponse {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<FetchLikeResponse>;

export class IcsCalendarSource {
  private readonly cache = new Map<string, CachedCalendar>();

  constructor(
    private readonly calendars: CalendarConfig[],
    private readonly cacheTtlMs: number,
    private readonly allowedHosts: Set<string> | undefined,
    private readonly fetcher: FetchLike = fetch,
  ) {
    for (const calendar of calendars) this.validateUrl(calendar.url);
  }

  async events(calendarIds: string[], rangeStart: Date, rangeEnd: Date): Promise<NormalizedEvent[]> {
    const selected = this.select(calendarIds);
    const documents = await Promise.all(selected.map((calendar) => this.getIcs(calendar)));
    return documents.flatMap(({ calendar, ics }) => parseAvailabilityIcs(calendar.id, ics, rangeStart, rangeEnd));
  }

  health(): CalendarHealth[] {
    return this.calendars.map((calendar) => {
      const cache = this.cache.get(calendar.id);
      return {
        id: calendar.id,
        cached: Boolean(cache),
        lastSuccessAt: cache?.lastSuccessAt,
        lastError: cache?.lastError,
      };
    });
  }

  private select(calendarIds: string[]): CalendarConfig[] {
    if (!calendarIds.length) return this.calendars;
    const requested = new Set(calendarIds);
    const selected = this.calendars.filter((calendar) => requested.has(calendar.id));
    if (selected.length !== requested.size) throw new Error("One or more requested calendar ids are not configured.");
    return selected;
  }

  private validateUrl(rawUrl: string): void {
    const url = new URL(rawUrl);
    if (url.protocol !== "https:") throw new Error("Calendar URLs must use HTTPS.");
    if (url.username || url.password) throw new Error("Calendar URLs may not include embedded credentials.");
    if (url.port && url.port !== "443") throw new Error("Calendar URLs must use port 443.");
    if (this.allowedHosts && !this.allowedHosts.has(url.hostname.toLowerCase())) {
      throw new Error(`Calendar URL host is not allowed: ${url.hostname}`);
    }
  }

  private async getIcs(calendar: CalendarConfig): Promise<{ calendar: CalendarConfig; ics: string }> {
    const cached = this.cache.get(calendar.id);
    if (cached && Date.now() - cached.fetchedAt < this.cacheTtlMs) return { calendar, ics: cached.ics };

    const headers = new Headers({ accept: "text/calendar" });
    if (cached?.etag) headers.set("if-none-match", cached.etag);
    if (cached?.lastModified) headers.set("if-modified-since", cached.lastModified);

    try {
      const response = await this.fetcher(calendar.url, { headers, signal: AbortSignal.timeout(15_000) });
      if (response.status === 304 && cached) {
        cached.fetchedAt = Date.now();
        return { calendar, ics: cached.ics };
      }
      if (!response.ok) throw new Error(`Calendar fetch failed with HTTP ${response.status}.`);
      const ics = await response.text();
      if (Buffer.byteLength(ics, "utf8") > MAX_ICS_BYTES) throw new Error("Calendar feed exceeds the 5 MiB limit.");
      if (!ics.includes("BEGIN:VCALENDAR")) throw new Error("Calendar source did not return an ICS document.");

      this.cache.set(calendar.id, {
        ics,
        fetchedAt: Date.now(),
        etag: response.headers.get("etag") ?? undefined,
        lastModified: response.headers.get("last-modified") ?? undefined,
        lastSuccessAt: new Date().toISOString(),
      });
      return { calendar, ics };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown calendar fetch error.";
      if (cached) {
        cached.lastError = message;
        return { calendar, ics: cached.ics };
      }
      this.cache.set(calendar.id, {
        ics: "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n",
        fetchedAt: 0,
        lastSuccessAt: "",
        lastError: message,
      });
      throw new Error(`Could not refresh calendar '${calendar.id}'. ${message}`);
    }
  }
}
