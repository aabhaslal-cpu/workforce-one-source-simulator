import { createHash } from "node:crypto";
import type {
  Department,
  GeneratedOrganization,
  OrganizationConfig,
  OrganizationNode,
  Person,
  RoleLevel,
  RoleTemplate,
  SourceConnection,
  Team,
} from "./domain.js";
import { departments, roleLevels, sourceSystems } from "./domain.js";
import { customerProfiles } from "./customers.js";
import { tenant } from "./data.js";

export const roleTemplates: RoleTemplate[] = departments.flatMap((department) =>
  roleLevels.map((roleLevel) => ({
    id: `role-${department.replace("_", "-")}-${roleLevel}`,
    department,
    roleLevel,
    title: roleTitle(department, roleLevel),
    description: `${roleTitle(department, roleLevel)} generated-person template`,
  })),
);

export const defaultOrganizationConfig: OrganizationConfig = {
  seed: "wfo-m1-org-seed",
  departments: {
    product: {
      vpCount: 1,
      directorsPerVp: 2,
      managersPerDirector: 2,
      icsPerManager: 4,
      customIcsPerManager: { "product:v1:d2:m1": 3, "product:v1:d2:m2": 5 },
    },
    engineering: {
      vpCount: 1,
      directorsPerVp: 2,
      managersPerDirector: 3,
      icsPerManager: 5,
      customIcsPerManager: { "engineering:v1:d1:m1": 7, "engineering:v1:d2:m3": 4 },
    },
    customer_success: {
      vpCount: 1,
      directorsPerVp: 2,
      managersPerDirector: 2,
      icsPerManager: 4,
      customManagersPerDirector: { "customer_success:v1:d2": 3 },
      customIcsPerManager: { "customer_success:v1:d1:m2": 5, "customer_success:v1:d2:m3": 4 },
    },
  },
};

const firstNames = [
  "Ari",
  "Dana",
  "Elena",
  "Iris",
  "Julian",
  "Leah",
  "Marco",
  "Maya",
  "Nora",
  "Owen",
  "Priya",
  "Samir",
  "Talia",
  "Dev",
  "Anika",
  "Ravi",
  "Mina",
  "Jonah",
  "Lena",
  "Omar",
];

const lastNames = [
  "Blake",
  "Cho",
  "Grant",
  "Lee",
  "Morgan",
  "Park",
  "Patel",
  "Raman",
  "Silva",
  "Stone",
  "Torres",
  "Wu",
  "Chen",
  "Shah",
  "Rivera",
  "Khan",
  "Meyer",
  "Okafor",
  "Nguyen",
  "Diaz",
];

