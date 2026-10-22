import { HTTPException } from "hono/http-exception";
import * as v from "valibot";
import type { ManagedSpec } from "./controllers/ensure-managed-tasks";

const text = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(10000));
export const managedItemsSchema = v.object({
  items: v.pipe(
    v.array(
      v.object({
        key: v.pipe(v.string(), v.regex(/^[a-zA-Z0-9:._/-]{1,512}$/)),
        title: text,
        description: v.pipe(v.string(), v.maxLength(100000)),
        goal: text,
        acceptanceCriteria: text,
        workItemType: v.picklist(["epic", "sub_epic", "task"]),
      }),
    ),
    v.length(3),
  ),
});

export function validateManagedHierarchy(items: ManagedSpec[]) {
  if (
    items.some(
      (item, i) => item.workItemType !== ["epic", "sub_epic", "task"][i],
    ) ||
    new Set(items.map((item) => item.key)).size !== 3
  )
    throw new HTTPException(400, {
      message: "Provide distinct epic, sub_epic, task keys in hierarchy order",
    });
}
