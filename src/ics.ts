import ICAL from "ical.js";

import type { BusyStatus, NormalizedEvent } from "./types.js";

const MAX_OCCURRENCES_PER_EVENT = 5_000;

function toDate(value: ICAL.Time): Date {
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
): NormalizedEvent[] {
  const root = new ICAL.Component(ICAL.parse(ics));
  const events: NormalizedEvent[] = [];

  for (const component of root.getAllSubcomponents("vevent")) {
    if (component.getFirstProperty("recurrence-id")) continue;
    const status = eventStatus(component);
    if (!status) continue;

    const event = new ICAL.Event(component);
    const uid = String(component.getFirstPropertyValue("uid") ?? "event");
    const allDay = event.startDate.isDate;

    if (!event.isRecurring()) {
      addOccurrence(
        events,
        calendarId,
        uid,
        toDate(event.startDate),
        toDate(event.endDate),
        status,
        allDay,
        rangeStart,
        rangeEnd,
      );
      continue;
    }

    const iterator = event.iterator();
    for (let occurrenceCount = 0; occurrenceCount < MAX_OCCURRENCES_PER_EVENT; occurrenceCount += 1) {
      const recurrenceId = iterator.next();
      if (!recurrenceId) break;
      const details = event.getOccurrenceDetails(recurrenceId);
      const occurrenceStatus = eventStatus(details.item.component);
      if (!occurrenceStatus) continue;
      const start = toDate(details.startDate);
      const end = toDate(details.endDate);
      if (start >= rangeEnd) break;
      addOccurrence(events, calendarId, uid, start, end, occurrenceStatus, details.startDate.isDate, rangeStart, rangeEnd);
    }
  }

  return events.sort((a, b) => a.start.getTime() - b.start.getTime());
}
