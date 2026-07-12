import { makeVendorAdapter, slug, templateStatus, templateText } from "./shared.js";

export const productboardAdapter = makeVendorAdapter(
  "productboard",
  ["feature", "insight", "note"],
  (input) => {
    const isNote = input.template.objectType === "insight";
    const type = isNote ? "note" : "feature";
    const id = String(input.template.rawPayload.featureId ?? `${type}-${slug(input.sourceId)}`);
    const company = input.template.rawPayload.customer ?? input.instance.account;
    return {
      objectType: type,
      rawPayload: {
        data: {
          type,
          id,
          attributes: isNote
            ? {
                title: input.template.title,
                content: templateText(input),
                note_type: "textNote",
                created_at: input.occurredAt,
                updated_at: input.changeOccurredAt,
              }
            : {
                name: input.template.title,
                description: templateText(input),
                status: { name: templateStatus(input, "under_review") },
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
            ...(company
              ? {
                  companies: {
                    data: [{ type: "company", id: slug(company) }],
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
