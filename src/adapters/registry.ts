import type { SourceSystem } from "../domain.js";
import type { SourceAdapter } from "./types.js";
import { amplitudeAdapter } from "./amplitude.js";
import { calendarAdapter } from "./calendar.js";
import { gainsightAdapter } from "./gainsight.js";
import { githubAdapter } from "./github.js";
import { gmailAdapter } from "./gmail.js";
import { jiraAdapter } from "./jira.js";
import { notionAdapter } from "./notion.js";
import { pagerdutyAdapter } from "./pagerduty.js";
import { productboardAdapter } from "./productboard.js";
import { salesforceAdapter } from "./salesforce.js";
import { slackAdapter } from "./slack.js";
import { zendeskAdapter } from "./zendesk.js";

export const sourceAdapters: SourceAdapter[] = [
  slackAdapter,
  gmailAdapter,
  calendarAdapter,
  notionAdapter,
  jiraAdapter,
  productboardAdapter,
  amplitudeAdapter,
  githubAdapter,
  pagerdutyAdapter,
  salesforceAdapter,
  gainsightAdapter,
  zendeskAdapter,
];

export const sourceAdapterBySystem = new Map<SourceSystem, SourceAdapter>(sourceAdapters.map((adapter) => [adapter.sourceSystem, adapter]));

export function requireSourceAdapter(sourceSystem: SourceSystem): SourceAdapter {
  const adapter = sourceAdapterBySystem.get(sourceSystem);
  if (!adapter) throw new Error(`No source adapter registered for ${sourceSystem}`);
  return adapter;
}
