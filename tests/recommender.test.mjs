// Run with:  node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseCSV } from "../lib/csv.js";
import { prepareRestaurants, recommend, samePlace } from "../lib/recommender.js";

const root = new URL("..", import.meta.url);
const R = prepareRestaurants(readFileSync(new URL("tests/fixtures/restaurants_sample.csv", root), "utf8"));
const P = Object.fromEntries(JSON.parse(readFileSync(new URL("data/people.json", root), "utf8")).map((p) => [p.name, p]));
const names = (recs) => recs.map((r) => r.restaurant.name);

test("CSV parser handles quoted commas", () => {
  const rows = parseCSV('a,b\n1,"x, y"\n2,"say ""hi"""\n');
  assert.deepEqual(rows, [{ a: "1", b: "x, y" }, { a: "2", b: 'say "hi"' }]);
});

test("Star's rule is about meat: veggie places are fine, beef-and-pork-only places aren't", () => {
  const base = R.find((r) => r.name === "Subway");
  const data = [
    { ...base, name: "Veggie Spot", proteins: ["vegetarian"] },
    { ...base, name: "Ribs Only", proteins: ["beef", "pork"] },
    { ...base, name: "Sushi Spot", proteins: ["fish", "seafood"] },
  ];
  const { recs, excluded } = recommend([P.Star], data, { occasion: "lunch", topN: 10 });
  assert.deepEqual(names(recs).sort(), ["Sushi Spot", "Veggie Spot"]);
  assert.equal(excluded[0].name, "Ribs Only");
  assert.match(excluded[0].reason, /Star only eats boneless chicken, fish or seafood for meat/);
});

test("Star can still get matcha on a coffee run", () => {
  const { recs } = recommend([P.Star], R, { occasion: "coffee", craving: "matcha", topN: 3 });
  assert.ok(recs.some((r) => r.restaurant.tags.includes("matcha")));
});

test("Harshi's coffee pick is Tim Hortons", () => {
  const { recs } = recommend([P.Harshi], R, { occasion: "coffee", topN: 1 });
  assert.deepEqual(names(recs), ["Tim Hortons"]);
});

test("Aahil's top lunch picks aren't greasy", () => {
  const { recs } = recommend([P.Aahil], R, { occasion: "lunch", topN: 3 });
  for (const r of recs) assert.ok(!r.restaurant.tags.includes("greasy"));
});

test("Sahil gets shawarma or pasta first", () => {
  const { recs } = recommend([P.Sahil], R, { occasion: "dinner", topN: 2 });
  const dishes = recs.flatMap((r) => r.restaurant.dishes);
  assert.ok(dishes.includes("shawarma") || dishes.includes("pasta"));
});

test("late-night only returns late-night places", () => {
  const { recs } = recommend([P.Riri], R, { occasion: "late-night", topN: 20 });
  assert.ok(recs.length);
  for (const r of recs) assert.ok(r.restaurant.good_for.includes("late-night"));
});

test("a place is ruled out for the group if anyone can't eat there", () => {
  const base = R.find((r) => r.name === "Subway");
  const data = [...R, { ...base, name: "Ribs Only", proteins: ["beef", "pork"] }];
  const solo = recommend([P.Harshi], data, { occasion: "lunch", topN: 50 });
  const group = recommend([P.Harshi, P.Star], data, { occasion: "lunch", topN: 50 });
  assert.ok(names(solo.recs).includes("Ribs Only"));
  assert.ok(!names(group.recs).includes("Ribs Only"));
  assert.ok(names(group.recs).includes("Savoy (HUB)")); // vegetarian, so fine for Star
});

test("unknown menu is kept but flagged", () => {
  const df = R.map((r) => (r.name === "SAMPLE Matcha Cafe" ? { ...r, proteins: [], good_for: [...r.good_for, "dinner"] } : r));
  const { recs } = recommend([P.Star], df, { occasion: "dinner", topN: 50 });
  const rec = recs.find((r) => r.restaurant.name === "SAMPLE Matcha Cafe");
  assert.ok(rec.perPerson.some((p) => p.warnings.some((w) => w.includes("check the menu"))));
});

test("craving text matches word variants (spicy ~ spice)", () => {
  const { recs } = recommend([P.Animesh], R, { occasion: "dinner", craving: "spicy", topN: 3 });
  assert.ok(names(recs).includes("SAMPLE Thai Kitchen"));
});

test("group scores are sorted and between 0 and 1", () => {
  const { recs } = recommend(Object.values(P), R, { topN: 10 });
  const s = recs.map((r) => r.score);
  assert.deepEqual(s, [...s].sort((a, b) => b - a));
  for (const x of s) assert.ok(x >= 0 && x <= 1);
});

