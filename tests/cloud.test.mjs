// Shared ratings client, tested with a fake fetch (no network).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRatingsStore, cleanRow } from "../lib/cloud.js";

function fakeFetch(reply = { ok: true, status: 200, body: [] }) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url, ...init, body: init.body ? JSON.parse(init.body) : undefined });
    return { ok: reply.ok, status: reply.status, json: async () => reply.body, text: async () => JSON.stringify(reply.body) };
  };
  fn.calls = calls;
  return fn;
}

test("store is off without a URL and key", async () => {
  const s = createRatingsStore({ url: "", key: "", fetchImpl: fakeFetch() });
  assert.equal(s.enabled, false);
  assert.deepEqual(await s.load(), []);
  await assert.rejects(s.save({ person: "Riri", restaurant: "X", rating: 5 }));
});

test("load reads ratings and drops bad rows", async () => {
  const f = fakeFetch({ ok: true, status: 200, body: [
    { person: "Riri", restaurant: "Remedy Cafe", rating: 5, date: "2026-11-01" },
    { person: "Star", restaurant: "Remedy Cafe", rating: 9, date: "2026-11-01" },
  ] });
  const s = createRatingsStore({ url: "https://abc.supabase.co/", key: "k", fetchImpl: f });
  assert.deepEqual(await s.load(), [{ person: "Riri", restaurant: "Remedy Cafe", rating: 5, date: "2026-11-01" }]);
  assert.match(f.calls[0].url, /^https:\/\/abc\.supabase\.co\/rest\/v1\/ratings\?select=/);
  assert.equal(f.calls[0].headers.apikey, "k");
  assert.equal(f.calls[0].headers.Authorization, undefined);
});

test("legacy anon keys (JWTs) are also sent as the Bearer token", async () => {
  const f = fakeFetch();
  await createRatingsStore({ url: "https://abc.supabase.co", key: "eyJabc", fetchImpl: f }).load();
  assert.equal(f.calls[0].headers.Authorization, "Bearer eyJabc");
});

test("save upserts one rating per person per place", async () => {
  const f = fakeFetch({ ok: true, status: 201, body: null });
  const s = createRatingsStore({ url: "https://abc.supabase.co", key: "k", fetchImpl: f });
  await s.save({ person: "Riri", restaurant: "Remedy Cafe", rating: 4, date: "2026-11-02" });
  const c = f.calls[0];
  assert.equal(c.method, "POST");
  assert.match(c.url, /on_conflict=person,restaurant$/);
  assert.match(c.headers.Prefer, /resolution=merge-duplicates/);
  assert.deepEqual(c.body, [{ person: "Riri", restaurant: "Remedy Cafe", rating: 4, date: "2026-11-02" }]);
});

test("save refuses invalid ratings and surfaces server errors", async () => {
  const s = createRatingsStore({ url: "https://abc.supabase.co", key: "k", fetchImpl: fakeFetch({ ok: false, status: 401, body: { message: "bad key" } }) });
  await assert.rejects(s.save({ person: "Riri", restaurant: "X", rating: 0 }), /Invalid rating/);
  await assert.rejects(s.save({ person: "Riri", restaurant: "X", rating: 3 }), /Supabase 401/);
});

test("cleanRow fills a missing date and trims names", () => {
  const r = cleanRow({ person: " Riri ", restaurant: " Remedy Cafe ", rating: "5" });
  assert.equal(r.person, "Riri");
  assert.equal(r.restaurant, "Remedy Cafe");
  assert.equal(r.rating, 5);
  assert.match(r.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(cleanRow({ person: "x".repeat(41), restaurant: "A", rating: 3 }), null);
});
