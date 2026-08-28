import ICAL from "ical.js";
import { DateTime } from "luxon";

import type { BusyStatus, NormalizedEvent } from "./types.js";

const MAX_OCCURRENCES_PER_EVENT = 5_000;
// When fast-forwarding recurrence iteration to the query range, back off far
// enough to cover floating-time skew between UTC and any IANA zone (±14h).
const ITERATION_SLACK_MS = 2 * 24 * 60 * 60 * 1_000;
const DAY_MS = 24 * 60 * 60 * 1_000;

/**
 * ICAL's `event.iterator(startTime)` redefines the series start rather than
 * fast-forwarding, so an arbitrary start corrupts occurrence times. Instead,
 * advance DTSTART by whole rule periods — preserving time-of-day, weekday, and
 * day-of-month — to land shortly before `targetMs`. Returns undefined when
 * skipping is unsafe (COUNT anchors occurrences to the true start; month-end
 * and leap-day starts do not survive month/year arithmetic) or unnecessary.
 * Any occurrence the rule emits at the substituted start lies before the
 * queried range, so a start that does not match the rule pattern is harmless.
 */
function fastForwardedStart(component: ICAL.Component, dtstart: ICAL.Time, targetMs: number): ICAL.Time | undefined {
  const rules = component.getAllProperties("rrule");
  if (rules.length !== 1) return undefined;
  const rule = rules[0].getFirstValue() as ICAL.Recur;
  if (rule.count) return undefined;
  const interval = rule.interval || 1;
  const startMs = dtstart.toJSDate().getTime();

  const periods = (periodMs: number): number => Math.floor((targetMs - startMs) / periodMs) - 1;
  const aligned = dtstart.clone();
  let steps: number;
  switch (rule.freq) {
    case "DAILY":
      steps = periods(interval * DAY_MS);
      if (steps < 1) return undefined;
      aligned.adjust(steps * interval, 0, 0, 0);
      return aligned;
    case "WEEKLY":
      steps = periods(interval * 7 * DAY_MS);
      if (steps < 1) return undefined;
      aligned.adjust(steps * interval * 7, 0, 0, 0);
      return aligned;
    case "MONTHLY": {
      if (dtstart.day > 28) return undefined;
      steps = periods(interval * 31 * DAY_MS);
      if (steps < 1) return undefined;
      const months = dtstart.month - 1 + steps * interval;
      aligned.year += Math.floor(months / 12);
      aligned.month = (months % 12) + 1;
      return aligned;
    }
    case "YEARLY":
      if (dtstart.month === 2 && dtstart.day > 28) return undefined;
      steps = periods(interval * 366 * DAY_MS);
      if (steps < 1) return undefined;
      aligned.year += steps * interval;
      return aligned;
    default:
      return undefined;
  }
}

/**
 * Date-only and floating (TZID-less) values carry no zone of their own, so
 * interpret them in the caller's timezone rather than wherever this server
 * happens to run. Zoned and UTC values convert exactly.
 */
function toDate(value: ICAL.Time, timezone: string): Date {
  if (value.isDate || value.zone === ICAL.Timezone.localTimezone) {
    return DateTime.fromObject(
      {
        year: value.year,
        month: value.month,
        day: value.day,
        hour: value.hour,
        minute: value.minute,
        second: value.second,
      },
      { zone: timezone },
    ).toJSDate();
  }
  return value.toJSDate();
}

function overlaps(start: Date, end: Date, rangeStart: Date, rangeEnd: Date): boolean {
  return start < rangeEnd && end > rangeStart;
}

function eventStatus(component: ICAL.Component): BusyStatus | undefined {
  const status = String(component.getFirstPropertyValue("status") ?? "").toUpperCase();
  const transparency = String(component.getFirstPropertyValue("transp") ?? "").toUpperCase();
  if (status === "CANCELLED" || transparency === "TRANSPARENT") return undefined;
  return status === "TENTATIVE" ? "tentative" : "busy";
}

