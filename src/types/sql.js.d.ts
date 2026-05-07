// Minimal ambient module decl — sql.js ships no types and DefinitelyTyped's
// @types/sql.js is stale. We use a small surface (initSqlJs, Database,
// prepare/step/getAsObject/run/export) and let any() through.
declare module "sql.js" {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const init: (opts?: any) => Promise<any>;
  export default init;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export type Database = any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export type SqlJsStatic = any;
}
