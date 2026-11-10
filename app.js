import { OCCASIONS, prepareRestaurants, recommend } from "./lib/recommender.js";
import { toCSV } from "./lib/csv.js";

const CAMPUS = [53.5263, -113.525];
const PLAN_LABELS = {
  any: "✨ Anything", coffee: "☕ Coffee / matcha", "quick snack": "🥨 Quick snack", lunch: "🥪 Lunch",
  dinner: "🍝 Dinner", "late-night": "🌙 Late-night", "drive-thru": "🚗 Drive-thru",
  dessert: "🍨 Dessert", "on campus": "🏫 On campus",
};
const MOODS = [
  { id: "comfort", label: "Comfort Food", icon: "🍲", craving: "comfort burger pasta fried chicken pizza mac and cheese" },
  { id: "spicy", label: "Spicy Craving", icon: "🌶️", craving: "spicy curry hot korean thai szechuan" },
  { id: "budget", label: "Budget Meal", icon: "🪙", maxCost: 13 },
  { id: "light", label: "Light & Healthy", icon: "🥗", craving: "salad poke bowl light fresh healthy smoothie" },
  { id: "cozy", label: "Warm & Cozy", icon: "🍜", craving: "soup ramen pho curry noodles warm cozy" },
  { id: "quick", label: "Quick Bites", icon: "⚡", plan: "quick snack" },
];
// Cuisine -> emoji for the card art (no photos of real restaurants).
const ART = [
  [["sushi", "japanese", "poke", "hawaiian"], "🍣"], [["ramen", "noodles", "pho", "vietnamese"], "🍜"],
  [["korean"], "🍗"], [["dumpling"], "🥟"], [["chinese", "chow mein", "fried rice", "orange chicken"], "🥡"], [["thai", "curry", "indian"], "🍛"],
  [["shawarma", "middle eastern", "arabic", "lebanese", "kebab", "mediterranean", "greek", "turkish"], "🥙"],
  [["mexican", "tacos", "burrito"], "🌮"], [["pizza"], "🍕"], [["italian", "pasta"], "🍝"],
  [["burgers", "burger", "fast food", "american"], "🍔"], [["bbq"], "🍖"], [["subway", "sandwich", "sub", "wrap"], "🥪"],
  [["smoothies", "juice"], "🥤"], [["bubble tea", "tea", "matcha"], "🧋"], [["ice cream", "dessert", "donut"], "🍩"],
  [["bakery"], "🥐"], [["brunch", "breakfast"], "🥞"], [["coffee", "cafe", "coffee shop"], "☕"],
  [["vegan", "bowls", "salad"], "🥗"], [["chicken"], "🍗"],
];
const FACE_COLORS = ["#1f4d26", "#e0662f", "#7a5af8", "#d6457f", "#0f8a7e", "#c48a00", "#3b6fd4", "#8c4b2f", "#4f7d2c", "#b0367a"];

const store = {
  get(k, fallback) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fallback; } catch { return fallback; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const ICON = {
  pin: '<svg viewBox="0 0 24 24"><path d="M12 22s7-6.2 7-12a7 7 0 1 0-14 0c0 5.8 7 12 7 12Z"/><circle cx="12" cy="10" r="2.5"/></svg>',
  clock: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  arrow: '<svg viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
  close: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>',
};

// ---- theme --------------------------------------------------------------------------
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  store.set("ffo.theme", t);
  const btn = $("#theme-btn");
  if (btn) btn.textContent = t === "bold" ? "🎨 Bold" : "🌿 Fresh";
}
applyTheme(store.get("ffo.theme", "fresh"));
$("#theme-btn")?.addEventListener("click", () => applyTheme(document.documentElement.dataset.theme === "bold" ? "fresh" : "bold"));

// ---- data ----------------------------------------------------------------------------
const [restaurants, peopleList] = await Promise.all([
  fetch("data/restaurants.csv").then((r) => r.text()).then(prepareRestaurants),
  fetch("data/people.json").then((r) => r.json()),
]);
const people = Object.fromEntries(peopleList.map((p) => [p.name, p]));
const faceColor = Object.fromEntries(peopleList.map((p, i) => [p.name, FACE_COLORS[i % FACE_COLORS.length]]));
const initials = (n) => n.split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();

