import { OCCASIONS, prepareRestaurants, recommend, samePlace, nameList } from "./lib/recommender.js";
import { parseCSV, toCSV } from "./lib/csv.js";
import { CUISINES, matchesCuisine, extraCuisines } from "./lib/cuisines.js";
import { createRatingsStore } from "./lib/cloud.js";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";

const CAMPUS = [53.5263, -113.525];
const PLAN_LABELS = {
  any: "Anything", coffee: "Coffee & matcha", "quick snack": "Quick snack", lunch: "Lunch", dinner: "Dinner",
  "late-night": "Late-night", "drive-thru": "Drive-thru", dessert: "Dessert", "on campus": "On campus",
};
const PLAN_EMOJI = {
  any: "✨", coffee: "☕", "quick snack": "🥨", lunch: "🥪", dinner: "🍝", "late-night": "🌙", "drive-thru": "🚗", dessert: "🍨", "on campus": "🎓",
};
// Food tile for each card, matched to the place's name, dishes or cuisine (no photos of real restaurants).
const ART = [
  // Drinks and sweets first, so "Vietnamese coffee" is a coffee, not noodles.
  [["bubble tea", "boba", "milk tea", "matcha"], "🧋"], [["smoothie", "juice"], "🥤"],
  [["ice cream", "gelato", "dessert", "donut", "doughnut"], "🍩"], [["bakery", "croissant", "pastr"], "🥐"],
  [["coffee", "cafe", "espresso", "london fog"], "☕"],
  [["sushi", "japanese", "poke", "hawaiian", "izakaya"], "🍣"], [["ramen", "noodle", "pho", "vietnamese", "udon"], "🍜"],
  [["korean"], "🥘"], [["dumpling", "momo"], "🥟"], [["chinese", "chow mein", "fried rice", "wok"], "🥡"], [["thai", "curry", "indian", "biryani", "dosa"], "🍛"],
  [["shawarma", "middle eastern", "arabic", "lebanese", "kebab", "donair", "mediterranean", "greek", "turkish", "falafel"], "🥙"],
  [["mexican", "taco", "burrito"], "🌮"], [["pizza"], "🍕"], [["italian", "pasta"], "🍝"],
  [["burger", "fast food", "american"], "🍔"], [["bbq", "barbecue", "steak"], "🥩"], [["subway", "sandwich", "sub", "wrap", "panini"], "🥪"],
  [["brunch", "breakfast", "pancake"], "🥞"], [["vegan", "bowls", "salad"], "🥗"], [["chicken", "wings"], "🍗"], [["seafood", "fish"], "🦐"],
];
const FACE_COLORS = ["#c8431d", "#7c5cbf", "#2f7d4f", "#b4517a", "#2d6aa8", "#a8741a", "#5b6b2f", "#8a4b3b", "#3d7f86", "#6b5b95"];

const store = {
  get(k, fallback) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fallback; } catch { return fallback; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const title = (s) => String(s).replace(/\b\w/g, (c) => c.toUpperCase());
// Reasons come from the recommender with a leading emoji; the interface shows them as plain text.
const clean = (s) => String(s).replace(/^[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}️‍\s]+/u, "");
const ICON = {
  pin: '<svg viewBox="0 0 24 24"><path d="M12 22s7-6.2 7-12a7 7 0 1 0-14 0c0 5.8 7 12 7 12Z"/><circle cx="12" cy="10" r="2.5"/></svg>',
  clock: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  wallet: '<svg viewBox="0 0 24 24"><rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10h18M16 14.5h2"/></svg>',
  star: '<svg viewBox="0 0 24 24"><path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.3 6.5 20.2l1-6.2L3 9.6l6.2-.9Z"/></svg>',
  alert: '<svg viewBox="0 0 24 24"><path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 2.4 17.6A2 2 0 0 0 4.1 20.6h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/></svg>',
  close: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  directions: '<svg viewBox="0 0 24 24"><path d="M3 11 21 3l-8 18-2-8Z"/></svg>',
};

// ---- data ----------------------------------------------------------------------------
const cloud = createRatingsStore({ url: SUPABASE_URL, key: SUPABASE_ANON_KEY });
let cloudOk = cloud.enabled; // false if not set up, or if the database couldn't be reached
const [restaurants, peopleList, crewRatings, shared] = await Promise.all([
  fetch("data/restaurants.csv").then((r) => r.text()).then(prepareRestaurants),
  fetch("data/people.json").then((r) => r.json()),
  fetch("data/ratings.csv").then((r) => (r.ok ? r.text() : "")).then((t) => (t ? parseCSV(t) : [])).catch(() => []),
  cloud.load().catch((e) => { console.warn("Shared ratings unavailable:", e); cloudOk = false; return []; }),
]);
const people = Object.fromEntries(peopleList.map((p) => [p.name, p]));
const faceColor = Object.fromEntries(peopleList.map((p, i) => [p.name, FACE_COLORS[i % FACE_COLORS.length]]));
const initials = (n) => n.split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();

