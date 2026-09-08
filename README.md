# Boat Widget — Saltholmen → Köpstadsö

An iOS home screen widget (via [Scriptable](https://scriptable.app)) that shows
live departure times for the archipelago boat from **Saltholmen** to
**Köpstadsö**, refreshing roughly every 10 minutes.

It pulls real-time data from the [Trafiklab Realtime API](https://www.trafiklab.se/api/our-apis/trafiklab-realtime-apis/),
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
   the widget → choose size **Medium** (recommended, shows 3 departures) →
   set **Script** to `BoatWidget`.

## Changing the route

Edit the `CONFIG` block at the top of `BoatWidget.js`:

```js
const CONFIG = {
  originStopName: "Saltholmen",
  destinationStopName: "Köpstadsö",
  targetBoatCount: 10, // how many upcoming boats to look for
  refreshMinutes: 10,
};
```

Köpstadsö is a via-stop, not any boat's final destination (more than one
line calls there - at least 281 and 282), and the API's departure board
only reports each boat's final stop (e.g. "Vrångö"), never the stops along
the way. So instead of guessing line numbers, the script asks Trafiklab's
**Trip Details** endpoint for each boat's actual stop-by-stop route and
keeps only the ones that call at `destinationStopName`. Which lines qualify
is cached locally (re-checked every 30 days) so this only costs one extra
API call the first time a given line is seen, not on every refresh.

To see more than the widget's on-screen rows, run the script manually in
Scriptable (▶️ Play) — it prints the next `targetBoatCount` departures to
the console log and shows a larger in-app preview.

## Notes & limitations

- **Refresh cadence is a request, not a guarantee.** iOS decides the actual
  refresh budget for home screen widgets; `refreshMinutes` tells it how soon
  the widget is allowed to refresh, but very infrequently-viewed widgets can
  be throttled by the OS. Opening your phone regularly keeps it closer to
  10 minutes.
- **Finding 10 boats requires paging across multiple 60-minute windows**
  (the API always returns a fixed 60-minute window per call), since the
  line runs roughly hourly. The script advances the window using each
  page's last departure time; if that ever stops making progress it gives
  up early and shows however many boats it found.
- If the API call fails (no signal, bad key, etc.), the widget falls back to
  the last successfully fetched departures and shows a "saved data" note.
