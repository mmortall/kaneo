import type { QueryClient } from "@tanstack/react-query";

/** Refresh task revisions after committed or uncertain label mutations. */
export default function invalidateLabelTaskCaches(client: QueryClient) {
  for (const queryKey of [
    ["labels"],
    ["tasks"],
    ["task"],
    ["task-relations"],
    ["activities"],
    ["notifications"],
  ])
    void client.invalidateQueries({ queryKey });
}
