import type { ScenarioRecordTemplate } from "./domain.js";

export interface CustomerProfile {
  name: string;
  shortName: string;
  slug: string;
  permissionGroup: string;
  industry: string;
}

export const customerProfiles: readonly CustomerProfile[] = [
  {
    name: "Northstar Medical",
    shortName: "Northstar",
    slug: "northstar-medical",
    permissionGroup: "account-northstar",
    industry: "Healthcare",
  },
  {
    name: "Summit Foods",
    shortName: "Summit",
    slug: "summit-foods",
    permissionGroup: "account-summit",
    industry: "Food & Beverage",
  },
  {
    name: "Cobalt Bank",
    shortName: "Cobalt",
    slug: "cobalt-bank",
    permissionGroup: "account-cobalt",
    industry: "Financial Services",
  },
  {
    name: "Beacon Retail",
    shortName: "Beacon",
    slug: "beacon-retail",
    permissionGroup: "account-beacon",
    industry: "Retail",
  },
  {
    name: "Atlas Logistics",
    shortName: "Atlas",
    slug: "atlas-logistics",
    permissionGroup: "account-atlas",
    industry: "Logistics",
  },
  {
    name: "Pioneer Health",
    shortName: "Pioneer",
    slug: "pioneer-health",
    permissionGroup: "account-pioneer",
    industry: "Healthcare",
  },
  {
    name: "BluePeak Energy",
    shortName: "BluePeak",
    slug: "bluepeak-energy",
    permissionGroup: "account-bluepeak",
    industry: "Energy",
  },
  {
    name: "Redwood Manufacturing",
    shortName: "Redwood",
    slug: "redwood-manufacturing",
    permissionGroup: "account-redwood",
    industry: "Manufacturing",
  },
  {
    name: "Juniper Education",
    shortName: "Juniper",
    slug: "juniper-education",
    permissionGroup: "account-juniper",
    industry: "Education",
  },
  {
    name: "Solstice Media",
    shortName: "Solstice",
    slug: "solstice-media",
    permissionGroup: "account-solstice",
    industry: "Media",
  },
];

const customerAnchorPattern = /northstar|summit/i;

const customerReplacements = (profile: CustomerProfile): readonly [string, string][] => [
  ["Northstar Medical", profile.name],
  ["Summit Foods", profile.name],
  ["account-northstar", profile.permissionGroup],
  ["account-summit", profile.permissionGroup],
  ["northstar-medical", profile.slug],
  ["summit-foods", profile.slug],
  ["Food & Beverage", profile.industry],
  ["Healthcare", profile.industry],
  ["Northstar", profile.shortName],
  ["Summit", profile.shortName],
];

export function customerProfileForName(name: string): CustomerProfile | undefined {
  return customerProfiles.find((profile) => profile.name === name);
}

export function contextualizeScenarioRecordTemplate(
  template: ScenarioRecordTemplate,
  customerName: string | undefined,
): ScenarioRecordTemplate {
  const profile = customerName ? customerProfileForName(customerName) : undefined;
  if (!profile || !isCustomerAnchoredRecordTemplate(template)) {
    return template;
  }

  return {
    ...template,
    title: replaceCustomerContext(template.title, profile) as string,
    acl: replaceCustomerContext(template.acl, profile) as ScenarioRecordTemplate["acl"],
    rawPayload: replaceCustomerContext(template.rawPayload, profile) as Record<string, unknown>,
  };
}

export function isCustomerAnchoredRecordTemplate(
  template: ScenarioRecordTemplate,
): boolean {
  return containsCustomerAnchor([template.title, template.acl, template.rawPayload]);
}

function containsCustomerAnchor(value: unknown): boolean {
  if (typeof value === "string") {
    return customerAnchorPattern.test(value);
  }
  if (Array.isArray(value)) {
    return value.some(containsCustomerAnchor);
  }
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some(containsCustomerAnchor);
  }
  return false;
}

function replaceCustomerContext(value: unknown, profile: CustomerProfile): unknown {
  if (typeof value === "string") {
    return customerReplacements(profile).reduce(
      (result, [search, replacement]) => result.replaceAll(search, replacement),
      value,
    );
  }
  if (Array.isArray(value)) {
    return value.map((entry) => replaceCustomerContext(entry, profile));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        replaceCustomerContext(entry, profile),
      ]),
    );
  }
  return value;
}
