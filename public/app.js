const $ = (id) => document.getElementById(id);
let calendarChart, historyChart;
let currentRouteId = null;
let selectedDate = null; // kalenterista valittu lähtöpäivä (pystyviivaa varten)
let lastHistoryRows = null; // viimeksi piirretyn hintakäyrän rivit (teeman väripäivitystä varten)
let themeTransitionTimer; // ajastin, joka poistaa .theme-transition-luokan häivytyksen jälkeen
const NARROW = 760; // leveysraja (sama kuin CSS-media query)
let narrowMode = window.innerWidth < NARROW;

// Staattinen moodi (GitHub Pages): jos data/manifest.json löytyy, data luetaan
// esirenderöidyistä JSON-tiedostoista API:n sijaan. Muuten käytetään /api/*-backendia.
let STATIC = false;
let manifest = null;
const routeCache = new Map(); // route_id -> esiladattu blob
const routesById = new Map(); // route_id -> { from, to, fromName, toName }

// Polkuun sidottu localStorage. localStorage on origin-kohtainen, ei polkukohtainen,
// joten saman github.io-originin eri projektisivut jakaisivat samat avaimet. Etuliite
// sisältää sivun polun, jolloin arvot eristyvät tähän sovellukseen. try/catch suojaa
// privaattitilalta yms. (sama tyyli kuin aiemmin teemalla). HUOM: index.html:n inline-
// FOUC-skripti rakentaa saman avaimen ("vrhh:" + pathname + ":theme") käsin -> jos
// muutat etuliitettä, päivitä myös se.
const STORE_PREFIX = `vrhh:${location.pathname}:`;
function storeGet(key) {
  try { return localStorage.getItem(STORE_PREFIX + key); } catch { return null; }
}
function storeSet(key, value) {
  try { localStorage.setItem(STORE_PREFIX + key, value); } catch { /* esim. privaattitila -> ei tallenneta */ }
}

async function detectMode() {
  try {
    const res = await fetch("data/manifest.json", { cache: "no-cache" });
    if (res.ok) {
      manifest = await res.json();
      STATIC = true;
    }
  } catch {
    /* ei manifestia -> API-moodi */
  }
}

/** Lataa (ja muistaa) yhden reitin koko datablobin staattisessa moodissa. */
async function routeData(id) {
  if (routeCache.has(id)) return routeCache.get(id);
  const blob = await json(`data/route-${id}.json`);
  routeCache.set(id, blob);
  return blob;
}

/** Y-akselin rajat VAIN näkyvissä olevista hinnoista, jotta ikkunan ulkopuoliset (piilossa
 *  olevat) hintapiikit eivät litistä näkyvää käyrää. Asteikko seuraa siis valittua aikaikkunaa. */
function computeYBounds(rows) {
  let lo = Infinity, hi = -Infinity;
  for (const d of rows) {
    if (d.minPrice < lo) lo = d.minPrice;
    if (d.avgPrice > hi) hi = d.avgPrice; // ylin piirretty arvo on keskihintakäyrä
  }
  if (!isFinite(lo) || !isFinite(hi)) return null;
  const pad = Math.max(1, (hi - lo) * 0.05);
  return { min: Math.max(0, Math.floor(lo - pad)), max: Math.ceil(hi + pad) };
}

// Päivämäärä ilman aikavyöhykesiirtymää (vältetään off-by-one viikonloppupäivissä).
function weekday(dateStr) {
  return new Date(dateStr + "T00:00:00").getDay(); // 0 = su, 6 = la
}
function isWeekend(dateStr) {
  const d = weekday(dateStr);
  return d === 0 || d === 6;
}
const WEEKDAY_FI = ["su", "ma", "ti", "ke", "to", "pe", "la"];
function weekdayName(dateStr) {
  return WEEKDAY_FI[weekday(dateStr)];
}

