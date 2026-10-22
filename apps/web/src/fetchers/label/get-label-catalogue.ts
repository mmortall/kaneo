import { client } from "@kaneo/libs";

export type LabelCatalogueOptions = {
  page?: number;
  limit?: number;
  scope?: "groups" | "definitions";
  search?: string;
  exact?: boolean;
};

/** Fetch one catalogue page; never fall back to all workspace assignments. */
export default async function getLabelCatalogue(
  workspaceId: string,
  options: LabelCatalogueOptions = {},
  signal?: AbortSignal,
) {
  const page = options.page ?? 1;
  const limit = options.limit ?? 50;
  if (
    !Number.isSafeInteger(page) ||
    page < 1 ||
    page > 9_999_999 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100
  ) {
    throw new Error("Invalid label catalogue page");
  }
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await client.label.workspace[
      ":workspaceId"
    ].catalogue.$get(
      {
        param: { workspaceId },
        query: {
          page: String(page),
          limit: String(limit),
          scope: options.scope ?? "groups",
          search: options.search ?? "",
          exact: options.exact ? "true" : "false",
        },
      },
      { init: { signal: controller.signal } },
    );
    if (!response.ok) {
      if (response.status === 404)
        throw new Error(
          "Server does not support paginated label catalogues. Reload after upgrading Kaneo.",
        );
      throw new Error(await response.text());
    }
    const body = await response.json();
    const pagination = body.pagination;
    if (
      !pagination ||
      !Array.isArray(body.items) ||
      body.items.length > limit ||
      !Number.isSafeInteger(pagination.total) ||
      pagination.total < 0 ||
      pagination.page !== page ||
      pagination.pageSize !== limit ||
      pagination.totalPages !== Math.ceil(pagination.total / limit) ||
      pagination.hasMore !== page < pagination.totalPages ||
      pagination.nextPage !== (pagination.hasMore ? page + 1 : null)
    ) {
      throw new Error("Label catalogue returned invalid pagination");
    }
    return body;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}
