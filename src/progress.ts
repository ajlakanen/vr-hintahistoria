import { loadConfig, expandRoutes } from "./config.ts";
import { getDb } from "./db.ts";

/**
 * Näyttää käynnissä olevan / viimeisimmän keräyksen edistymisen lukemalla kannasta,
 * montako (reitti × lähtöpäivä) -paria on jo käsitelty tämän päivän ajossa.
 * Käyttö:  npm run progress
 */
function main(): void {
  const cfg = loadConfig();
  const expected = expandRoutes(cfg).length * cfg.daysAhead;
  const db = getDb();

  const scrapeDate = new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Helsinki" });

  const today = db
    .prepare(
      `SELECT COUNT(DISTINCT route_id || travel_date) AS combos, COUNT(*) AS rows
       FROM price_history WHERE scrape_date = ?`
    )
    .get(scrapeDate) as { combos: number; rows: number };

  const last = db
    .prepare(
      `SELECT r.from_code AS f, r.to_code AS t, h.travel_date AS d, MAX(h.scraped_at) AS at
       FROM price_history h JOIN routes r ON r.id = h.route_id
       WHERE h.scrape_date = ?`
    )
    .get(scrapeDate) as { f: string; t: string; d: string; at: string } | undefined;

  const pct = expected > 0 ? Math.round((today.combos / expected) * 100) : 0;
  console.log(`Ajopäivä ${scrapeDate}`);
  console.log(`Edistyminen: ${today.combos} / ${expected} reitti×päivä  (${pct} %)`);
  console.log(`Hintarivejä tänään: ${today.rows}`);
  if (last?.at) console.log(`Viimeisin tallennus: ${last.f}->${last.t} ${last.d}  (${last.at})`);
}

main();