// Chart.js-plugin: varjostaa viikonloppupäivät (la–su) kevyellä taustapalkilla.
const weekendBands = {
  id: "weekendBands",
  beforeDraw(chart) {
    const x = chart.scales.x;
    const area = chart.chartArea;
    const labels = chart.data.labels || [];
    if (!x || !area || labels.length === 0) return;
    const step =
      labels.length > 1 ? x.getPixelForValue(1) - x.getPixelForValue(0) : 20;
    const ctx = chart.ctx;
    ctx.save();
    ctx.fillStyle = cssVar("--c-chart-band");
    for (let i = 0; i < labels.length; i++) {
      if (!isWeekend(labels[i])) continue;
      const c = x.getPixelForValue(i);
      const left = Math.max(area.left, c - step / 2);
      const right = Math.min(area.right, c + step / 2);
      ctx.fillRect(left, area.top, right - left, area.bottom - area.top);
    }
    ctx.restore();
  },
};

// Chart.js-plugin: pystyviiva valitun päivän kohdalle (vihreä) ja kursorin
// kohdalla olevan päivän kohdalle (himmeä) — helpottaa hahmottamaan valinnan.
const dayMarker = {
  id: "dayMarker",
  afterDraw(chart) {
    const x = chart.scales.x;
    const area = chart.chartArea;
    if (!x || !area) return;
    const ctx = chart.ctx;
    const line = (px, color, width, dash) => {
      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.setLineDash(dash);
      ctx.beginPath();
      ctx.moveTo(px, area.top);
      ctx.lineTo(px, area.bottom);
      ctx.stroke();
      ctx.restore();
    };
    // Kursorin kohdalla oleva päivä (himmeä katkoviiva).
    const active = chart.getActiveElements();
    if (active.length) line(active[0].element.x, cssVar("--c-chart-marker"), 1, [4, 3]);
    // Valittu päivä (kiinteä vihreä viiva).
    if (selectedDate != null) {
      const idx = (chart.data.labels || []).indexOf(selectedDate);
      if (idx >= 0) line(x.getPixelForValue(idx), cssVar("--c-accent"), 2, []);
    }
  },
};

// Chart.js-plugin: pelkkä kursorin kohdalla oleva himmeä katkoviiva (ilman valittua
// päivää) — käytetään booking-käyrässä, jossa ei ole "valittua" saraketta kuten pääkäyrässä.
const hoverMarker = {
  id: "hoverMarker",
  afterDraw(chart) {
    const area = chart.chartArea;
    if (!area) return;
    const active = chart.getActiveElements();
    if (!active.length) return;
    const ctx = chart.ctx;
    ctx.save();
    ctx.strokeStyle = cssVar("--c-chart-marker");
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(active[0].element.x, area.top);
    ctx.lineTo(active[0].element.x, area.bottom);
    ctx.stroke();
    ctx.restore();
  },
};

// Chart.js-plugin: "Ei tietoja" keskelle, jos valitulla välillä ei ole yhtään pistettä
// (esim. selattaessa aikaikkunaa kohtaan, jolta hintoja ei ole kerätty).
const noData = {
  id: "noData",
  afterDraw(chart) {
    const has = (chart.data.datasets || []).some((ds) => (ds.data || []).length > 0);
    if (has) return;
    const { ctx, chartArea: area } = chart;
    if (!area) return;
    ctx.save();
    ctx.fillStyle = cssVar("--c-muted");
    ctx.font = "600 15px system-ui, -apple-system, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("Ei tietoja valitulla välillä", (area.left + area.right) / 2, (area.top + area.bottom) / 2);
    ctx.restore();
  },
};

/** Lukee CSS-muuttujan (esim. "--c-accent") arvon :root-elementistä. Pitää kaavioiden
 * värit samassa lähteessä style.css:n kanssa — ei kovakoodattuja värejä JS:ssä. */
function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

async function json(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
  return res.json();
}

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

