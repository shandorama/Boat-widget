# Boat Widget — Saltholmen ⇄ Köpstadsö

Two iOS home screen widgets (via [Scriptable](https://scriptable.app)) showing
live departure times for the archipelago boat between **Saltholmen** and
**Köpstadsö**, one per direction, each refreshing roughly every 10 minutes:

- **`BoatWidget.js`** — Saltholmen → Köpstadsö
- **`BoatWidgetReturn.js`** — Köpstadsö → Saltholmen

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
   and paste in the contents of [`BoatWidget.js`](./BoatWidget.js).
4. Tap the **▶️ Play** button once to run it inside the app (not as a widget
   yet). It will:
   - Ask for your Trafiklab API key and store it in the iOS Keychain (it is
     never written into the script file).
   - Look up the Saltholmen stop id once and cache it locally.
   - Show a preview of the widget so you can confirm it's finding boats.
5. Long-press your home screen → tap **+** → search **Scriptable** → add
   the widget → choose size **Medium** (recommended) or **Large** (shows
   all `targetBoatCount` departures) → set **Script** to `BoatWidget`.
6. Repeat steps 3–5 for the return trip: create a script named
   `BoatWidgetReturn` with the contents of
   [`BoatWidgetReturn.js`](./BoatWidgetReturn.js). It reuses the same
   Trafiklab API key from the Keychain, so you won't be asked for it again.

## Changing the route

Edit the `CONFIG` block at the top of either file:

```js
const CONFIG = {
  originStopName: "Saltholmen",
  destinationStopName: "Köpstadsö",
  targetBoatCount: 5, // how many upcoming boats to look for
  refreshMinutes: 10,
};
```

Köpstadsö is a via-stop, not any boat's final destination (more than one
line calls there - at least 281 and 282), and the API's departure board
only reports each boat's final stop (e.g. "Vrångö"), never the stops along
the way. So instead of guessing line numbers, the script asks Trafiklab's
**Trip Details** endpoint for each boat's actual, ordered stop-by-stop
route and keeps only the ones that travel from `originStopName` *toward*
`destinationStopName` (checking stop order, not just presence, so a boat
that already passed the destination and is heading further out doesn't
count). Which lines qualify is cached locally per direction (re-checked
every 30 days), so this only costs one extra API call the first time a
given line is seen, not on every refresh.

The search for `targetBoatCount` upcoming boats pages forward through
60-minute windows and keeps going across any overnight service gap into
the next day, so you'll always get that many boats rather than "however
many are left today".

To see more than the widget's on-screen rows, run the script manually in
Scriptable (▶️ Play) — it prints the next `targetBoatCount` departures to
the console log and shows a larger in-app preview.

## Notes & limitations

- **Refresh cadence is a request, not a guarantee.** iOS decides the actual
  refresh budget for home screen widgets; `refreshMinutes` tells it how soon
  the widget is allowed to refresh, but very infrequently-viewed widgets can
  be throttled by the OS. Opening your phone regularly keeps it closer to
  10 minutes.
- If the API call fails (no signal, bad key, etc.), the widget falls back to
  the last successfully fetched departures and shows a "saved data" note.
- The two scripts are intentionally near-duplicates (Scriptable widgets are
  simplest as standalone, copy-pasteable files) rather than sharing a
  library file. If you tweak the matching logic in one, mirror the change
  in the other.
