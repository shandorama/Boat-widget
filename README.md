# Boat Widget — Saltholmen ⇄ Köpstadsö

Two iOS home screen widgets (via [Scriptable](https://scriptable.app)) showing
live departure times for the archipelago boat between **Saltholmen** and
**Köpstadsö**, one per direction, each refreshing roughly every 10 minutes:

- **`BoatWidget.js`** — Saltholmen → Köpstadsö loader (paste this into Scriptable)
- **`BoatWidgetCore.js`** — its actual logic, downloaded automatically - never paste this one in
- **`BoatWidgetReturn.js`** — Köpstadsö → Saltholmen loader (paste this into Scriptable)
- **`BoatWidgetCoreReturn.js`** — its actual logic, downloaded automatically - never paste this one in

Both pull real-time data from the [Trafiklab Realtime API](https://www.trafiklab.se/api/our-apis/trafiklab-realtime-apis/),
which covers Västtrafik / Styrsöbolaget ferries.

## Why Scriptable, not a web page?

Neither iOS nor Android lets a website render live content directly on a
home screen icon without opening it — "Add to Home Screen" always launches
a full app. A true always-visible, auto-updating tile requires a native or
Scriptable-style widget, which is what this is.

## Setup

1. Get a **free API key** from [trafiklab.se](https://www.trafiklab.se/)
   (sign up, then create a key for the "Trafiklab Realtime APIs").
2. Install **[Scriptable](https://apps.apple.com/app/scriptable/id1405459188)**
   from the App Store (free).
3. In Scriptable, tap **+** to create a new script, name it `BoatWidget`,
   and paste in the contents of [`BoatWidget.js`](./BoatWidget.js) — this
   is a short "loader," not the full logic.
4. Tap the **▶️ Play** button once to run it inside the app (not as a widget
   yet). It will:
   - Download the actual logic (`BoatWidgetCore.js`) and run it immediately.
   - Ask for your Trafiklab API key and store it in the iOS Keychain (it is
     never written into any script file).
   - Look up the Saltholmen stop id once and cache it locally.
   - Show a preview of the widget so you can confirm it's finding boats.
5. Long-press your home screen → tap **+** → search **Scriptable** → add
   the widget → choose size **Medium** (recommended) or **Large** (shows
   all `targetBoatCount` departures) → set **Script** to `BoatWidget`.
6. Repeat steps 3–5 for the return trip: create a script named
   `BoatWidgetReturn` with the contents of
   [`BoatWidgetReturn.js`](./BoatWidgetReturn.js). It reuses the same
   Trafiklab API key from the Keychain, so you won't be asked for it again.

That's the only manual copy-paste you should ever need — see "Self-updating"
below. You may notice `BoatWidgetCore` / `BoatWidgetCoreReturn` show up as
extra entries in Scriptable's own script list once downloaded — that's
expected (they're just files Scriptable found), you can ignore them; the
loaders are what you actually run or add as widgets.

## Self-updating

`BoatWidget.js` and `BoatWidgetReturn.js` are thin "loaders" that rarely
need to change. On every run - both a manual ▶️ Play and the automatic
background widget refresh (~every 10 min) - each one:

1. Downloads its actual logic (`BoatWidgetCore.js` / `BoatWidgetCoreReturn.js`)
   fresh from this repo's `main` branch.
2. Saves it to a local file if it's changed.
3. Runs that file immediately, in the *same* run - so a manual test run
   shows a just-pushed fix right away, not "next time."

So once you've done the setup above, any future fix pushed to this repo
reaches your phone and takes effect on your very next run/refresh — no
more copy-pasting, and no need to run twice to see it apply.

A failed download (offline, GitHub unreachable) falls back to whatever
version was already downloaded before, so it never blocks the widget from
showing boat times — only if there's *no* cached copy at all (e.g. the
very first run with no connection) does it show a "Loader error" message.

If you ever want to stop this (e.g. to hand-edit the logic yourself
without it being overwritten), edit the *core* file directly rather than
the loader, and remove or comment out `await ensureLatestCore();` in the
loader so it stops re-downloading over your changes.

## Changing the route

Edit the `CONFIG` block at the top of either *core* file (`BoatWidgetCore.js`
/ `BoatWidgetCoreReturn.js`) — not the loader, which doesn't have one:

```js
const CONFIG = {
  originStopName: "Saltholmen",
  destinationStopName: "Köpstadsö",
  targetBoatCount: 4, // how many regular upcoming boats to show
  lastBoatGapMinutes: 90, // a gap at least this long marks the overnight break
  lastBoatSearchCount: 25, // how many boats ahead to look at when finding it
  refreshMinutes: 10,
};
```

Köpstadsö is a via-stop, not any boat's final destination (more than one
line calls there - at least 281 and 282), and the API's departure board
only reports each boat's final stop (e.g. "Vrångö"), never the stops along
the way. Line numbers also aren't reliable on their own: the same line can
run different stopping patterns on different trips (e.g. an express that
skips a stop some runs make). So instead of trusting line numbers, the
script checks Trafiklab's **Trip Details** endpoint for *every individual
boat trip*, using its actual ordered stop-by-stop route, and keeps only
the ones that travel from `originStopName` *toward* `destinationStopName`
(checking stop order, not just presence, so a boat that already passed the
destination and is heading further out doesn't count). Each specific
trip's result is cached locally per direction (a trip's own stop pattern
never changes once scheduled, so this is safe), so a boat already seen on
a previous refresh isn't re-checked every 10 minutes.

## Last boat of the night

The widget shows the next `targetBoatCount` (4) regular boats, plus a 5th
row in a different color (purple, with a 🌙) for the **last boat before
the overnight service gap** — handy if you're out late and need to know
your last ride home.

It's found by fetching up to `lastBoatSearchCount` (25) boats ahead and
walking through them in order to find the first gap between two
consecutive boats that's at least `lastBoatGapMinutes` (90) long — the
boat right before that gap is the last one before the archipelago boats
stop for the night (typically resuming around 04:30–05:47). That boat is
pulled out of the regular list and always shown as the 5th row, even if
it's hours away from the next 4 departures shown above it (e.g. it's
currently mid-afternoon and tonight's last boat is still hours off).

To see more than the widget's on-screen rows, run the script manually in
Scriptable (▶️ Play) — it prints the full list to the console log and
shows a larger in-app preview.

## Notes & limitations

- **Refresh cadence is a request, not a guarantee.** iOS decides the actual
  refresh budget for home screen widgets; `refreshMinutes` tells it how soon
  the widget is allowed to refresh, but very infrequently-viewed widgets can
  be throttled by the OS. Opening your phone regularly keeps it closer to
  10 minutes.
- If the API call fails (no signal, bad key, etc.), the widget falls back to
  the last successfully fetched departures and shows a "saved data" note.
- The two core files are intentionally near-duplicates (Scriptable widgets
  are simplest as standalone files) rather than sharing more logic between
  them. If you tweak the matching logic in one, mirror the change in the
  other. The two loaders are likewise near-duplicates of each other.
