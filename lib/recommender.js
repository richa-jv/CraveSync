// FFO Match recommender.
// Pipeline: occasion filter -> hard filters -> per-person scoring -> group blend -> explanations.
// Runs in the browser and in Node (for tests / evaluation).
import { parseCSV } from "./csv.js";

export const OCCASIONS = ["coffee", "quick snack", "lunch", "dinner", "late-night", "drive-thru", "dessert", "on campus"];

// "dessert" and "on campus" are worked out from each place's data, so they work with any restaurant list.
const DESSERT_WORDS = ["dessert", "ice cream", "gelato", "donut", "doughnut", "bubble tea", "boba", "cake", "bakery",
  "pastr", "crepe", "waffle", "frozen yogurt", "froyo", "cookie", "mochi", "churro", "chocolate", "cupcake", "macaron", "sweets"];
const CAMPUS_LOCATIONS = /^(on campus|sub|hub|cab|ecertl|ccis|lister|education|tory|business)\b/i;

// For drive-thrus you're driving, so distance matters much less (km you'd happily drive).
export const DRIVE_KM = 15;
// Default longest trip (minutes from campus, walking / LRT / one bus) someone's happy with.
export const DEFAULT_MAX_TRAVEL_MIN = 30;
const WALK_MIN_PER_KM = 15.6; // used when a hand-entered place has no travel estimate

// Occasions where we don't require a protein everyone can eat (e.g. a coffee run).
const SNACK_OCCASIONS = new Set(["coffee", "quick snack", "dessert"]);

export const WEIGHTS = { cuisine: 0.2, place: 0.25, dish: 0.15, budget: 0.1, distance: 0.1, text: 0.2 };
const SOFT_AVOID_PENALTY = 0.12;
const CALORIE_BONUS = 0.1;
// How much the group score cares about the least-happy person (0 = pure average).
export const FAIRNESS = 0.4;

const split = (v) => String(v ?? "").split(";").map((s) => s.trim().toLowerCase()).filter(Boolean);
// Cached per list, since the same profile lists are checked against every place.
const LOWER = new WeakMap();
const lower = (xs) => {
  if (!xs) return new Set();
  let v = LOWER.get(xs);
  if (!v) LOWER.set(xs, (v = new Set(xs.map((x) => x.toLowerCase()))));
  return v;
};
const inter = (a, b) => [...a].filter((x) => b.has(x));
const title = (s) => s.replace(/\b\w/g, (c) => c.toUpperCase());

// ---- data -----------------------------------------------------------------------
export function prepareRestaurants(csvText) {
  return parseCSV(csvText).map((r) => {
    const out = {
      ...r,
      cuisines: split(r.cuisines),
      dishes: split(r.dishes),
      proteins: split(r.proteins),
      good_for: split(r.good_for),
      tags: split(r.tags),
      perks: String(r.perks ?? "").split(";").map((s) => s.trim()).filter(Boolean),
      avg_cost: Number(r.avg_cost) || 15,
      distance_km: r.distance_km === undefined || r.distance_km === "" ? null : Number(r.distance_km) || 0,
      travel_min: r.travel_min !== undefined && r.travel_min !== "" ? Number(r.travel_min) : null,
      how: r.how || "",
      lat: r.lat ? Number(r.lat) : null,
      lon: r.lon ? Number(r.lon) : null,
      location: r.location || "",
      description: r.description || "",
    };
    if (out.travel_min == null && out.how !== "drive" && out.distance_km != null) out.travel_min = Math.round(out.distance_km * WALK_MIN_PER_KM);
    out.doc = [out.name, out.description, ...out.cuisines, ...out.dishes, ...out.tags].join(" ");
    const sweetText = [out.name, ...out.cuisines, ...out.dishes, ...out.tags].join(" ").toLowerCase();
    if (!out.good_for.includes("dessert") && DESSERT_WORDS.some((w) => sweetText.includes(w))) out.good_for.push("dessert");
    if (!out.good_for.includes("on campus") && out.how !== "drive" && (CAMPUS_LOCATIONS.test(out.location) || (out.location === "" && out.distance_km != null && out.distance_km <= 0.5)))
      out.good_for.push("on campus");
    return out;
  });
}