export function generateOrganization(input: OrganizationConfig = defaultOrganizationConfig): GeneratedOrganization {
  const config = normalizeConfig(input);
  const people: Person[] = [];
  const teams: Team[] = [];
  const reportingRelationships: GeneratedOrganization["reportingRelationships"] = [];

  for (const department of departments) {
    const departmentConfig = config.departments[department];
    const departmentTeamId = `team-${department}-department`;
    teams.push({
      id: departmentTeamId,
      name: `${labelDepartment(department)} Department`,
      department,
      level: "department",
      leadPersonId: null,
      parentTeamId: null,
      memberPersonIds: [],
      responsibilityScopes: [scopeForDepartment(department, "portfolio")],
    });

    for (let vpIndex = 1; vpIndex <= departmentConfig.vpCount; vpIndex += 1) {
      const vp = createPerson(config.seed, department, "vp", vpIndex, 0, 0, 0, null, departmentTeamId);
      people.push(vp);
      addMember(teams, departmentTeamId, vp.id);
      setLead(teams, departmentTeamId, vp.id);

      const directorCount = countFor(
        departmentConfig.directorsPerVp,
        departmentConfig.customDirectorsPerVp,
        `${department}:v${vpIndex}`,
      );
      for (let directorIndex = 1; directorIndex <= directorCount; directorIndex += 1) {
        const directorTeamId = `team-${department}-v${vpIndex}-d${directorIndex}`;
        teams.push({
          id: directorTeamId,
          name: `${labelDepartment(department)} Director Group ${directorIndex}`,
          department,
          level: "director_group",
          leadPersonId: null,
          parentTeamId: departmentTeamId,
          memberPersonIds: [],
          responsibilityScopes: [scopeForDepartment(department, `director-${directorIndex}`)],
        });
        const director = createPerson(config.seed, department, "director", vpIndex, directorIndex, 0, 0, vp.id, directorTeamId);
        people.push(director);
        addReport(vp, director, reportingRelationships);
        addMember(teams, departmentTeamId, director.id);
        addMember(teams, directorTeamId, director.id);
        setLead(teams, directorTeamId, director.id);

        const managerCount = countFor(
          departmentConfig.managersPerDirector,
          departmentConfig.customManagersPerDirector,
          `${department}:v${vpIndex}:d${directorIndex}`,
        );
        for (let managerIndex = 1; managerIndex <= managerCount; managerIndex += 1) {
          const managerTeamId = `team-${department}-v${vpIndex}-d${directorIndex}-m${managerIndex}`;
          teams.push({
            id: managerTeamId,
            name: `${labelDepartment(department)} Team ${directorIndex}.${managerIndex}`,
            department,
            level: "manager_team",
            leadPersonId: null,
            parentTeamId: directorTeamId,
            memberPersonIds: [],
            responsibilityScopes: [scopeForDepartment(department, `team-${directorIndex}-${managerIndex}`)],
          });
          const manager = createPerson(
            config.seed,
            department,
            "manager",
            vpIndex,
            directorIndex,
            managerIndex,
            0,
            director.id,
            managerTeamId,
          );
          people.push(manager);
          addReport(director, manager, reportingRelationships);
          addMember(teams, directorTeamId, manager.id);
          addMember(teams, managerTeamId, manager.id);
          setLead(teams, managerTeamId, manager.id);

          const icCount = countFor(
            departmentConfig.icsPerManager,
            departmentConfig.customIcsPerManager,
            `${department}:v${vpIndex}:d${directorIndex}:m${managerIndex}`,
          );
          for (let icIndex = 1; icIndex <= icCount; icIndex += 1) {
            const ic = createPerson(
              config.seed,
              department,
              "ic",
              vpIndex,
              directorIndex,
              managerIndex,
              icIndex,
              manager.id,
              managerTeamId,
            );
            people.push(ic);
            addReport(manager, ic, reportingRelationships);
            addMember(teams, managerTeamId, ic.id);
          }
        }
      }
    }
  }

  assignCustomerSuccessPortfolios(people);
  applyCrossFunctionalRelationships(people, teams, reportingRelationships);

  const tree = buildTree(people);
  const validation = validateOrganization(people);
  return {
    seed: config.seed,
    config,
    roleTemplates,
    people,
    teams,
    reportingRelationships,
    tree,
    counts: countPeople(people),
    validation,
  };
}

export function createConnections(organization: GeneratedOrganization): SourceConnection[] {
  const perPerson = organization.people.map((person) => connectionForPerson(person, personConnectionId(person)));
  const aliases = roleTemplates
    .map((template) => {
      const person = firstPersonForRole(organization, template.id);
      return person ? connectionForPerson(person, `conn-${template.department.replace("_", "-")}-${template.roleLevel}`) : null;
    })
    .filter((connection): connection is SourceConnection => connection !== null);
  return [...aliases, ...perPerson];
}

export function personConnectionId(person: Person): string {
  return `conn-person-${slug(person.stableKey)}`;
}

export function firstPersonForRole(organization: GeneratedOrganization, roleTemplateId: string): Person | undefined {
  return organization.people.find((person) => person.roleTemplateId === roleTemplateId);
}

export function selectPersonForRole(organization: GeneratedOrganization, roleTemplateId: string, key: string): Person {
  const candidates = organization.people.filter((person) => person.roleTemplateId === roleTemplateId);
  if (candidates.length === 0) {
    throw new Error(`No generated person for role template ${roleTemplateId}`);
  }
  return candidates[hashNumber(organization.seed, roleTemplateId, key) % candidates.length]!;
}

export function previewOrganizationCounts(config: OrganizationConfig): GeneratedOrganization["counts"] {
  return countPeople(generateOrganization(config).people);
}

function connectionForPerson(person: Person, connectionId: string): SourceConnection {
  return {
    id: connectionId,
    tenantId: tenant.id,
    personId: person.id,
    roleTemplateId: person.roleTemplateId,
    label: `${person.name} (${person.roleTitle}) simulator connection`,
    allowedSources: [...sourceSystems],
    allowedGroups: [...person.groupMemberships],
  };
}

