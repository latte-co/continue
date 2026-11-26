import fs from "node:fs";

const lock = JSON.parse(fs.readFileSync("package-lock.json", "utf8"));
const disallowed = [];

for (const [pkg, meta] of Object.entries(lock.packages ?? {})) {
  if (typeof meta?.resolved === "string" && /^https?:/.test(meta.resolved)) {
    const origin = new URL(meta.resolved).origin;
    if (origin !== "https://registry.npmjs.org") {
      disallowed.push(`${pkg || "<root>"} -> ${meta.resolved}`);
    }
  }
}

if (disallowed.length > 0) {
  console.error(
    "package-lock.json contains non-npmjs.org resolved URLs:\n" +
      disallowed.map((item) => `  - ${item}`).join("\n"),
  );
  process.exit(1);
}
