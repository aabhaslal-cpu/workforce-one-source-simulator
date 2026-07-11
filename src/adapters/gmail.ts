import type { SourceEmissionInput } from "./types.js";
import {
  emailHeader,
  gmailMessageId,
  makeVendorAdapter,
  numericId,
  templateText,
} from "./shared.js";

export const gmailAdapter = makeVendorAdapter("gmail", ["email", "thread"], (input) => {
  const recipient = input.assignee ?? input.managerChain[0] ?? input.actor;
  const cc = input.managerChain.slice(1, 3);
  const subject = String(input.template.rawPayload.subject ?? input.template.title);
  const labels = gmailLabels(input);
  const message = {
    id: gmailMessageId(input),
    threadId: String(input.template.rawPayload.threadId ?? `thread-${gmailMessageId(input)}`),
    labelIds: labels,
    snippet: templateText(input).slice(0, 160),
    historyId: String(numericId(`${input.sourceId}:${input.changeType}`, 10_000, 90_000)),
    internalDate: String(Date.parse(input.changeOccurredAt)),
    sizeEstimate: 1200 + numericId(input.sourceId, 1, 600),
    payload: {
      partId: "",
      mimeType: "text/plain",
      filename: "",
      headers: [
        { name: "From", value: emailHeader(input.actor) },
        { name: "To", value: emailHeader(recipient) },
        ...(cc.length > 0 ? [{ name: "Cc", value: cc.map(emailHeader).join(", ") }] : []),
        { name: "Subject", value: subject },
        { name: "Date", value: new Date(input.changeOccurredAt).toUTCString() },
        { name: "Message-ID", value: `<${gmailMessageId(input)}@example.test>` },
      ],
      body: { size: templateText(input).length },
    },
  };
  if (input.template.objectType === "thread") {
    return {
      objectType: "thread",
      rawPayload: {
        id: message.threadId,
        historyId: message.historyId,
        messages: [message],
      },
    };
  }
  return { objectType: "message", rawPayload: message };
});

function gmailLabels(input: SourceEmissionInput): string[] {
  const base = Array.isArray(input.template.rawPayload.labels)
    ? input.template.rawPayload.labels.map((label) =>
        String(label)
          .toUpperCase()
          .replace(/[^A-Z0-9_]+/g, "_"),
      )
    : [];
  const labels = new Set(["INBOX", ...base]);
  if (input.changeType === "created") labels.add("UNREAD");
  if (input.changeType === "updated") {
    labels.delete("UNREAD");
    labels.add("IMPORTANT");
  }
  if (input.changeType === "deleted") labels.add("TRASH");
  return [...labels];
}
