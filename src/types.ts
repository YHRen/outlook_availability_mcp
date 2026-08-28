export type BusyStatus = "busy" | "tentative";

export interface CalendarConfig {
  id: string;
  url: string;
}

export interface NormalizedEvent {
  calendarId: string;
  uid: string;
  start: Date;
  end: Date;
  status: BusyStatus;
  allDay: boolean;
}

export interface BusyInterval {
  start: string;
  end: string;
  status: BusyStatus;
  calendars: string[];
}

export interface FreeSlot {
  start: string;
  end: string;
  durationMinutes: number;
}

export interface CalendarHealth {
  id: string;
  cached: boolean;
  lastSuccessAt?: string;
  lastError?: string;
}