function applyCrossFunctionalRelationships(
  people: Person[],
  teams: Team[],
  reportingRelationships: GeneratedOrganization["reportingRelationships"],
): void {
  const productManager = firstByRole(people, "role-product-manager");
  const productDirector = firstByRole(people, "role-product-director");
  const productVp = firstByRole(people, "role-product-vp");
  const engineeringIc = firstByRole(people, "role-engineering-ic");
  const engineeringManager = firstByRole(people, "role-engineering-manager");
  const engineeringDirector = firstByRole(people, "role-engineering-director");
  const csIc = firstByRole(people, "role-customer-success-ic");
  const csManager = firstByRole(people, "role-customer-success-manager");
  const csDirector = firstByRole(people, "role-customer-success-director");
  const csVp = firstByRole(people, "role-customer-success-vp");

  addProjectTeam(teams, "team-project-aurora", "Aurora Cross-Functional Release Team", "product", productManager?.id ?? null, [
    productManager,
    productDirector,
    productVp,
    engineeringIc,
    engineeringManager,
    engineeringDirector,
    csIc,
    csManager,
    csDirector,
  ]);
  for (const person of [productManager, productDirector, productVp, engineeringIc, engineeringManager, engineeringDirector, csIc, csManager, csDirector]) {
    addPersonScope(person, "project-aurora", { project: "aurora-release", product: "operations-control", workstream: "aurora-release" });
  }

  addProjectTeam(teams, "team-account-northstar", "Northstar Account Team", "customer_success", csManager?.id ?? null, [
    csIc,
    csManager,
    csDirector,
    csVp,
    productManager,
    engineeringManager,
  ]);
  for (const person of [csIc, csManager, csDirector, csVp, productManager, engineeringManager]) {
    addPersonScope(person, "account-northstar", { account: "northstar-medical", workstream: "northstar-account" });
  }

  addProjectTeam(teams, "team-account-summit", "Summit Implementation Team", "customer_success", csManager?.id ?? null, [
    csIc,
    csManager,
    productManager,
    engineeringManager,
  ]);
  for (const person of [csIc, csManager, productManager, engineeringManager]) {
    addPersonScope(person, "account-summit", { account: "summit-foods", workstream: "summit-implementation" });
  }

  addProjectTeam(teams, "team-incident-response", "Incident Response Roster", "engineering", engineeringManager?.id ?? null, [
    engineeringIc,
    engineeringManager,
    engineeringDirector,
    csManager,
  ]);
  for (const person of [engineeringIc, engineeringManager, engineeringDirector, csManager]) {
    addPersonScope(person, "incident-response", { project: "incident-response", workstream: "incident-response" });
  }

  if (productDirector && engineeringManager) {
    reportingRelationships.push({
      managerId: productDirector.id,
      reportId: engineeringManager.id,
      relationshipType: "dotted_line",
      context: "project-aurora release dependency",
    });
  }
  if (csDirector && productManager) {
    reportingRelationships.push({
      managerId: csDirector.id,
      reportId: productManager.id,
      relationshipType: "dotted_line",
      context: "northstar account product gap",
    });
  }
}

function firstByRole(people: Person[], roleTemplateId: string): Person | undefined {
  return people.find((person) => person.roleTemplateId === roleTemplateId);
}

function addProjectTeam(
  teams: Team[],
  id: string,
  name: string,
  department: Department,
  leadPersonId: string | null,
  members: Array<Person | undefined>,
): void {
  const memberPersonIds = members.filter((person): person is Person => Boolean(person)).map((person) => person.id);
  teams.push({
    id,
    name,
    department,
    level: "project",
    leadPersonId,
    parentTeamId: null,
    memberPersonIds: [...new Set(memberPersonIds)],
    responsibilityScopes: [id.replace("team-", "").replaceAll("-", ":")],
  });
}

function addPersonScope(
  person: Person | undefined,
  group: string,
  assignments: { project?: string; product?: string; account?: string; workstream?: string },
): void {
  if (!person) return;
  pushUnique(person.groupMemberships, group);
  if (assignments.project) pushUnique(person.assignedProjects, assignments.project);
  if (assignments.product) pushUnique(person.assignedProducts, assignments.product);
  if (assignments.account) pushUnique(person.assignedAccounts, assignments.account);
  if (assignments.workstream) pushUnique(person.assignedWorkstreams, assignments.workstream);
  pushUnique(person.permissionScopes, `group:${group}`);
}

