import { loadConfig } from "./config.ts";
import { getActiveRoutes, recordPrice } from "./db.ts";
import { VrScraper } from "./scraper.ts";
import { RateLimiter, sleep } from "./rateLimiter.ts";
import { log } from "./logger.ts";

/** Palauttaa päivämäärän YYYY-MM-DD Suomen aikavyöhykkeellä, offset päivää eteenpäin. */
function dateStr(offsetDays: number): string {
  const now = new Date();
  const helsinki = new Date(now.toLocaleString("en-US", { timeZone: "Europe/Helsinki" }));
  helsinki.setDate(helsinki.getDate() + offsetDays);
  const y = helsinki.getFullYear();
  const m = String(helsinki.getMonth() + 1).padStart(2, "0");
  const d = String(helsinki.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const routes = getActiveRoutes();
  if (routes.length === 0) {
    log.error("Ei reittejä. Aja ensin: npm run seed");
    process.exit(1);
  }

  const scrapeDate = dateStr(0);
  const dates = Array.from({ length: cfg.daysAhead }, (_, i) => dateStr(i));
  const total = routes.length * dates.length;
  log.info(
    `Aloitetaan keräys: ${routes.length} reittiä × ${dates.length} päivää = ${total} hakua. Ajopäivä ${scrapeDate}.`
  );

  const limiter = new RateLimiter(cfg.rateLimit);
  const scraper = new VrScraper(cfg.browser.headless);
  await scraper.init();

  let done = 0;
  let rowsWritten = 0;
  let failures = 0;

  try {
    for (const route of routes) {
      for (const date of dates) {
        done++;
        const tag = `${route.from_code}->${route.to_code} ${date} (${done}/${total})`;
        let ok = false;
        for (let attempt = 1; attempt <= cfg.rateLimit.maxRetries && !ok; attempt++) {
          try {
            const journeys = await scraper.fetchJourneys(
              route.from_code,
              route.to_code,
              date,
              cfg.passengers
            );
            for (const j of journeys) {
              if (recordPrice(route.id, j, scrapeDate)) rowsWritten++;
            }
            log.info(`${tag}: ${journeys.length} lähtöä tallennettu.`);
            ok = true;
          } catch (e) {
            log.warn(`${tag}: yritys ${attempt} epäonnistui: ${(e as Error).message}`);
            if (attempt < cfg.rateLimit.maxRetries) {
              await sleep(cfg.rateLimit.retryBackoffMs * attempt);
            }
          }
        }
        if (!ok) failures++;
        await limiter.wait();
      }
    }
  } finally {
    await scraper.close();
  }

  log.info(
    `Valmis. Historiarivejä lisätty: ${rowsWritten}. Epäonnistuneita hakuja: ${failures}/${total}.`
  );
}

main().catch((e) => {
  log.error(e);
  process.exit(1);
});
