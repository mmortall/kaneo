import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";

/** Fingerprint every compiled runtime module, including imported tools. */
export async function compiledFingerprint() {
  const files = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) await walk(path);
      else if (entry.name.endsWith(".js")) files.push(path);
    }
  }
  await walk("packages/mcp/dist");
  const hash = createHash("sha256");
  const modules = [];
  for (const path of files.sort()) {
    const source = await readFile(path);
    const relativePath = path.slice("packages/mcp/dist/".length);
    hash.update(relativePath).update("\0").update(source).update("\0");
    modules.push({
      path: relativePath,
      sha256: createHash("sha256").update(source).digest("hex"),
    });
  }
  return { sha256: hash.digest("hex"), modules };
}