const state = {
  who: new Set(store.get("ffo.who", ["Richa"]).filter((n) => people[n])),
  plan: store.get("ffo.plan", "any"),
  mood: null,
  nearby: false,
  surprise: 0,
  priceMin: 1,
  priceMax: 500,
};
if (!state.who.size && peopleList.length) state.who.add(peopleList[0].name);
let current = { recs: [], excluded: [] };

function artFor(r) {
  // The place's name and dishes say more than its cuisine tag (a "matcha cafe" tagged japanese is still a cafe).
  // Words are checked in order, so a place's first-listed dish wins (Starbucks: coffee before sandwich).
  const pick = (words) => { for (const w of words) for (const [keys, e] of ART) if (keys.some((k) => w.includes(k))) return e; return null; };
  const emoji = pick([r.name.toLowerCase(), ...r.dishes]) ?? pick(r.cuisines) ?? "🍽️";
  let h = 0;
  for (const c of r.cuisines[0] ?? r.name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return { emoji, tone: h % 6 };
}
const price = (c) => (c <= 10 ? "$" : c <= 18 ? "$$" : "$$$");
function tripText(r) {
  if (state.plan === "drive-thru" || r.how === "drive" || r.travel_min == null) return `${r.distance_km} km away`;
  return `~${r.travel_min} min`;
}
function howText(r) {
  if (state.plan === "drive-thru" || r.how === "drive") return `${r.distance_km} km from campus by car`;
  return r.how || `~${r.travel_min} min walk from campus`;
}
function directionsUrl(r) {
  const dest = r.lat != null ? `${r.lat},${r.lon}` : encodeURIComponent(`${r.name} Edmonton`);
  const mode = state.plan === "drive-thru" || r.how === "drive" ? "driving" : "transit";
  return `https://www.google.com/maps/dir/?api=1&origin=University+of+Alberta&destination=${dest}&travelmode=${mode}`;
}

// ---- navigation ----------------------------------------------------------------------
function go(view) {
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.id === view));
  document.querySelectorAll(".nav-btn").forEach((b) => b.classList.toggle("active", b.dataset.go === view));
  window.scrollTo({ top: 0 });
  if (view === "mapview") setTimeout(() => { map?.invalidateSize(); renderMap(); }, 30);
}
document.addEventListener("click", (e) => {
  const t = e.target.closest("[data-go]");
  if (t) go(t.dataset.go);
});

// ---- home controls -------------------------------------------------------------------
function renderPeople() {
  $("#people").innerHTML = peopleList.map((p) => `
    <button class="avatar" data-name="${esc(p.name)}" aria-pressed="${state.who.has(p.name)}">
      <span class="face" style="background:${faceColor[p.name]}">${esc(initials(p.name))}</span>
      <span class="nm">${esc(p.name)}</span>
    </button>`).join("");
  const n = state.who.size;
  const first = [...state.who][0];
  $("#hello").textContent = n === 0 ? "Who's hungry? 👋" : n === 1 ? `Hey ${first} 👋` : `Planning for ${first} + ${n - 1} 👋`;
}
$("#people").addEventListener("click", (e) => {
  const name = e.target.closest(".avatar")?.dataset.name;
  if (!name) return;
  state.who.has(name) ? state.who.delete(name) : state.who.add(name);
  update();
});
$("#pick-all").addEventListener("click", () => { state.who = new Set(Object.keys(people)); update(); });
$("#pick-none").addEventListener("click", () => { state.who = new Set(["Richa"].filter((n) => people[n])); update(); });

function renderPlans() {
  $("#plans").innerHTML = ["any", ...OCCASIONS]
    .map((o) => `<button class="hchip" data-plan="${o}" aria-pressed="${state.plan === o}">${PLAN_LABELS[o] ?? o}</button>`).join("");
}
$("#plans").addEventListener("click", (e) => {
  const plan = e.target.closest("[data-plan]")?.dataset.plan;
  if (plan) { state.plan = plan; state.surprise = 0; update(); }
});