test("Harshi and Star don't get pushed towards shawarma", () => {
  const plain = { ...P.Harshi, soft_avoid: [] };
  const rank = (person) => names(recommend([person], R, { occasion: "dinner", topN: 50 }).recs).indexOf("SAMPLE Shawarma Spot");
  assert.ok(rank(P.Harshi) > rank(plain));
  const { recs } = recommend([P.Star], R, { occasion: "dinner", topN: 50 });
  const spot = recs.find((r) => r.restaurant.name === "SAMPLE Shawarma Spot");
  assert.ok(spot.perPerson[0].warnings.some((w) => w.includes("shawarma")));
});

test("place names match loosely but safely", () => {
  assert.ok(samePlace("Jerusalem Shawarma", "Jerusalem Shawarma Whyte Ave"));
  assert.ok(samePlace("Bar Burrito (SUB)", "Bar Burrito"));
  assert.ok(samePlace("McDonald's", "McDonalds"));
  assert.ok(samePlace("A&W", "A&W"));
  assert.ok(!samePlace("A&W", "Awesome Wings"));
  assert.ok(!samePlace("Subway", "Sushi Way"));
});

test("Jerusalem Shawarma is a go-to that beats Harshi and Star's shawarma dislike", () => {
  const js = { ...R.find((r) => r.name === "SAMPLE Shawarma Spot"), name: "Jerusalem Shawarma", location: "Whyte Ave" };
  const data = [...R, js];
  for (const who of ["Harshi", "Star"]) {
    const { recs } = recommend([P[who]], data, { occasion: "dinner", topN: 50 });
    const rec = recs.find((r) => r.restaurant.name === "Jerusalem Shawarma");
    assert.ok(rec.reasons.some((x) => x.includes("go-to")));
    assert.ok(!rec.perPerson[0].warnings.some((w) => w.includes("shawarma")));
    assert.ok(names(recs).indexOf("Jerusalem Shawarma") < names(recs).indexOf("SAMPLE Shawarma Spot"));
  }
  const group = recommend(Object.values(P), data, { occasion: "dinner", topN: 1 });
  assert.deepEqual(names(group.recs), ["Jerusalem Shawarma"]);
});

test("drive-thru plan only shows drive-thrus, doesn't punish driving distance, one per chain", () => {
  const base = R.find((r) => r.name === "McDonald's");
  const dt = (name, km, area) => ({ ...base, name, location: area, distance_km: km, good_for: ["drive-thru"], tags: [...base.tags, "drive-thru"] });
  const data = [...R, dt("McDonald's (drive-thru, Southgate)", 4.8, "Southgate"), dt("McDonald's (drive-thru, Clareview)", 11.5, "Clareview"),
    { ...dt("A&W (drive-thru, Kingsway)", 4.6, "Kingsway"), cuisines: ["burgers"], dishes: ["burger"] }];
  const { recs } = recommend([P.Sahil], data, { occasion: "drive-thru", topN: 10 });
  assert.ok(recs.every((r) => r.restaurant.good_for.includes("drive-thru")));
  assert.deepEqual(names(recs).sort(), ["A&W (drive-thru, Kingsway)", "McDonald's (drive-thru, Southgate)"]);
  for (const r of recs) assert.ok(!r.perPerson[0].warnings.some((w) => w.includes("farther")));
});

test("picks are scored by travel time, with each person's own limit", () => {
  const base = R.find((r) => r.name === "SAMPLE Ramen House");
  const far = { ...base, name: "Clareview Ramen", travel_min: 38, how: "LRT to Clareview + 6 min walk" };
  const close = { ...base, name: "Campus Ramen", travel_min: 8, how: "8 min walk from campus" };
  const data = [far, close];
  const strict = recommend([{ ...P.Star, max_travel_min: 30 }], data, { occasion: "dinner" });
  assert.deepEqual(names(strict.recs), ["Campus Ramen", "Clareview Ramen"]);
  assert.ok(strict.recs[1].perPerson[0].warnings.some((w) => w.includes("38 min")));
  const relaxed = recommend([{ ...P.Star, max_travel_min: 45 }], data, { occasion: "dinner" });
  assert.ok(!relaxed.recs.find((r) => r.restaurant.name === "Clareview Ramen").perPerson[0].warnings.length);
});

test("stays fast with thousands of places", () => {
  const big = [];
  for (let i = 0; i < 4000; i++) {
    const r = R[i % R.length];
    big.push({ ...r, name: `${r.name} #${i}`, travel_min: 5 + (i % 40) });
  }
  const everyone = Object.values(P);
  recommend(everyone, big, { occasion: "dinner", craving: "warm" }); // builds the index once
  const t = performance.now();
  for (const c of ["spicy", "noodles", "something cheap"]) recommend(everyone, big, { occasion: "dinner", craving: c });
  const each = (performance.now() - t) / 3;
  assert.ok(each < 400, `took ${each.toFixed(0)} ms per search`);
});

