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
  destinationName: "Köpstadsö",
  refreshMinutes: 10,
};
```

## Notes & limitations

- **Refresh cadence is a request, not a guarantee.** iOS decides the actual
  refresh budget for home screen widgets; `refreshMinutes` tells it how soon
  the widget is allowed to refresh, but very infrequently-viewed widgets can
  be throttled by the OS. Opening your phone regularly keeps it closer to
  10 minutes.
- **Field names**: Trafiklab's newer Realtime API's exact JSON field names
  couldn't be fully verified against live docs while building this (network
  access to trafiklab.se was blocked in the build environment). The script
  therefore scans each departure's fields heuristically (looking for keys
  containing things like `realtime`, `scheduled`, `delay`, `destination`)
  rather than hardcoding exact paths. If a field ever looks wrong once you
  have a working API key, run the script manually in Scriptable and share
  what you see — it's a quick fix to tighten the field matching.
- If the API call fails (no signal, bad key, etc.), the widget falls back to
  the last successfully fetched departures and shows a "saved data" note.
