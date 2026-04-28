/**
 * Pure-WASM SQLite loader. We use sql.js so `npm i -g strait` requires no
 * native compilation on the user's machine — the wasm binary ships with the
 * package and runs anywhere Node runs.
 *
 * One module-level instance, lazily initialized. Closing a Database releases
 * the in-memory copy of that file but leaves the WASM runtime loaded.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import initSqlJs, { type Database, type SqlJsStatic } from "sql.js";

let cached: SqlJsStatic | null = null;

async function getSqlJs(): Promise<SqlJsStatic> {
  if (cached) return cached;
  cached = await initSqlJs({
    // Locate sql-wasm.wasm next to the sql.js package, regardless of whether
    // we're running from source or from a global npm install.
    locateFile: (file: string) => {
      const here = path.dirname(fileURLToPath(import.meta.url));
      // 1. Bundled install: sql-wasm.wasm sits next to dist/index.js.
      const sibling = path.join(here, file);
      if (fs.existsSync(sibling)) return sibling;
      // 2. Source / dev: walk upward to find node_modules/sql.js/dist/<file>.
      let dir = here;
      for (let i = 0; i < 6; i++) {
        const candidate = path.join(dir, "node_modules", "sql.js", "dist", file);
        if (fs.existsSync(candidate)) return candidate;
        dir = path.dirname(dir);
      }
      return file;
    },
  });
  return cached;
}

/** Open a SQLite file read-only. Returns a Database that callers MUST close. */
export async function openDatabase(filePath: string): Promise<Database> {
  const SQL = await getSqlJs();
  const buf = fs.readFileSync(filePath);
  return new SQL.Database(new Uint8Array(buf));
}