test("dessert and on-campus plans are worked out from the data", () => {
  const dessert = recommend([P.Star], R, { occasion: "dessert", topN: 20 }).recs.map((r) => r.restaurant.name);
  assert.ok(dessert.includes("SAMPLE Matcha Cafe"));     // mochi + pastries
  assert.ok(!dessert.includes("SAMPLE Pho Shop"));
  const campus = recommend([P.Riri], R, { occasion: "on campus", topN: 20 }).recs.map((r) => r.restaurant.location);
  assert.ok(campus.length && campus.every((l) => /^(On campus|SUB|HUB)$/.test(l)));
});

test("reasons read like a friend wrote them", () => {
  const group = recommend([P.Harshi, P.Star, P.Riri], R, { occasion: "coffee", topN: 5 }).recs;
  const all = group.flatMap((r) => r.reasons).join(" | ");
  assert.match(all, /Loved by [A-Z][a-z]+(, [A-Z][a-z]+)*( & [A-Z][a-z]+)?/);
  assert.ok(!/has \w+ for/.test(all), all);
  const solo = recommend([P.Star], R, { occasion: "coffee", craving: "matcha", topN: 3 }).recs.flatMap((r) => r.reasons);
  assert.ok(solo.includes("🍵 Your matcha fix"), solo.join(" | "));
});

test("past ratings nudge picks: a 5★ place rises, a 'meh' 3★ place drops", () => {
  const base = R.find((r) => r.name === "SAMPLE Thai Kitchen");
  const data = [{ ...base, name: "Meh Place" }, { ...base, name: "Fave Place" }, { ...base, name: "New Place" }];
  const ratings = [
    { person: "Harshi", restaurant: "Meh Place", rating: 3 },
    { person: "Harshi", restaurant: "Fave Place", rating: 5 },
  ];
  const { recs } = recommend([P.Harshi], data, { occasion: "dinner", ratings });
  assert.deepEqual(names(recs), ["Fave Place", "New Place", "Meh Place"]);
});

test("reasons say 'everyone' instead of listing the whole group", () => {
  const base = R.find((r) => r.name === "SAMPLE Ramen House");
  const data = [{ ...base, name: "Tansen Izakaya", dishes: ["5 dollar ramen", "ramen"] }];
  const { recs } = recommend(Object.values(P), data, { occasion: "dinner" });
  const text = recs[0].reasons.join(" | ");
  assert.match(text, /Everyone's go-to/);
  assert.match(text, /Everyone's \$5 ramen fix/);
});

test("a place name with no Latin letters doesn't match every go-to", () => {
  assert.ok(!samePlace("Tim Hortons", "爱民顿"));
  assert.ok(!samePlace("爱民顿", "Tim Hortons"));
});

test("cuisine picker matches whole words and tags, not lookalikes", async () => {
  const { CUISINES, matchesCuisine, extraCuisines } = await import("../lib/cuisines.js");
  const c = Object.fromEntries(CUISINES.map((x) => [x.id, x]));
  const place = (o) => ({ name: "", cuisines: [], dishes: [], tags: [], good_for: [], ...o });
  assert.ok(matchesCuisine(place({ name: "My Tea", dishes: ["bubble tea"] }), c.boba));
  assert.ok(!matchesCuisine(place({ name: "Steakhouse", dishes: ["steak"] }), c.boba));
  assert.ok(matchesCuisine(place({ name: "Subway" }), c.sandwiches));
  assert.ok(!matchesCuisine(place({ name: "SUBmart", dishes: ["pizza"] }), c.sandwiches));
  assert.ok(matchesCuisine(place({ name: "Starbucks", dishes: ["matcha latte"] }), c.matcha));
  assert.ok(matchesCuisine(place({ name: "Jerusalem Shawarma", cuisines: ["shawarma"] }), c.arabic));
  assert.ok(matchesCuisine(place({ name: "Tim Hortons", good_for: ["dessert"] }), c.dessert));
  const extras = extraCuisines([place({ cuisines: ["ethiopian"] }), place({ cuisines: ["ethiopian"] }), place({ cuisines: ["korean"] })]);
  assert.deepEqual(extras.map((x) => x.label), ["Ethiopian"]);
});

test("favourite dishes also match whole words in a place's name", () => {
  const base = R.find((r) => r.name === "SAMPLE Indian Kitchen");
  const data = [{ ...base, name: "Goat Curry House", dishes: [] }, { ...base, name: "Pancake House", dishes: [] }];
  const goat = recommend([P.Mihir], data, { occasion: "dinner" }).recs.find((r) => r.restaurant.name === "Goat Curry House");
  assert.ok(goat.reasons.some((x) => x.includes("goat curry fix")), goat.reasons.join(" | "));
  const pancake = recommend([P.Riri], data, { occasion: "dinner" }).recs.find((r) => r.restaurant.name === "Pancake House");
  assert.ok(!pancake.reasons.some((x) => x.includes("cake fix")), pancake.reasons.join(" | "));
});
