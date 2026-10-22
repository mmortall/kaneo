import { sha256 } from "@noble/hashes/sha2.js";

const PREFIX = "kaneo-label-group:";

export type LabelFilterGroup = { id: string; name: string; color: string };

/** Hash exact group values, independent of mutable assignment/definition IDs. */
export function labelGroupKey(
  group: Pick<LabelFilterGroup, "name" | "color">,
): string {
  return Array.from(
    sha256(new TextEncoder().encode(`${group.name}\0${group.color}`)),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

/** Keep group intent separate from saved individual assignment IDs. */
export function labelGroupSelection(group: LabelFilterGroup): string {
  return PREFIX + JSON.stringify([group.name, group.color, group.id]);
}

export function parseLabelGroupSelection(
  value: string,
): LabelFilterGroup | undefined {
  if (!value.startsWith(PREFIX)) return undefined;
  try {
    const fields: unknown = JSON.parse(value.slice(PREFIX.length));
    if (
      Array.isArray(fields) &&
      fields.length === 3 &&
      fields.every((field) => typeof field === "string")
    ) {
      return { name: fields[0], color: fields[1], id: fields[2] };
    }
  } catch {
    /* Preserve malformed saved values as individual IDs. */
  }
  return undefined;
}

export function matchesLabelSelection(
  selection: readonly string[],
  labels: readonly LabelFilterGroup[],
): boolean {
  return selection.some((value) => {
    const group = parseLabelGroupSelection(value);
    return labels.some((label) =>
      group
        ? label.name === group.name && label.color === group.color
        : label.id === value,
    );
  });
}
