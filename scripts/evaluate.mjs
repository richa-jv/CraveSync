// Evaluate FFO Match against real ratings.   Run:  node scripts/evaluate.mjs
//
// data/ratings.csv rows: person,restaurant,rating(1-5)[,date]. Rating >= 4 = "good pick".
// precision@k per person = of the top-k recommended places the person has actually rated,
// how many did they rate >= 4. Compared with a baseline (cheapest + closest first).
import { readFileSync } from "node:fs";
import { parseCSV } from "../lib/csv.js";
import { prepareRestaurants, recommend } from "../lib/recommender.js";

const K = 5;
const GOOD = 4;
const root = new URL("..", import.meta.url);
const read = (p) => readFileSync(new URL(p, root), "utf8");

const ratings = parseCSV(read("data/ratings.csv")).map((r) => ({ ...r, rating: Number(r.rating) }));
if (!ratings.length) {
  console.log("No ratings yet. Add rows to data/ratings.csv (the app's Rate tab can export them).");
  process.exit(0);
}
const restaurants = prepareRestaurants(read("data/restaurants.csv"));
const people = Object.fromEntries(JSON.parse(read("data/people.json")).map((p) => [p.name, p]));
const baseline = [...restaurants].sort((a, b) => a.avg_cost - b.avg_cost || a.distance_km - b.distance_km).map((r) => r.name);

function precisionAtK(ranked, liked, rated) {
  const top = ranked.filter((n) => rated.has(n)).slice(0, K);
  return top.length ? top.filter((n) => liked.has(n)).length / top.length : null;
}

const rows = [];
for (const name of [...new Set(ratings.map((r) => r.person))]) {
  if (!people[name]) continue;
  const mine = ratings.filter((r) => r.person === name);
  const rated = new Set(mine.map((r) => r.restaurant));
  const liked = new Set(mine.filter((r) => r.rating >= GOOD).map((r) => r.restaurant));
  const { recs } = recommend([people[name]], restaurants, { topN: restaurants.length });
  rows.push({
    person: name,
    ratings: mine.length,
    [`ffo_p@${K}`]: precisionAtK(recs.map((r) => r.restaurant.name), liked, rated),
    [`baseline_p@${K}`]: precisionAtK(baseline, liked, rated),
  });
}
console.table(rows);
const mean = (k) => { const v = rows.map((r) => r[k]).filter((x) => x != null); return v.reduce((a, b) => a + b, 0) / (v.length || 1); };
console.log(`Mean precision@${K}: FFO Match ${mean(`ffo_p@${K}`).toFixed(2)} vs baseline ${mean(`baseline_p@${K}`).toFixed(2)}`);