/** Lisää n päivää ISO-päivään (YYYY-MM-DD) paikallisaika huomioiden. */
function addDaysIso(iso, n) {
  const d = new Date(iso + "T00:00:00");
  d.setDate(d.getDate() + n);
  const p = (x) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Aikaikkunan pituus päivinä (start–end mukaan lukien). */
function rangeDays() {
  const s = $("start").value, e = $("end").value;
  if (!s || !e) return 0;
  return Math.round((new Date(e + "T00:00:00") - new Date(s + "T00:00:00")) / 86400000) + 1;
}

/** Asettaa aikavälin kenttiin (ISO + suomalainen näyttö) ja lataa käyrän. */
function setRange(s, e) {
  $("start").value = s;
  $("end").value = e;
  $("startText").value = fmtFi(s);
  $("endText").value = fmtFi(e);
  loadCalendar();
}

/** Siirtää näkyvää aikaikkunaa yhden ikkunan verran taakse/eteen. */
function shiftRange(dir) {
  const days = rangeDays();
  if (!days) return;
  setRange(addDaysIso($("start").value, days * dir), addDaysIso($("end").value, days * dir));
}

/** Päivittää selausnappien tekstit ikkunan pituuden mukaan. */
function updateRangeNav() {
  const days = rangeDays();
  if (!days) return;
  $("rangePrev").textContent = `← Edelliset ${days} päivää`;
  $("rangeNext").textContent = `Seuraavat ${days} päivää →`;
}

// ---------- Suomalaismuotoinen päivämääräkenttä (pp.kk.vvvv) ----------

/** "2026-06-12" -> "12.06.2026" (tyhjä jos ei arvoa). */
function fmtFi(iso) {
  if (!iso) return "";
  const [y, m, d] = iso.split("-");
  return `${d}.${m}.${y}`;
}

/** "2026-06-13" -> "13.6.2026" (suomalainen näyttömuoto ilman etunollia). */
function fmtFiDate(iso) {
  return new Date(iso + "T00:00:00").toLocaleDateString("fi-FI");
}

/** "12.6.2026" tai "12.06.2026" -> "2026-06-12", tai null jos kelvoton. */
function parseFi(s) {
  const m = s.trim().match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (!m) return null;
  const d = +m[1], mo = +m[2], y = +m[3];
  const dt = new Date(y, mo - 1, d);
  // Hylkää ylivuodot (esim. 31.02.) — Date korjaisi ne hiljaa seuraavaan kuukauteen.
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
  const p = (n) => String(n).padStart(2, "0");
  return `${y}-${p(mo)}-${p(d)}`;
}

/**
 * Kytkee näkyvän tekstikentän (pp.kk.vvvv) ja piilotetun natiivin date-inputin yhteen.
 * Natiivi pitää ISO-arvon, jota muu koodi lukee; tekstikenttä on käyttäjälle näkyvä.
 */
function bindDateField(textId, dateId) {
  const text = $(textId);
  const date = $(dateId);

  // Kalenterivalinta -> tekstikenttä.
  date.addEventListener("input", () => {
    text.value = fmtFi(date.value);
    text.classList.remove("invalid");
  });

  // Tekstisyöte -> natiivi (vahvistus blurilla / Enterillä).
  const commit = () => {
    const raw = text.value.trim();
    if (raw === "") {
      text.classList.remove("invalid");
      if (date.value) {
        date.value = "";
        date.dispatchEvent(new Event("change", { bubbles: true }));
      }
      return;
    }
    const iso = parseFi(raw);
    if (!iso) {
      text.classList.add("invalid");
      return;
    }
    text.value = fmtFi(iso); // normalisoi esim. 12.6.2026 -> 12.06.2026
    text.classList.remove("invalid");
    if (date.value !== iso) {
      date.value = iso;
      date.dispatchEvent(new Event("change", { bubbles: true })); // laukaisee loadCalendarin
    }
  };
  text.addEventListener("blur", commit);
  text.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); commit(); }
  });
}