function renderMoods() {
  $("#moods").innerHTML = MOODS.map((m, i) => `
    <button class="mood tone-${i}" data-mood="${m.id}" aria-pressed="${state.mood === m.id}">
      <span class="ic">${m.icon}</span><span class="lb">${m.label}</span>
    </button>`).join("");
  $("#clear-mood").hidden = !state.mood;
}
$("#moods").addEventListener("click", (e) => {
  const id = e.target.closest("[data-mood]")?.dataset.mood;
  if (!id) return;
  state.mood = state.mood === id ? null : id;
  state.surprise = 0;
  update();
});
$("#clear-mood").addEventListener("click", () => { state.mood = null; update(); });

// Budget slider: $1 to $500 on a curve, so $5-$30 (where most meals are) gets most of the room.
const PRICE_MAX = 500;
const toPrice = (t) => (t <= 0 ? 1 : Math.round(Math.pow(PRICE_MAX, t / 100)));
const toPos = (price) => (100 * Math.log(Math.max(1, price))) / Math.log(PRICE_MAX);
$("#range-ticks").innerHTML = [1, 10, 25, 75, 500].map((v) => `<span style="left:${toPos(v)}%">$${v}</span>`).join("");
function renderBudget() {
  const a = Number($("#bmin").value), b = Number($("#bmax").value);
  $("#range-fill").style.left = `${a}%`;
  $("#range-fill").style.width = `${b - a}%`;
  const any = state.priceMin <= 1 && state.priceMax >= PRICE_MAX;
  $("#budget-label").textContent = any ? "Any price" : `$${state.priceMin} – $${state.priceMax}${state.priceMax >= PRICE_MAX ? "+" : ""}`;
}
let budgetTimer;
for (const id of ["#bmin", "#bmax"]) {
  $(id).addEventListener("input", (e) => {
    let a = Number($("#bmin").value), b = Number($("#bmax").value);
    if (a > b - 2) { if (e.target.id === "bmin") { a = b - 2; $("#bmin").value = a; } else { b = a + 2; $("#bmax").value = b; } }
    state.priceMin = toPrice(Math.max(0, a));
    state.priceMax = toPrice(Math.min(100, b));
    renderBudget();
    clearTimeout(budgetTimer);
    budgetTimer = setTimeout(update, 120);
  });
}
renderBudget();
$("#nearby").addEventListener("click", () => { state.nearby = !state.nearby; update(); });
const surprise = (e) => { e?.preventDefault(); state.surprise = 1 + Math.floor(Math.random() * 1e6); update(); };
$("#surprise").addEventListener("click", surprise);


// ---- results ---------------------------------------------------------------------------
function compute() {
  const group = [...state.who].map((n) => people[n]);
  const mood = MOODS.find((m) => m.id === state.mood);
  const occasion = state.plan !== "any" ? state.plan : mood?.plan ?? "any";
  const filters = [];
  if (mood?.maxCost) filters.push((r) => r.avg_cost <= mood.maxCost);
  if (state.priceMin > 1 || state.priceMax < 500) filters.push((r) => r.avg_cost >= state.priceMin && r.avg_cost <= state.priceMax);
  if (state.nearby) filters.push((r) => r.travel_min != null && r.travel_min <= 15 && r.how !== "drive");
  const where = filters.length ? (r) => filters.every((f) => f(r)) : null;
  const craving = mood?.craving ?? "";
  const res = recommend(group, restaurants, { occasion, craving, topN: state.surprise ? 12 : 8, where });
  if (state.surprise && res.recs.length > 1) {
    const i = state.surprise % res.recs.length;
    const [pick] = res.recs.splice(i, 1);
    res.recs = [pick, ...res.recs].slice(0, 8);
  }
  return { ...res, group };
}