// ---- text matching: character n-gram TF-IDF (so "spicy" ~ "spice") --------------
function charGrams(text, minN = 4, maxN = 5) {
  const grams = [];
  for (const word of text.toLowerCase().split(/\s+/).filter(Boolean)) {
    const w = ` ${word} `;
    for (let n = minN; n <= maxN; n++) {
      let offset = 0;
      grams.push(w.slice(offset, offset + n));
      while (offset + n < w.length) { offset++; grams.push(w.slice(offset, offset + n)); }
      if (offset === 0) break; // short word counted once
    }
  }
  return grams;
}

// Index built once per restaurant list, so thousands of places stay fast to search.
const INDEX = new WeakMap();
function weigh(grams, df, n) {
  const tf = new Map();
  for (const g of grams) tf.set(g, (tf.get(g) ?? 0) + 1);
  const v = new Map();
  let norm = 0;
  for (const [g, c] of tf) {
    const w = (1 + Math.log(c)) * (Math.log((1 + n) / (1 + (df.get(g) ?? 0))) + 1);
    v.set(g, w);
    norm += w * w;
  }
  norm = Math.sqrt(norm) || 1;
  for (const [g, w] of v) v.set(g, w / norm);
  return v;
}
function textIndex(restaurants) {
  let idx = INDEX.get(restaurants);
  if (idx) return idx;
  const grams = restaurants.map((r) => charGrams(r.doc));
  const df = new Map();
  for (const gs of grams) for (const g of new Set(gs)) df.set(g, (df.get(g) ?? 0) + 1);
  const n = restaurants.length + 1;
  idx = { df, n, vecs: new Map(restaurants.map((r, i) => [r, weigh(grams[i], df, n)])) };
  INDEX.set(restaurants, idx);
  return idx;
}
function querySims(idx, pool, query) {
  if (!query.trim()) return pool.map(() => 0);
  const q = weigh(charGrams(query), idx.df, idx.n);
  const sims = pool.map((r) => {
    const v = idx.vecs.get(r);
    let s = 0;
    for (const [g, w] of q) s += w * (v.get(g) ?? 0);
    return s;
  });
  const max = Math.max(0, ...sims);
  return max > 0 ? sims.map((x) => x / max) : sims;
}

export function textSimilarity(docs, query) {
  if (!query.trim()) return docs.map(() => 0);
  const all = [...docs, query].map((t) => charGrams(t));
  const df = new Map();
  for (const grams of all) for (const g of new Set(grams)) df.set(g, (df.get(g) ?? 0) + 1);
  const n = all.length;
  const vec = (grams) => {
    const tf = new Map();
    for (const g of grams) tf.set(g, (tf.get(g) ?? 0) + 1);
    const v = new Map();
    let norm = 0;
    for (const [g, c] of tf) {
      const w = (1 + Math.log(c)) * (Math.log((1 + n) / (1 + df.get(g))) + 1);
      v.set(g, w);
      norm += w * w;
    }
    norm = Math.sqrt(norm) || 1;
    for (const [g, w] of v) v.set(g, w / norm);
    return v;
  };
  const vecs = all.map(vec);
  const q = vecs.pop();
  const sims = vecs.map((v) => { let s = 0; for (const [g, w] of q) s += w * (v.get(g) ?? 0); return s; });
  const max = Math.max(...sims);
  return max > 0 ? sims.map((s) => s / max) : sims;
}