async function initRoutes() {
  const routes = STATIC ? manifest.routes : await json("/api/routes");
  const sel = $("route");
  sel.innerHTML = "";
  routesById.clear();
  for (const r of routes) {
    routesById.set(r.id, r);
    const opt = document.createElement("option");
    opt.value = r.id;
    const from = r.fromName || r.from;
    const to = r.toName || r.to;
    opt.textContent = `${from} → ${to}  (${r.from}–${r.to})`;
    sel.appendChild(opt);
  }
  // Palauta edellisellä kerralla valittu reitti, jos se on yhä seurannassa. Näin refresh
  // ei pudota valintaa takaisin ensimmäiseen reittiin. Aikaväliä EI palauteta tahallaan:
  // tilannetta katsotaan aina nykyhetkestä eteenpäin.
  const savedRoute = storeGet("route");
  if (savedRoute && routesById.has(Number(savedRoute))) {
    sel.value = savedRoute;
  }
  // Oletusaikaväli: tästä päivästä eteenpäin (inklusiivinen ikkuna). Kapealla näytöllä
  // lyhyempi (21 pv), jotta käyrä pysyy luettavana ja päiviin osuu sormella; työpöydällä 60 pv.
  const windowDays = window.innerWidth < NARROW ? 21 : 60;
  const today = new Date();
  const end = new Date();
  end.setDate(end.getDate() + windowDays - 1);
  $("start").value = isoDate(today);
  $("end").value = isoDate(end);
  $("startText").value = fmtFi($("start").value);
  $("endText").value = fmtFi($("end").value);
}

async function loadCalendar() {
  currentRouteId = Number($("route").value);
  const start = $("start").value;
  const end = $("end").value;
  if (!currentRouteId || !start || !end) return;

  // Reitti/aikaväli vaihtui -> edellisen päivän lähdöt ja hintakäyrä eivät enää vastaa
  // valintaa. Nollataan ne kehotteeksi.
  resetDetails();
  updateRangeNav();

  let data;
  if (STATIC) {
    const blob = await routeData(currentRouteId);
    data = blob.calendar.filter((d) => d.date >= start && d.date <= end);
  } else {
    data = await json(
      `/api/calendar?route_id=${currentRouteId}&start=${start}&end=${end}`
    );
  }

  // Y-akselin rajat VAIN näkyvistä hinnoista -> ikkunan ulkopuoliset piikit eivät litistä käyrää.
  const yBounds = computeYBounds(data);

  const labels = data.map((d) => d.date);
  const mins = data.map((d) => d.minPrice);
  const avgs = data.map((d) => d.avgPrice);

  const cMin = cssVar("--c-chart-min");
  const cAvg = cssVar("--c-chart-avg");

  if (calendarChart) calendarChart.destroy();
  calendarChart = new Chart($("calendarChart"), {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "Halvin (€)",
          data: mins,
          borderColor: cMin,
          fill: false,
          tension: 0.2,
          pointBackgroundColor: cMin,
          pointBorderColor: cMin,
          pointRadius: 2.5,
          pointHoverRadius: 6,
          pointHitRadius: 14, // osuma lähelle riittää (helpottaa napautusta sormella)
        },
        { label: "Keskihinta (€)", data: avgs, borderColor: cAvg, borderDash: [5, 4], tension: 0.2, fill: false, pointRadius: 0 },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false, // korkeus tulee .chart-box-laatikosta (luettavampi mobiilissa)
      // Korosta lähin päivä x-akselin perusteella (ei vaadita osumaa pisteeseen) —
      // helpottaa oikean päivän valintaa kursoria liikuttaessa / napauttaessa.
      interaction: { mode: "index", intersect: false, axis: "x" },
      onClick: (evt, els, chart) => {
        let idx = els.length ? els[0].index : null;
        if (idx == null) {
          const pts = chart.getElementsAtEventForMode(evt, "index", { intersect: false, axis: "x" }, true);
          if (pts.length) idx = pts[0].index;
        }
        if (idx != null) loadDepartures(labels[idx]);
      },
      plugins: {
        legend: { position: "bottom" },
        tooltip: {
          callbacks: {
            // Lisää viikonpäivä päivämäärän perään, esim. "2026-06-20 (la)".
            title: (items) => {
              const d = items[0].label;
              return `${d} (${weekdayName(d)})`;
            },
          },
        },
      },
      scales: {
        x: {
          ticks: {
            autoSkip: true,
            maxRotation: 90,
            // Harvenna päivämäärämerkinnät, ettei akseli tukkeudu (etenkin mobiilissa).
            maxTicksLimit: window.innerWidth < NARROW ? 7 : 16,
          },
        },
        y: {
          beginAtZero: false,
          min: yBounds ? yBounds.min : undefined,
          max: yBounds ? yBounds.max : undefined,
          title: { display: true, text: "€" },
        },
      },
    },
    plugins: [weekendBands, dayMarker, noData],
  });

  if (data.length === 0) {
    showDepHint("Ei dataa valitulla välillä — onko keräys (npm run scrape) ajettu?");
  }
}

