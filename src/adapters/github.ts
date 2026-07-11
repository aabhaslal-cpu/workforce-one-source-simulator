import type { Person } from "../domain.js";
import {
  githubLogin,
  isPerson,
  makeVendorAdapter,
  numericId,
  stableHex,
  templateText,
} from "./shared.js";

export const githubAdapter = makeVendorAdapter(
  "github",
  ["issue", "pull_request", "commit", "release"],
  (input) => {
    const repository = String(input.template.rawPayload.repository ?? "acme/operating-loop");
    const number = Number(input.template.rawPayload.number ?? numericId(input.sourceId, 1, 9000));
    const author = githubUser(input.actor);
    const reviewers = [input.assignee, ...input.managerChain.slice(0, 1)]
      .filter(isPerson)
      .map(githubUser);
    const state =
      input.changeType === "deleted" ||
      input.template.rawPayload.updatedStatus === "closed" ||
      input.template.rawPayload.updatedStatus === "merged"
        ? "closed"
        : "open";
    if (input.template.objectType === "pull_request") {
      const merged =
        input.changeType === "updated" && input.template.rawPayload.updatedStatus === "merged";
      return {
        objectType: "pull_request",
        rawPayload: {
          id: numericId(`${input.sourceId}:pr`, 100_000, 900_000),
          node_id: `PR_${stableHex(input.sourceId, 16)}`,
          number,
          state,
          title: input.template.title,
          body: templateText(input),
          user: author,
          html_url: `https://github.example.test/${repository}/pull/${number}`,
          draft: false,
          merged,
          mergeable: input.changeType === "created" ? true : null,
          requested_reviewers: reviewers,
          head: {
            ref: `sim/${input.template.id}`,
            sha: stableHex(`${input.sourceId}:head:${input.changeType}`, 40),
            repo: { full_name: repository },
          },
          base: {
            ref: "main",
            sha: stableHex(`${input.sourceId}:base`, 40),
            repo: { full_name: repository },
          },
          created_at: input.occurredAt,
          updated_at: input.changeOccurredAt,
          closed_at: state === "closed" ? input.changeOccurredAt : null,
          merged_at: merged ? input.changeOccurredAt : null,
        },
      };
    }
    return {
      objectType: "issue",
      rawPayload: {
        id: numericId(`${input.sourceId}:issue`, 100_000, 900_000),
        node_id: `I_${stableHex(input.sourceId, 16)}`,
        number,
        state,
        title: input.template.title,
        body: templateText(input),
        user: author,
        labels: [
          {
            id: numericId(`${input.sourceId}:label`, 1_000, 9_000),
            name: String(input.template.rawPayload.status ?? "simulation"),
            color: "ededed",
          },
        ],
        assignees: reviewers,
        comments: input.changeType === "updated" ? 1 : 0,
        html_url: `https://github.example.test/${repository}/issues/${number}`,
        created_at: input.occurredAt,
        updated_at: input.changeOccurredAt,
        closed_at: state === "closed" ? input.changeOccurredAt : null,
      },
    };
  },
);

function githubUser(person: Person) {
  return {
    login: githubLogin(person),
    id: numericId(person.stableKey, 10_000, 900_000),
    node_id: `U_${stableHex(person.stableKey, 16)}`,
    type: "User",
    site_admin: false,
    html_url: `https://github.example.test/${githubLogin(person)}`,
  };
}
