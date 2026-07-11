import { makeVendorAdapter, slackChannelId, slackUserId, templateText, unixTs } from "./shared.js";

export const slackAdapter = makeVendorAdapter(
  "slack",
  ["message", "thread", "direct_message"],
  (input) => {
    const channelType =
      String(input.template.rawPayload.channelType ?? "").toLowerCase() === "private"
        ? "group"
        : "channel";
    const baseMessage = {
      type: "message",
      channel: slackChannelId(input),
      user: slackUserId(input.actor),
      text: templateText(input),
      ts: unixTs(input.occurredAt),
      event_ts: unixTs(input.changeOccurredAt),
      channel_type: channelType,
      thread_ts: input.template.objectType === "thread" ? unixTs(input.occurredAt) : undefined,
      reactions: Array.isArray(input.template.rawPayload.reactions)
        ? input.template.rawPayload.reactions.map((reaction) => ({
            name: String(reaction),
            users: [slackUserId(input.actor)],
            count: 1,
          }))
        : undefined,
    };
    if (input.changeType === "updated") {
      return {
        rawPayload: {
          ...baseMessage,
          subtype: "message_changed",
          text: String(
            input.template.rawPayload.reply ?? `${templateText(input)} Follow-up posted.`,
          ),
          message: {
            ...baseMessage,
            text: String(
              input.template.rawPayload.reply ?? `${templateText(input)} Follow-up posted.`,
            ),
          },
          previous_message: baseMessage,
          edited: { user: slackUserId(input.actor), ts: unixTs(input.changeOccurredAt) },
        },
      };
    }
    if (input.changeType === "deleted") {
      return {
        rawPayload: {
          ...baseMessage,
          subtype: "message_deleted",
          text: "",
          hidden: true,
          deleted_ts: unixTs(input.changeOccurredAt),
        },
      };
    }
    return { rawPayload: baseMessage };
  },
);