function assignCustomerSuccessPortfolios(people: Person[]): void {
  const peopleById = new Map(people.map((person) => [person.id, person]));
  const customerSuccessIcs = people
    .filter(
      (person) =>
        person.department === "customer_success" && person.roleLevel === "ic",
    )
    .sort((left, right) => left.stableKey.localeCompare(right.stableKey));

  customerSuccessIcs.forEach((ic, index) => {
    const customer = customerProfiles[index % customerProfiles.length]!;
    let current: Person | undefined = ic;
    while (current) {
      addPersonScope(current, customer.permissionGroup, {
        account: customer.slug,
        workstream: `${customer.slug}-account`,
      });
      current = current.managerId ? peopleById.get(current.managerId) : undefined;
    }
  });
}

function createPerson(
  seed: string,
  department: Department,
  roleLevel: RoleLevel,
  vpIndex: number,
  directorIndex: number,
  managerIndex: number,
  icIndex: number,
  managerId: string | null,
  teamId: string,
): Person {
  const stableKey = `${department}:${roleLevel}:v${vpIndex}:d${directorIndex}:m${managerIndex}:i${icIndex}`;
  const id = `person-${slug(stableKey)}-${shortHash(seed, stableKey)}`;
  const name = deterministicName(seed, stableKey);
  return {
    id,
    stableKey,
    name,
    email: `${slug(name)}.${shortHash(seed, stableKey).slice(0, 6)}@example.test`,
    department,
    roleTemplateId: `role-${department.replace("_", "-")}-${roleLevel}`,
    roleTitle: roleTitle(department, roleLevel),
    roleLevel,
    teamId,
    managerId,
    directReportIds: [],
    sourceIdentities: Object.fromEntries(sourceSystems.map((source) => [source, `${source}:${id}`])),
    groupMemberships: groupMemberships(department, roleLevel, teamId),
    assignedProjects: department === "engineering" ? [`connector-gateway-${managerIndex || directorIndex || vpIndex}`] : [`operating-loop-${directorIndex || vpIndex}`],
    assignedProducts: department === "product" ? [`workflow-hub-${directorIndex || vpIndex}`] : [],
    assignedAccounts: department === "customer_success" ? [`northstar-medical-${managerIndex || directorIndex || vpIndex}`] : [],
    assignedWorkstreams: [scopeForDepartment(department, teamId)],
    permissionScopes: permissionScopes(department, roleLevel, teamId),
  };
}

function groupMemberships(department: Department, roleLevel: RoleLevel, teamId: string): string[] {
  const groups = new Set<string>([
    `${department}-all`,
    `${department}-${roleLevel}`,
    teamId,
  ]);

  if (department === "product") {
    groups.add("product-core");
    groups.add("product-launch-team");
    if (roleLevel !== "ic") groups.add("product-managers");
    if (roleLevel === "director" || roleLevel === "vp") groups.add("product-leadership");
    if (roleLevel === "vp") groups.add("product-portfolio");
  }

  if (department === "engineering") {
    groups.add("engineering-platform");
    groups.add("incident-response");
    if (roleLevel !== "ic") groups.add("engineering-managers");
    if (roleLevel === "director" || roleLevel === "vp") groups.add("engineering-leadership");
  }

  if (department === "customer_success") {
    groups.add("cs-east");
    groups.add("account-northstar");
    if (roleLevel !== "ic") groups.add("cs-managers");
    if (roleLevel === "director" || roleLevel === "vp") groups.add("cs-leadership");
  }

  if (roleLevel === "vp") groups.add("exec-staff");
  return [...groups].sort();
}

function permissionScopes(department: Department, roleLevel: RoleLevel, teamId: string): string[] {
  const scopes = [`source:${department}`, `team:${teamId}`];
  if (roleLevel === "director" || roleLevel === "vp") scopes.push(`portfolio:${department}`);
  if (roleLevel === "vp") scopes.push("executive:staff");
  return scopes;
}

function addReport(manager: Person, report: Person, relationships: GeneratedOrganization["reportingRelationships"]): void {
  manager.directReportIds.push(report.id);
  relationships.push({ managerId: manager.id, reportId: report.id, relationshipType: "primary", context: null });
}

function buildTree(people: Person[]): OrganizationNode[] {
  const peopleByManager = new Map<string | null, Person[]>();
  for (const person of people) {
    const existing = peopleByManager.get(person.managerId) ?? [];
    existing.push(person);
    peopleByManager.set(person.managerId, existing);
  }

  const nodeFor = (person: Person): OrganizationNode => ({
    personId: person.id,
    name: person.name,
    roleTitle: person.roleTitle,
    roleLevel: person.roleLevel,
    department: person.department,
    teamId: person.teamId,
    directReports: (peopleByManager.get(person.id) ?? []).map(nodeFor),
  });

  return (peopleByManager.get(null) ?? []).map(nodeFor);
}