/** Näyttää lähtöpaneelissa infotekstin taulukon sijaan (kun päivää ei ole valittu / ei dataa). */
function showDepHint(msg) {
  $("depHint").textContent = msg;
  $("depHint").hidden = false;
  $("departures").hidden = true;
  $("departures").querySelector("tbody").innerHTML = "";
}

/** Palauttaa hintakäyrän alkutilaan (näyttää taas kehotteen). */
function clearHistory() {
  lastHistoryRows = null;
  $("histTitle").textContent = "Hintakehitys (booking-käyrä)";
  $("histHint").hidden = false;
  if (historyChart) { historyChart.destroy(); historyChart = null; }
}

/** Palauttaa lähtölistan ja hintakäyrän alkutilaan (esim. reittiä vaihdettaessa). */
function resetDetails() {
  selectedDate = null;
  $("depTitle").textContent = "Lähdöt";
  showDepHint("Klikkaa päivää yllä olevasta käyrästä nähdäksesi sen lähdöt.");
  clearHistory();
}

/** Täyttää footerin tilatiedot (seurattujen reittien määrä, datan päivitysaika). */
function renderFooter() {
  const el = $("footerStats");
  if (!el || !STATIC || !manifest) return;
  const parts = [`${manifest.routes.length} seurattua suuntaa`];
  if (manifest.generatedAt) {
    const fmt = new Date(manifest.generatedAt).toLocaleString("fi-FI", {
      day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit",
    });
    parts.push(`data päivitetty ${fmt}`);
  }
  el.innerHTML = `<strong>Tilanne:</strong> ${parts.join(" · ")}.`;
}

/**
 * Rakentaa linkin VR.fi:n hakutulossivulle annetulle reitille ja päivälle. VR EI tue
 * suoraa linkitystä yksittäiseen lähtöön (jatkovaihe vaatii palvelimen luoman saleId:n,
 * jota ei voi johtaa pvm/klo/junanumerosta) — paras mahdollinen on tämän päivän lähtölista,
 * jossa käyttäjä valitsee oikean kellonajan yhdellä klikkauksella.
 */
function vrBuyUrl(fromCode, toCode, travelDate) {
  const p = new URLSearchParams({ from: fromCode, to: toCode, outboundDate: travelDate });
  p.append("passengers[0][type]", "ADULT");
  return `https://www.vr.fi/kertalippu-menomatkan-hakutulokset?${p.toString()}`;
}