function featuredCard(rec, groupSize) {
  const r = rec.restaurant;
  const a = artFor(r);
  const label = state.surprise ? "🎲 Surprise pick" : groupSize > 1 ? "✨ Best for the group" : "✨ Top pick for you";
  const warns = [...new Set(rec.perPerson.flatMap((p) => p.warnings))].slice(0, 2);
  return `
  <button class="featured" data-open="0">
    <div class="art tone-${a.tone}"><span>${a.emoji}</span><span class="pick-label">${label}</span><span class="match">${Math.round(rec.score * 100)}% match</span></div>
    <div class="body">
      <div class="meta"><span class="pill">${esc(r.location || "Near campus")}</span><b>${price(r.avg_cost)}</b><span>${ICON.clock.replace("<svg", '<svg style="width:14px;height:14px;vertical-align:-2px"')} ${tripText(r)}</span></div>
      <h3>${esc(r.name)}${r.verified === "yes" ? "" : `<span class="badge">unverified</span>`}</h3>
      <p class="muted small" style="margin:2px 0 12px">${esc(howText(r))}</p>
      <ul class="reasons">${(rec.reasons.length ? rec.reasons : [r.description]).slice(0, 4).map((x) => `<li>${esc(x)}</li>`).join("")}</ul>
      ${warns.length ? `<div class="warn">Heads up: ${warns.map(esc).join(" · ")}</div>` : ""}
    </div>
  </button>`;
}

function pickCard(rec, i) {
  const r = rec.restaurant;
  const a = artFor(r);
  return `
  <button class="pick" data-open="${i}">
    <div class="art tone-${a.tone}">${a.emoji}<span class="num">${i + 1}</span></div>
    <div>
      <div class="pick-top"><h3>${esc(r.name)}</h3><span class="match">${Math.round(rec.score * 100)}%</span></div>
      <div class="meta"><span>${esc(r.location || "Near campus")}</span><b>${price(r.avg_cost)}</b><span>${tripText(r)}</span></div>
      <ul class="reasons">${(rec.reasons.length ? rec.reasons : [r.cuisines.join(", ") || "food spot"]).slice(0, 2).map((x) => `<li>${esc(x)}</li>`).join("")}</ul>
    </div>
  </button>`;
}

function renderResults() {
  current = compute();
  const { recs, excluded, group } = current;
  if (!group.length) {
    $("#featured").innerHTML = `<div class="empty"><span class="big">👋</span>Pick who's eating to get started.</div>`;
    $("#results").innerHTML = "";
  } else if (!recs.length) {
    $("#featured").innerHTML = `<div class="empty"><span class="big">🤔</span>Nothing fits everyone right now.<br>Try another plan or mood, or fewer people.</div>`;
    $("#results").innerHTML = "";
  } else {
    $("#featured").innerHTML = featuredCard(recs[0], group.length);
    $("#results").innerHTML = recs.slice(1).map((rec, i) => pickCard(rec, i + 1)).join("");
  }
  $("#more-title").textContent = recs.length > 1 ? "More picks" : "";
  const ex = $("#excluded");
  ex.hidden = !excluded.length;
  ex.querySelector("summary").textContent = `Ruled out for this group (${excluded.length})`;
  ex.querySelector("ul").innerHTML = excluded.slice(0, 40).map((e) => `<li><b>${esc(e.name)}</b>: ${esc(e.reason)}</li>`).join("")
    + (excluded.length > 40 ? `<li>…and ${excluded.length - 40} more</li>` : "");
  if ($("#mapview").classList.contains("active")) renderMap();
}
document.addEventListener("click", (e) => {
  const t = e.target.closest("[data-open]");
  if (t) openSheet(Number(t.dataset.open));
});

