/**
 * Lets `node --experimental-strip-types` follow the extensionless relative
 * imports that TypeScript uses (`./db` → `./db.ts`) and the `@/` alias from
 * tsconfig. Only used by the verify scripts — the deployed app is bundled by
 * Next, which resolves these itself.
 */
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const src = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

const firstExisting = (base) => {
  for (const ext of [".ts", ".tsx", "/index.ts", "/index.tsx"]) {
    const candidate = base + ext;
    if (existsSync(candidate)) return pathToFileURL(candidate).href;
  }
  return null;
};

registerHooks({
  resolve(specifier, context, nextResolve) {
    // "@/lib/db" → <root>/src/lib/db.ts
    if (specifier.startsWith("@/")) {
      const found = firstExisting(join(src, specifier.slice(2)));
      if (found) return { url: found, shortCircuit: true };
    }

    // "./db" → ./db.ts, when the specifier carries no extension of its own
    if (specifier.startsWith(".") && !/\.\w+$/.test(specifier) && context.parentURL) {
      const parent = dirname(fileURLToPath(context.parentURL));
      const found = firstExisting(join(parent, specifier));
      if (found) return { url: found, shortCircuit: true };
    }

    return nextResolve(specifier, context);
  },
});
