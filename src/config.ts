import { z } from "zod";

import type { CalendarConfig } from "./types.js";

const calendarSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]+$/, "must contain only letters, numbers, underscores, or hyphens"),
  url: z.string().url(),
});

function asPositiveInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export interface AppConfig {
  calendars: CalendarConfig[];
  allowedHosts?: Set<string>;
  cacheTtlMs: number;
}

export function loadConfig(env = process.env): AppConfig {
  let calendars: CalendarConfig[];
  if (env.CALENDARS_JSON) {
    calendars = z.array(calendarSchema).min(1).parse(JSON.parse(env.CALENDARS_JSON));
  } else if (env.CALENDAR_ICS_URL) {
    calendars = [{ id: "default", url: z.string().url().parse(env.CALENDAR_ICS_URL) }];
  } else {
    throw new Error("Set CALENDAR_ICS_URL or CALENDARS_JSON before starting the server.");
  }

  const ids = new Set<string>();
  for (const calendar of calendars) {
    if (ids.has(calendar.id)) throw new Error(`Duplicate calendar id: ${calendar.id}`);
    ids.add(calendar.id);
  }

  const allowedHosts = env.CALENDAR_ALLOWED_HOSTS
    ?.split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);

  return {
    calendars,
    allowedHosts: allowedHosts?.length ? new Set(allowedHosts) : undefined,
    cacheTtlMs: asPositiveInteger(env.CALENDAR_CACHE_TTL_SECONDS, 300) * 1_000,
  };
}
