import fs from "node:fs";
import { fileURLToPath } from "node:url";

export async function resolve(specifier, context, nextResolve) {
  const relative = specifier.startsWith("./") || specifier.startsWith("../");
  if (relative && context.parentURL?.endsWith(".ts") && !/\.[cm]?[jt]sx?$|\.json$/.test(specifier)) {
    for (const suffix of [".ts", ".tsx", "/index.ts"]) {
      const url = new URL(specifier + suffix, context.parentURL);
      if (fs.existsSync(fileURLToPath(url))) return nextResolve(url.href, context);
    }
  }
  return nextResolve(specifier, context);
}
