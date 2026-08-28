import { parseAvailabilityIcs } from "./ics.js";
import type { CalendarConfig, CalendarHealth, NormalizedEvent } from "./types.js";

const MAX_ICS_BYTES = 5 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15_000;
// After a failed refresh, wait before retrying so an outage does not add the
// full fetch timeout to every tool call.
const FAILURE_BACKOFF_MS = 30_000;
const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

interface CachedCalendar {
  ics?: string;
  refreshAfter: number;
  etag?: string;
  lastModified?: string;
  lastSuccessAt?: string;
  lastError?: string;
  stale: boolean;
}

interface CalendarDocument {
  calendar: CalendarConfig;
  ics: string;
  stale: boolean;
}

export interface EventsResult {
  events: NormalizedEvent[];
  /** Calendars served from an expired cache because their refresh failed. */
  staleCalendars: string[];
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
  private readonly pending = new Map<string, Promise<CalendarDocument>>();

  constructor(
    private readonly calendars: CalendarConfig[],
    private readonly cacheTtlMs: number,
    private readonly allowedHosts: Set<string> | undefined,
    private readonly fetcher: FetchLike = fetch,
  ) {
    for (const calendar of calendars) this.validateUrl(calendar.url);
  }

  async events(calendarIds: string[], rangeStart: Date, rangeEnd: Date, timezone: string): Promise<EventsResult> {
    const selected = this.select(calendarIds);
    const documents = await Promise.all(selected.map((calendar) => this.getIcs(calendar)));
    return {
      events: documents.flatMap(({ calendar, ics }) =>
        parseAvailabilityIcs(calendar.id, ics, rangeStart, rangeEnd, timezone),
      ),
      staleCalendars: documents.filter((document) => document.stale).map((document) => document.calendar.id),
    };
  }

  health(): CalendarHealth[] {
    return this.calendars.map((calendar) => {
      const cache = this.cache.get(calendar.id);
      return {
        id: calendar.id,
        cached: cache?.ics !== undefined,
        stale: cache?.stale ?? false,
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

  /** Follows redirects manually so every hop passes the same URL validation. */
  private async fetchValidated(url: string, headers: Headers): Promise<FetchLikeResponse> {
    let current = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const response = await this.fetcher(current, {
        headers,
        redirect: "manual",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!REDIRECT_STATUSES.has(response.status)) return response;
      const location = response.headers.get("location");
      if (!location) throw new Error(`Calendar fetch redirect (HTTP ${response.status}) had no location header.`);
      current = new URL(location, current).toString();
      this.validateUrl(current);
    }
    throw new Error(`Calendar fetch exceeded ${MAX_REDIRECTS} redirects.`);
  }

  private async getIcs(calendar: CalendarConfig): Promise<CalendarDocument> {
    const cached = this.cache.get(calendar.id);
    if (cached && Date.now() < cached.refreshAfter) {
      if (cached.ics !== undefined) return { calendar, ics: cached.ics, stale: cached.stale };
      throw new Error(`Could not refresh calendar '${calendar.id}'. ${cached.lastError ?? "Unknown error."}`);
    }

    const pending = this.pending.get(calendar.id);
    if (pending) return pending;
    const refresh = this.refresh(calendar, cached).finally(() => this.pending.delete(calendar.id));
    this.pending.set(calendar.id, refresh);
    return refresh;
  }

  private async refresh(calendar: CalendarConfig, cached: CachedCalendar | undefined): Promise<CalendarDocument> {
    const headers = new Headers({ accept: "text/calendar" });
    if (cached?.etag) headers.set("if-none-match", cached.etag);
    if (cached?.lastModified) headers.set("if-modified-since", cached.lastModified);

    try {
      const response = await this.fetchValidated(calendar.url, headers);
      if (response.status === 304 && cached?.ics !== undefined) {
        cached.refreshAfter = Date.now() + this.cacheTtlMs;
        cached.lastSuccessAt = new Date().toISOString();
        cached.lastError = undefined;
        cached.stale = false;
        return { calendar, ics: cached.ics, stale: false };
      }
      if (!response.ok) throw new Error(`Calendar fetch failed with HTTP ${response.status}.`);
      const contentLength = Number.parseInt(response.headers.get("content-length") ?? "", 10);
      if (Number.isFinite(contentLength) && contentLength > MAX_ICS_BYTES) {
        throw new Error("Calendar feed exceeds the 5 MiB limit.");
      }
      const ics = await response.text();
      if (Buffer.byteLength(ics, "utf8") > MAX_ICS_BYTES) throw new Error("Calendar feed exceeds the 5 MiB limit.");
      if (!ics.includes("BEGIN:VCALENDAR")) throw new Error("Calendar source did not return an ICS document.");

      this.cache.set(calendar.id, {
        ics,
        refreshAfter: Date.now() + this.cacheTtlMs,
        etag: response.headers.get("etag") ?? undefined,
        lastModified: response.headers.get("last-modified") ?? undefined,
        lastSuccessAt: new Date().toISOString(),
        stale: false,
      });
      return { calendar, ics, stale: false };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown calendar fetch error.";
      if (cached?.ics !== undefined) {
        cached.refreshAfter = Date.now() + FAILURE_BACKOFF_MS;
        cached.lastError = message;
        cached.stale = true;
        return { calendar, ics: cached.ics, stale: true };
      }
      this.cache.set(calendar.id, {
        refreshAfter: Date.now() + FAILURE_BACKOFF_MS,
        lastSuccessAt: cached?.lastSuccessAt,
        lastError: message,
        stale: false,
      });
      throw new Error(`Could not refresh calendar '${calendar.id}'. ${message}`);
    }
  }
}