// ---- filters & scoring ------------------------------------------------------------
// "Jerusalem Shawarma" matches "Jerusalem Shawarma Whyte Ave"; "Bar Burrito (SUB)" matches "Bar Burrito".
const WORDS = new Map();
const words = (s) => {
  let v = WORDS.get(s);
  if (!v) WORDS.set(s, (v = String(s).toLowerCase().replace(/\(.*?\)/g, " ").replace(/['’]/g, "").split(/[^a-z0-9]+/).filter(Boolean)));
  return v;
};
export function samePlace(favorite, placeName) {
  const f = words(favorite), n = words(placeName);
  if (!f.length || !n.length) return false; // e.g. a name with no Latin letters can't "match" everything
  const [short, long] = f.length <= n.length ? [f, n] : [n, f];
  return short.every((w, i) => long[i] === w);
}
const meatList = (person) => (person.can_eat_proteins?.length ? person.can_eat_proteins.map((x) => x.toLowerCase()).filter((x) => x !== "vegetarian") : null);
const nameListOr = (xs) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} or ${xs.at(-1)}`);

export function hardFail(person, r, occasion) {
  const avoid = inter(lower(person.avoid_cuisines), new Set(r.cuisines));
  if (avoid.length) return `${person.name} avoids ${avoid.sort().join(", ")}`;

  // can_eat_proteins lists the only MEATS someone eats. Vegetarian food (and desserts, drinks)
  // is always fine, so a place is only ruled out if everything there is a meat they don't eat.
  // Empty proteins = we don't know the menu yet (e.g. from the map): keep it, but warn.
  const meats = meatList(person);
  if (meats && !SNACK_OCCASIONS.has(occasion) && r.proteins.length) {
    const ok = new Set([...meats, "vegetarian"]);
    if (!r.proteins.some((p) => ok.has(p)))
      return `only ${r.proteins.join(" / ")} here, and ${person.name} only eats ${nameListOr(meats)} for meat`;
  }
  return null;
}

// How much someone's own past rating of a place moves their score (they've been, they know).
export const RATING_NUDGE = { 5: 0.1, 4: 0.05, 3: -0.08, 2: -0.2, 1: -0.3 };

export function scorePerson(person, r, textSim, occasion = "any", myRating = null) {
  const name = person.name;
  const parts = {};
  const reasons = [];
  const warnings = [];
  // Structured "why", turned into friendly sentences by groupReasons().
  const likes = { cuisine: null, place: false, dish: null, safe: [], light: false, calories: null };

  // No stated favourites = "doesn't mind": neutral 0.5 so easy-going friends don't drag picks down.
  const favs = lower(person.favorite_cuisines);
  const hit = inter(favs, new Set(r.cuisines)).sort();
  // Loving a cuisine is a plus; anything else is neutral (people eat more than their favourites).
  parts.cuisine = hit.length ? 1 : 0.5;
  if (hit.length) { likes.cuisine = hit[0]; reasons.push(`${name} loves ${title(hit[0])} food`); }

  // A go-to place gets full marks; any other place is neutral (not being a go-to isn't a minus).
  const isFavPlace = (person.favorite_places ?? []).some((f) => samePlace(f, r.name));
  parts.place = isFavPlace ? 1 : 0.5;
  if (isFavPlace) { likes.place = true; reasons.push(`one of ${name}'s go-tos`); }

  const dishes = r.dishes.join(" ");
  // The map rarely lists dishes, so also look for the dish as whole words in the name ("Goat Curry House").
  const nameWords = ` ${r.name.toLowerCase().replace(/[^a-z0-9]+/g, " ")} `;
  // Exact dish matches first ("mcnuggets"), then partial ones ("fish" in "filet-o-fish").
  const dishHits = (person.favorite_dishes ?? [])
    .filter((d) => dishes.includes(d.toLowerCase()) || nameWords.includes(` ${d.toLowerCase()} `))
    .sort((a, b) => Number(r.dishes.includes(b.toLowerCase())) - Number(r.dishes.includes(a.toLowerCase())) || b.length - a.length);
  parts.dish = dishHits.length ? 1 : 0.5;
  if (dishHits.length) { likes.dish = dishHits[0]; reasons.push(`has ${dishHits[0]} for ${name}`); }

  const budget = person.budget ?? 20;
  parts.budget = r.avg_cost <= budget ? 1 : Math.max(0, 1 - (2 * (r.avg_cost - budget)) / budget);
  if (r.avg_cost > budget) warnings.push(`over ${name}'s $${budget} budget`);

  if (r.distance_km == null && r.travel_min == null) {
    parts.distance = 0.5; // location not known yet: neutral
  } else if (occasion === "drive-thru" || r.travel_min == null) {
    parts.distance = r.distance_km <= DRIVE_KM ? 1 : Math.max(0, 1 - (r.distance_km - DRIVE_KM) / DRIVE_KM);
  } else {
    // Score by travel time (walk / LRT / one bus), not straight-line distance.
    const maxT = person.max_travel_min ?? DEFAULT_MAX_TRAVEL_MIN;
    parts.distance = r.travel_min <= maxT ? 1 : Math.max(0, 1 - (r.travel_min - maxT) / maxT);
    if (r.travel_min > maxT) warnings.push(`~${r.travel_min} min away, longer than ${name}'s ${maxT} min`);
  }

  parts.text = textSim;

  let score = Object.entries(parts).reduce((s, [k, v]) => s + WEIGHTS[k] * v, 0);
  if (myRating) score += RATING_NUDGE[Math.round(myRating)] ?? 0;

  const soft = lower(person.soft_avoid);
  // A go-to place overrides general dislikes (e.g. "doesn't like shawarma, but loves Jerusalem Shawarma").
  const softHits = isFavPlace ? [] : inter(soft, new Set([...r.tags, ...r.cuisines, ...r.dishes])).sort();
  if (softHits.length) {
    score -= SOFT_AVOID_PENALTY * softHits.length;
    warnings.push(`${name} prefers to avoid ${softHits.join(", ")}`);
  } else if (["greasy", "high-sodium", "sugary"].some((t) => soft.has(t)) && r.tags.includes("light-options")) {
    score += CALORIE_BONUS;
    likes.light = true;
    reasons.push(`lighter, fresher option for ${name}`);
  }

  const goal = person.calorie_goal_per_meal;
  if (goal) {
    if (r.tags.includes("light-options")) { score += CALORIE_BONUS; likes.calories = goal; reasons.push(`easy to stay near ${name}'s ~${goal} cal meal goal`); }
    if (r.tags.includes("greasy")) { score -= CALORIE_BONUS; warnings.push(`harder to hit ${name}'s ~${goal} cal goal`); }
  }

  const allowed = person.can_eat_proteins;
  const meats = meatList(person);
  if (meats && !r.proteins.length && !SNACK_OCCASIONS.has(occasion))
    warnings.push(`${name} only eats ${nameListOr(meats)} for meat, so check the menu`);
  if (allowed?.length && allowed.length <= 3) {
    const ok = inter(lower(allowed), new Set(r.proteins)).filter((p) => p !== "vegetarian").sort();
    if (ok.length) { if (!SNACK_OCCASIONS.has(occasion)) likes.safe = ok; reasons.push(`${name} can get ${ok.join(" / ")}`); }
  }

  return { name, score: Math.min(1, Math.max(0, score)), reasons, warnings, likes };
}

// `where` is an optional extra filter, e.g. (r) => r.avg_cost <= 13 for a budget meal.
// `ratings` (optional): rows of { person, restaurant, rating } from past visits.
export function recommend(people, restaurants, { occasion = "any", craving = "", topN = 5, where = null, ratings = null } = {}) {
  if (!people.length) return { recs: [], excluded: [] };
  const pool = restaurants.filter(
    (r) => (!occasion || occasion === "any" || r.good_for.includes(occasion)) && (!where || where(r))
  );

  const idx = textIndex(restaurants);
  const sims = Object.fromEntries(
    people.map((p) => [p.name, querySims(idx, pool, `${p.likes_text ?? ""} ${craving} ${craving}`)])
  );

  // Each person's latest rating for each place (matched loosely by name, e.g. "Earls" ~ "Earls Kitchen + Bar").
  const byPerson = new Map();
  for (const x of ratings ?? []) {
    const n = Number(x.rating);
    if (n >= 1) byPerson.set(`${x.person}|${x.restaurant}`, n);
  }
  const ratedNames = [...new Set((ratings ?? []).map((x) => x.restaurant))];
  const ratingOf = (person, r) => {
    if (!byPerson.size) return null;
    const exact = byPerson.get(`${person}|${r.name}`);
    if (exact) return exact;
    for (const nm of ratedNames) if (samePlace(nm, r.name) && byPerson.has(`${person}|${nm}`)) return byPerson.get(`${person}|${nm}`);
    return null;
  };

  const recs = [];
  const excluded = [];
  pool.forEach((r, i) => {
    for (const p of people) {
      const fail = hardFail(p, r, occasion);
      if (fail) { excluded.push({ name: r.name, reason: fail }); return; }
    }
    const perPerson = people.map((p) => scorePerson(p, r, sims[p.name][i], occasion, ratingOf(p.name, r)));
    const vals = perPerson.map((s) => s.score);
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const score = vals.length === 1 ? mean : (1 - FAIRNESS) * mean + FAIRNESS * Math.min(...vals);
    // Reasons are only worked out when a card is actually shown (hundreds of matches, a few on screen).
    let reasons;
    recs.push({ restaurant: r, score, perPerson, get reasons() { return (reasons ??= groupReasons(perPerson, r, people)); } });
  });

  const near = (r) => r.travel_min ?? (r.distance_km == null ? 999 : r.distance_km * WALK_MIN_PER_KM);
  recs.sort((a, b) => b.score - a.score || near(a.restaurant) - near(b.restaurant));
  // One pick per chain: "Tim Hortons" and "Tim Hortons (drive-thru, Southgate)" count as the same place.
  const seen = new Set();
  const unique = recs.filter((rec) => {
    const key = words(rec.restaurant.name).join(" ");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { recs: unique.slice(0, topN), excluded };
}

// ---- friendly explanations -----------------------------------------------------------
const DISH_EMOJI = { goat: "🐐", "goat curry": "🐐", "curry goat": "🐐", mutton: "🐐", "goat biryani": "🐐", "chocolate croissant": "🥐", "5 dollar ramen": "🍜", "fries with tzatziki": "🍟", "london fog": "🫖", "vietnamese coffee": "☕", mcnuggets: "🍗", "teriyaki chicken": "🥢", pizza: "🍕", "kuttu paratha": "🫓", matcha: "🍵", coffee: "☕", shawarma: "🥙", "shish tawouk": "🥙", falafel: "🧆", hummus: "🧆", pasta: "🍝",
  sushi: "🍣", muffin: "🧁", "ice cream": "🍦", "bubble tea": "🧋", donut: "🍩", cake: "🍰", mochi: "🍡", beef: "🥩",
  "boneless wings": "🍗", "chicken burger": "🍔", seafood: "🦐", fish: "🐟" };
const DISH_NAMES = { "5 dollar ramen": "$5 ramen", "london fog": "London Fog", mcnuggets: "McNuggets", "vietnamese coffee": "Vietnamese coffee" };
export function nameList(names) {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} & ${names.at(-1)}`;
}

const GUESSES = [
  ["would probably love this", "would probably love this"],
  ["is going to want this", "are going to want this"],
  ["would be so into this", "would be so into this"],
  ["is basically drooling already", "are basically drooling already"],
];
const hash = (str) => [...String(str)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);

function groupReasons(perPerson, r, people) {
  const solo = people.length === 1;
  const out = [];
  // "everyone" when it's the whole group, "A, B, C & 2 more" when the list gets long.
  const names = (ns) => (ns.length === people.length && ns.length > 2 ? "everyone" : ns.length > 4 ? `${ns.slice(0, 3).join(", ")} & ${ns.length - 3} more` : nameList(ns));
  const whose = (ns) => (ns.length === people.length && ns.length > 2 ? "Everyone's" : `${names(ns)}'s`);
  const who = (pred) => perPerson.filter(pred).map((p) => p.name);

  // A taste match is a guess, not a review: "Star would probably love this", never "Loved by Star".
  // (Real opinions come from ratings and go-tos.) The phrasing varies a little per place, but stays put.
  const goTo = who((p) => p.likes.place);
  const fans = who((p) => (p.likes.cuisine || p.likes.dish) && !p.likes.place);
  if (fans.length) {
    const [one, many] = GUESSES[hash(r.name) % GUESSES.length];
    const all = fans.length === people.length && people.length > 2;
    out.push(solo ? "🤤 Right up your alley" : `🤤 ${all ? "Everyone" : names(fans)} ${fans.length === 1 ? one : many}`);
  }

  if (goTo.length) out.push(solo ? "📍 One of your go-tos" : goTo.length === people.length && goTo.length > 2 ? "📍 Everyone's go-to" : `📍 A go-to for ${names(goTo)}`);

  const byDish = new Map();
  for (const p of perPerson) if (p.likes.dish) byDish.set(p.likes.dish, [...(byDish.get(p.likes.dish) ?? []), p.name]);
  for (const [dish, ns] of byDish) out.push(`${DISH_EMOJI[dish] ?? "😋"} ${solo ? "Your" : whose(ns)} ${DISH_NAMES[dish] ?? dish} fix`);

  for (const p of perPerson) if (p.likes.safe.length)
    out.push(solo ? `✅ Has ${nameList(p.likes.safe)} for you` : `✅ Safe for ${p.name}: ${nameList(p.likes.safe)}`);

  const cost = Math.round(r.avg_cost);
  if (people.every((p) => r.avg_cost <= (p.budget ?? 20)))
    out.push(solo ? `💸 Broke-student approved (~$${cost})` : `💸 Broke-student approved for everyone (~$${cost})`);

  const light = who((p) => p.likes.light);
  if (light.length) out.push(solo ? "🥗 Light & fresh, just how you like it" : `🥗 Light & fresh for ${names(light)}`);
  for (const p of perPerson) if (p.likes.calories)
    out.push(solo ? `💪 Fits your ~${p.likes.calories} cal goal` : `💪 Fits ${p.name}'s ~${p.likes.calories} cal goal`);

  return [...new Set(out)].slice(0, 5);
}
