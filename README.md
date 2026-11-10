# 🍜 FFO Match

**Where should we eat?** FFO Match recommends food spots around the University of Alberta for one person or a whole friend group, and explains every pick.

It started with a real problem: me, my two roommates and our friends (9 people with very different food rules) trying to agree on where to go. It's an independent prototype inspired by X-Innovations' *FFO | For Foodies Only* concept.

## What it does

- **Solo or group picks.** Choose who's coming, what the plan is (coffee/matcha, quick snack, lunch, dinner, late-night, drive-thru, dessert, on campus) and, optionally, the cuisines you're craving (Korean, pizza, boba, matcha, shawarma, dessert… plus any other cuisine found in the data). Up to 50 picks show at once, with more on request.
- **Everywhere you can get to by train.** One script pulls every café, restaurant and fast-food spot from OpenStreetMap that's within a walk or one bus of campus, **or within a 15-minute walk or bus ride of any Capital Line or Metro Line LRT station** (Century Park to Clareview, plus MacEwan, Kingsway and NAIT). It works out which plans each place suits from its type and opening hours.
- **Travel time, not kilometres.** Every place gets an estimated trip from campus and how to get there ("~23 min · LRT to Southgate + 4 min walk"), and each person has their own limit (`max_travel_min`, default 30).
- **Drive-thrus across south and central Edmonton.** Drive-thrus come from a much bigger area (McKernan, Strathcona, South Campus, Southgate, downtown, up to Kingsway and Clareview), are labelled by neighbourhood, and aren't marked down for distance.
- **Respects real dietary rules.** For example, one friend only eats boneless chicken, fish or seafood. Another doesn't eat beef. One avoids greasy, salty or sugary food. One tracks calories (~1000 per meal).
- **Fair group decisions.** The group score blends the average match with the *least happy* person's match, so it picks places everyone is fine with, not places three people love and one person hates.
- **Explains itself.** For example: "fits everyone's budget (~$15) · has shawarma for Sahil · Star can get boneless chicken". It also lists what was ruled out and why.
- **Shows the picks on a map** and **checks itself**: friends rate places they visit, and an evaluation script measures how many top picks were rated 4/5 or higher.

## How it works

```
scripts/fetch_places.py  ──►  data/restaurants.csv  +  data/people.json
(OpenStreetMap: campus,              │
 every LRT stop + 15 min,             │
 drive-thrus)                         │
                                      ▼
lib/recommender.js   1. Occasion filter  → only places good for the plan
                     2. Hard filters     → drop places where anyone has nothing they can eat
                                           (unknown menu → kept, with a "check the menu" note)
                     3. Per-person score → cuisine · go-to places · favourite dishes · budget ·
                                           travel time · text match to their words + tonight's craving
                                           − soft avoids (greasy, high-sodium…) ± calorie goal
                     4. Group blend      → 0.6 × average + 0.4 × least-happy person
                     5. Explanations     → reasons, heads-ups, ruled-out list
                                      │
                                      ▼
index.html + app.js (static site, runs in the browser)  ──►  ratings  ──►  scripts/evaluate.mjs
```

Text matching uses character n-gram TF-IDF, so "spicy" matches "spice" and "warm" matches "warming". All weights are at the top of `lib/recommender.js`.

The site is plain HTML/CSS/JavaScript with no build step and no dependencies, so it deploys to Vercel as-is.

## Run it locally

The page loads its data with `fetch`, so open it through a local server rather than double-clicking `index.html`:

```bash
python -m http.server 8000
```

Then go to http://localhost:8000.

## Update the restaurant list

```bash
pip install -r requirements.txt
python scripts/fetch_places.py            # campus + every LRT station + drive-thrus
python scripts/fetch_places.py --dry-run  # preview first
```

Hand-entered rows (`source=manual`) and rows you've checked (`verified=yes`) are never overwritten. For places pulled from the map, prices are rough defaults and `proteins` is blank (unknown). Fill these in for the places you actually go to, then set `verified=yes`.

## Deploy to Vercel

1. Push this folder to a GitHub repo.
2. On vercel.com, choose **Add New → Project** and import the repo.
3. Set Framework Preset to **Other** and leave the build command empty. Click **Deploy**.

Every push to GitHub redeploys the site automatically, so updating `data/restaurants.csv` or `data/people.json` and pushing updates the live site.

Ratings on the live site are saved in each visitor's browser. Use **Download ratings.csv**, add the rows to `data/ratings.csv`, and push. (A shared database is a later upgrade.)

## Tests and evaluation

```bash
node --test tests/recommender.test.mjs   # recommender (uses fixed sample data)
python -m pytest                         # map import
node scripts/evaluate.mjs                # precision@5 vs. a cheapest-and-closest baseline
```

## Data

| File | What's in it |
|---|---|
| `data/restaurants.csv` | Spots on and near campus: cuisines, dishes, proteins, cost, distance, which plans they suit, tags, coordinates. |
| `data/people.json` | One profile per friend. `can_eat_proteins: null` means "eats anything"; `max_travel_min` is the longest trip they're happy with. |
| `data/ratings.csv` | Real visit ratings. |
| `tests/fixtures/` | Fixed sample data the tests run on, so tests don't change when the real list does. |

## Where it could go for FFO

- Open it up to more students with a sign-up form instead of a hand-written profile.
- Learn from ratings (collaborative filtering) instead of only stated preferences.
- Match student food creators with restaurants looking for tastings and promotion.

---
Map data © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors, available under the ODbL.

### How travel times are estimated

Rough, but consistent: walking is 4.8 km/h with a 1.25 detour factor; the LRT is about 2.3 min per stop plus 10 min to get from the Quad onto a train at University station; a bus adds a 7 min wait, 3 min to transfer from the LRT, and about 18 km/h. A place counts as reachable if it's a walk or one bus from campus, or a 15-minute walk or bus ride from an LRT station. Station positions are looked up on the map each time you run the import. All of these numbers are at the top of `scripts/fetch_places.py`.