function eventUid(component: ICAL.Component): string {
  return String(component.getFirstPropertyValue("uid") ?? "event");
}

function addOccurrence(
  events: NormalizedEvent[],
  calendarId: string,
  uid: string,
  start: Date,
  end: Date,
  status: BusyStatus,
  allDay: boolean,
  rangeStart: Date,
  rangeEnd: Date,
): void {
  if (end <= start) return;
  if (overlaps(start, end, rangeStart, rangeEnd)) {
    events.push({ calendarId, uid, start, end, status, allDay });
  }
}

/**
 * Converts an ICS document into privacy-safe time intervals. No event summary,
 * description, location, attendee, or organizer data leaves this module.
 */
export function parseAvailabilityIcs(
  calendarId: string,
  ics: string,
  rangeStart: Date,
  rangeEnd: Date,
  timezone: string,
): NormalizedEvent[] {
  const root = new ICAL.Component(ICAL.parse(ics));
  const events: NormalizedEvent[] = [];
  const components = root.getAllSubcomponents("vevent");

  // Recurrence overrides (RECURRENCE-ID) are handled as standalone events so
  // they are found even when the master's iteration never reaches them, and
  // their original occurrences are suppressed below.
  const overriddenOccurrences = new Set<string>();
  for (const component of components) {
    const recurrenceId = component.getFirstPropertyValue("recurrence-id");
    if (!recurrenceId) continue;
    const uid = eventUid(component);
    overriddenOccurrences.add(`${uid}:${toDate(recurrenceId as ICAL.Time, timezone).getTime()}`);
    const status = eventStatus(component);
    if (!status) continue;
    const override = new ICAL.Event(component);
    addOccurrence(
      events,
      calendarId,
      uid,
      toDate(override.startDate, timezone),
      toDate(override.endDate, timezone),
      status,
      override.startDate.isDate,
      rangeStart,
      rangeEnd,
    );
  }

  for (const component of components) {
    if (component.getFirstProperty("recurrence-id")) continue;
    const status = eventStatus(component);
    if (!status) continue;

    const event = new ICAL.Event(component);
    const uid = eventUid(component);
    const allDay = event.startDate.isDate;
    const start = toDate(event.startDate, timezone);
    const end = toDate(event.endDate, timezone);

    if (!event.isRecurring()) {
      addOccurrence(events, calendarId, uid, start, end, status, allDay, rangeStart, rangeEnd);
      continue;
    }

    // Start iterating near the query range so long-running series (e.g. a
    // years-old daily meeting) never exhaust the occurrence cap before
    // reaching it. Back off by the event duration so spanning occurrences
    // that begin before the range are still yielded.
    const durationMs = Math.max(0, end.getTime() - start.getTime());
    const targetMs = rangeStart.getTime() - durationMs - ITERATION_SLACK_MS;
    const iterator = event.iterator(fastForwardedStart(component, event.startDate, targetMs));
    for (let occurrenceCount = 0; occurrenceCount < MAX_OCCURRENCES_PER_EVENT; occurrenceCount += 1) {
      const recurrenceId = iterator.next();
      if (!recurrenceId) break;
      // Break on the original recurrence time: iterator times are monotonic,
      // while an override could move a single occurrence past the range end.
      const originalStart = toDate(recurrenceId, timezone);
      if (originalStart.getTime() >= rangeEnd.getTime()) break;
      if (overriddenOccurrences.has(`${uid}:${originalStart.getTime()}`)) continue;
      const details = event.getOccurrenceDetails(recurrenceId);
      addOccurrence(
        events,
        calendarId,
        uid,
        toDate(details.startDate, timezone),
        toDate(details.endDate, timezone),
        status,
        details.startDate.isDate,
        rangeStart,
        rangeEnd,
      );
    }
  }

  return events.sort((a, b) => a.start.getTime() - b.start.getTime());
}
