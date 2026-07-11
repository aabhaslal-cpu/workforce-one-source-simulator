import {
  addHoursIso,
  isPerson,
  makeVendorAdapter,
  slug,
  templateText,
  vendorUserEmail,
} from "./shared.js";

export const calendarAdapter = makeVendorAdapter("calendar", ["meeting", "event"], (input) => {
  const eventId = slug(input.template.rawPayload.eventId ?? input.sourceId, "event");
  const start = String(input.template.rawPayload.start ?? input.changeOccurredAt);
  const end = String(input.template.rawPayload.end ?? addHoursIso(start, 1));
  const attendees = [input.assignee, ...input.managerChain].filter(isPerson).map((person) => ({
    ...vendorUserEmail(person),
    responseStatus: "accepted",
  }));
  return {
    objectType: "event",
    rawPayload: {
      kind: "calendar#event",
      etag: `"${eventId}-${Date.parse(input.changeOccurredAt)}"`,
      id: eventId,
      htmlLink: `${input.baseUrl}/sim/calendar/${input.sourceId}`,
      status: input.changeType === "deleted" ? "cancelled" : "confirmed",
      summary: input.template.title,
      description: templateText(input),
      organizer: { ...vendorUserEmail(input.actor), self: true },
      creator: vendorUserEmail(input.actor),
      attendees,
      start: { dateTime: start, timeZone: "America/Los_Angeles" },
      end: { dateTime: end, timeZone: "America/Los_Angeles" },
      recurrence:
        input.template.rawPayload.recurring === true ? ["RRULE:FREQ=WEEKLY;COUNT=4"] : undefined,
      created: input.occurredAt,
      updated: input.changeOccurredAt,
    },
  };
});