const state = {
  who: new Set(store.get("ffo.who", ["Riri"]).filter((n) => people[n])),
  plan: store.get("ffo.plan", "any"),
  cuisines: new Set(),
  showAllCuisines: false,
  nearby: false,
  hangout: false,
  surprise: 0,
  priceMin: 1,
  priceMax: 500,
  shown: 50, // up to 50 picks on screen at first; "Show more" adds 25
};
const FIRST_PAGE = 50;
const PAGE = 25;
let lastQuery = "";
if (!state.who.size && peopleList.length) state.who.add(peopleList[0].name);
let current = { recs: [], excluded: [] };

// ---- small helpers ---------------------------------------------------------------------
// $ = up to $10 per person, $$ = $11-$34, $$$ = $35 and up.
const price = (c) => (c <= 10 ? "$" : c < 35 ? "$$" : "$$$");
const known = (r) => !(r.distance_km == null && r.travel_min == null);
function tripText(r) {
  if (!known(r)) return "";
  if (state.plan === "drive-thru" || r.how === "drive" || r.travel_min == null) return `${r.distance_km} km away`;
  return `${Math.max(1, r.travel_min)} min`;
}
function howText(r) {
  if (!known(r)) return "Location not added yet";
  if (state.plan === "drive-thru" || r.how === "drive") return `${r.distance_km} km from campus by car`;
  return r.how ? `${r.how.charAt(0).toUpperCase()}${r.how.slice(1)}` : `About ${r.travel_min} min from campus`;
}
const placeLabel = (r) => r.location || (known(r) ? "Near campus" : "Location TBC");
function cuisineLabel(r) {
  if (r.cuisines.some((x) => ["cafe", "coffee", "coffee shop"].includes(x))) return "Café";
  const c = CUISINES.find((x) => x.id !== "coffee" && x.id !== "dessert" && matchesCuisine(r, x));
  if (c) return c.label;
  if (r.good_for.includes("coffee")) return "Café";
  if (r.good_for.includes("dessert")) return "Dessert";
  const raw = r.cuisines.find((x) => !["restaurant", "regional", "fast food", "cafe", "coffee shop"].includes(x));
  return raw ? title(raw) : r.cuisines.includes("fast food") ? "Fast food" : "";
}
function directionsUrl(r) {
  const dest = r.lat != null ? `${r.lat},${r.lon}` : encodeURIComponent(`${r.name} Edmonton`);
  const mode = state.plan === "drive-thru" || r.how === "drive" ? "driving" : "transit";
  return `https://www.google.com/maps/dir/?api=1&origin=University+of+Alberta&destination=${dest}&travelmode=${mode}`;
}

