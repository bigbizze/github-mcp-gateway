import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Comma-separated identities that must never appear in the repository, such as the
// account names of a private deployment. Set FORBIDDEN_IDENTITIES in your shell or as a
// CI secret so the list itself stays out of the source. The test is skipped when unset.
const forbidden = (process.env.FORBIDDEN_IDENTITIES ?? "")
  .split(",")
  .map((identity) => identity.trim().toLowerCase())
  .filter(Boolean);

const excludedDirectories = new Set([
  ".git",
  ".idea",
  ".playwright-mcp",
  ".wrangler",
  "coverage",
  "dist",
  "node_modules",
]);

// Local secret files are gitignored and may name an operator account on purpose.
function isLocalSecretFile(name: string): boolean {
  if (name === ".dev.vars.example" || name === ".env.example") return false;
  return (
    name === ".dev.vars" || name.startsWith(".dev.vars.") || name === ".env" || name.startsWith(".env.")
  );
}

async function projectFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!excludedDirectories.has(entry.name)) {
        files.push(...(await projectFiles(path.join(directory, entry.name))));
      }
    } else if (entry.isFile() && !isLocalSecretFile(entry.name)) {
      files.push(path.join(directory, entry.name));
    }
  }
  return files;
}

describe("account-neutral repository content", () => {
  it.skipIf(forbidden.length === 0)("does not contain any FORBIDDEN_IDENTITIES entry", async () => {
    const findings: string[] = [];

    for (const file of await projectFiles(process.cwd())) {
      const content = (await readFile(file, "utf8")).toLowerCase();
      if (forbidden.some((identity) => content.includes(identity))) {
        findings.push(`${path.relative(process.cwd(), file)} contains a forbidden identity`);
      }
    }

    expect(findings).toEqual([]);
  });
});
