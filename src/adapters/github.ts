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
    const terminalUpdate =
      input.changeType === "updated" &&
      (input.template.rawPayload.updatedStatus === "closed" ||
        input.template.rawPayload.updatedStatus === "merged");
    const state = terminalUpdate ? "closed" : "open";
    if (input.template.objectType === "commit") {
      const sha = stableHex(`${input.sourceId}:commit:${input.changeType}`, 40);
      const parentSha = stableHex(`${input.sourceId}:parent`, 40);
      return {
        objectType: "commit",
        rawPayload: {
          sha,
          node_id: `C_${stableHex(input.sourceId, 16)}`,
          url: `https://api.github.example.test/repos/${repository}/commits/${sha}`,
          html_url: `https://github.example.test/${repository}/commit/${sha}`,
          comments_url: `https://api.github.example.test/repos/${repository}/commits/${sha}/comments`,
          commit: {
            author: {
              name: input.actor.name,
              email: input.actor.email,
              date: input.changeOccurredAt,
            },
            committer: {
              name: input.actor.name,
              email: input.actor.email,
              date: input.changeOccurredAt,
            },
            message: templateText(input),
            tree: {
              sha: stableHex(`${input.sourceId}:tree`, 40),
              url: `https://api.github.example.test/repos/${repository}/git/trees/${stableHex(`${input.sourceId}:tree`, 40)}`,
            },
            url: `https://api.github.example.test/repos/${repository}/git/commits/${sha}`,
            comment_count: input.changeType === "updated" ? 1 : 0,
            verification: {
              verified: true,
              reason: "valid",
              signature: null,
              payload: null,
            },
          },
          author,
          committer: author,
          parents: [
            {
              sha: parentSha,
              url: `https://api.github.example.test/repos/${repository}/commits/${parentSha}`,
              html_url: `https://github.example.test/${repository}/commit/${parentSha}`,
            },
          ],
          stats: {
            total: numericId(`${input.sourceId}:stats`, 1, 20),
            additions: numericId(`${input.sourceId}:additions`, 1, 15),
            deletions: numericId(`${input.sourceId}:deletions`, 0, 5),
          },
          files: [
            {
              sha: stableHex(`${input.sourceId}:file`, 40),
              filename: String(input.template.rawPayload.path ?? "src/simulator.ts"),
              status: input.changeType === "deleted" ? "removed" : "modified",
              additions: numericId(`${input.sourceId}:file:add`, 1, 10),
              deletions: numericId(`${input.sourceId}:file:del`, 0, 4),
              changes: numericId(`${input.sourceId}:file:changes`, 1, 14),
              blob_url: `https://github.example.test/${repository}/blob/${sha}/src/simulator.ts`,
              raw_url: `https://raw.github.example.test/${repository}/${sha}/src/simulator.ts`,
              contents_url: `https://api.github.example.test/repos/${repository}/contents/src/simulator.ts?ref=${sha}`,
            },
          ],
        },
      };
    }
    if (input.template.objectType === "release") {
      const releaseId = numericId(`${input.sourceId}:release`, 100_000, 900_000);
      const tagName = String(
        input.template.rawPayload.tagName ?? `v${numericId(input.sourceId, 1, 20)}.0.0`,
      );
      const draft = input.changeType === "deleted";
      return {
        objectType: "release",
        rawPayload: {
          id: releaseId,
          node_id: `RE_${stableHex(input.sourceId, 16)}`,
          tag_name: tagName,
          target_commitish: "main",
          name: input.template.title,
          body: templateText(input),
          draft,
          prerelease: input.template.rawPayload.prerelease === true,
          created_at: input.occurredAt,
          published_at: draft ? null : input.changeOccurredAt,
          author,
          html_url: `https://github.example.test/${repository}/releases/tag/${tagName}`,
          url: `https://api.github.example.test/repos/${repository}/releases/${releaseId}`,
          assets_url: `https://api.github.example.test/repos/${repository}/releases/${releaseId}/assets`,
          upload_url: `https://uploads.github.example.test/repos/${repository}/releases/${releaseId}/assets{?name,label}`,
          tarball_url: `https://api.github.example.test/repos/${repository}/tarball/${tagName}`,
          zipball_url: `https://api.github.example.test/repos/${repository}/zipball/${tagName}`,
          assets: [],
        },
      };
    }
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
