import { expandRoutes, loadConfig } from "./config.ts";
import { fetchStationNames } from "./digitraffic.ts";
import { upsertRoute } from "./db.ts";
import { log } from "./logger.ts";

/**
 * Siementää 'routes'-taulun config.json:n reiteistä ja täyttää asemanimet
 * Digitrafficista. Aja kerran (ja uudelleen kun muutat reittejä).
 */
async function main(): Promise<void> {
  const cfg = loadConfig();
  const directed = expandRoutes(cfg);

  let names = new Map<string, string>();
  try {
    names = await fetchStationNames();
  } catch (e) {
    log.warn("Asemanimien haku epäonnistui, jatketaan ilman nimiä:", (e as Error).message);
  }

  let count = 0;
  for (const r of directed) {
    const fromName = names.get(r.from) ?? null;
    const toName = names.get(r.to) ?? null;
    upsertRoute(r.from, r.to, fromName, toName);
    count++;
    log.info(`Reitti: ${r.from} (${fromName ?? "?"}) -> ${r.to} (${toName ?? "?"})`);
  }
  log.info(`Valmis. ${count} suunnattua reittiä taulussa 'routes'.`);
}

main().catch((e) => {
  log.error(e);
  process.exit(1);
});
