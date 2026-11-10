import { OCCASIONS, prepareRestaurants, recommend } from "./lib/recommender.js";
import { toCSV } from "./lib/csv.js";

const CAMPUS = [53.5263, -113.525];
const PLAN_LABELS = {
  any: "Anything", coffee: "☕ Coffee", "quick snack": "🥨 Quick snack",
  lunch: "🥪 Lunch", dinner: "🍝 Dinner", "late-night": "🌙 Late-night cravings", "drive-thru": "🚗 Drive-thru",
};
const store = {
  get(k, fallback) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fallback; } catch { return fallback; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const [restaurants, peopleList] = await Promise.all([
  fetch("data/restaurants.csv").then((r) => r.text()).then(prepareRestaurants),
  fetch("data/people.json").then((r) => r.json()),
]);
const people = Object.fromEntries(peopleList.map((p) => [p.name, p]));

const state = {
  who: new Set(store.get("ffo.who", ["Richa"]).filter((n) => people[n])),
  plan: store.get("ffo.plan", "any"),
  craving: "",
};

// ---- tabs ----------------------------------------------------------------------
document.querySelectorAll(".tab").forEach((btn) =>
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b === btn));
    document.querySelectorAll(".panel").forEach((p) => p.classList.toggle("active", p.id === btn.dataset.tab));
    if (btn.dataset.tab === "find") map?.invalidateSize();
  })
);

// ---- find: controls ----------------------------------------------------------------
function renderPeople() {
  $("#people").innerHTML = peopleList
    .map((p) => `<button class="chip" data-name="${esc(p.name)}" aria-pressed="${state.who.has(p.name)}">${esc(p.name)}</button>`)
    .join("");
}
$("#people").addEventListener("click", (e) => {
  const name = e.target.closest(".chip")?.dataset.name;
  if (!name) return;
  state.who.has(name) ? state.who.delete(name) : state.who.add(name);
  update();
});
$("#pick-all").addEventListener("click", () => { state.who = new Set(Object.keys(people)); update(); });
$("#pick-none").addEventListener("click", () => { state.who.clear(); update(); });

function renderPlans() {
  $("#plans").innerHTML = ["any", ...OCCASIONS]
    .map((o) => `<button class="seg" data-plan="${o}" aria-pressed="${state.plan === o}">${PLAN_LABELS[o] ?? o}</button>`)
    .join("");
}
$("#plans").addEventListener("click", (e) => {
  const plan = e.target.closest(".seg")?.dataset.plan;
  if (!plan) return;
  state.plan = plan;
  update();
});
let typing;
$("#craving").addEventListener("input", (e) => {
  clearTimeout(typing);
  typing = setTimeout(() => { state.craving = e.target.value; update(); }, 200);
});

// ---- find: results ---------------------------------------------------------------
function renderResults() {
  const group = [...state.who].map((n) => people[n]);
  const { recs, excluded } = recommend(group, restaurants, { occasion: state.plan, craving: state.craving, topN: 5 });

  const who = group.length === 0 ? "" : group.length === 1 ? group[0].name : `all ${group.length} of you`;
  $("#results-title").textContent = group.length ? `Top picks for ${who}` : "Pick who's coming to get started";

  if (!group.length) $("#results").innerHTML = "";
  else if (!recs.length) $("#results").innerHTML = `<li class="card empty">Nothing fits everyone for this plan. Try a different plan or fewer people.</li>`;
  else $("#results").innerHTML = recs.map((rec, i) => pickCard(rec, i, group.length)).join("");

  const ex = $("#excluded");
  ex.hidden = !excluded.length;
  ex.querySelector("summary").textContent = `Ruled out (${excluded.length})`;
  ex.querySelector("ul").innerHTML = excluded.map((e) => `<li><b>${esc(e.name)}</b>: ${esc(e.reason)}</li>`).join("");

  renderMap(recs);
}

function pickCard(rec, i, groupSize) {
  const r = rec.restaurant;
  const pct = Math.round(rec.score * 100);
  const reasons = rec.reasons.length ? rec.reasons : [r.description];
  const warns = [...new Set(rec.perPerson.flatMap((p) => p.warnings))].slice(0, 3);
  let who = "";
  if (groupSize > 1) {
    const sorted = [...rec.perPerson].sort((a, b) => b.score - a.score);
    who = `<div class="who">Most excited: <b>${esc(sorted[0].name)}</b> · Least excited: <b>${esc(sorted.at(-1).name)}</b></div>`;
  }
  return `
  <li class="card pick" data-i="${i}">
    <div class="rank">${i + 1}</div>
    <div>
      <h3>${esc(r.name)}${r.verified === "yes" ? "" : `<span class="badge" title="Prices and menu not checked yet">unverified</span>`}</h3>
      <div class="meta">${esc(r.location || "Near campus")} · ~$${Math.round(r.avg_cost)} · ${tripText(r)}${r.tags.includes("drive-thru") ? " · 🚗 drive-thru" : ""}</div>
      <ul class="reasons">${reasons.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>
      ${who}
      ${warns.length ? `<div class="warn">Heads up: ${warns.map(esc).join(" · ")}</div>` : ""}
    </div>
    <div class="score"><b>${pct}%</b><span>match</span><div class="bar"><i style="width:${pct}%"></i></div></div>
  </li>`;
}

function tripText(r) {
  if (state.plan === "drive-thru" || r.how === "drive" || r.travel_min == null) return `${r.distance_km} km from campus`;
  return r.how ? `~${r.travel_min} min · ${esc(r.how)}` : `~${r.travel_min} min walk`;
}

