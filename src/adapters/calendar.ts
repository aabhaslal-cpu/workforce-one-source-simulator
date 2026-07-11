import { isPerson, makeSimpleAdapter, personPayload, statusFor } from "./shared.js";

export const calendarAdapter = makeSimpleAdapter("calendar", ["meeting", "event"], (input) => ({
  eventId: input.template.rawPayload.eventId ?? `cal-${input.sourceId}`,
  organizer: personPayload(input.actor),
  attendees: [input.assignee, ...input.managerChain].filter(isPerson).map(personPayload),
  agenda: input.template.rawPayload.agenda ?? input.template.rawPayload.summary ?? input.template.title,
  start: input.template.rawPayload.start ?? input.occurredAt,
  end: input.template.rawPayload.end ?? input.changeOccurredAt,
  recurring: input.template.rawPayload.recurring ?? false,
  attendeeChanges: input.changeType === "updated" ? input.template.rawPayload.attendeeChanges ?? [] : [],
  cancelled: input.changeType === "deleted" || input.template.rawPayload.status === "cancelled",
  status: statusFor(input, "confirmed"),
}));
