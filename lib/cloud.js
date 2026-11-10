// Tiny client for the shared ratings table in Supabase, using its REST API directly
// (no SDK, so the site stays dependency-free). Works in the browser and in Node tests.

const COLUMNS = "person,restaurant,rating,date";

export function createRatingsStore({ url, key, fetchImpl = globalThis.fetch } = {}) {
  const base = url ? `${url.replace(/\/+$/, "")}/rest/v1/ratings` : "";
  const enabled = Boolean(base && key && fetchImpl);
  // New publishable keys (sb_publishable_…) go in the apikey header only; legacy anon keys are JWTs (eyJ…)
  // and are also sent as the Bearer token.
  const headers = { apikey: key, "Content-Type": "application/json" };
  if (String(key).startsWith("eyJ")) headers.Authorization = `Bearer ${key}`;

  async function call(path, init = {}) {
    const res = await fetchImpl(`${base}${path}`, { ...init, headers: { ...headers, ...init.headers } });
    if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text().catch(() => "")}`.trim());
    return res;
  }

  return {
    enabled,

    // Every shared rating, newest first.
    async load() {
      if (!enabled) return [];
      const res = await call(`?select=${COLUMNS}&order=date.desc&limit=10000`);
      return (await res.json()).map(cleanRow).filter(Boolean);
    },

    // Save one or more ratings. One rating per person per place: a new one replaces the old.
    async save(rows) {
      if (!enabled) throw new Error("Shared ratings are not set up");
      const body = [].concat(rows).map(cleanRow);
      if (body.some((r) => !r)) throw new Error("Invalid rating");
      await call("?on_conflict=person,restaurant", {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify(body),
      });
    },
  };
}

// Same rules as the database checks, so bad rows fail fast with a clear message.
export function cleanRow(x) {
  const person = String(x?.person ?? "").trim();
  const restaurant = String(x?.restaurant ?? "").trim();
  const rating = Number(x?.rating);
  const date = String(x?.date ?? "").slice(0, 10) || new Date().toISOString().slice(0, 10);
  if (!person || person.length > 40 || !restaurant || restaurant.length > 120) return null;
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  return { person, restaurant, rating, date };
}