// A static map centred on the place (OpenStreetMap tiles), used in the detail panel.
// Places without coordinates get a monogram instead.
const tileUrl = (z, x, y) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`;
const monogram = (name) => name.replace(/[^A-Za-z0-9 ]/g, "").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "•";
function smap(r, w, h, z = 15) {
  if (r.lat == null || r.lon == null) return `<div class="mono" aria-hidden="true">${esc(monogram(r.name))}</div>`;
  const n = 256 * 2 ** z;
  const px = ((r.lon + 180) / 360) * n;
  const lat = (r.lat * Math.PI) / 180;
  const py = ((1 - Math.log(Math.tan(lat) + 1 / Math.cos(lat)) / Math.PI) / 2) * n;
  let imgs = "";
  for (let tx = Math.floor((px - w / 2) / 256); tx <= Math.floor((px + w / 2) / 256); tx++)
    for (let ty = Math.floor((py - h / 2) / 256); ty <= Math.floor((py + h / 2) / 256); ty++)
      imgs += `<img src="${tileUrl(z, tx, ty)}" style="left:${Math.round(tx * 256 - px)}px;top:${Math.round(ty * 256 - py)}px" alt="" loading="lazy" decoding="async">`;
  return `<div class="smap" aria-hidden="true"><div class="tiles">${imgs}</div><span class="dot"></span></div>`;
}
function art(r, cls = "") {
  // The place's name and first-listed dishes say more than its cuisine tag ("Matcha Cafe" tagged japanese is still a cafe).
  const pick = (words) => { for (const w of words) for (const [keys, e] of ART) if (keys.some((k) => w.includes(k))) return e; return null; };
  // Order: signature (first-listed) dish, then the name, then other dishes, then cuisine tags.
  const emoji = pick([r.dishes[0] ?? "", r.name.toLowerCase(), ...r.dishes.slice(1)]) ?? pick(r.cuisines) ?? "🍽️";
  let h = 7;
  for (const c of r.name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return `<div class="art tone-${h % 6} ${cls}" aria-hidden="true">${emoji}</div>`;
}
// If a map tile can't load (offline, blocked), just leave the plain background.
document.addEventListener("error", (e) => { if (e.target.closest?.(".smap")) e.target.style.visibility = "hidden"; }, true);

// ---- navigation ----------------------------------------------------------------------
function go(view) {
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.id === view));
  document.querySelectorAll("[data-go]").forEach((b) => b.classList.toggle("active", b.dataset.go === view && !b.classList.contains("brand")));
  window.scrollTo({ top: 0 });
  if (view === "mapview") setTimeout(() => { map?.invalidateSize(); renderMap(); }, 30);
}
document.addEventListener("click", (e) => {
  const t = e.target.closest("[data-go]");
  if (t) go(t.dataset.go);
});

// ---- filters -----------------------------------------------------------------------------
function renderPeople() {
  $("#people").innerHTML = peopleList.map((p) => `
    <button class="avatar" data-name="${esc(p.name)}" aria-pressed="${state.who.has(p.name)}" title="${esc(p.name)}">
      <span class="face" style="background:${faceColor[p.name]}">${esc(initials(p.name))}</span>
      <span class="nm">${esc(p.name)}</span>
    </button>`).join("");
  const n = state.who.size;
  const first = [...state.who][0];
  $("#hello").textContent = n === 0 ? "Tap some faces. Nobody eats alone here."
    : n === 1 ? `Just you, ${first}. Treat yourself, you've earned it.`
    : n >= peopleList.length ? `The whole crew. Let's settle this before someone says "I don't mind".`
    : `${first} + ${n - 1} friend${n > 2 ? "s" : ""}. Let's settle this before someone says "I don't mind".`;
}
$("#people").addEventListener("click", (e) => {
  const name = e.target.closest(".avatar")?.dataset.name;
  if (!name) return;
  state.who.has(name) ? state.who.delete(name) : state.who.add(name);
  update();
});
$("#pick-all").addEventListener("click", () => { state.who = new Set(Object.keys(people)); update(); });
$("#pick-none").addEventListener("click", () => { state.who = new Set(["Riri"].filter((n) => people[n])); update(); });

function renderPlans() {
  $("#plans").innerHTML = ["any", ...OCCASIONS]
    .map((o) => `<button class="chip" data-plan="${o}" aria-pressed="${state.plan === o}"><span class="e">${PLAN_EMOJI[o] ?? ""}</span>${PLAN_LABELS[o] ?? title(o)}</button>`).join("");
}
$("#plans").addEventListener("click", (e) => {
  const plan = e.target.closest("[data-plan]")?.dataset.plan;
  if (plan) { state.plan = plan; state.surprise = 0; update(); }
});

const ALL_CUISINES = [...CUISINES, ...extraCuisines(restaurants)];
const cuisineById = Object.fromEntries(ALL_CUISINES.map((c) => [c.id, c]));
function renderCuisines() {
  const inPlan = restaurants.filter((r) => state.plan === "any" || r.good_for.includes(state.plan));
  const chips = (list) => list
    .map((c) => ({ c, n: inPlan.filter((r) => matchesCuisine(r, c)).length }))
    .filter(({ c, n }) => n > 0 || state.cuisines.has(c.id))
    .map(({ c, n }) => `<button class="chip" data-cuisine="${esc(c.id)}" aria-pressed="${state.cuisines.has(c.id)}"><span class="e">${c.emoji}</span>${esc(c.label)}<small>${n}</small></button>`)
    .join("");
  const extras = ALL_CUISINES.slice(CUISINES.length);
  $("#cuisines").innerHTML = chips(CUISINES) + chips(extras.filter((c) => state.showAllCuisines || state.cuisines.has(c.id))) +
    (extras.length ? `<button class="chip more" id="more-cuisines">${state.showAllCuisines ? "Show fewer" : `+${extras.length} more`}</button>` : "");
  $("#clear-cuisines").hidden = !state.cuisines.size;
}
$("#cuisines").addEventListener("click", (e) => {
  if (e.target.closest("#more-cuisines")) { state.showAllCuisines = !state.showAllCuisines; renderCuisines(); return; }
  const id = e.target.closest("[data-cuisine]")?.dataset.cuisine;
  if (!id) return;
  state.cuisines.has(id) ? state.cuisines.delete(id) : state.cuisines.add(id);
  state.surprise = 0;
  update();
});
$("#clear-cuisines").addEventListener("click", () => { state.cuisines.clear(); update(); });

