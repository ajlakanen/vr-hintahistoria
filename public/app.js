const $ = (id) => document.getElementById(id);
let calendarChart, historyChart;
let currentRouteId = null;
let selectedDate = null; // kalenterista valittu lähtöpäivä (pystyviivaa varten)

// Staattinen moodi (GitHub Pages): jos data/manifest.json löytyy, data luetaan
// esirenderöidyistä JSON-tiedostoista API:n sijaan. Muuten käytetään /api/*-backendia.
let STATIC = false;
let manifest = null;
const routeCache = new Map(); // route_id -> esiladattu blob
const routesById = new Map(); // route_id -> { from, to, fromName, toName }

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
    ctx.fillStyle = "rgba(20, 20, 20, 0.07)";
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
    if (active.length) line(active[0].element.x, "rgba(20,20,20,0.25)", 1, [4, 3]);
    // Valittu päivä (kiinteä vihreä viiva).
    if (selectedDate != null) {
      const idx = (chart.data.labels || []).indexOf(selectedDate);
      if (idx >= 0) line(x.getPixelForValue(idx), "#00a149", 2, []);
    }
  },
};

async function json(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
  return res.json();
}

function isoDate(d) {
  return d.toISOString().slice(0, 10);
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
  // Oletusaikaväli: tästä päivästä 60 päivää eteenpäin.
  const today = new Date();
  const end = new Date();
  end.setDate(end.getDate() + 60);
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

  let data;
  if (STATIC) {
    const blob = await routeData(currentRouteId);
    data = blob.calendar.filter((d) => d.date >= start && d.date <= end);
  } else {
    data = await json(
      `/api/calendar?route_id=${currentRouteId}&start=${start}&end=${end}`
    );
  }

  const labels = data.map((d) => d.date);
  const mins = data.map((d) => d.minPrice);
  const avgs = data.map((d) => d.avgPrice);

  // Viikonlopun pisteet erottuvalla värillä (oranssi), arkipäivät vihreällä.
  const pointColors = labels.map((d) => (isWeekend(d) ? "#e4572e" : "#00a149"));
  const pointRadii = labels.map((d) => (isWeekend(d) ? 3.5 : 2.5));

  if (calendarChart) calendarChart.destroy();
  calendarChart = new Chart($("calendarChart"), {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "Halvin (€)",
          data: mins,
          borderColor: "#00a149",
          fill: false,
          tension: 0.2,
          pointBackgroundColor: pointColors,
          pointBorderColor: pointColors,
          pointRadius: pointRadii,
          pointHoverRadius: 6,
        },
        { label: "Keskihinta (€)", data: avgs, borderColor: "#888", borderDash: [5, 4], tension: 0.2, fill: false, pointRadius: 0 },
      ],
    },
    options: {
      responsive: true,
      // Korosta lähin päivä x-akselin perusteella (ei vaadita osumaa pisteeseen) —
      // helpottaa oikean päivän valintaa kursoria liikuttaessa.
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
      scales: { y: { beginAtZero: false, title: { display: true, text: "€" } } },
    },
    plugins: [weekendBands, dayMarker],
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

async function loadDepartures(travelDate) {
  selectedDate = travelDate;
  if (calendarChart) calendarChart.update("none"); // piirrä valitun päivän pystyviiva
  const r = routesById.get(currentRouteId);
  $("depTitle").textContent = r
    ? `${r.fromName || r.from}–${r.toName || r.to} ${fmtFiDate(travelDate)}`
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
  for (const r of rows) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${r.time}</td><td>${r.train || ""}</td><td>${r.price.toFixed(2)} ${r.currency}</td>`;
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
  if (historyChart) historyChart.destroy();
  historyChart = new Chart($("historyChart"), {
    type: "line",
    data: {
      labels: rows.map((r) => r.scrapeDate),
      datasets: [
        {
          label: "Hinta keräyspäivänä (€)",
          data: rows.map((r) => r.price),
          borderColor: "#0b6bcb",
          tension: 0.2,
          fill: false,
          pointRadius: 3,
        },
      ],
    },
    options: {
      responsive: true,
      plugins: { legend: { position: "bottom" } },
      scales: { x: { title: { display: true, text: "keräyspäivä" } }, y: { title: { display: true, text: "€" } } },
    },
  });
}

// Päivitä graafi heti kun reitti tai aikaväli muuttuu (ei tarvita Hae-painiketta).
$("load").addEventListener("click", loadCalendar);
$("route").addEventListener("change", loadCalendar);
$("start").addEventListener("change", loadCalendar);
$("end").addEventListener("change", loadCalendar);

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

detectMode()
  .then(initRoutes)
  .then(loadCalendar)
  .then(renderFooter)
  .catch((e) => alert("Virhe: " + e.message));
