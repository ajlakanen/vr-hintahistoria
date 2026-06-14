import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { AppConfig } from "./types.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = join(__dirname, "..");
export const DATA_DIR = join(PROJECT_ROOT, "data");
// Kannan polku; VR_DB_PATH-ympäristömuuttuja voi ohittaa sen (mm. testit -> ei kosketa
// oikeaa kantaa). Tyhjä/asettamaton = oletus data/prices.db.
export const DB_PATH = process.env.VR_DB_PATH || join(DATA_DIR, "prices.db");
export const PUBLIC_DIR = join(PROJECT_ROOT, "public");

let cached: AppConfig | null = null;

export function loadConfig(): AppConfig {
  if (cached) return cached;
  const raw = readFileSync(join(PROJECT_ROOT, "config.json"), "utf8");
  const cfg = JSON.parse(raw) as AppConfig;

  if (!Array.isArray(cfg.routes) || cfg.routes.length === 0) {
    throw new Error("config.json: 'routes' on tyhjä — lisää vähintään yksi reitti.");
  }
  if (!cfg.daysAhead || cfg.daysAhead < 1) cfg.daysAhead = 60;
  // freshnessHours: oletus 5 h. Salli 0 (= ei ohitusta), hylkää epäkelvot arvot.
  if (typeof cfg.freshnessHours !== "number" || cfg.freshnessHours < 0) cfg.freshnessHours = 5;
  if (!cfg.passengers || cfg.passengers.length === 0) {
    cfg.passengers = [{ type: "ADULT" }];
  }
  cached = cfg;
  return cfg;
}

/** Laajentaa reittilistan suunnatuiksi pareiksi (molemmat suunnat jos asetettu). */
export function expandRoutes(cfg: AppConfig): { from: string; to: string }[] {
  const seen = new Set<string>();
  const out: { from: string; to: string }[] = [];
  const add = (from: string, to: string) => {
    if (from === to) return;
    const key = `${from}>${to}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ from, to });
  };
  for (const r of cfg.routes) {
    add(r.from, r.to);
    if (cfg.bothDirections) add(r.to, r.from);
  }
  return out;
}