// Budget slider: $1 to $500 on a curve, so $5-$30 (where most meals are) gets most of the room.
const PRICE_MAX = 500;
const toPrice = (t) => (t <= 0 ? 1 : Math.round(Math.pow(PRICE_MAX, t / 100)));
const toPos = (p) => (100 * Math.log(Math.max(1, p))) / Math.log(PRICE_MAX);
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
$("#hangout").addEventListener("click", () => { state.hangout = !state.hangout; update(); });
$("#surprise").addEventListener("click", () => { state.surprise = 1 + Math.floor(Math.random() * 1e6); update(); window.scrollTo({ top: 0, behavior: "smooth" }); });

// ---- results ---------------------------------------------------------------------------
function compute() {
  const group = [...state.who].map((n) => people[n]);
  const occasion = state.plan;
  const picked = [...state.cuisines].map((id) => cuisineById[id]).filter(Boolean);
  const filters = [];
  if (picked.length) filters.push((r) => picked.some((c) => matchesCuisine(r, c)));
  if (state.priceMin > 1 || state.priceMax < 500) filters.push((r) => r.avg_cost >= state.priceMin && r.avg_cost <= state.priceMax);
  if (state.hangout) filters.push((r) => r.perks.length > 0);
  if (state.nearby) filters.push((r) => r.travel_min != null && r.travel_min <= 15 && r.how !== "drive");
  const where = filters.length ? (r) => filters.every((f) => f(r)) : null;
  const craving = picked.map((c) => [c.label, ...c.words].join(" ")).join(" ");
  const res = recommend(group, restaurants, { occasion, craving, topN: Infinity, where, ratings: allRatings() });
  res.available = restaurants.filter((r) => (occasion === "any" || r.good_for.includes(occasion)) && (!where || where(r))).length;
  res.occasion = occasion;
  if (state.surprise && res.recs.length > 1) {
    const i = state.surprise % Math.min(12, res.recs.length); // surprise from the top 12
    const [pick] = res.recs.splice(i, 1);
    res.recs = [pick, ...res.recs];
  }
  return { ...res, group };
}

// ---- crew ratings (data/ratings.csv + shared database + this browser's unsaved ones) --------
// One rating per person per place: later sources win, so a re-rating replaces the old one.
const rateKey = (x) => `${x.person}|${x.restaurant}`.toLowerCase();
function dedupe(rows) {
  const m = new Map();
  for (const x of rows) m.set(rateKey(x), { ...x, rating: Number(x.rating) });
  return [...m.values()].filter((x) => x.rating >= 1);
}
const sharedRatings = () => dedupe([...crewRatings, ...[...shared].reverse()]);
function allRatings() {
  return dedupe([...sharedRatings(), ...ratings]);
}
function ratingFor(r) {
  const rows = allRatings().filter((x) => x.restaurant === r.name || samePlace(x.restaurant, r.name));
  if (!rows.length) return null;
  return { avg: rows.reduce((a, x) => a + x.rating, 0) / rows.length, count: rows.length, rows };
}
const shortList = (names) => (names.length > 4 ? `${names.slice(0, 3).join(", ")} & ${names.length - 3} more` : nameList(names));
function ratingReason(r) {
  const rt = ratingFor(r);
  if (!rt) return null;
  const mine = rt.rows.filter((x) => state.who.has(x.person) && x.rating >= 4);
  if (!mine.length) return null;
  const top = Math.max(...mine.map((x) => x.rating));
  const names = [...new Set(mine.map((x) => x.person))];
  if (names.length === 1 && state.who.size === 1) return `You rated it ${top}★`;
  if (names.length === state.who.size && names.length > 2) return `Everyone rated it ${top}★`;
  return `Rated ${top}★ by ${shortList(names)}`;
}
function ratingWarning(r) {
  const rt = ratingFor(r);
  if (!rt) return null;
  const meh = rt.rows.filter((x) => state.who.has(x.person) && x.rating <= 3);
  if (!meh.length) return null;
  const names = [...new Set(meh.map((x) => x.person))];
  const low = Math.min(...meh.map((x) => x.rating));
  const who = names.length === 1 && state.who.size === 1 ? "You" : shortList(names);
  return `${who} thought it was ${low <= 2 ? "not great" : "meh"} (${low}★)`;
}
const warningsFor = (rec, n) => [ratingWarning(rec.restaurant), rec.restaurant.heads_up || null, ...new Set(rec.perPerson.flatMap((p) => p.warnings))]
  .filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).slice(0, n);

