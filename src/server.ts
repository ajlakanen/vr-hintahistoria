import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { loadConfig, PUBLIC_DIR } from "./config.ts";
import { getDb, getActiveRoutes, expandHistorySegments, type HistorySegment } from "./db.ts";
import { log } from "./logger.ts";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function sendJson(res: import("node:http").ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(body);
}

// ---------- API-kyselyt ----------

function apiRoutes() {
  return getActiveRoutes().map((r) => ({
    id: r.id,
    from: r.from_code,
    to: r.to_code,
    fromName: r.from_name,
    toName: r.to_name,
  }));
}

/** Halvin nykyhinta per lähtöpäivä valitulla aikavälillä. */
function apiCalendar(routeId: number, start: string, end: string) {
  return getDb()
    .prepare(
      // Vain varattavissa olevat lähdöt (available=1) -> "halvin/keskihinta" pysyy totena
      // eikä näytä loppuunmyydyn lähdön vanhaa (ei enää ostettavissa olevaa) hintaa.
      `SELECT travel_date AS date,
              MIN(price)  AS minPrice,
              AVG(price)  AS avgPrice,
              MAX(price)  AS maxPrice,
              COUNT(*)    AS departures
       FROM prices
       WHERE route_id = ? AND travel_date BETWEEN ? AND ? AND available = 1
       GROUP BY travel_date
       ORDER BY travel_date`
    )
    .all(routeId, start, end);
}

/** Yhden lähtöpäivän kaikki lähdöt (tuorein hinta). */
function apiDepartures(routeId: number, travelDate: string) {
  return getDb()
    .prepare(
      `SELECT departure_time AS time, train_number AS train, price, currency,
              available, updated_at AS updatedAt
       FROM prices
       WHERE route_id = ? AND travel_date = ?
       ORDER BY departure_time`
    )
    .all(routeId, travelDate);
}

/** Booking-käyrä: miten yhden lähdön hinta on kehittynyt ajopäivittäin. Kanta tallentaa vain
 *  muutoskohdat (segmentit); laajennetaan takaisin päiväkohtaiseksi sarjaksi näyttöä varten. */
function apiHistory(routeId: number, travelDate: string, departureTime: string) {
  const segments = getDb()
    .prepare(
      `SELECT scrape_date AS scrapeDate, last_scrape_date AS lastScrapeDate, price, currency, available
       FROM price_history
       WHERE route_id = ? AND travel_date = ? AND departure_time = ?
       ORDER BY scrape_date`
    )
    .all(routeId, travelDate, departureTime) as unknown as HistorySegment[];
  return expandHistorySegments(segments);
}

// ---------- staattiset tiedostot ----------

async function serveStatic(
  res: import("node:http").ServerResponse,
  urlPath: string
): Promise<void> {
  const rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
  const full = normalize(join(PUBLIC_DIR, rel));
  if (!full.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end("Forbidden");
    return;
  }
  try {
    const data = await readFile(full);
    res.writeHead(200, { "Content-Type": MIME[extname(full)] ?? "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404).end("Not found");
  }
}

// ---------- palvelin ----------

const cfg = loadConfig();
getDb(); // varmista skeema

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    const q = url.searchParams;

    if (url.pathname === "/api/routes") {
      return sendJson(res, 200, apiRoutes());
    }
    if (url.pathname === "/api/calendar") {
      const routeId = Number(q.get("route_id"));
      const start = q.get("start") ?? "";
      const end = q.get("end") ?? "";
      if (!routeId || !start || !end) return sendJson(res, 400, { error: "route_id, start, end vaaditaan" });
      return sendJson(res, 200, apiCalendar(routeId, start, end));
    }
    if (url.pathname === "/api/departures") {
      const routeId = Number(q.get("route_id"));
      const date = q.get("travel_date") ?? "";
      if (!routeId || !date) return sendJson(res, 400, { error: "route_id, travel_date vaaditaan" });
      return sendJson(res, 200, apiDepartures(routeId, date));
    }
    if (url.pathname === "/api/history") {
      const routeId = Number(q.get("route_id"));
      const date = q.get("travel_date") ?? "";
      const time = q.get("departure_time") ?? "";
      if (!routeId || !date || !time)
        return sendJson(res, 400, { error: "route_id, travel_date, departure_time vaaditaan" });
      return sendJson(res, 200, apiHistory(routeId, date, time));
    }

    if (url.pathname.startsWith("/api/")) return sendJson(res, 404, { error: "tuntematon rajapinta" });
    return await serveStatic(res, url.pathname);
  } catch (e) {
    log.error(e);
    sendJson(res, 500, { error: (e as Error).message });
  }
});

// Portti ja osoite voidaan ylikirjoittaa ympäristömuuttujilla (kontti/palvelin).
const port = Number(process.env.PORT) || cfg.server.port;
const host = process.env.HOST || "0.0.0.0";
server.listen(port, host, () => {
  log.info(`Käyttöliittymä käynnissä: http://${host}:${port}`);
});
