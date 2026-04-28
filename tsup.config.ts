import { defineConfig } from "tsup";
import { copyFileSync, mkdirSync } from "node:fs";
import * as path from "node:path";

export default defineConfig({
  entry: { index: "src/index.ts" },
  format: ["esm"],
  target: "node20",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  banner: {
    js: `#!/usr/bin/env node
import { createRequire as __createRequire } from "module";
import { fileURLToPath as __fileURLToPath } from "url";
import { dirname as __dirname_fn } from "path";
const require = __createRequire(import.meta.url);
const __filename = __fileURLToPath(import.meta.url);
const __dirname = __dirname_fn(__filename);`,
  },
  shims: false,
  splitting: false,
  // Bundle every dep so the published package is self-contained — no
  // node_modules/* lookups at runtime, no native compilation. The only
  // non-JS asset is sql.js's WASM, which we copy alongside dist/index.js
  // and locate at runtime via src/sqlite.ts.
  noExternal: [/.*/],
  onSuccess: async () => {
    const src = path.resolve("node_modules/sql.js/dist/sql-wasm.wasm");
    const dst = path.resolve("dist/sql-wasm.wasm");
    mkdirSync(path.dirname(dst), { recursive: true });
    copyFileSync(src, dst);
    console.log("✓ copied sql-wasm.wasm into dist/");
  },
});