// Plain-text reasons, with the rating line first and repeats of it dropped.
function reasonsFor(rec) {
  const rr = ratingReason(rec.restaurant);
  const base = rec.reasons.map(clean);
  const perks = (rec.restaurant.perks ?? []).map(clean);
  if (!rr) return [...perks, ...base];
  const raters = new Set(peopleList.map((p) => p.name).filter((n) => rr.includes(n)));
  const repeats = (raw) => {
    if (!/^(🤤|📍)/.test(raw)) return false;
    if (rr.startsWith("You") || rr.startsWith("Everyone")) return true;
    const named = peopleList.map((p) => p.name).filter((n) => raw.includes(n));
    return named.length > 0 && named.every((n) => raters.has(n));
  };
  return [rr, ...perks, ...rec.reasons.filter((x) => !repeats(x)).map(clean)];
}
// The one playful line on the top pick: the taste guess if there is one ("Star is going to want this").
const tagline = (rec) => clean(rec.reasons.find((x) => x.startsWith("🤤")) ?? "");

function facts(r, { place = true } = {}) {
  const rt = ratingFor(r);
  const parts = [
    place ? `<span>${esc(placeLabel(r))}</span>` : "",
    cuisineLabel(r) ? `<span>${esc(cuisineLabel(r))}</span>` : "",
    `<span class="price">${price(r.avg_cost)}</span>`,
    rt ? `<span class="rated"><i>★</i> ${rt.avg.toFixed(1)} <span class="muted">(${rt.count})</span></span>` : "",
    tripText(r) ? `<span>${esc(tripText(r))}</span>` : "",
  ];
  return `<div class="facts">${parts.join("")}</div>`;
}

function topPick(rec, groupSize) {
  const r = rec.restaurant;
  const label = state.surprise ? "🎲 Fate has chosen" : groupSize > 1 ? "The group's pick" : "Your top pick";
  const tl = tagline(rec);
  const why = reasonsFor(rec).filter((x) => x !== tl).slice(0, 4);
  const warns = warningsFor(rec, 2);
  return `
  <button class="top-pick" data-open="0">
    ${art(r, "big")}
    <div class="tp-body">
      <span class="eyebrow">${label}</span>
      <h3>${esc(r.name)}</h3>
      ${facts(r)}
      ${tl ? `<p class="tagline">${esc(tl)}.</p>` : ""}
      ${why.length ? `<ul class="why">${why.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}
      ${warns.map((w) => `<p class="note">${esc(w)}</p>`).join("")}
      <div class="score"><b>${Math.round(rec.score * 100)}%</b><span>match</span></div>
    </div>
  </button>`;
}

function row(rec, i) {
  const r = rec.restaurant;
  const why = reasonsFor(rec).slice(0, 2);
  const warn = [ratingWarning(r), r.heads_up].filter(Boolean)[0];
  return `
  <button class="row" data-open="${i}">
    <span class="rank">${i + 1}</span>
    ${art(r)}
    <div>
      <h3>${esc(r.name)}</h3>
      ${facts(r)}
      ${why.length ? `<p class="why-line">${why.map(esc).join(" · ")}</p>` : ""}
      ${warn ? `<p class="note">${esc(warn)}</p>` : ""}
    </div>
    <span class="pct">${Math.round(rec.score * 100)}%</span>
  </button>`;
}

function renderResults() {
  current = compute();
  const { recs, excluded, group } = current;
  const query = JSON.stringify([[...state.who].sort(), state.plan, [...state.cuisines].sort(), state.nearby, state.hangout, state.priceMin, state.priceMax, state.surprise]);
  if (query !== lastQuery) { state.shown = FIRST_PAGE; lastQuery = query; }
  renderFilterNote();

  const plan = state.plan === "any" ? "" : ` for ${PLAN_LABELS[state.plan].toLowerCase()}`;
  $("#results-title").textContent = !group.length ? "Who's hungry?" : recs.length ? `${recs.length} ${recs.length === 1 ? "spot" : "spots"}${plan}. No excuses.` : "Hmm.";
  $("#results-sub").textContent = group.length && recs.length ? `Ranked for ${group.length === 1 ? group[0].name : `${group.length} people`}, best match first` : "";

  if (!group.length) {
    $("#featured").innerHTML = `<div class="empty"><strong>It's quiet in here</strong>Tap at least one hungry person on the left.</div>`;
    $("#results").innerHTML = "";
  } else if (!recs.length && !current.available) {
    const filtered = state.priceMin > 1 || state.priceMax < 500 || state.nearby || state.hangout || state.cuisines.size;
    $("#featured").innerHTML = filtered
      ? `<div class="empty"><strong>Nothing matches those filters</strong>Your standards are impressive. Try a wider budget, another craving, or turning off an extra.</div>`
      : `<div class="empty"><strong>No ${esc(PLAN_LABELS[state.plan].toLowerCase())} spots yet</strong>Run <code>python scripts/fetch_places.py</code> to pull in real places from the map.</div>`;
    $("#results").innerHTML = "";
  } else if (!recs.length) {
    const why = [...new Set(excluded.map((e) => e.reason))].slice(0, 2).join("; ");
    $("#featured").innerHTML = `<div class="empty"><strong>Someone's being picky</strong>${esc(why)}.<br>Try a different vibe, or leave someone at home.</div>`;
    $("#results").innerHTML = "";
  } else {
    $("#featured").innerHTML = topPick(recs[0], group.length);
    $("#results").innerHTML = recs.slice(1, state.shown).map((rec, i) => row(rec, i + 1)).join("");
  }
  updateMoreButton();
  const ex = $("#excluded");
  ex.hidden = !excluded.length;
  ex.querySelector("summary").textContent = `${excluded.length} ruled out for this group`;
  ex.querySelector("ul").innerHTML = excluded.slice(0, 40).map((e) => `<li><b>${esc(e.name)}</b>: ${esc(e.reason)}</li>`).join("")
    + (excluded.length > 40 ? `<li>…and ${excluded.length - 40} more</li>` : "");
  if ($("#mapview").classList.contains("active")) renderMap();
}
function updateMoreButton() {
  const total = current.recs.length;
  const visible = Math.min(state.shown, total);
  $("#more-title").textContent = total > 1 ? `More options · showing ${visible} of ${total}` : "";
  const more = $("#show-more");
  more.hidden = total <= state.shown;
  more.textContent = `Show ${Math.min(PAGE, total - state.shown)} more`;
}
document.addEventListener("click", (e) => {
  const t = e.target.closest("[data-open]");
  if (t) openSheet(Number(t.dataset.open));
});
$("#show-more").addEventListener("click", () => {
  if (state.shown >= current.recs.length) return;
  state.shown = Math.min(state.shown + PAGE, current.recs.length);
  const before = document.querySelectorAll("#results .row").length;
  $("#results").insertAdjacentHTML("beforeend", current.recs.slice(before + 1, state.shown).map((rec, i) => row(rec, before + i + 1)).join(""));
  updateMoreButton();
  if ($("#mapview").classList.contains("active")) renderMap();
});

