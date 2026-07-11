import { makeSimpleAdapter, statusFor } from "./shared.js";

export const slackAdapter = makeSimpleAdapter("slack", ["message", "thread", "direct_message"], (input) => ({
  channel: input.template.rawPayload.channel ?? `#${input.instance.workstream}`,
  channelType: input.template.rawPayload.channelType ?? (input.template.rawPayload.private ? "private" : "public"),
  ts: `${Date.parse(input.occurredAt) / 1000}.000`,
  threadTs: input.template.rawPayload.threadTs ?? `${Date.parse(input.occurredAt) / 1000}.000`,
  text: input.template.rawPayload.message ?? input.template.rawPayload.summary ?? input.template.title,
  replies: input.changeType === "updated" ? [{ author: input.assignee?.id ?? input.actor.id, text: input.template.rawPayload.reply ?? "Follow-up posted." }] : [],
  reactions: input.template.rawPayload.reactions ?? [],
  edited: input.changeType === "updated",
  deleted: input.changeType === "deleted",
  status: statusFor(input, "posted"),
}));
