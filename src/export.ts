import { mkdirSync, writeFileSync, readFileSync, cpSync, rmSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_ROOT, PUBLIC_DIR } from "./config.ts";
import { getDb, getActiveRoutes, buildRouteBlob } from "./db.ts";
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

function main(): void {
  getDb(); // varmista skeema
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

  let bytes = 0;
  const manifestRoutes: {
    id: number;
    from: string;
    to: string;
    fromName: string | null;
    toName: string | null;
    earliestDate: string | null;
  }[] = [];
  for (const r of routes) {
    const blob = buildRouteBlob(r);
    const json = JSON.stringify(blob);
    bytes += json.length;
    writeFileSync(join(DATA_DIR, `route-${r.id}.json`), json);

    // Varhaisin päivä, jolta on vielä varattava lähtö — loppuunmyydyt eivät kelpaa.
    const earliestDate =
      Object.keys(blob.departures)
        .sort()
        .find((d) => blob.departures[d].some((x) => x.available === 1)) ?? null;

    manifestRoutes.push({
      id: r.id,
      from: r.from_code,
      to: r.to_code,
      fromName: r.from_name,
      toName: r.to_name,
      earliestDate,
    });
  }

  const manifest = {
    generatedAt: new Date().toISOString(),
    routes: manifestRoutes,
  };
  writeFileSync(join(DATA_DIR, "manifest.json"), JSON.stringify(manifest));

  log.info(
    `Export valmis: ${routes.length} reittiä -> ${DATA_DIR} (~${(bytes / 1024 / 1024).toFixed(1)} MB dataa).`
  );
}

main();
