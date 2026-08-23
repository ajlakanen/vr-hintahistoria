/* ============================================================================
   VR-hintakalenteri.

   Data luetaan aina samoista poluista:
     data/manifest.json     — seuratut suunnat
     data/route-<id>.json   — yhden reitin lähdöt ja hintahistoria (RouteBlob, src/db.ts)

   GitHub Pagesissa ne ovat esirenderöityjä tiedostoja (npm run export), omalla
   palvelimella (npm run serve) sama sisältö lasketaan lennossa kannasta. Selaimessa
   ei siis ole moodin tunnistusta eikä kahta koodipolkua.

   Kalenteria ei esisummata kannassa: päivän halvin hinta lasketaan tässä
   lähtöriveistä, jotta lähtöajan rajaus vaikuttaa myös kalenteriin.
   ============================================================================ */

/* ---------- apurit ---------- */

const $ = (id) => document.getElementById(id);
const nf2 = new Intl.NumberFormat("fi-FI", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const nf1 = new Intl.NumberFormat("fi-FI", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const nf0 = new Intl.NumberFormat("fi-FI", { maximumFractionDigits: 0 });
const eur = (v) => nf2.format(v) + " €";

const MONTHS = ["tammikuu","helmikuu","maaliskuu","huhtikuu","toukokuu","kesäkuu",
  "heinäkuu","elokuu","syyskuu","lokakuu","marraskuu","joulukuu"];
const DOW = ["su", "ma", "ti", "ke", "to", "pe", "la"];

const parseISO = (s) => new Date(s + "T00:00:00");
const monthKey = (s) => s.slice(0, 7);
/** Paikallinen päivä ISO-muodossa — toISOString() antaisi UTC:n ja voisi heittää vuorokaudella. */
const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

function fmtDay(s) {
  const d = parseISO(s);
  return `${DOW[d.getDay()]} ${d.getDate()}.${d.getMonth() + 1}.${d.getFullYear()}`;
}
function fmtShort(s) {
  const d = parseISO(s);
  return `${d.getDate()}.${d.getMonth() + 1}.`;
}
function isWeekend(s) {
  const g = parseISO(s).getDay();
  return g === 0 || g === 6;
}
function cssVar(n) {
  return getComputedStyle(document.documentElement).getPropertyValue(n).trim();
}
function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}

/* ---------- tallennettu tila ----------
   localStorage on origin-kohtainen, ei polkukohtainen, joten saman github.io-originin
   eri projektisivut jakaisivat avaimet. Etuliite sisältää polun -> arvot eristyvät tähän
   sovellukseen. HUOM: index.html:n FOUC-skripti rakentaa saman avaimen käsin. */

const STORE_PREFIX = `vrhh:${location.pathname}:`;
const storeGet = (k) => {
  try {
    return localStorage.getItem(STORE_PREFIX + k);
  } catch {
    return null; // esim. privaattitila
  }
};
const storeSet = (k, v) => {
  try {
    localStorage.setItem(STORE_PREFIX + k, v);
  } catch {
    /* ei tallenneta */
  }
};

/* ---------- tila ---------- */

const state = { routeId: null, month: null, date: null, dep: null, h0: 0, h1: 24, sort: "price" };

/* ---------- datalähde ---------- */

let generatedAt = null;
let ROUTES = [];
let blob = null; // valitun reitin normalisoitu data
const STATIONS = new Map();
const routeByPair = new Map();
const blobCache = new Map();

const stationName = (c) => STATIONS.get(c) || c;

async function json(url) {
  const res = await fetch(url, { cache: "no-cache" });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json();
}

async function loadRouteList() {
  const m = await json("data/manifest.json");
  generatedAt = m.generatedAt ?? null;
  return m.routes;
}

function ingestRoutes(list) {
  ROUTES = [];
  STATIONS.clear();
  routeByPair.clear();
  for (const r of list) {
    const short = { id: r.id, f: r.from, t: r.to };
    ROUTES.push(short);
    routeByPair.set(r.from + ">" + r.to, short);
    STATIONS.set(r.from, r.fromName || r.from);
    STATIONS.set(r.to, r.toName || r.to);
  }
}

/**
 * Lähtörivit taulukkomuotoon [aika, juna, junatyyppi, hinta, varattavissa, päivitetty].
 * Kalenteri käy nämä läpi jokaisella suodatinmuutoksella, joten kompakti muoto on
 * mielekäs — ja se pitää piirtokoodin riippumattomana rajapinnan kenttänimistä.
 */
function normalizeBlob(b) {
  const dep = {};
  for (const date in b.departures) {
    dep[date] = b.departures[date].map((d) => [
      d.time,
      d.train ?? "",
      d.trainType ?? "",
      d.price,
      d.available,
      d.updatedAt,
    ]);
  }
  return { route: b.route, dep, history: b.history || {} };
}

async function loadRoute(id) {
  if (!blobCache.has(id)) {
    const raw = await json(`data/route-${id}.json`);
    blobCache.set(id, normalizeBlob(raw));
  }
  return blobCache.get(id);
}

/* ---------- reittivalitsimet ---------- */

function origins() {
  return [...new Set(ROUTES.map((r) => r.f))].sort((a, b) =>
    stationName(a).localeCompare(stationName(b), "fi")
  );
}
function destinations(from) {
  return ROUTES.filter((r) => r.f === from).map((r) => r.t)
    .sort((a, b) => stationName(a).localeCompare(stationName(b), "fi"));
}
function fillSelect(el, codes, selected) {
  el.innerHTML = codes
    .map((c) => `<option value="${c}"${c === selected ? " selected" : ""}>${esc(stationName(c))} (${c})</option>`)
    .join("");
}

let routeSeq = 0;

async function setRoute(from, to) {
  const r = routeByPair.get(from + ">" + to) || routeByPair.get(from + ">" + destinations(from)[0]);
  state.routeId = r.id;
  fillSelect($("from"), origins(), r.f);
  fillSelect($("to"), destinations(r.f), r.t);
  $("swap").disabled = !routeByPair.has(r.t + ">" + r.f);
  $("cFrom").textContent = r.f;
  $("cTo").textContent = r.t;
  $("cNames").textContent = `${stationName(r.f)} – ${stationName(r.t)}`;
  storeSet("route", String(r.id));
  state.month = null;

  const seq = ++routeSeq;
  document.body.classList.add("busy");
  let loaded;
  try {
    loaded = await loadRoute(r.id);
  } catch (e) {
    if (seq === routeSeq) showError(`Reitin ${r.f}–${r.t} tietoja ei saatu ladattua.`, e);
    return;
  } finally {
    if (seq === routeSeq) document.body.classList.remove("busy");
  }
  if (seq !== routeSeq) return; // käyttäjä ehti vaihtaa reittiä uudestaan
  blob = loaded;
  render();
}

function showError(msg, err) {
  if (err) console.error(err);
  $("tiles").innerHTML = "";
  $("statnote").textContent = "";
  $("fcount").textContent = "";
  $("cal").innerHTML = `<p class="empty-note" style="grid-column:1/-1">${esc(msg)} Kokeile päivittää sivu.</p>`;
  $("depBody").innerHTML = "";
  $("dayDate").textContent = "—";
  $("daySub").textContent = "";
  renderHistory(null);
}

/* ---------- aikaikkuna ---------- */

const inWindow = (t) => {
  const h = +t.slice(0, 2);
  return h >= state.h0 && h < state.h1;
};

function countDepartures() {
  const byDate = blob.dep;
  const today = todayIso();
  let total = 0;
  let shown = 0;
  for (const date in byDate) {
    if (date < today) continue;
    for (const d of byDate[date]) {
      total++;
      if (inWindow(d[0])) shown++;
    }
  }
  return { total, shown };
}

/* ---------- hintaskaala ---------- */

/**
 * Kalenteririvit lasketaan lähdöistä eikä valmiiksi summatusta taulusta,
 * jotta aikaikkunan rajaus näkyy myös kalenterissa. Mukaan vain varattavissa
 * olevat lähdöt, jotta loppuunmyydyn vanha hinta ei painu "halvimmaksi", ja
 * vain tästä päivästä eteenpäin — menneen päivän hintaa ei voi enää ostaa.
 * Päivämäärä on avaimessa mukana, jotta välimuisti vanhenee keskiyöllä.
 */
let calCache = { key: null, rows: [] };

function calendarRows() {
  const today = todayIso();
  const key = `${state.routeId}|${state.h0}|${state.h1}|${today}`;
  if (calCache.key === key) return calCache.rows;
  const byDate = blob.dep;
  const rows = [];
  for (const date of Object.keys(byDate).sort()) {
    if (date < today) continue;
    let mn = Infinity;
    let mx = -Infinity;
    let sum = 0;
    let n = 0;
    for (const d of byDate[date]) {
      if (d[4] !== 1 || !inWindow(d[0])) continue;
      if (d[3] < mn) mn = d[3];
      if (d[3] > mx) mx = d[3];
      sum += d[3];
      n++;
    }
    if (n) rows.push([date, mn, sum / n, mx, n]);
  }
  calCache = { key, rows };
  return rows;
}
function quantiles(values) {
  const s = [...values].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return [q(0.2), q(0.4), q(0.6), q(0.8)];
}
function binOf(price, thresholds) {
  let i = 0;
  while (i < thresholds.length && price > thresholds[i]) i++;
  return i + 1; // 1..5
}

/* ---------- tunnusluvut ---------- */

function renderTiles() {
  const rows = calendarRows();
  const mins = rows.map((r) => r[1]);
  const mean = mins.reduce((a, b) => a + b, 0) / mins.length;
  const cheapest = rows.reduce((a, b) => (b[1] < a[1] ? b : a));
  const priciest = rows.reduce((a, b) => (b[1] > a[1] ? b : a));

  const goTile = (cls, label, row) => `
    <button type="button" class="tile ${cls} tile--go" data-goto="${row[0]}"
      aria-label="Siirry päivään ${fmtDay(row[0])}, halvin lähtö ${eur(row[1])}">
      <span class="k">${label}<span class="go" aria-hidden="true">→</span></span>
      <span class="v">${eur(row[1])}</span>
      <span class="s">${fmtDay(row[0])}</span>
    </button>`;

  $("tiles").innerHTML =
    goTile("tile--best", "Halvin päivä", cheapest) +
    `<div class="tile">
      <span class="k">Hinta keskimäärin</span>
      <span class="v">${eur(mean)}</span>
      <span class="s">${rows.length} lähtöpäivää</span>
    </div>` +
    goTile("", "Kallein päivä", priciest);

  // Ilman tätä lausetta "kallein päivä" jää tulkinnanvaraiseksi: onko kyse
  // päivän kalleimmasta lähdöstä vai kalleimmasta päivästä.
  $("statnote").textContent =
    `Jokainen luku kuvaa päivän halvinta lähtöä. Kalleimpanakin päivänä ` +
    `(${fmtDay(priciest[0])}) halvin lippu maksaa ${eur(priciest[1])}.`;
}

/* ---------- kalenteri ---------- */

function monthsWithData() {
  return [...new Set(calendarRows().map((r) => monthKey(r[0])))].sort();
}

/** Kuluva kuukausi jos siltä on vielä lähtöjä, muuten aikaisin kuukausi jolta on. */
function defaultMonth() {
  const months = monthsWithData();
  const now = monthKey(todayIso());
  return months.includes(now) ? now : months[0];
}

function renderCalendar() {
  const rows = calendarRows();
  const byDate = new Map(rows.map((r) => [r[0], r]));
  const th = quantiles(rows.map((r) => r[1]));
  const maxMin = Math.max(...rows.map((r) => r[1]));
  const minMin = Math.min(...rows.map((r) => r[1]));

  // Skaalan selite
  $("ramp").innerHTML = [1, 2, 3, 4, 5].map((i) => `<i style="background:var(--cell-${i})"></i>`).join("");
  $("rampLo").textContent = `${nf0.format(minMin)} €`;
  $("rampHi").textContent = `${nf0.format(maxMin)} €`;

  const [y, m] = state.month.split("-").map(Number);
  $("monthLabel").textContent = `${MONTHS[m - 1]} ${y}`;
  const months = monthsWithData();
  $("prev").disabled = months.indexOf(state.month) <= 0;
  $("next").disabled = months.indexOf(state.month) >= months.length - 1;

  const first = new Date(y, m - 1, 1);
  const lead = (first.getDay() + 6) % 7; // maanantai ensin
  const days = new Date(y, m, 0).getDate();

  const cells = [];
  for (let i = 0; i < lead; i++) cells.push('<div class="cell blank"></div>');

  const today = todayIso();
  for (let d = 1; d <= days; d++) {
    const key = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    const row = byDate.get(key);
    const we = isWeekend(key) ? " we" : "";
    // Mennyt päivä ja "seurataan mutta ei hintaa" ovat eri asioita, joten ne
    // näyttävät eriltä: mennyt on pelkkä himmeä numero, katkoviiva tarkoittaa
    // ettei kyseiseltä päivältä ole (vielä) kerättyä hintaa.
    if (key < today) {
      cells.push(`<div class="cell past"><span class="d">${d}</span></div>`);
      continue;
    }
    if (!row) {
      cells.push(`<div class="cell empty${we}"><span class="d">${d}</span></div>`);
      continue;
    }
    const bin = binOf(row[1], th);
    // Palkki mittaa edullisuutta, ei hintaa: täysi leveys halvimpana päivänä,
    // kutistuu olemattomiin kalleimpana. Näin pisin palkki on se, jonka haluat löytää.
    const width = Math.max(5, Math.round((1 - (row[1] - minMin) / (maxMin - minMin || 1)) * 95 + 5));
    const sel = key === state.date ? " sel" : "";
    cells.push(`
      <button type="button" class="cell${we}${sel}" data-date="${key}"
        data-min="${row[1]}" data-avg="${row[2]}" data-n="${row[4]}"
        style="background:var(--cell-${bin})"
        aria-label="${fmtDay(key)}, halvin ${eur(row[1])}, ${row[4]} lähtöä">
        <span class="d">${d}</span>
        <span class="p">${nf2.format(row[1])}</span>
        <span class="bar" style="width:${width}%;background:var(--bar-${bin})"></span>
      </button>`);
  }
  $("cal").innerHTML = cells.join("");
}

/* ---------- päivän lähdöt ---------- */

function depsFor(date) {
  return (blob.dep[date] || []).filter((d) => inWindow(d[0]));
}

function trainLabel(number, type) {
  const t = (type || "").replaceAll("->", " → ");
  const n = (number || "").replaceAll("->", " → ");
  return t && n ? `${t} ${n}` : t || n || "—";
}

function buyUrl(from, to, date) {
  const p = new URLSearchParams({ from, to, outboundDate: date });
  p.append("passengers[0][type]", "ADULT");
  return `https://www.vr.fi/kertalippu-menomatkan-hakutulokset?${p.toString()}`;
}

function renderDay() {
  const r = ROUTES.find((x) => x.id === state.routeId);
  const deps = depsFor(state.date);

  if (!state.date || !deps.length) {
    $("dayDate").textContent = "Valitse päivä";
    $("daySub").textContent = "Napauta kalenterista päivää nähdäksesi sen lähdöt.";
    $("depBody").innerHTML = '<p class="empty-note">Ei lähtötietoja valitulle päivälle.</p>';
    renderHistory(null);
    return;
  }

  const bookable = deps.filter((d) => d[4] === 1);
  const lo = bookable.length ? Math.min(...bookable.map((d) => d[3])) : null;
  const hi = bookable.length ? Math.max(...bookable.map((d) => d[3])) : null;

  $("dayDate").textContent = fmtDay(state.date);
  $("daySub").textContent = bookable.length ? `${eur(lo)} – ${eur(hi)}` : "Ei varattavia lähtöjä";

  // Loppuunmyydyt aina viimeisiksi, muuten valitun järjestyksen mukaan.
  const ordered =
    state.sort === "price"
      ? [...deps].sort((a, b) => b[4] - a[4] || a[3] - b[3] || a[0].localeCompare(b[0]))
      : deps;

  const rowsHtml = ordered
    .map((d) => {
      const [time, num, type, price, avail] = d;
      const gone = avail !== 1;
      const isBest = !gone && price === lo;
      const key = time + "|" + num;
      const sel = key === state.dep ? " sel" : "";
      const delta = !gone && lo !== null && price > lo ? `+${nf2.format(price - lo)}` : "";
      return `<tr class="row${gone ? " gone" : ""}${sel}" data-dep="${esc(key)}">
          <td class="time">${esc(time)}</td>
          <td class="train">${esc(trainLabel(num, type))}</td>
          <td class="price r">${nf2.format(price)}${isBest ? ' <span class="pill pill--best">halvin</span>' : ""}${
            gone ? ' <span class="pill pill--gone">loppu</span>' : ""
          }</td>
          <td class="delta r">${delta}</td>
        </tr>`;
    })
    .join("");

  $("depBody").innerHTML = `
    <div class="deplist-wrap">
    <div class="deplist">
      <table class="dep">
        <thead>
          <tr><th>Lähtö</th><th>Juna</th><th class="r">Hinta €</th><th class="r">vs. halvin</th></tr>
        </thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    </div>
    </div>
    <p style="margin:var(--s3) 0 0">
      <a class="buy" href="${buyUrl(r.f, r.t, state.date)}" target="_blank" rel="noopener">
        Avaa päivän lähdöt VR.fi:ssä →
      </a>
    </p>`;

  const list = $("depBody").querySelector(".deplist");
  const markOverflow = () =>
    list.parentElement.classList.toggle(
      "more",
      list.scrollHeight - list.scrollTop - list.clientHeight > 8
    );
  markOverflow();
  list.addEventListener("scroll", markOverflow, { passive: true });

  if (!deps.some((d) => d[0] + "|" + d[1] === state.dep)) {
    const pick = bookable.find((d) => d[3] === lo) || deps[0];
    state.dep = pick[0] + "|" + pick[1];
    for (const tr of $("depBody").querySelectorAll("[data-dep]")) {
      if (tr.dataset.dep !== state.dep) continue;
      tr.classList.add("sel");
      // Aikajärjestyksessä halvin voi olla kaukana listan alempana.
      list.scrollTop = Math.max(0, tr.offsetTop - list.clientHeight / 2);
      markOverflow();
    }
  }
  renderHistory(deps.find((d) => d[0] + "|" + d[1] === state.dep));
}

/* ---------- hintakehitys (booking-käyrä) ---------- */

/**
 * Yhden lähdön hinta keräyspäivittäin. Kanta tallentaa vain muutoskohdat; palvelin
 * ja export laajentavat ne päiväkohtaisiksi pisteiksi, joten tässä riitää haku
 * avaimella. Historiaa kertyy keräys kerrallaan: uudella lähdöllä pisteitä on yksi.
 */
function historyFor(dep) {
  if (!dep) return [];
  const key = `${state.date}|${dep[0]}|${dep[1]}`;
  return (blob.history[key] || []).map((p) => ({ d: p.scrapeDate, p: p.price }));
}

let histPoints = [];

function renderHistory(dep) {
  const host = $("hist");
  const meta = $("histMeta");
  if (!dep) {
    histPoints = [];
    $("histSub").textContent = "";
    meta.textContent = "";
    host.innerHTML = '<p class="empty-note">Valitse lähtö listalta.</p>';
    $("histTable").innerHTML = "";
    return;
  }

  histPoints = historyFor(dep);
  const label = `Lähtö <b class="mono">${esc(dep[0])}</b> · ${esc(trainLabel(dep[1], dep[2]))}`;
  meta.textContent = histPoints.length
    ? `${histPoints.length} keräyspäivä${histPoints.length === 1 ? "" : "ä"}`
    : "";

  if (histPoints.length < 2) {
    // Yksi havainto ei ole käyrä. Kerrotaan se suoraan sen sijaan että piirrettäisiin
    // viiva, joka näyttäisi tasaiselta hinnalta.
    $("histSub").innerHTML = label;
    host.innerHTML = histPoints.length
      ? `<p class="empty-note">Ensimmäinen havainto ${fmtShort(histPoints[0].d)} —
         <b class="mono">${eur(histPoints[0].p)}</b>. Käyrä piirtyy, kun hintaa on kerätty
         useampana päivänä.</p>`
      : '<p class="empty-note">Tälle lähdölle ei ole vielä kertynyt hintahistoriaa.</p>';
    $("histTable").innerHTML = "";
    return;
  }

  const first = histPoints[0].p;
  const change = histPoints[histPoints.length - 1].p - first;
  const pct = first ? Math.abs((change / first) * 100) : 0;
  $("histSub").innerHTML =
    change === 0
      ? `${label} — hinta on pysynyt samana seuranta-aikana.`
      : `${label} — ${change > 0 ? "noussut" : "laskenut"} ` +
        `<b class="mono">${nf2.format(Math.abs(change))} €</b> (${nf0.format(pct)} %) seuranta-aikana.`;
  drawCurve(host, histPoints);
  renderHistTable(histPoints);
}

function renderHistTable(pts) {
  const step = Math.max(1, Math.ceil(pts.length / 12));
  const sample = pts.filter((_, i) => i % step === 0 || i === pts.length - 1);
  $("histTable").innerHTML = `
    <summary>Näytä lukuina (${pts.length} keräyspäivää${step > 1 ? `, joka ${step}. näytetty` : ""})</summary>
    <table><thead><tr><th>Keräyspäivä</th><th>Hinta €</th></tr></thead><tbody>
    ${sample.map((p) => `<tr><td>${fmtShort(p.d)}</td><td>${nf2.format(p.p)}</td></tr>`).join("")}
    </tbody></table>`;
}

function drawCurve(host, pts) {
  const w = Math.max(280, host.clientWidth || 380);
  const h = 190;
  const pad = { l: 42, r: 12, t: 12, b: 24 };
  const vals = pts.map((p) => p.p);
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const pad0 = (hi - lo) * 0.15 || 2;
  const y0 = Math.max(0, lo - pad0);
  const y1 = hi + pad0;
  const X = (i) => pad.l + (i / Math.max(1, pts.length - 1)) * (w - pad.l - pad.r);
  const Y = (v) => pad.t + (1 - (v - y0) / (y1 - y0 || 1)) * (h - pad.t - pad.b);

  const ticks = 4;
  const gridColor = cssVar("--grid");
  const muted = cssVar("--muted");
  const curve = cssVar("--curve");
  const surface = cssVar("--surface");

  // Kapealla hintahaitarilla kokonaisluvut toistuisivat (6, 6, 5, 5, 4).
  const tick = (y1 - y0) < 8 ? (v) => nf1.format(v) : (v) => nf0.format(v);

  let grid = "";
  for (let i = 0; i <= ticks; i++) {
    const v = y0 + ((y1 - y0) * i) / ticks;
    const yy = Y(v).toFixed(1);
    grid += `<line x1="${pad.l}" y1="${yy}" x2="${w - pad.r}" y2="${yy}" stroke="${gridColor}" stroke-width="1"></line>
      <text x="${pad.l - 7}" y="${yy}" text-anchor="end" dominant-baseline="middle"
        font-family="IBM Plex Mono, monospace" font-size="10" fill="${muted}">${tick(v)}</text>`;
  }

  const line = pts.map((p, i) => `${i ? "L" : "M"}${X(i).toFixed(1)} ${Y(p.p).toFixed(1)}`).join(" ");
  const area = `${line} L${X(pts.length - 1).toFixed(1)} ${h - pad.b} L${X(0).toFixed(1)} ${h - pad.b} Z`;

  const xLabels = [0, Math.floor(pts.length / 2), pts.length - 1]
    .map(
      (i) =>
        `<text x="${X(i).toFixed(1)}" y="${h - 6}" text-anchor="${i === 0 ? "start" : i === pts.length - 1 ? "end" : "middle"}"
           font-family="IBM Plex Mono, monospace" font-size="10" fill="${muted}">${fmtShort(pts[i].d)}</text>`
    )
    .join("");

  host.innerHTML = `
    <svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img"
         aria-label="Hinnan kehitys keräyspäivittäin, ${eur(lo)}–${eur(hi)}">
      ${grid}
      <path d="${area}" fill="${cssVar("--curve-fill")}"></path>
      <path d="${line}" fill="none" stroke="${curve}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"></path>
      <circle cx="${X(pts.length - 1).toFixed(1)}" cy="${Y(pts[pts.length - 1].p).toFixed(1)}" r="4.5"
        fill="${curve}" stroke="${surface}" stroke-width="2"></circle>
      <line class="cross" x1="0" y1="${pad.t}" x2="0" y2="${h - pad.b}" stroke="${muted}"
        stroke-width="1" stroke-dasharray="3 3" opacity="0"></line>
      <circle class="cursor" r="4" fill="${curve}" stroke="${surface}" stroke-width="2" opacity="0"></circle>
      <rect class="hit" x="${pad.l}" y="0" width="${w - pad.l - pad.r}" height="${h}" fill="transparent"></rect>
    </svg>
    <div class="tip" id="tip"></div>`;

  const svg = host.querySelector("svg");
  const cross = svg.querySelector(".cross");
  const cursor = svg.querySelector(".cursor");
  const tip = host.querySelector("#tip");

  const move = (ev) => {
    const box = svg.getBoundingClientRect();
    const px = ((ev.clientX - box.left) / box.width) * w;
    const i = Math.max(0, Math.min(pts.length - 1,
      Math.round(((px - pad.l) / (w - pad.l - pad.r)) * (pts.length - 1))));
    const cx = X(i);
    const cy = Y(pts[i].p);
    cross.setAttribute("x1", cx);
    cross.setAttribute("x2", cx);
    cross.setAttribute("opacity", "1");
    cursor.setAttribute("cx", cx);
    cursor.setAttribute("cy", cy);
    cursor.setAttribute("opacity", "1");
    tip.innerHTML = `${fmtShort(pts[i].d)} &nbsp;<b>${eur(pts[i].p)}</b>`;
    tip.classList.add("on");
    const scale = box.width / w;
    const tw = tip.offsetWidth;
    tip.style.left = Math.max(0, Math.min(box.width - tw, cx * scale - tw / 2)) + "px";
    tip.style.top = Math.max(0, cy * scale - 38) + "px";
  };
  const leave = () => {
    cross.setAttribute("opacity", "0");
    cursor.setAttribute("opacity", "0");
    tip.classList.remove("on");
  };
  svg.addEventListener("pointermove", move);
  svg.addEventListener("pointerleave", leave);
}

/* ---------- piirto ---------- */

function render() {
  syncFilterUi();
  const rows = calendarRows();

  if (!rows.length) {
    renderNoMatches();
    return;
  }

  if (!state.month || !rows.some((r) => monthKey(r[0]) === state.month)) state.month = defaultMonth();

  const monthRows = rows.filter((r) => monthKey(r[0]) === state.month);
  if (!state.date || !monthRows.some((r) => r[0] === state.date)) {
    state.date = monthRows.reduce((a, b) => (b[1] < a[1] ? b : a))[0];
    state.dep = null;
  }

  renderTiles();
  renderCalendar();
  renderDay();
  renderFooter();
}

/** Tuorein hintapäivitys tällä reitillä — kertoo datan iän myös palvelinmoodissa. */
function latestUpdate() {
  if (!blob) return null;
  let max = null;
  for (const date in blob.dep) {
    for (const d of blob.dep[date]) if (!max || d[5] > max) max = d[5];
  }
  return max;
}

function renderFooter() {
  const el = $("footerStats");
  if (!el) return;
  const parts = [`${ROUTES.length} seurattua suuntaa`];
  // Lähtöjen updated_at kertoo milloin hinnat oikeasti haettiin. Staattisen julkaisun
  // generatedAt on vain exportin ajohetki, joten se kelpaa vain varalle.
  const stamp = latestUpdate() || generatedAt;
  if (stamp) {
    const t = new Date(stamp);
    if (!isNaN(t)) {
      parts.push(
        `hinnat haettu ${t.toLocaleString("fi-FI", {
          day: "numeric",
          month: "numeric",
          year: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        })}`
      );
    }
  }
  el.textContent = parts.join(" · ") + ".";
}

function renderNoMatches() {
  state.date = null;
  state.dep = null;

  // Kaksi eri syytä näyttää samalta, jos ei erotella: liian kapea aikaikkuna vai
  // se ettei reitiltä ole lainkaan tulevia lähtöjä (keräys vanhentunut).
  const hasFuture = Object.keys(blob.dep).some((d) => d >= todayIso());
  const tile = hasFuture
    ? "Valitussa aikaikkunassa ei ole yhtään varattavaa lähtöä tällä reitillä."
    : "Tältä reitiltä ei ole hintoja tulevilta päiviltä.";
  const note = hasFuture
    ? "Laajenna aikaikkunaa nähdäksesi hintoja."
    : "Kaikki kerätyt lähtöpäivät ovat jo menneet — aja keräys uudelleen.";

  $("tiles").innerHTML = `<div class="tile"><span class="k">Ei lähtöjä</span><span class="s">${esc(tile)}</span></div>`;
  $("statnote").textContent = "";
  $("ramp").innerHTML = "";
  $("rampLo").textContent = "";
  $("rampHi").textContent = "";
  $("monthLabel").textContent = "—";
  $("prev").disabled = true;
  $("next").disabled = true;
  $("cal").innerHTML = `<p class="empty-note" style="grid-column:1/-1">${esc(note)}</p>`;
  renderDay();
  renderFooter();
}

/* ---------- aikaikkunan suodatin ---------- */

function fillHours() {
  const opt = (h) => `<option value="${h}">${String(h).padStart(2, "0")}:00</option>`;
  $("h0").innerHTML = Array.from({ length: 24 }, (_, h) => opt(h)).join("");
  $("h1").innerHTML = Array.from({ length: 24 }, (_, i) => opt(i + 1)).join("");
}

function syncFilterUi() {
  $("h0").value = String(state.h0);
  $("h1").value = String(state.h1);
  const all = state.h0 === 0 && state.h1 === 24;
  for (const b of $("presets").querySelectorAll("[data-h]")) {
    b.classList.toggle("on", b.dataset.h === `${state.h0}-${state.h1}`);
  }
  for (const b of $("sortmode").querySelectorAll("[data-sort]")) {
    b.classList.toggle("on", b.dataset.sort === state.sort);
  }
  const { total, shown } = countDepartures();
  $("fcount").textContent = all
    ? `${nf0.format(total)} seurattua lähtöä`
    : `${nf0.format(shown)} / ${nf0.format(total)} lähtöä aikaikkunassa`;
}

function setWindow(h0, h1) {
  state.h0 = Math.max(0, Math.min(23, h0));
  state.h1 = Math.max(state.h0 + 1, Math.min(24, h1));
  storeSet("hours", `${state.h0}-${state.h1}`);
  state.date = null;
  state.dep = null;
  render();
}

$("h0").addEventListener("change", () => setWindow(+$("h0").value, state.h1));
$("h1").addEventListener("change", () => setWindow(state.h0, +$("h1").value));
$("presets").addEventListener("click", (e) => {
  const b = e.target.closest("[data-h]");
  if (!b) return;
  const [a, z] = b.dataset.h.split("-").map(Number);
  setWindow(a, z);
});
$("sortmode").addEventListener("click", (e) => {
  const b = e.target.closest("[data-sort]");
  if (!b) return;
  state.sort = b.dataset.sort;
  storeSet("sort", state.sort);
  syncFilterUi();
  renderDay();
});

/* ---------- tapahtumat ---------- */

$("from").addEventListener("change", (e) => {
  const from = e.target.value;
  const to = destinations(from).includes($("to").value) ? $("to").value : destinations(from)[0];
  state.date = null;
  setRoute(from, to);
});
$("to").addEventListener("change", () => {
  state.date = null;
  setRoute($("from").value, $("to").value);
});
$("swap").addEventListener("click", () => {
  state.date = null;
  setRoute($("to").value, $("from").value);
});

$("prev").addEventListener("click", () => step(-1));
$("next").addEventListener("click", () => step(1));
function step(dir) {
  const months = monthsWithData();
  const i = months.indexOf(state.month) + dir;
  if (i < 0 || i >= months.length) return;
  state.month = months[i];
  state.date = null;
  render();
}

/** Oikotie tunnusluvusta: vaihda päivä ja valitse sen halvin lähtö. */
function gotoDate(date) {
  state.month = monthKey(date);
  state.date = date;
  state.dep = null; // renderDay valitsee päivän halvimman
  render();
  const panel = document.querySelector(".daypanel");
  const box = panel.getBoundingClientRect();
  if (box.top < 0 || box.top > window.innerHeight * 0.55) {
    panel.scrollIntoView({
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
      block: "start",
    });
  }
}

$("tiles").addEventListener("click", (e) => {
  const t = e.target.closest("[data-goto]");
  if (t) gotoDate(t.dataset.goto);
});

$("cal").addEventListener("click", (e) => {
  const cell = e.target.closest("[data-date]");
  if (!cell) return;
  state.date = cell.dataset.date;
  state.dep = null;
  renderCalendar();
  renderDay();
});

// Kalenterisolun vihje: näyttää keskihinnan ja lähtömäärän, joita solu ei ehdi kertoa.
const calTip = $("calTip");
$("cal").addEventListener("pointermove", (e) => {
  const cell = e.target.closest("[data-date]");
  if (!cell) {
    calTip.classList.remove("on");
    return;
  }
  calTip.innerHTML =
    `<b>${fmtDay(cell.dataset.date)}</b><br>halvin <b>${eur(+cell.dataset.min)}</b>` +
    ` · keski ${eur(+cell.dataset.avg)}<br>${cell.dataset.n} lähtöä`;
  calTip.classList.add("on");
  const wrap = calTip.parentElement.getBoundingClientRect();
  const box = cell.getBoundingClientRect();
  const tw = calTip.offsetWidth;
  const th = calTip.offsetHeight;
  const left = Math.max(0, Math.min(wrap.width - tw, box.left - wrap.left + box.width / 2 - tw / 2));
  let top = box.top - wrap.top - th - 6;
  if (top < 0) top = box.bottom - wrap.top + 6;
  calTip.style.left = left + "px";
  calTip.style.top = top + "px";
});
$("cal").addEventListener("pointerleave", () => calTip.classList.remove("on"));

$("depBody").addEventListener("click", (e) => {
  const row = e.target.closest("[data-dep]");
  if (!row) return;
  state.dep = row.dataset.dep;
  renderDay();
});

/* ---------- teema ---------- */

function currentDark() {
  const set = document.documentElement.getAttribute("data-theme");
  if (set) return set === "dark";
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}
const ICON_SUN =
  '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"' +
  ' stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4.2"></circle>' +
  '<path d="M12 2.6v2.2M12 19.2v2.2M4.3 4.3l1.6 1.6M18.1 18.1l1.6 1.6M2.6 12h2.2M19.2 12h2.2' +
  'M4.3 19.7l1.6-1.6M18.1 5.9l1.6-1.6"></path></svg>';
const ICON_MOON =
  '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"' +
  ' stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M20.2 14.4A8.3 8.3 0 0 1 9.6 3.8a8.5 8.5 0 1 0 10.6 10.6z"></path></svg>';

function paintThemeButton() {
  $("theme").innerHTML = currentDark() ? ICON_SUN : ICON_MOON;
  $("theme").setAttribute("aria-label", currentDark() ? "Vaihda vaaleaan teemaan" : "Vaihda tummaan teemaan");
}
$("theme").addEventListener("click", () => {
  document.documentElement.setAttribute("data-theme", currentDark() ? "light" : "dark");
  paintThemeButton();
  // Kaavio lukee värinsä tokeneista, joten se piirretään uudelleen.
  if (histPoints.length) drawCurve($("hist"), histPoints);
});
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  if (document.documentElement.getAttribute("data-theme")) return;
  paintThemeButton();
  if (histPoints.length) drawCurve($("hist"), histPoints);
});

