import { makeVendorAdapter, slug, templateStatus, templateText, uuidLike } from "./shared.js";

export const productboardAdapter = makeVendorAdapter(
  "productboard",
  ["feature", "insight", "note", "textNote"],
  (input) => {
    const isNote =
      input.template.objectType === "insight" ||
      input.template.objectType === "note" ||
      input.template.objectType === "textNote";
    const id = uuidLike(String(input.template.rawPayload.featureId ?? input.sourceId));
    const company = input.template.rawPayload.customer ?? input.instance.account;
    const ownerId = uuidLike(input.actor.stableKey);
    const linkedFeatureId = uuidLike(`${input.sourceId}:linked-feature`);
    const customerId = uuidLike(String(company ?? `${input.sourceId}:company`));
    const archived = input.changeType === "updated" && input.template.rawPayload.archived === true;
    if (isNote) {
      return {
        objectType: "note",
        rawPayload: {
          data: {
            id,
            type: "textNote",
            createdAt: input.occurredAt,
            updatedAt: input.changeOccurredAt,
            fields: {
              name: input.template.title,
              tags: [{ name: slug(input.instance.product ?? "simulation") }],
              content: templateText(input),
              owner: { id: ownerId, email: input.actor.email },
              creator: { id: ownerId, email: input.actor.email },
              processed: input.changeType !== "created",
              archived,
            },
            relationships: [
              {
                type: "customer",
                target: {
                  id: customerId,
                  type: "company",
                  links: {
                    self: `https://api.productboard.example.test/v2/companies/${customerId}`,
                  },
                },
              },
              {
                type: "link",
                target: {
                  id: linkedFeatureId,
                  type: "feature",
                  links: {
                    self: `https://api.productboard.example.test/v2/entities/${linkedFeatureId}`,
                  },
                },
              },
            ],
            links: {
              self: `https://api.productboard.example.test/v2/notes/${id}`,
              html: `https://productboard.example.test/all-notes/notes/${id}`,
            },
          },
        },
      };
    }

    const status = templateStatus(input, "under_review");
    const parentId = uuidLike(`${input.instance.product ?? "simulated-product"}:component`);
    return {
      objectType: "feature",
      rawPayload: {
        data: {
          id,
          type: "feature",
          fields: {
            name: input.template.title,
            status: { id: uuidLike(`productboard-status:${status}`), name: status },
            owner: { id: ownerId, email: input.actor.email },
            tags: [{ id: uuidLike(`${input.sourceId}:tag`), name: slug(input.scenario.id) }],
            archived,
          },
          relationships: {
            data: [
              {
                type: "parent",
                target: {
                  id: parentId,
                  type: "component",
                  links: {
                    self: `https://api.productboard.example.test/v2/entities/${parentId}`,
                    html: `https://productboard.example.test/detail/${parentId}`,
                  },
                },
              },
            ],
            links: { next: null },
          },
          links: {
            self: `https://api.productboard.example.test/v2/entities/${id}`,
            html: `https://productboard.example.test/detail/${id}`,
          },
          createdAt: input.occurredAt,
          updatedAt: input.changeOccurredAt,
        },
      },
    };
  },
);