// ---- detail sheet -------------------------------------------------------------------------
function openSheet(i) {
  const rec = current.recs[i];
  if (!rec) return;
  const r = rec.restaurant;
  const a = artFor(r);
  const warns = [...new Set(rec.perPerson.flatMap((p) => p.warnings))];
  const scores = [...rec.perPerson].sort((x, y) => y.score - x.score);
  $("#sheet").innerHTML = `
    <div class="art tone-${a.tone}">${a.emoji}<button class="close" id="sheet-close" aria-label="Close">${ICON.close}</button></div>
    <div class="sheet-body">
      <div class="sheet-card">
        <h3>${esc(r.name)}</h3>
        <div class="meta"><span class="match">${Math.round(rec.score * 100)}% match</span><span class="pill">${esc(r.cuisines.slice(0, 2).join(" · ") || "Food")}</span><b>${price(r.avg_cost)} · ~$${Math.round(r.avg_cost)}</b></div>
        <div class="loc"><span class="ic">${ICON.pin}</span><span>${esc(r.location || "Near campus")} · ${esc(howText(r))}</span></div>
      </div>
      <div class="band"><span class="ic">${ICON.clock}</span><div><b>${r.opening_hours ? "Opening hours" : "Hours not listed"}</b><span>${esc(r.opening_hours || "Check before you go")}</span></div></div>
      <div class="grid2">
        <div class="tile"><div class="k">Getting there</div><div class="v">${tripText(r)}</div></div>
        <div class="tile"><div class="k">Price per person</div><div class="v">~$${Math.round(r.avg_cost)}${r.verified === "yes" ? "" : " (est.)"}</div></div>
      </div>
      <div class="sheet-card" style="margin-top:12px">
        <h2 style="font-size:18px">Why it works</h2>
        <ul class="reasons" style="margin-top:10px">${(rec.reasons.length ? rec.reasons : [r.description]).map((x) => `<li>${esc(x)}</li>`).join("")}</ul>
        ${scores.length > 1 ? `<div class="people-scores">${scores.map((p) => `
          <div class="ps"><span class="face" style="background:${faceColor[p.name]}">${esc(initials(p.name))}</span><span class="track"><i style="width:${Math.round(p.score * 100)}%"></i></span><span class="pc">${Math.round(p.score * 100)}%</span></div>`).join("")}</div>` : ""}
        ${warns.length ? `<div class="warn">Heads up: ${warns.map(esc).join(" · ")}</div>` : ""}
      </div>
      <a class="btn wide" href="${directionsUrl(r)}" target="_blank" rel="noopener">Get directions <span class="arrow">${ICON.arrow}</span></a>
    </div>`;
  $("#sheet").classList.add("open");
  $("#sheet-backdrop").classList.add("open");
  $("#sheet").scrollTop = 0;
  $("#sheet-close").focus();
}
function closeSheet() {
  $("#sheet").classList.remove("open");
  $("#sheet-backdrop").classList.remove("open");
}
$("#sheet-backdrop").addEventListener("click", closeSheet);
document.addEventListener("click", (e) => { if (e.target.closest("#sheet-close")) closeSheet(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeSheet(); });

// ---- map ----------------------------------------------------------------------------------
let map = null;
let layer = null;
if (window.L) {
  map = L.map("map", { scrollWheelZoom: false, zoomControl: true }).setView(CAMPUS, 13);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);
  L.circleMarker(CAMPUS, { radius: 7, color: "#fff", weight: 3, fillColor: "#3b6fd4", fillOpacity: 1 }).addTo(map).bindTooltip("U of A Quad");
  layer = L.layerGroup().addTo(map);
} else {
  $("#map").innerHTML = `<div class="empty" style="box-shadow:none">Map couldn't load. Check your internet connection.</div>`;
}

function renderMap() {
  const { recs } = current;
  $("#map-sub").textContent = recs.length ? `Your top ${recs.length} picks, numbered like on the home screen.` : "Pick who's eating on the home screen first.";
  const pinned = recs.map((rec, i) => ({ rec, i })).filter(({ rec }) => rec.restaurant.lat != null);
  const missing = recs.length - pinned.length;
  $("#map-note").textContent = missing ? `${missing} pick${missing > 1 ? "s aren't" : " isn't"} on the map yet (no coordinates). Run the map import or add lat/lon in restaurants.csv.` : "";
  $("#map-list").innerHTML = recs.map((rec, i) => `
    <button class="map-row" data-open="${i}"><span class="num">${i + 1}</span>
      <span><span class="t">${esc(rec.restaurant.name)}</span><br><span class="s">${esc(rec.restaurant.location || "Near campus")} · ${tripText(rec.restaurant)}</span></span>
      <span class="match">${Math.round(rec.score * 100)}%</span></button>`).join("");
  if (!map) return;
  layer.clearLayers();
  const pts = [];
  for (const { rec, i } of pinned) {
    const r = rec.restaurant;
    const icon = L.divIcon({ className: "", html: `<div class="pin"><span>${i + 1}</span></div>`, iconSize: [32, 32], iconAnchor: [16, 34] });
    L.marker([r.lat, r.lon], { icon }).addTo(layer).on("click", () => openSheet(i));
    pts.push([r.lat, r.lon]);
  }
  if (pts.length) map.fitBounds([...pts, CAMPUS], { padding: [40, 40], maxZoom: 15 });
  else map.setView(CAMPUS, 13);
}