/* ---------- koon muutos ---------- */

let rt;
window.addEventListener("resize", () => {
  clearTimeout(rt);
  rt = setTimeout(() => {
    if (histPoints.length) drawCurve($("hist"), histPoints);
  }, 140);
});

/* ---------- käynnistys ---------- */

/** Palauta edellisellä käynnillä valitut suodattimet. Reitti palautetaan erikseen. */
function restoreState() {
  const h = (storeGet("hours") || "").split("-").map(Number);
  if (h.length === 2 && h.every(Number.isInteger) && h[0] >= 0 && h[1] > h[0] && h[1] <= 24) {
    state.h0 = h[0];
    state.h1 = h[1];
  }
  const s = storeGet("sort");
  if (s === "price" || s === "time") state.sort = s;
}

async function start() {
  paintThemeButton();
  fillHours();
  restoreState();

  try {
    ingestRoutes(await loadRouteList());
  } catch (e) {
    showError("Reittilistaa ei saatu ladattua.", e);
    return;
  }
  if (!ROUTES.length) {
    showError("Yhtään reittiä ei ole seurannassa.");
    return;
  }

  const saved = ROUTES.find((r) => r.id === Number(storeGet("route")));
  const first = saved || routeByPair.get("HKI>TPE") || ROUTES[0];
  await setRoute(first.f, first.t);
}

start();
