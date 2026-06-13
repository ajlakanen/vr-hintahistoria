import { mkdirSync, writeFileSync, readFileSync, cpSync, rmSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_ROOT, PUBLIC_DIR } from "./config.ts";
import { getDb, getActiveRoutes } from "./db.ts";
import { log } from "./logger.ts";

/**
 * Esirenderöi kannan staattisiksi JSON-tiedostoiksi 'docs/'-kansioon, jotta sivu
 * voidaan julkaista GitHub Pagesiin ilman elävää API-backendia. Frontend (app.js)
 * tunnistaa 'data/manifest.json':n ja siirtyy staattiseen moodiin.
 *
 * Aja keräyksen jälkeen:  npm run scrape && npm run export
 * Sitten:                 committaa docs/ ja pushaa -> Pages päivittyy.
 */

const DOCS_DIR = join(PROJECT_ROOT, "docs");
const DATA_DIR = join(DOCS_DIR, "data");

interface DepRow {
  travel_date: string;
  time: string;
  train: string | null;
  price: number;
  currency: string;
  available: number;
  updatedAt: string;
}
interface HistRow {
  travel_date: string;
  departure_time: string;
  scrapeDate: string;
  price: number;
  currency: string;
  available: number;
}

function main(): void {
  const db = getDb();
  const routes = getActiveRoutes();
  if (routes.length === 0) {
    log.error("Ei reittejä. Aja ensin: npm run seed");
    process.exit(1);
  }

  // Tyhjennä vanha export ja kopioi frontend (index.html, style.css, app.js) docs/:iin.
  rmSync(DOCS_DIR, { recursive: true, force: true });
  mkdirSync(DATA_DIR, { recursive: true });
  cpSync(PUBLIC_DIR, DOCS_DIR, { recursive: true });
  // Estä GitHub Pagesin Jekyll-käsittely (mm. alaviiva-alkuiset tiedostot).
  writeFileSync(join(DOCS_DIR, ".nojekyll"), "");

  // Välimuistin ohitus: lisää versioleima app.js/style.css-viittauksiin, jotta selain
  // (etenkin iOS Safari) hakee tuoreet tiedostot eikä tarjoile vanhaa välimuistista.
  const buildId = new Date().toISOString().replace(/\D/g, "").slice(0, 14); // YYYYMMDDHHMMSS
  const indexPath = join(DOCS_DIR, "index.html");
  const html = readFileSync(indexPath, "utf8")
    .replace('href="style.css"', `href="style.css?v=${buildId}"`)
    .replace('src="app.js"', `src="app.js?v=${buildId}"`);
  writeFileSync(indexPath, html);

  const calStmt = db.prepare(
    // Vain varattavissa olevat lähdöt -> "halvin/keskihinta" ei näytä loppuunmyydyn vanhaa hintaa.
    `SELECT travel_date AS date, MIN(price) AS minPrice, AVG(price) AS avgPrice,
            MAX(price) AS maxPrice, COUNT(*) AS departures
     FROM prices WHERE route_id = ? AND available = 1 GROUP BY travel_date ORDER BY travel_date`
  );
  const depStmt = db.prepare(
    `SELECT travel_date, departure_time AS time, train_number AS train, price, currency,
            available, updated_at AS updatedAt
     FROM prices WHERE route_id = ? ORDER BY travel_date, departure_time`
  );
  const histStmt = db.prepare(
    `SELECT travel_date, departure_time, scrape_date AS scrapeDate, price, currency, available
     FROM price_history WHERE route_id = ? ORDER BY travel_date, departure_time, scrape_date`
  );

  let bytes = 0;
  for (const r of routes) {
    const calendar = calStmt.all(r.id);

    const departures: Record<string, Omit<DepRow, "travel_date">[]> = {};
    for (const d of depStmt.all(r.id) as unknown as DepRow[]) {
      (departures[d.travel_date] ??= []).push({
        time: d.time,
        train: d.train,
        price: d.price,
        currency: d.currency,
        available: d.available,
        updatedAt: d.updatedAt,
      });
    }

    const history: Record<
      string,
      { scrapeDate: string; price: number; currency: string; available: number }[]
    > = {};
    for (const h of histStmt.all(r.id) as unknown as HistRow[]) {
      const key = `${h.travel_date}|${h.departure_time}`;
      (history[key] ??= []).push({
        scrapeDate: h.scrapeDate,
        price: h.price,
        currency: h.currency,
        available: h.available,
      });
    }

    const blob = {
      route: { id: r.id, from: r.from_code, to: r.to_code, fromName: r.from_name, toName: r.to_name },
      calendar,
      departures,
      history,
    };
    const json = JSON.stringify(blob);
    bytes += json.length;
    writeFileSync(join(DATA_DIR, `route-${r.id}.json`), json);
  }

  const manifest = {
    generatedAt: new Date().toISOString(),
    routes: routes.map((r) => ({
      id: r.id,
      from: r.from_code,
      to: r.to_code,
      fromName: r.from_name,
      toName: r.to_name,
    })),
  };
  writeFileSync(join(DATA_DIR, "manifest.json"), JSON.stringify(manifest));

  log.info(
    `Export valmis: ${routes.length} reittiä -> ${DATA_DIR} (~${(bytes / 1024 / 1024).toFixed(1)} MB dataa).`
  );
}

main();
