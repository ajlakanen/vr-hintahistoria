import { getDb, getActiveRoutes } from "./db.ts";
import { log } from "./logger.ts";

/**
 * Pikaraportti komentoriviltä:  npm run report -- HKI TPE
 * Näyttää tuoreimmat hinnat per lähtöpäivä valitulle reitille.
 */
function main(): void {
  const [from, to] = process.argv.slice(2);
  if (!from || !to) {
    log.info("Käyttö: npm run report -- <FROM> <TO>   (esim. npm run report -- HKI TPE)");
    log.info("Aktiiviset reitit:");
    for (const r of getActiveRoutes()) {
      log.info(`  ${r.from_code} -> ${r.to_code}  (${r.from_name ?? "?"} -> ${r.to_name ?? "?"})`);
    }
    return;
  }

  const db = getDb();
  const rows = db
    .prepare(
      `SELECT p.travel_date, p.departure_time, p.train_number, p.price, p.currency, p.updated_at
       FROM prices p
       JOIN routes r ON r.id = p.route_id
       WHERE r.from_code = ? AND r.to_code = ?
       ORDER BY p.travel_date, p.departure_time`
    )
    .all(from.toUpperCase(), to.toUpperCase()) as Array<{
    travel_date: string;
    departure_time: string;
    train_number: string | null;
    price: number;
    currency: string;
  }>;

  if (rows.length === 0) {
    log.info(`Ei dataa reitille ${from} -> ${to}. Onko keräys ajettu?`);
    return;
  }

  log.info(`Tuoreimmat hinnat ${from} -> ${to}:`);
  for (const r of rows) {
    log.info(
      `  ${r.travel_date} ${r.departure_time}  ${r.price.toFixed(2)} ${r.currency}` +
        (r.train_number ? `  (juna ${r.train_number})` : "")
    );
  }
}

main();