async function loadDepartures(travelDate) {
  selectedDate = travelDate;
  if (calendarChart) calendarChart.update("none"); // piirrä valitun päivän pystyviiva
  const route = routesById.get(currentRouteId);
  $("depTitle").textContent = route
    ? `${route.fromName || route.from}–${route.toName || route.to} ${fmtFiDate(travelDate)}`
    : `Lähdöt — ${fmtFiDate(travelDate)}`;
  let rows;
  if (STATIC) {
    const blob = await routeData(currentRouteId);
    rows = blob.departures[travelDate] || [];
  } else {
    rows = await json(
      `/api/departures?route_id=${currentRouteId}&travel_date=${travelDate}`
    );
  }
  if (rows.length === 0) { showDepHint("Ei lähtöjä tälle päivälle."); clearHistory(); return; }
  // Näytä taulukko, piilota infoteksti.
  $("depHint").hidden = true;
  $("departures").hidden = false;
  const tbody = $("departures").querySelector("tbody");
  tbody.innerHTML = "";
  // Päivän halvin VARATTAVISSA oleva hinta (loppuunmyytyjä ei lasketa). Voi osua useaan
  // lähtöön (tasapeli) -> kaikki sen hintaiset saavat merkin.
  const bookablePrices = rows.filter((d) => d.available !== 0).map((d) => d.price);
  const minPrice = bookablePrices.length ? Math.min(...bookablePrices) : null;
  for (const r of rows) {
    const tr = document.createElement("tr");
    // available voi puuttua vanhasta staattisesta datasta -> tulkitaan varattavaksi.
    const soldOut = r.available === 0;
    if (soldOut) tr.classList.add("sold-out");
    const cheapest = !soldOut && minPrice !== null && r.price === minPrice;
    const cheapestTag = cheapest
      ? ' <span class="cheapest-tag">⭐ Päivän halvin!</span>'
      : "";
    const priceCell = soldOut
      ? `${r.price.toFixed(2)} ${r.currency} <span class="sold-out-tag">ei varattavissa</span>`
      : `${r.price.toFixed(2)} ${r.currency}${cheapestTag}`;
    tr.title = soldOut ? "Lähtöä ei voi enää varata — hinta on viimeksi tiedetty hinta." : "";
    // Ostolinkki vain varattaville lähdöille; vie VR.fi:n hakuun tälle reitille ja päivälle.
    const buyCell =
      soldOut || !route
        ? ""
        : `<a class="buy-link" href="${vrBuyUrl(route.from, route.to, travelDate)}" target="_blank" rel="noopener" title="Avaa VR.fi:n haku tälle reitille ja päivälle">Osta&nbsp;↗</a>`;
    tr.innerHTML = `<td>${r.time}</td><td>${r.train || ""}</td><td>${priceCell}</td><td class="buy-cell">${buyCell}</td>`;
    // Ostolinkin klikkaus ei saa myös valita riviä (hintakäyrää).
    const buyLink = tr.querySelector(".buy-link");
    if (buyLink) buyLink.addEventListener("click", (e) => e.stopPropagation());
    tr.onclick = () => {
      tbody.querySelectorAll("tr").forEach((x) => x.classList.remove("active"));
      tr.classList.add("active");
      loadHistory(travelDate, r.time);
    };
    tbody.appendChild(tr);
  }
}

async function loadHistory(travelDate, time) {
  $("histHint").hidden = true;
  $("histTitle").textContent = `Hintakehitys — ${fmtFiDate(travelDate)} klo ${time}`;
  let rows;
  if (STATIC) {
    const blob = await routeData(currentRouteId);
    rows = blob.history[`${travelDate}|${time}`] || [];
  } else {
    rows = await json(
      `/api/history?route_id=${currentRouteId}&travel_date=${travelDate}&departure_time=${encodeURIComponent(time)}`
    );
  }
  lastHistoryRows = rows; // talteen, jotta teeman vaihto voi värittää käyrän paikallaan
  // Loppuunmyydyt keräyspäivät (available=0) punaisella: hinta on/oli olemassa, mutta
  // lähtöä ei voinut enää varata. available voi puuttua vanhasta datasta -> varattava.
  const SOLD = cssVar("--c-danger"), BOOKABLE = cssVar("--c-chart-hist");
  const isSold = (r) => r.available === 0;
  const pointColors = rows.map((r) => (isSold(r) ? SOLD : BOOKABLE));
  const pointSizes = rows.map((r) => (isSold(r) ? 5 : 3));

  if (historyChart) historyChart.destroy();
  historyChart = new Chart($("historyChart"), {
    type: "line",
    data: {
      labels: rows.map((r) => r.scrapeDate),
      datasets: [
        {
          label: "Hinta keräyspäivänä (€)",
          data: rows.map((r) => r.price),
          borderColor: BOOKABLE,
          tension: 0.2,
          fill: false,
          pointRadius: pointSizes,
          pointHoverRadius: pointSizes.map((s) => s + 2),
          pointBackgroundColor: pointColors,
          pointBorderColor: pointColors,
          // Väritä punaiseksi se viivan pätkä, joka päättyy loppuunmyytyyn pisteeseen.
          segment: { borderColor: (ctx) => (isSold(rows[ctx.p1DataIndex]) ? SOLD : BOOKABLE) },
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false, // korkeus tulee .chart-box-laatikosta
      // Sama kuin pääkäyrässä: korosta lähin sarake x-akselin perusteella, jotta
      // hover-katkoviiva seuraa kursoria eikä vaadi osumaa pisteeseen.
      interaction: { mode: "index", intersect: false, axis: "x" },
      plugins: {
        legend: { position: "bottom" },
        tooltip: {
          callbacks: {
            afterLabel: (item) => (isSold(rows[item.dataIndex]) ? "Ei enää varattavissa" : ""),
          },
        },
      },
      scales: {
        x: { title: { display: true, text: "keräyspäivä" }, ticks: { autoSkip: true, maxTicksLimit: 8 } },
        y: { title: { display: true, text: "€" } },
      },
    },
    plugins: [hoverMarker],
  });
}

// Päivitä graafi heti kun reitti tai aikaväli muuttuu (ei tarvita Hae-painiketta).
$("load").addEventListener("click", loadCalendar);
$("route").addEventListener("change", () => {
  storeSet("route", $("route").value); // säilytä valinta refreshin yli
  loadCalendar();
});
$("start").addEventListener("change", loadCalendar);
$("end").addEventListener("change", loadCalendar);

// Aikaikkunan selaus käyrän alta.
$("rangePrev").addEventListener("click", () => shiftRange(-1));
$("rangeNext").addEventListener("click", () => shiftRange(1));

// Adaptoi layout dynaamisesti kun ikkunan leveys ylittää NARROW-rajan: vaihda
// oletusikkunan pituus (21/60 pv) nykyisestä alkupäivästä. (Käyrän korkeus ja
// tick-tiheys hoituvat CSS-media queryllä ja Chart.js:n autoSkipillä.)
let resizeTimer;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    const nowNarrow = window.innerWidth < NARROW;
    if (nowNarrow === narrowMode) return;
    narrowMode = nowNarrow;
    const days = nowNarrow ? 21 : 60;
    const start = $("start").value || isoDate(new Date());
    setRange(start, addDaysIso(start, days - 1)); // päivittää kentät + loadCalendar
  }, 200);
});