// ---- map --------------------------------------------------------------------------
let map = null;
let layer = null;
if (window.L) {
  map = L.map("map", { scrollWheelZoom: false }).setView(CAMPUS, 14);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);
  L.circleMarker(CAMPUS, { radius: 6, color: "#7a6d64", fillOpacity: 0.6 }).addTo(map).bindTooltip("U of A Quad");
  layer = L.layerGroup().addTo(map);
} else {
  $("#map").innerHTML = `<div class="empty">Map couldn't load. Check your internet connection.</div>`;
}

function renderMap(recs) {
  const pinned = recs.map((rec, i) => ({ rec, i })).filter(({ rec }) => rec.restaurant.lat != null && rec.restaurant.lon != null);
  const missing = recs.length - pinned.length;
  $("#map-note").textContent = missing
    ? `${missing} pick${missing > 1 ? "s" : ""} not on the map yet (no coordinates). Run the map import or add lat/lon in restaurants.csv.`
    : "";
  // No coordinates for any pick (e.g. before the map import): hide the map, use full width.
  const showMap = pinned.length > 0;
  document.querySelector(".results-layout").classList.toggle("no-map", !showMap);
  if (!map || !showMap) return;
  map.invalidateSize();
  layer.clearLayers();
  const pts = [];
  for (const { rec, i } of pinned) {
    const r = rec.restaurant;
    const icon = L.divIcon({ className: "", html: `<div class="rank" style="box-shadow:0 1px 4px rgba(0,0,0,.3)">${i + 1}</div>`, iconSize: [32, 32], iconAnchor: [16, 16] });
    L.marker([r.lat, r.lon], { icon }).addTo(layer).bindPopup(`<b>${esc(r.name)}</b><br>${Math.round(rec.score * 100)}% match`);
    pts.push([r.lat, r.lon]);
  }
  if (pts.length) map.fitBounds([...pts, CAMPUS], { padding: [30, 30], maxZoom: 16 });
  else map.setView(CAMPUS, 14);
}

// ---- rate -------------------------------------------------------------------------
let stars = 4;
const ratings = store.get("ffo.ratings", []);
$("#rate-person").innerHTML = peopleList.map((p) => `<option>${esc(p.name)}</option>`).join("");
$("#places").innerHTML = [...new Set(restaurants.map((r) => r.name))].sort().map((n) => `<option value="${esc(n)}"></option>`).join("");
function renderStars() {
  $("#stars").innerHTML = [1, 2, 3, 4, 5]
    .map((n) => `<button class="star ${n <= stars ? "on" : ""}" data-n="${n}" role="radio" aria-checked="${n === stars}" aria-label="${n} star${n > 1 ? "s" : ""}">★</button>`)
    .join("");
}
$("#stars").addEventListener("click", (e) => { const n = e.target.closest(".star")?.dataset.n; if (n) { stars = Number(n); renderStars(); } });
$("#save-rating").addEventListener("click", () => {
  const place = $("#rate-place").value.trim();
  const msg = $("#rate-msg");
  if (!restaurants.some((r) => r.name === place)) { msg.textContent = "Pick a place from the list."; return; }
  const row = { person: $("#rate-person").value, restaurant: place, rating: stars, date: new Date().toISOString().slice(0, 10) };
  ratings.push(row);
  store.set("ffo.ratings", ratings);
  msg.textContent = `Saved: ${row.person} gave ${place} ${stars}/5`;
  $("#rate-place").value = "";
  renderRatings();
});
function renderRatings() {
  $("#ratings-body").innerHTML = ratings.length
    ? [...ratings].reverse().map((r) => `<tr><td>${esc(r.person)}</td><td>${esc(r.restaurant)}</td><td>${"★".repeat(r.rating)}</td><td>${esc(r.date)}</td></tr>`).join("")
    : `<tr><td colspan="4" class="muted">No ratings yet.</td></tr>`;
}
$("#download").addEventListener("click", () => {
  const blob = new Blob([toCSV(ratings, ["person", "restaurant", "rating", "date"])], { type: "text/csv" });
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: "ratings.csv" });
  a.click();
  URL.revokeObjectURL(a.href);
});
$("#clear-ratings").addEventListener("click", () => {
  ratings.length = 0;
  store.set("ffo.ratings", ratings);
  renderRatings();
});

// ---- crew -------------------------------------------------------------------------
const list = (xs) => (xs?.length ? xs.map(esc).join(", ") : `<span class="muted">anything</span>`);
$("#crew-grid").innerHTML = peopleList
  .map((p) => `
  <div class="card">
    <h3>${esc(p.name)}</h3>
    <dl>
      <dt>Loves</dt><dd>${list(p.favorite_cuisines)}</dd>
      <dt>Go-tos</dt><dd>${p.favorite_places?.length ? p.favorite_places.map(esc).join(", ") : "—"}</dd>
      <dt>Can eat</dt><dd>${p.can_eat_proteins ? p.can_eat_proteins.map(esc).join(", ") : `<span class="muted">anything</span>`}</dd>
      <dt>Avoids</dt><dd>${[...(p.avoid_cuisines ?? []), ...(p.soft_avoid ?? [])].map(esc).join(", ") || "—"}</dd>
      <dt>Budget</dt><dd>$${p.budget ?? 20} · up to ${p.max_travel_min ?? 30} min away</dd>
      ${p.calorie_goal_per_meal ? `<dt>Goal</dt><dd>~${p.calorie_goal_per_meal} cal per meal</dd>` : ""}
    </dl>
    ${p.notes ? `<p class="crew-note">${esc(p.notes)}</p>` : ""}
  </div>`)
  .join("");

// ---- go ---------------------------------------------------------------------------
function update() {
  store.set("ffo.who", [...state.who]);
  store.set("ffo.plan", state.plan);
  renderPeople();
  renderPlans();
  renderResults();
}
renderStars();
renderRatings();
update();