function renderFilterNote() {
  const on = state.priceMin > 1 || state.priceMax < 500;
  $("#filter-note").innerHTML = on
    ? `<div class="filter-note"><span>Budget filter: <b>$${state.priceMin} – $${state.priceMax}${state.priceMax >= 500 ? "+" : ""}</b>. Most prices are estimates, so this can hide good spots.</span><button class="link" id="reset-budget">Reset</button></div>`
    : "";
}
document.addEventListener("click", (e) => {
  if (!e.target.closest("#reset-budget")) return;
  $("#bmin").value = 0; $("#bmax").value = 100;
  state.priceMin = 1; state.priceMax = 500;
  renderBudget();
  update();
});

// ---- detail sheet -------------------------------------------------------------------------
function openSheet(i) {
  const rec = current.recs[i];
  if (!rec) return;
  const r = rec.restaurant;
  const rt = ratingFor(r);
  const tl = tagline(rec);
  const why = reasonsFor(rec).filter((x) => x !== tl);
  const warns = warningsFor(rec, 6);
  const scores = [...rec.perPerson].sort((x, y) => y.score - x.score);
  $("#sheet").innerHTML = `
    <div class="banner">${smap(r, 620, 240, 16)}<button class="close" id="sheet-close" aria-label="Close">${ICON.close}</button></div>
    <div class="sheet-body">
      <span class="eyebrow">${Math.round(rec.score * 100)}% match</span>
      <h3>${esc(r.name)}</h3>
      ${facts(r, { place: false })}
      ${tl ? `<p class="tagline">${esc(tl)}.</p>` : ""}
      <div class="detail">
        <div>${ICON.pin}<span><b>${esc(placeLabel(r))}</b>${esc(howText(r))}</span></div>
        <div>${ICON.clock}<span><b>${r.opening_hours ? "Hours" : "Hours not listed"}</b>${esc(r.opening_hours || "Check before you go")}</span></div>
        <div>${ICON.wallet}<span><b>About $${Math.round(r.avg_cost)} per person</b>${r.verified === "yes" ? "Checked price" : "Estimate"}</span></div>
        ${rt ? `<div>${ICON.star}<span><b>${rt.avg.toFixed(1)} from ${rt.count} crew rating${rt.count > 1 ? "s" : ""}</b>${esc(nameList([...new Set(rt.rows.map((x) => x.person))]))}</span></div>` : ""}
        ${warns.map((w) => `<div style="color:var(--warn)">${ICON.alert}<span>${esc(w)}</span></div>`).join("")}
      </div>
      ${why.length ? `<h4>Why it's a match</h4><ul class="why">${why.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}
      ${scores.length > 1 ? `<h4>How everyone feels</h4><div class="people-scores">${scores.map((p) => `
        <div class="ps"><span class="face" style="background:${faceColor[p.name]}" title="${esc(p.name)}">${esc(initials(p.name))}</span><span class="track"><i style="width:${Math.round(p.score * 100)}%"></i></span><span class="pc">${Math.round(p.score * 100)}%</span></div>`).join("")}</div>` : ""}
      ${r.description && !/^(restaurant|cafe|fast food)/i.test(r.description) ? `<p class="muted small" style="margin-top:16px">${esc(r.description)}</p>` : ""}
      <a class="btn full" href="${directionsUrl(r)}" target="_blank" rel="noopener">${ICON.directions} Get directions</a>
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
    maxZoom: 19, className: "soft-tiles",
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);
  L.circleMarker(CAMPUS, { radius: 6, color: "#fff", weight: 3, fillColor: "#1f1a17", fillOpacity: 1 }).addTo(map).bindTooltip("U of A Quad");
  layer = L.layerGroup().addTo(map);
} else {
  $("#map").innerHTML = `<div class="empty" style="border:0">The map couldn't load. Check your internet connection.</div>`;
}

