// FFO Match recommender.
// Pipeline: occasion filter -> hard filters -> per-person scoring -> group blend -> explanations.
// Runs in the browser and in Node (for tests / evaluation).
import { parseCSV } from "./csv.js";

export const OCCASIONS = ["coffee", "quick snack", "lunch", "dinner", "late-night", "drive-thru"];

// For drive-thrus you're driving, so distance matters much less (km you'd happily drive).
export const DRIVE_KM = 15;
// Default longest trip (minutes from campus, walking / LRT / one bus) someone's happy with.
export const DEFAULT_MAX_TRAVEL_MIN = 30;
const WALK_MIN_PER_KM = 15.6; // used when a hand-entered place has no travel estimate

// Occasions where we don't require a protein everyone can eat (e.g. a coffee run).
const SNACK_OCCASIONS = new Set(["coffee", "quick snack"]);

export const WEIGHTS = { cuisine: 0.2, place: 0.25, dish: 0.15, budget: 0.1, distance: 0.1, text: 0.2 };
const SOFT_AVOID_PENALTY = 0.12;
const CALORIE_BONUS = 0.1;
// How much the group score cares about the least-happy person (0 = pure average).
export const FAIRNESS = 0.4;

const split = (v) => String(v ?? "").split(";").map((s) => s.trim().toLowerCase()).filter(Boolean);
const lower = (xs) => new Set((xs ?? []).map((x) => x.toLowerCase()));
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
      avg_cost: Number(r.avg_cost) || 15,
      distance_km: Number(r.distance_km) || 0,
      travel_min: r.travel_min !== undefined && r.travel_min !== "" ? Number(r.travel_min) : null,
      how: r.how || "",
      lat: r.lat ? Number(r.lat) : null,
      lon: r.lon ? Number(r.lon) : null,
      location: r.location || "",
      description: r.description || "",
    };
    if (out.travel_min == null && out.how !== "drive") out.travel_min = Math.round(out.distance_km * WALK_MIN_PER_KM);
    out.doc = [out.name, out.description, ...out.cuisines, ...out.dishes, ...out.tags].join(" ");
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
const words = (s) => String(s).toLowerCase().replace(/\(.*?\)/g, " ").replace(/['’]/g, "").split(/[^a-z0-9]+/).filter(Boolean);
export function samePlace(favorite, placeName) {
  const f = words(favorite), n = words(placeName);
  if (!f.length) return false;
  const [short, long] = f.length <= n.length ? [f, n] : [n, f];
  return short.every((w, i) => long[i] === w);
}
export function hardFail(person, r, occasion) {
  const avoid = inter(lower(person.avoid_cuisines), new Set(r.cuisines));
  if (avoid.length) return `${person.name} avoids ${avoid.sort().join(", ")}`;

  const allowed = person.can_eat_proteins;
  // Empty proteins = we don't know the menu yet (e.g. from the map): keep it, but warn.
  if (allowed?.length && !SNACK_OCCASIONS.has(occasion) && r.proteins.length) {
    if (!inter(lower(allowed), new Set(r.proteins)).length)
      return `nothing ${person.name} can eat (${allowed.join(" / ")} only)`;
  }
  return null;
}

export function scorePerson(person, r, textSim, occasion = "any") {
  const name = person.name;
  const parts = {};
  const reasons = [];
  const warnings = [];

  // No stated favourites = "doesn't mind": neutral 0.5 so easy-going friends don't drag picks down.
  const favs = lower(person.favorite_cuisines);
  const hit = inter(favs, new Set(r.cuisines)).sort();
  parts.cuisine = hit.length ? 1 : favs.size ? 0 : 0.5;
  if (hit.length) reasons.push(`${name} loves ${title(hit[0])} food`);

  // A go-to place gets full marks; any other place is neutral (not being a go-to isn't a minus).
  const isFavPlace = (person.favorite_places ?? []).some((f) => samePlace(f, r.name));
  parts.place = isFavPlace ? 1 : 0.5;
  if (isFavPlace) reasons.push(`one of ${name}'s go-tos`);

  const dishes = r.dishes.join(" ");
  const dishHits = (person.favorite_dishes ?? []).filter((d) => dishes.includes(d.toLowerCase()));
  parts.dish = dishHits.length ? 1 : (person.favorite_dishes ?? []).length ? 0 : 0.5;
  if (dishHits.length) reasons.push(`has ${dishHits[0]} for ${name}`);

  const budget = person.budget ?? 20;
  parts.budget = r.avg_cost <= budget ? 1 : Math.max(0, 1 - (2 * (r.avg_cost - budget)) / budget);
  if (r.avg_cost > budget) warnings.push(`over ${name}'s $${budget} budget`);

  if (occasion === "drive-thru" || r.travel_min == null) {
    parts.distance = r.distance_km <= DRIVE_KM ? 1 : Math.max(0, 1 - (r.distance_km - DRIVE_KM) / DRIVE_KM);
  } else {
    // Score by travel time (walk / LRT / one bus), not straight-line distance.
    const maxT = person.max_travel_min ?? DEFAULT_MAX_TRAVEL_MIN;
    parts.distance = r.travel_min <= maxT ? 1 : Math.max(0, 1 - (r.travel_min - maxT) / maxT);
    if (r.travel_min > maxT) warnings.push(`~${r.travel_min} min away, longer than ${name}'s ${maxT} min`);
  }

  parts.text = textSim;

  let score = Object.entries(parts).reduce((s, [k, v]) => s + WEIGHTS[k] * v, 0);

  const soft = lower(person.soft_avoid);
  // A go-to place overrides general dislikes (e.g. "doesn't like shawarma, but loves Jerusalem Shawarma").
  const softHits = isFavPlace ? [] : inter(soft, new Set([...r.tags, ...r.cuisines, ...r.dishes])).sort();
  if (softHits.length) {
    score -= SOFT_AVOID_PENALTY * softHits.length;
    warnings.push(`${name} prefers to avoid ${softHits.join(", ")}`);
  } else if (["greasy", "high-sodium", "sugary"].some((t) => soft.has(t)) && r.tags.includes("light-options")) {
    score += CALORIE_BONUS;
    reasons.push(`lighter, fresher option for ${name}`);
  }

  const goal = person.calorie_goal_per_meal;
  if (goal) {
    if (r.tags.includes("light-options")) { score += CALORIE_BONUS; reasons.push(`easy to stay near ${name}'s ~${goal} cal meal goal`); }
    if (r.tags.includes("greasy")) { score -= CALORIE_BONUS; warnings.push(`harder to hit ${name}'s ~${goal} cal goal`); }
  }

  const allowed = person.can_eat_proteins;
  if (allowed?.length && !r.proteins.length) warnings.push(`check the menu for ${name} (${allowed.join(" / ")} only)`);
  if (allowed?.length && allowed.length <= 3) {
    const ok = inter(lower(allowed), new Set(r.proteins)).filter((p) => p !== "vegetarian").sort();
    if (ok.length) reasons.push(`${name} can get ${ok.join(" / ")}`);
  }

  return { name, score: Math.min(1, Math.max(0, score)), reasons, warnings };
}

export function recommend(people, restaurants, { occasion = "any", craving = "", topN = 5 } = {}) {
  if (!people.length) return { recs: [], excluded: [] };
  const pool = occasion && occasion !== "any" ? restaurants.filter((r) => r.good_for.includes(occasion)) : restaurants;

  const idx = textIndex(restaurants);
  const sims = Object.fromEntries(
    people.map((p) => [p.name, querySims(idx, pool, `${p.likes_text ?? ""} ${craving} ${craving}`)])
  );

  const recs = [];
  const excluded = [];
  pool.forEach((r, i) => {
    for (const p of people) {
      const fail = hardFail(p, r, occasion);
      if (fail) { excluded.push({ name: r.name, reason: fail }); return; }
    }
    const perPerson = people.map((p) => scorePerson(p, r, sims[p.name][i], occasion));
    const vals = perPerson.map((s) => s.score);
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const score = vals.length === 1 ? mean : (1 - FAIRNESS) * mean + FAIRNESS * Math.min(...vals);
    recs.push({ restaurant: r, score, perPerson, reasons: groupReasons(perPerson, r, people) });
  });

  const near = (r) => r.travel_min ?? r.distance_km * WALK_MIN_PER_KM;
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

function groupReasons(perPerson, r, people) {
  const reasons = [];
  if (people.length > 1 && people.every((p) => r.avg_cost <= (p.budget ?? 20)))
    reasons.push(`fits everyone's budget (~$${Math.round(r.avg_cost)})`);
  for (const s of [...perPerson].sort((a, b) => b.score - a.score)) reasons.push(...s.reasons);
  return [...new Set(reasons)].slice(0, 5);
}