function validateOrganization(people: Person[]): GeneratedOrganization["validation"] {
  const errors: string[] = [];
  const byId = new Map(people.map((person) => [person.id, person]));
  for (const person of people) {
    if (person.managerId !== null && !byId.has(person.managerId)) {
      errors.push(`${person.id} has missing manager ${person.managerId}`);
    }
    const visited = new Set<string>();
    let current: Person | undefined = person;
    while (current) {
      if (visited.has(current.id)) {
        errors.push(`${person.id} participates in a reporting cycle`);
        break;
      }
      visited.add(current.id);
      current = current.managerId ? byId.get(current.managerId) : undefined;
    }
  }
  return { ok: errors.length === 0, errors };
}

function countPeople(people: Person[]): GeneratedOrganization["counts"] {
  const byDepartment = { product: 0, engineering: 0, customer_success: 0 };
  const byRoleLevel = { ic: 0, manager: 0, director: 0, vp: 0 };
  for (const person of people) {
    byDepartment[person.department] += 1;
    byRoleLevel[person.roleLevel] += 1;
  }
  return { totalPeople: people.length, byDepartment, byRoleLevel };
}

function normalizeConfig(input: OrganizationConfig): OrganizationConfig {
  return {
    seed: input.seed || defaultOrganizationConfig.seed,
    departments: Object.fromEntries(
      departments.map((department) => {
        const fallback = defaultOrganizationConfig.departments[department];
        const override = input.departments?.[department] ?? fallback;
        return [
          department,
          {
            vpCount: positiveInt(override.vpCount, fallback.vpCount),
            directorsPerVp: positiveInt(override.directorsPerVp, fallback.directorsPerVp),
            managersPerDirector: positiveInt(override.managersPerDirector, fallback.managersPerDirector),
            icsPerManager: positiveInt(override.icsPerManager, fallback.icsPerManager),
            customDirectorsPerVp: override.customDirectorsPerVp ?? {},
            customManagersPerDirector: override.customManagersPerDirector ?? {},
            customIcsPerManager: override.customIcsPerManager ?? {},
          },
        ];
      }),
    ) as OrganizationConfig["departments"],
  };
}

function countFor(defaultCount: number, overrides: Record<string, number> | undefined, key: string): number {
  return positiveInt(overrides?.[key], defaultCount);
}

function positiveInt(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value) || value === undefined) return fallback;
  return Math.max(0, Math.floor(value));
}

function addMember(teams: Team[], teamId: string, personId: string): void {
  const team = teams.find((candidate) => candidate.id === teamId);
  if (team && !team.memberPersonIds.includes(personId)) team.memberPersonIds.push(personId);
}

function setLead(teams: Team[], teamId: string, personId: string): void {
  const team = teams.find((candidate) => candidate.id === teamId);
  if (team) team.leadPersonId = personId;
}

function pushUnique(values: string[], value: string): void {
  if (!values.includes(value)) values.push(value);
}

function deterministicName(seed: string, key: string): string {
  const first = firstNames[hashNumber(seed, key, "first") % firstNames.length]!;
  const last = lastNames[hashNumber(seed, key, "last") % lastNames.length]!;
  return `${first} ${last}`;
}

function roleTitle(department: Department, roleLevel: RoleLevel): string {
  const departmentLabel = labelDepartment(department);
  if (roleLevel === "ic") return department === "customer_success" ? "Customer Success Manager" : `${departmentLabel} IC`;
  if (roleLevel === "manager") return `${departmentLabel} Manager`;
  if (roleLevel === "director") return `Director, ${departmentLabel}`;
  return `VP ${departmentLabel}`;
}

function labelDepartment(department: Department): string {
  if (department === "customer_success") return "Customer Success";
  return department[0]!.toUpperCase() + department.slice(1);
}

function scopeForDepartment(department: Department, suffix: string): string {
  if (department === "product") return `product:${suffix}`;
  if (department === "engineering") return `engineering:${suffix}`;
  return `customer-success:${suffix}`;
}

function hashNumber(...parts: string[]): number {
  return Number.parseInt(shortHash(...parts).slice(0, 8), 16);
}

function shortHash(...parts: string[]): string {
  return createHash("sha256").update(parts.join("|"), "utf8").digest("hex").slice(0, 12);
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