function renderMap() {
  const recs = current.recs.slice(0, state.shown);
  $("#map-sub").textContent = recs.length ? `Your top ${recs.length} picks, numbered like on Discover. Pick the closest, or the tastiest. Your call.` : "Pick who's hungry on Discover first.";
  const pinned = recs.map((rec, i) => ({ rec, i })).filter(({ rec }) => rec.restaurant.lat != null);
  const missing = recs.length - pinned.length;
  $("#map-note").textContent = missing ? `${missing} pick${missing > 1 ? "s aren't" : " isn't"} pinned yet (no location).` : "";
  $("#map-list").innerHTML = recs.map((rec, i) => `
    <button class="row" data-open="${i}"><span class="rank">${i + 1}</span>
      <div><h3>${esc(rec.restaurant.name)}</h3>${facts(rec.restaurant)}</div>
      <span class="pct">${Math.round(rec.score * 100)}%</span></button>`).join("");
  if (!map) return;
  layer.clearLayers();
  const pts = [];
  for (const { rec, i } of pinned) {
    const r = rec.restaurant;
    const icon = L.divIcon({ className: "", html: `<div class="pin">${i + 1}</div>`, iconSize: [28, 28], iconAnchor: [14, 14] });
    L.marker([r.lat, r.lon], { icon, title: r.name }).addTo(layer).on("click", () => openSheet(i));
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
const keepLocal = (entry) => {
  const i = ratings.findIndex((x) => rateKey(x) === rateKey(entry));
  if (i >= 0) ratings.splice(i, 1);
  ratings.push(entry);
  store.set("ffo.ratings", ratings);
};
const addShared = (rows) => {
  for (const x of rows) {
    const i = shared.findIndex((y) => rateKey(y) === rateKey(x));
    if (i >= 0) shared.splice(i, 1);
    shared.unshift(x);
  }
};
// Ratings saved on this device while the database was unreachable get sent on the next visit.
async function syncPending() {
  if (!cloudOk || !ratings.length) return;
  const pending = [...ratings];
  try {
    await cloud.save(pending);
    addShared(pending);
    ratings.length = 0;
    store.set("ffo.ratings", ratings);
    renderRatings();
    update();
  } catch (e) { console.warn("Couldn't sync saved ratings yet:", e); }
}
$("#save-rating").addEventListener("click", async () => {
  const place = $("#rate-place").value.trim();
  const msg = $("#rate-msg");
  const btn = $("#save-rating");
  if (!restaurants.some((r) => r.name === place)) { msg.textContent = "Pick a place from the list."; return; }
  const entry = { person: $("#rate-person").value, restaurant: place, rating: stars, date: new Date().toISOString().slice(0, 10) };
  const verdict = stars >= 5 ? "Iconic." : stars <= 2 ? "Noted. Never again." : "Fair.";
  let where = "on this device";
  if (cloudOk) {
    btn.disabled = true;
    msg.textContent = "Saving…";
    try { await cloud.save(entry); addShared([entry]); where = "for the whole crew"; }
    catch (e) { console.warn(e); keepLocal(entry); where = "on this device for now (couldn't reach the shared list, it'll sync next visit)"; }
    btn.disabled = false;
  } else keepLocal(entry);
  msg.textContent = `Saved ${where}. ${entry.person} gave ${place} ${stars}/5. ${verdict}`;
  $("#rate-place").value = "";
  renderRatings();
  update();
});
function renderRatings() {
  // One row per place: everyone's ratings averaged, with this device's unsaved ones folded in and tagged.
  const tag = cloud.enabled ? "not synced yet" : "new";
  const pending = new Set(ratings.map(rateKey));
  const byPlace = new Map();
  for (const x of [...ratings].reverse()) byPlace.set(x.restaurant, []); // new ones go first
  for (const x of allRatings()) byPlace.set(x.restaurant, [...(byPlace.get(x.restaurant) ?? []), x]);
  const rows = [...byPlace].filter(([, rs]) => rs.length).map(([place, rs]) => {
    const avg = rs.reduce((a, x) => a + x.rating, 0) / rs.length;
    const isNew = rs.some((x) => pending.has(rateKey(x)));
    return `<div class="rating-row"><span><b>${esc(place)}</b> <span class="muted">· ${esc(shortList(rs.map((x) => x.person)))}</span>${isNew ? ` <span class="muted small">${tag}</span>` : ""}</span><span class="stars-txt">★ ${avg.toFixed(1)}</span></div>`;
  });
  $("#ratings-list").innerHTML = rows.length ? rows.join("") : `<p class="muted small">No ratings yet.</p>`;
}
$("#ratings-note").textContent = cloudOk
  ? "Ratings are shared with the whole crew. Download saves a backup of all of them."
  : cloud.enabled
    ? "Couldn't reach the shared ratings right now, so new ones are saved in this browser and sync next visit."
    : "New ratings are saved in this browser. Download them and add the rows to data/ratings.csv.";
$("#download").addEventListener("click", () => {
  const rows = cloudOk ? allRatings() : ratings;
  const blob = new Blob([toCSV(rows, ["person", "restaurant", "rating", "date"])], { type: "text/csv" });
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: "ratings.csv" });
  a.click();
  URL.revokeObjectURL(a.href);
});
$("#clear-ratings").addEventListener("click", () => { ratings.length = 0; store.set("ffo.ratings", ratings); renderRatings(); update(); });

