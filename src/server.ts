import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { loadConfig, PUBLIC_DIR } from "./config.ts";
import { getDb, getActiveRoutes, buildRouteBlob } from "./db.ts";
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
  const earliestStmt = getDb().prepare(
    `SELECT MIN(travel_date) AS earliestDate
     FROM prices
     WHERE route_id = ? AND available = 1`
  );
  return getActiveRoutes().map((r) => ({
    id: r.id,
    from: r.from_code,
    to: r.to_code,
    fromName: r.from_name,
    toName: r.to_name,
    earliestDate: (earliestStmt.get(r.id) as { earliestDate: string | null } | undefined)?.earliestDate ?? null,
  }));
}

/**
 * Yhden reitin koko datablobi. Sama muoto kuin staattisen exportin
 * `data/route-<id>.json`, jotta selain käyttää identtistä koodia kummassakin
 * moodissa. Kalenteri lasketaan selaimessa näistä lähdöistä, jolloin
 * lähtöajan rajaus vaikuttaa myös päiväkohtaiseen halvimpaan hintaan.
 */
function apiRoute(routeId: number) {
  const route = getActiveRoutes().find((r) => r.id === routeId);
  return route ? buildRouteBlob(route) : null;
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

    // Palvelin tarjoilee täsmälleen samat polut kuin staattinen Pages-julkaisu, vain
    // laskettuna lennossa. Näin selaimessa ei ole moodin tunnistusta eikä kahta koodipolkua.
    if (url.pathname === "/data/manifest.json") {
      return sendJson(res, 200, { generatedAt: new Date().toISOString(), routes: apiRoutes() });
    }
    const routeFile = url.pathname.match(/^\/data\/route-(\d+)\.json$/);
    if (routeFile) {
      const blob = apiRoute(Number(routeFile[1]));
      if (!blob) return sendJson(res, 404, { error: "tuntematon reitti" });
      return sendJson(res, 200, blob);
    }

    if (url.pathname.startsWith("/data/")) return sendJson(res, 404, { error: "tuntematon tiedosto" });
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
