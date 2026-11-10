// "What are you craving?" chips. Each cuisine matches a place by its cuisine tags (from the map
// or your edits) or by whole words in its name and dishes (so "tea" never matches "steak").

export const CUISINES = [
  { id: "korean", label: "Korean", emoji: "🥘", tags: ["korean"], words: ["korean", "bibimbap", "tteokbokki", "kbbq"] },
  { id: "pizza", label: "Pizza", emoji: "🍕", tags: ["pizza"], words: ["pizza"] },
  { id: "japanese", label: "Japanese", emoji: "🍣", tags: ["japanese", "sushi", "ramen", "izakaya", "teriyaki"], words: ["sushi", "ramen", "udon", "teriyaki", "japanese", "izakaya"] },
  { id: "boba", label: "Boba", emoji: "🧋", tags: ["bubble tea"], words: ["bubble tea", "boba", "milk tea"] },
  { id: "burgers", label: "Burgers", emoji: "🍔", tags: ["burger", "burgers"], words: ["burger", "burgers"] },
  { id: "arabic", label: "Arabic & shawarma", emoji: "🥙", tags: ["arab", "arabic", "lebanese", "middle eastern", "syrian", "shawarma", "kebab", "persian"], words: ["shawarma", "donair", "kebab", "falafel", "shish tawouk"] },
  { id: "dessert", label: "Dessert", emoji: "🍰", tags: ["dessert", "ice cream", "frozen yogurt", "donut", "bakery", "cake", "crepe", "waffle"], words: [], goodFor: "dessert" },
  { id: "vietnamese", label: "Vietnamese", emoji: "🍜", tags: ["vietnamese"], words: ["pho", "banh mi", "vietnamese"] },
  { id: "indian", label: "Indian", emoji: "🍛", tags: ["indian", "south indian", "sri lankan", "pakistani", "nepalese", "punjabi"], words: ["biryani", "butter chicken", "dosa", "naan", "kuttu paratha", "indian"] },
  { id: "coffee", label: "Coffee", emoji: "☕", tags: ["coffee", "coffee shop", "cafe"], words: ["coffee", "espresso", "latte", "london fog"] },
  { id: "mediterranean", label: "Mediterranean", emoji: "🫒", tags: ["mediterranean", "greek", "turkish"], words: ["souvlaki", "gyro", "greek", "tzatziki"] },
  { id: "chinese", label: "Chinese", emoji: "🥡", tags: ["chinese", "cantonese", "szechuan", "sichuan", "dim sum", "dumpling", "taiwanese", "hot pot"], words: ["dim sum", "dumpling", "dumplings", "chow mein", "wonton", "hot pot", "chinese"] },
  { id: "matcha", label: "Matcha", emoji: "🍵", tags: ["matcha"], words: ["matcha"] },
  { id: "italian", label: "Italian", emoji: "🍝", tags: ["italian"], words: ["pasta", "italian"] },
  { id: "mexican", label: "Mexican", emoji: "🌮", tags: ["mexican", "tex-mex", "tacos", "burrito"], words: ["taco", "tacos", "burrito", "burritos", "quesadilla", "nachos"] },
  { id: "sandwiches", label: "Sandwiches", emoji: "🥪", tags: ["sandwich", "sandwiches", "sub", "deli"], words: ["sandwich", "sandwiches", "sub", "subs", "subway", "panini", "banh mi"] },
  { id: "thai", label: "Thai", emoji: "🍲", tags: ["thai"], words: ["pad thai", "thai"] },
  { id: "chicken", label: "Chicken & wings", emoji: "🍗", tags: ["chicken", "wings", "fried chicken"], words: ["wings", "fried chicken", "nuggets", "mcnuggets"] },
  { id: "healthy", label: "Healthy bowls", emoji: "🥗", tags: ["salad", "poke", "vegan", "healthy", "juice", "smoothies", "bowls", "hawaiian"], words: ["salad", "poke", "smoothie", "bowl", "bowls"] },
  { id: "brunch", label: "Brunch", emoji: "🥞", tags: ["breakfast", "brunch", "pancake"], words: ["brunch", "breakfast", "pancake", "pancakes", "eggs benny"] },
];

// Tags too general to be a "cuisine" chip of their own.
const GENERIC = new Set(["restaurant", "fast food", "regional", "international", "canadian", "american", "convenience",
  "food court", "coffee shop", "cafe", "fine dining", "pub", "bar", "grill", "asian", "fusion", "snacks", "drinks"]);
const KNOWN = new Set(CUISINES.flatMap((c) => c.tags));

const TEXT = new WeakMap();
function text(r) {
  let t = TEXT.get(r);
  if (t === undefined) TEXT.set(r, (t = ` ${[r.name, ...(r.dishes ?? [])].join(" ").toLowerCase().replace(/[^a-z0-9]+/g, " ")} `));
  return t;
}

export function matchesCuisine(r, c) {
  if (c.goodFor && r.good_for?.includes(c.goodFor)) return true;
  if ((r.cuisines ?? []).some((x) => c.tags.includes(x)) || (r.tags ?? []).some((x) => c.tags.includes(x))) return true;
  const t = text(r);
  return c.words.some((w) => t.includes(` ${w} `));
}

// Other cuisines that show up in your data (e.g. "ethiopian", "filipino"), most common first.
export function extraCuisines(restaurants, min = 2) {
  const counts = new Map();
  for (const r of restaurants) for (const c of r.cuisines ?? []) {
    if (KNOWN.has(c) || GENERIC.has(c) || c.length < 3) continue;
    counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  return [...counts].filter(([, n]) => n >= min).sort((a, b) => b[1] - a[1])
    .map(([c]) => ({ id: `x:${c}`, label: c.replace(/\b\w/g, (m) => m.toUpperCase()), emoji: "🍽️", tags: [c], words: [] }));
}