// ---- rate -----------------------------------------------------------------------------------
let stars = 4;
const ratings = store.get("ffo.ratings", []);
$("#rate-person").innerHTML = peopleList.map((p) => `<option>${esc(p.name)}</option>`).join("");
$("#places").innerHTML = [...new Set(restaurants.map((r) => r.name))].sort().map((n) => `<option value="${esc(n)}"></option>`).join("");
function renderStars() {
  $("#stars").innerHTML = [1, 2, 3, 4, 5]
    .map((n) => `<button class="star ${n <= stars ? "on" : ""}" data-n="${n}" role="radio" aria-checked="${n === stars}" aria-label="${n} star${n > 1 ? "s" : ""}">★</button>`).join("");
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
  $("#ratings-list").innerHTML = ratings.length
    ? [...ratings].reverse().map((r) => `<div class="rating-row"><span><b>${esc(r.person)}</b> · ${esc(r.restaurant)}</span><span class="stars-txt">${"★".repeat(r.rating)}</span></div>`).join("")
    : `<p class="muted small">No ratings yet.</p>`;
}
$("#download").addEventListener("click", () => {
  const blob = new Blob([toCSV(ratings, ["person", "restaurant", "rating", "date"])], { type: "text/csv" });
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: "ratings.csv" });
  a.click();
  URL.revokeObjectURL(a.href);
});
$("#clear-ratings").addEventListener("click", () => { ratings.length = 0; store.set("ffo.ratings", ratings); renderRatings(); });

// ---- crew -----------------------------------------------------------------------------------
const tags = (xs, cls = "") => (xs?.length ? xs.map((x) => `<span class="tag ${cls}">${esc(x)}</span>`).join("") : `<span class="tag">anything</span>`);
$("#crew-grid").innerHTML = peopleList.map((p) => `
  <div class="crew-card">
    <div class="crew-top"><span class="face" style="background:${faceColor[p.name]}">${esc(initials(p.name))}</span>
      <div><h3>${esc(p.name)}</h3><p>$${p.budget ?? 20} budget · up to ${p.max_travel_min ?? 30} min away${p.calorie_goal_per_meal ? ` · ~${p.calorie_goal_per_meal} cal/meal` : ""}</p></div></div>
    <div class="crew-sec"><div class="k">Loves</div><div class="tags">${tags(p.favorite_cuisines, "green")}</div></div>
    ${p.favorite_places?.length ? `<div class="crew-sec"><div class="k">Go-tos</div><div class="tags">${tags(p.favorite_places)}</div></div>` : ""}
    <div class="crew-sec"><div class="k">Can eat</div><div class="tags">${tags(p.can_eat_proteins)}</div></div>
    ${[...(p.avoid_cuisines ?? []), ...(p.soft_avoid ?? [])].length ? `<div class="crew-sec"><div class="k">Avoids</div><div class="tags">${tags([...(p.avoid_cuisines ?? []), ...(p.soft_avoid ?? [])], "red")}</div></div>` : ""}
    ${p.notes ? `<p class="crew-note">${esc(p.notes)}</p>` : ""}
  </div>`).join("");

// ---- go -------------------------------------------------------------------------------------
function update() {
  store.set("ffo.who", [...state.who]);
  store.set("ffo.plan", state.plan);
  renderPeople();
  renderPlans();
  renderMoods();
  $("#nearby").setAttribute("aria-pressed", state.nearby);
  renderResults();
}
renderStars();
renderRatings();
update();
