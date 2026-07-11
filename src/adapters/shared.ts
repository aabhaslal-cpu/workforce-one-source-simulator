import type { Person, SourceSystem } from "../domain.js";
import type {
  SourceAdapter,
  SourceChangeDraft,
  SourceEmissionInput,
  ValidationResult,
} from "./types.js";
import { canonicalPayloadFamily, validateVendorPayload } from "./vendor-schemas.js";

export function simulatorDeepLink(sourceSystem: string, baseUrl: string, sourceId: string): string {
  return `${baseUrl}/sim/${sourceSystem}/${sourceId}`;
}

export function validateRecordPayload(
  sourceSystem: SourceSystem,
  payload: unknown,
  objectType?: string,
): ValidationResult {
  return validateVendorPayload(sourceSystem, objectType, payload);
}

export function isPerson(person: Person | null | undefined): person is Person {
  return person !== null && person !== undefined;
}

export function vendorDraft(
  sourceSystem: SourceSystem,
  input: SourceEmissionInput,
  objectType: string,
  rawPayload: Record<string, unknown>,
): SourceChangeDraft {
  return {
    sourceUrl: simulatorDeepLink(sourceSystem, input.baseUrl, input.sourceId),
    objectType: canonicalPayloadFamily(sourceSystem, objectType),
    rawPayload,
  };
}

export function makeVendorAdapter(
  sourceSystem: SourceAdapter["sourceSystem"],
  supportedObjectTypes: string[],
  fields: (input: SourceEmissionInput) => {
    objectType?: string;
    rawPayload: Record<string, unknown>;
  },
): SourceAdapter {
  return {
    sourceSystem,
    supportedObjectTypes,
    create: (input) => {
      const result = fields(input);
      return vendorDraft(
        sourceSystem,
        input,
        result.objectType ?? input.template.objectType,
        result.rawPayload,
      );
    },
    update: (input) => {
      const result = fields(input);
      return vendorDraft(
        sourceSystem,
        input,
        result.objectType ?? input.template.objectType,
        result.rawPayload,
      );
    },
    remove: (input) => {
      const result = fields(input);
      return vendorDraft(
        sourceSystem,
        input,
        result.objectType ?? input.template.objectType,
        result.rawPayload,
      );
    },
    validatePayload: (payload, objectType) =>
      validateRecordPayload(sourceSystem, payload, objectType),
    buildSourceUrl: (input) => simulatorDeepLink(sourceSystem, input.baseUrl, input.sourceId),
  };
}

export function templateText(input: SourceEmissionInput): string {
  return String(
    input.template.rawPayload.message ??
      input.template.rawPayload.summary ??
      input.template.rawPayload.description ??
      input.template.title,
  );
}

export function templateStatus(input: SourceEmissionInput, fallback: string): string {
  if (input.changeType === "updated" && typeof input.template.rawPayload.updatedStatus === "string")
    return input.template.rawPayload.updatedStatus;
  if (typeof input.template.rawPayload.status === "string") return input.template.rawPayload.status;
  return fallback;
}

export function slug(value: unknown, fallback = "item"): string {
  const normalized = String(value ?? fallback)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return normalized || fallback;
}

export function numericId(input: string, min = 100_000, range = 900_000): number {
  return min + (hashCode(input) % range);
}

export function stableAlphaNumeric(input: string, length: number): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let value = hashCode(input);
  let output = "";
  for (let index = 0; index < length; index += 1) {
    value = (value * 33 + index + input.length) >>> 0;
    output += alphabet[value % alphabet.length];
  }
  return output;
}

export function stableHex(input: string, length: number): string {
  let value = hashCode(input);
  let output = "";
  for (let index = 0; index < length; index += 1) {
    value = (value * 33 + index + input.length) >>> 0;
    output += "0123456789abcdef"[value % 16]!;
  }
  return output;
}

export function uuidLike(input: string): string {
  const hex = stableHex(input, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function slackUserId(person: Person): string {
  return `U${stableAlphaNumeric(person.stableKey, 10)}`;
}

export function slackChannelId(input: SourceEmissionInput): string {
  const raw = String(input.template.rawPayload.channel ?? "");
  if (raw.startsWith("#")) return `C${stableAlphaNumeric(raw, 10)}`;
  if (raw.toLowerCase().includes("private")) return `G${stableAlphaNumeric(raw, 10)}`;
  return `C${stableAlphaNumeric(input.template.id, 10)}`;
}

export function unixTs(iso: string, offsetMs = 0): string {
  return `${Math.floor((Date.parse(iso) + offsetMs) / 1000)}.000000`;
}

export function emailHeader(person: Person): string {
  return `${person.name} <${person.email}>`;
}

export function gmailMessageId(input: SourceEmissionInput): string {
  return `msg-${stableAlphaNumeric(input.sourceId, 18).toLowerCase()}`;
}

export function vendorUserEmail(person: Person): { email: string; displayName: string } {
  return { email: person.email, displayName: person.name };
}

export function jiraAccountId(person: Person): string {
  return `sim-${stableAlphaNumeric(person.stableKey, 18).toLowerCase()}`;
}

export function githubLogin(person: Person): string {
  return slug(person.email.split("@")[0], "sim-user");
}

export function salesforceId(prefix: string, input: string): string {
  const cleanPrefix = prefix.padEnd(3, "0").slice(0, 3);
  return `${cleanPrefix}${stableAlphaNumeric(input, 15)}`.slice(0, 18);
}

export function dateOnlyFromIso(iso: string): string {
  return iso.slice(0, 10);
}

export function addHoursIso(iso: string, hours: number): string {
  return new Date(Date.parse(iso) + hours * 60 * 60 * 1000).toISOString();
}

function hashCode(input: string): number {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash >>> 0;
}
