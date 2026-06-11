const $ = (id) => document.getElementById(id);
let calendarChart, historyChart;
let currentRouteId = null;

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

async function json(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
  return res.json();
}

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

async function initRoutes() {
  const routes = await json("/api/routes");
  const sel = $("route");
  sel.innerHTML = "";
  for (const r of routes) {
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
}

async function loadCalendar() {
  currentRouteId = Number($("route").value);
  const start = $("start").value;
  const end = $("end").value;
  if (!currentRouteId || !start || !end) return;

  const data = await json(
    `/api/calendar?route_id=${currentRouteId}&start=${start}&end=${end}`
  );

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
      onClick: (_evt, els) => {
        if (els.length) loadDepartures(labels[els[0].index]);
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
    plugins: [weekendBands],
  });

  if (data.length === 0) {
    clearDepartures("Ei dataa valitulla välillä — onko keräys (npm run scrape) ajettu?");
  }
}

function clearDepartures(msg) {
  $("departures").querySelector("tbody").innerHTML =
    `<tr><td colspan="3" class="muted">${msg || ""}</td></tr>`;
  if (historyChart) { historyChart.destroy(); historyChart = null; }
}

async function loadDepartures(travelDate) {
  $("depTitle").textContent = `Lähdöt — ${travelDate}`;
  const rows = await json(
    `/api/departures?route_id=${currentRouteId}&travel_date=${travelDate}`
  );
  const tbody = $("departures").querySelector("tbody");
  tbody.innerHTML = "";
  if (rows.length === 0) { clearDepartures("Ei lähtöjä tälle päivälle."); return; }
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
  $("histTitle").textContent = `Hintakehitys — ${travelDate} klo ${time}`;
  const rows = await json(
    `/api/history?route_id=${currentRouteId}&travel_date=${travelDate}&departure_time=${encodeURIComponent(time)}`
  );
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

initRoutes()
  .then(loadCalendar)
  .catch((e) => alert("Virhe: " + e.message));