// ---- crew -----------------------------------------------------------------------------------
const tags = (xs, cls = "") => xs.map((x) => `<span class="tag ${cls}">${esc(x)}</span>`).join("");
$("#crew-grid").innerHTML = peopleList.map((p) => {
  const avoids = [...(p.avoid_cuisines ?? []), ...(p.soft_avoid ?? [])];
  const meats = p.can_eat_proteins?.filter((x) => x !== "vegetarian");
  return `
  <div class="crew-card">
    <div class="crew-top"><span class="face" style="background:${faceColor[p.name]}">${esc(initials(p.name))}</span>
      <div><h3>${esc(p.name)}</h3><p>$${p.budget ?? 20} budget · up to ${p.max_travel_min ?? 30} min away${p.calorie_goal_per_meal ? ` · ~${p.calorie_goal_per_meal} cal per meal` : ""}</p></div></div>
    <div class="crew-sec"><div class="k">Loves</div><div class="tags">${p.favorite_cuisines?.length ? tags(p.favorite_cuisines.map(title), "green") : '<span class="tag">Anything</span>'}</div></div>
    ${p.favorite_places?.length ? `<div class="crew-sec"><div class="k">Go-tos</div><div class="tags">${tags(p.favorite_places)}</div></div>` : ""}
    <div class="crew-sec"><div class="k">Meat</div><div class="tags">${meats?.length ? tags(meats.map(title)) + '<span class="tag green">+ all veggie food</span>' : '<span class="tag">Any meat</span>'}</div></div>
    ${avoids.length ? `<div class="crew-sec"><div class="k">Avoids</div><div class="tags">${tags(avoids.map(title), "red")}</div></div>` : ""}
    ${p.notes ? `<p class="crew-note">${esc(p.notes)}</p>` : ""}
  </div>`;
}).join("");

// ---- go -------------------------------------------------------------------------------------
function update() {
  store.set("ffo.who", [...state.who]);
  store.set("ffo.plan", state.plan);
  renderPeople();
  renderPlans();
  renderCuisines();
  $("#nearby").setAttribute("aria-pressed", state.nearby);
  $("#hangout").setAttribute("aria-pressed", state.hangout);
  renderResults();
}
renderStars();
renderRatings();
update();
syncPending();
