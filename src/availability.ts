import { DateTime, IANAZone } from "luxon";

import type { BusyInterval, FreeSlot, NormalizedEvent } from "./types.js";

export interface AvailabilityOptions {
  timezone: string;
  includeTentative: boolean;
}

export function assertTimezone(timezone: string): void {
  if (!IANAZone.isValidZone(timezone)) throw new Error(`Invalid IANA timezone: ${timezone}`);
}

function isoInZone(date: Date, timezone: string): string {
  return DateTime.fromJSDate(date, { zone: "utc" }).setZone(timezone).toISO({ suppressMilliseconds: true })!;
}

export function mergeBusyEvents(events: NormalizedEvent[], options: AvailabilityOptions): BusyInterval[] {
  assertTimezone(options.timezone);
  const blocking = events
    .filter((event) => options.includeTentative || event.status === "busy")
    .sort((a, b) => a.start.getTime() - b.start.getTime());

  const merged: Array<{ start: Date; end: Date; status: "busy" | "tentative"; calendars: Set<string> }> = [];
  for (const event of blocking) {
    const prior = merged.at(-1);
    if (prior && event.start <= prior.end) {
      if (event.end > prior.end) prior.end = event.end;
      prior.calendars.add(event.calendarId);
      if (event.status === "busy") prior.status = "busy";
    } else {
      merged.push({
        start: new Date(event.start),
        end: new Date(event.end),
        status: event.status,
        calendars: new Set([event.calendarId]),
      });
    }
  }

  return merged.map((interval) => ({
    start: isoInZone(interval.start, options.timezone),
    end: isoInZone(interval.end, options.timezone),
    status: interval.status,
    calendars: [...interval.calendars].sort(),
  }));
}

export interface WorkingHours {
  start: string;
  end: string;
  weekdays: number[];
}

export interface FindSlotsOptions extends AvailabilityOptions {
  durationMinutes: number;
  bufferMinutes: number;
  workingHours: WorkingHours;
}

function parseClock(clock: string): { hour: number; minute: number } {
  const match = /^(?:[01]\d|2[0-3]):[0-5]\d$/.exec(clock);
  if (!match) throw new Error("Working-hour times must use HH:mm.");
  const [hour, minute] = clock.split(":").map(Number);
  return { hour, minute };
}

function busyDates(events: NormalizedEvent[], includeTentative: boolean): Array<{ start: Date; end: Date }> {
  return events
    .filter((event) => includeTentative || event.status === "busy")
    .map((event) => ({ start: event.start, end: event.end }))
    .sort((a, b) => a.start.getTime() - b.start.getTime());
}

export function findFreeSlots(
  events: NormalizedEvent[],
  rangeStart: Date,
  rangeEnd: Date,
  options: FindSlotsOptions,
): FreeSlot[] {
  assertTimezone(options.timezone);
  if (!Number.isInteger(options.durationMinutes) || options.durationMinutes < 1) {
    throw new Error("durationMinutes must be a positive integer.");
  }
  const { hour: startHour, minute: startMinute } = parseClock(options.workingHours.start);
  const { hour: endHour, minute: endMinute } = parseClock(options.workingHours.end);
  if (endHour * 60 + endMinute <= startHour * 60 + startMinute) {
    throw new Error("Working-hours end must be after its start.");
  }
  const blocked = busyDates(events, options.includeTentative);
  const slots: FreeSlot[] = [];
  const localStart = DateTime.fromJSDate(rangeStart, { zone: "utc" }).setZone(options.timezone).startOf("day");
  const localEnd = DateTime.fromJSDate(rangeEnd, { zone: "utc" }).setZone(options.timezone).startOf("day");

  for (let day = localStart; day <= localEnd; day = day.plus({ days: 1 })) {
    if (!options.workingHours.weekdays.includes(day.weekday)) continue;
    const dayStart = day.set({ hour: startHour, minute: startMinute, second: 0, millisecond: 0 });
    const dayEnd = day.set({ hour: endHour, minute: endMinute, second: 0, millisecond: 0 });

    let cursor = Math.max(dayStart.toUTC().toMillis(), rangeStart.getTime());
    const limit = Math.min(dayEnd.toUTC().toMillis(), rangeEnd.getTime());
    for (const interval of blocked) {
      const start = interval.start.getTime() - options.bufferMinutes * 60_000;
      const end = interval.end.getTime() + options.bufferMinutes * 60_000;
      if (end <= cursor || start >= limit) continue;
      if (start > cursor && start - cursor >= options.durationMinutes * 60_000) {
        slots.push({
          start: isoInZone(new Date(cursor), options.timezone),
          end: isoInZone(new Date(start), options.timezone),
          durationMinutes: Math.floor((start - cursor) / 60_000),
        });
      }
      cursor = Math.max(cursor, end);
      if (cursor >= limit) break;
    }
    if (limit > cursor && limit - cursor >= options.durationMinutes * 60_000) {
      slots.push({
        start: isoInZone(new Date(cursor), options.timezone),
        end: isoInZone(new Date(limit), options.timezone),
        durationMinutes: Math.floor((limit - cursor) / 60_000),
      });
    }
  }
  return slots;
}