// Suomalaismuotoiset päivämääräkentät + kalenteripainikkeet.
bindDateField("startText", "start");
bindDateField("endText", "end");
document.querySelectorAll(".cal-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const date = $(btn.dataset.target);
    if (typeof date.showPicker === "function") {
      try { date.showPicker(); return; } catch { /* fallback alla */ }
    }
    date.focus();
    date.click();
  });
});

// ---------- Vaalea/tumma teema ----------
// HUOM: index.html:n <head>-skripti asettaa data-theme-attribuutin jo ENNEN piirtoa
// (estää vaalean välähdyksen). Täällä hoidetaan napin tila, tallennus ja kaavioiden
// uudelleenpiirto, koska Chart.js lukee värit vain luontihetkellä.

/** Onko tumma teema nyt aktiivinen (luetaan <html>-attribuutista). */
function isDark() {
  return document.documentElement.getAttribute("data-theme") === "dark";
}

/** Päivittää napin ikonin + saavutettavuustekstit nykyisen teeman mukaan. */
function updateThemeButton() {
  const btn = $("themeToggle");
  if (!btn) return;
  const dark = isDark();
  // Ikoni kertoo MIHIN teemaan napautus vaihtaa.
  btn.textContent = dark ? "☀️" : "🌙";
  const label = dark ? "Vaihda vaaleaan teemaan" : "Vaihda tummaan teemaan";
  btn.setAttribute("aria-label", label);
  btn.title = label;
}

/** Asettaa Chart.js:n globaalit oletusvärit teeman CSS-muuttujista. Vaikuttaa VASTA luotaviin
 *  kaavioihin — olemassa olevien akseli-/ruudukkovärit on päivitettävä erikseen (applyAxisColors),
 *  koska Chart.js lukee ne defaultsista vain luontihetkellä eikä update() pull­aa niitä uudelleen. */
function applyChartTheme() {
  if (typeof Chart === "undefined") return;
  Chart.defaults.color = cssVar("--c-chart-text");
  Chart.defaults.borderColor = cssVar("--c-chart-grid");
}

/** Päivittää olemassa olevan kaavion akselien, ruudukon, otsikoiden ja selitteen värit teeman
 *  mukaan. Pakollinen teemaa vaihdettaessa: nämä on bakettu scale-optioihin luontihetkellä,
 *  joten pelkkä Chart.defaults-muutos + update() jättäisi ruudukon vanhan teeman väriin. */
