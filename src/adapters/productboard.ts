import { makeVendorAdapter, slug, templateStatus, templateText } from "./shared.js";

export const productboardAdapter = makeVendorAdapter(
  "productboard",
  ["feature", "insight", "component", "note"],
  (input) => {
    const isNote = input.template.objectType === "insight";
    const type = isNote
      ? "note"
      : input.template.objectType === "component"
        ? "component"
        : "feature";
    const id = String(input.template.rawPayload.featureId ?? `${type}-${slug(input.sourceId)}`);
    return {
      objectType: type,
      rawPayload: {
        data: {
          type,
          id,
          attributes: {
            name: input.template.title,
            description: templateText(input),
            status: templateStatus(input, isNote ? "processed" : "under_review"),
            archived: input.changeType === "deleted" || input.template.rawPayload.archived === true,
            type: isNote ? "textNote" : undefined,
            product_area: input.template.rawPayload.productArea ?? input.instance.product,
            roadmap_position: input.template.rawPayload.roadmapPosition ?? "candidate",
            created_at: input.occurredAt,
            updated_at: input.changeOccurredAt,
          },
          relationships: {
            owner: {
              data: {
                type: "user",
                id: input.actor.sourceIdentities.productboard ?? input.actor.id,
              },
            },
            product: {
              data: { type: "product", id: slug(input.instance.product ?? "simulated-product") },
            },
            ...(input.template.rawPayload.customer
              ? {
                  companies: {
                    data: [{ type: "company", id: slug(input.template.rawPayload.customer) }],
                  },
                }
              : {}),
          },
          links: {
            self: `https://api.productboard.example.test/v2/${type}s/${id}`,
          },
        },
      },
    };
  },
);
