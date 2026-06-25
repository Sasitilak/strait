/**
 * Local strait config at ~/.strait/config.json (sibling of history.jsonl).
 *
 * Holds the cloud endpoint and an anonymous device id. The device id is a
 * random UUID generated once and persisted; it identifies a device, not a
 * person, and is the only stable identifier `strait push` attaches.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { randomUUID } from "node:crypto";

export const CONFIG_PATH = path.join(os.homedir(), ".strait", "config.json");

export interface StraitConfig {
  endpoint?: string;
  deviceId: string;
  userId?: string;
}

export function loadConfig(): StraitConfig {
  let raw: Partial<StraitConfig> = {};
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    // Missing or corrupt — fall through to defaults.
  }
  if (!raw.deviceId || typeof raw.deviceId !== "string") {
    const cfg: StraitConfig = { ...raw, deviceId: randomUUID() };
    saveConfig(cfg);
    return cfg;
  }
  return raw as StraitConfig;
}

export function saveConfig(cfg: StraitConfig): void {
  try {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n");
  } catch {
    // Best-effort — mirror history.ts; never crash on a config write.
  }
}