function applyAxisColors(chart) {
  const grid = cssVar("--c-chart-grid");
  const text = cssVar("--c-chart-text");
  for (const ax of Object.values(chart.options.scales || {})) {
    if (!ax) continue;
    if (ax.grid) ax.grid.color = grid;
    if (ax.ticks) ax.ticks.color = text;
    if (ax.title) ax.title.color = text;
  }
  const legend = chart.options.plugins && chart.options.plugins.legend;
  if (legend && legend.labels) legend.labels.color = text;
}

/** Päivittää kalenterikäyrän värit PAIKALLAAN (ei tuhoa/rakenna uudelleen -> ei välähdystä,
 *  valinta säilyy). Pluginit (viikonloppu, pystyviiva, "ei tietoja") lukevat värit live joka
 *  piirrossa, joten ne päivittyvät update()-kutsulla itsestään. */
function recolorCalendar() {
  if (!calendarChart) return;
  const cMin = cssVar("--c-chart-min"), cAvg = cssVar("--c-chart-avg");
  const [dMin, dAvg] = calendarChart.data.datasets;
  if (dMin) { dMin.borderColor = cMin; dMin.pointBackgroundColor = cMin; dMin.pointBorderColor = cMin; }
  if (dAvg) dAvg.borderColor = cAvg;
  applyAxisColors(calendarChart);
  calendarChart.update();
}

/** Päivittää hintakäyrän värit paikallaan viimeksi piirretyn käyrän rivien perusteella. */
function recolorHistory() {
  if (!historyChart || !lastHistoryRows) return;
  const SOLD = cssVar("--c-danger"), BOOKABLE = cssVar("--c-chart-hist");
  const rows = lastHistoryRows;
  const isSold = (r) => r.available === 0;
  const colors = rows.map((r) => (isSold(r) ? SOLD : BOOKABLE));
  const ds = historyChart.data.datasets[0];
  ds.borderColor = BOOKABLE;
  ds.pointBackgroundColor = colors;
  ds.pointBorderColor = colors;
  ds.segment.borderColor = (ctx) => (isSold(rows[ctx.p1DataIndex]) ? SOLD : BOOKABLE);
  applyAxisColors(historyChart);
  historyChart.update();
}

/** Päivittää näkyvien kaavioiden värit teeman mukaan (akselit + datasarjat + pluginit). */
function recolorCharts() {
  applyChartTheme();
  recolorCalendar();
  recolorHistory();
}

/**
 * Ottaa teeman käyttöön: asettaa attribuutin, päivittää napin ja kaavioiden värit.
 * animate=true lisää hetkeksi .theme-transition-luokan, jolloin värit ristihäivystyvät
 * pehmeästi (rajattu vaihtohetkeen, ettei hover/focus tms. ala animoitua).
 */
function applyTheme(theme, animate) {
  const root = document.documentElement;
  if (animate) {
    root.classList.add("theme-transition");
    clearTimeout(themeTransitionTimer);
    themeTransitionTimer = setTimeout(() => root.classList.remove("theme-transition"), 350);
  }
  root.setAttribute("data-theme", theme);
  updateThemeButton();
  recolorCharts();
}

/** Vaihtaa teemaa napista, tallentaa valinnan ja häivyttää vaihdoksen pehmeästi. */
function toggleTheme() {
  const next = isDark() ? "light" : "dark";
  storeSet("theme", next);
  applyTheme(next, true);
}

$("themeToggle").addEventListener("click", toggleTheme);

// Jos käyttäjä ei ole valinnut teemaa itse (ei tallennettua valintaa), seuraa
// käyttöjärjestelmän vaalea/tumma-tilaa myös sivun ollessa auki.
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", (e) => {
  const chosen = storeGet("theme");
  if (chosen) return;
  applyTheme(e.matches ? "dark" : "light", true);
});

updateThemeButton();
applyChartTheme(); // ennen ensimmäistä kaaviota, jotta akselivärit ovat heti oikein

detectMode()
  .then(initRoutes)
  .then(loadCalendar)
  .then(renderFooter)
  .catch((e) => alert("Virhe: " + e.message));
