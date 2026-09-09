// BoatWidgetCoreReturn.js — this file is downloaded and run by
// BoatWidgetReturn.js (the loader). It's not meant to be added as a
// Scriptable script/widget itself (it has no self-update logic of its
// own) - edit and push it, and the loader picks it up automatically. See
// BoatWidgetReturn.js for the full setup and self-update explanation.

/**
 * Köpstadsö -> Saltholmen boat departures widget logic (the return trip).
 *
 * This is the mirror image of BoatWidgetCore.js (Saltholmen -> Köpstadsö)
 * with originStopName/destinationStopName swapped below - see that file
 * for the full explanation of how route-matching and the last-boat row
 * work. Keep both files in sync if you change the matching logic; this
 * one is otherwise byte-for-byte the same.
 *
 * Data source: Trafiklab Realtime API (covers Västtrafik / Styrsöbolaget
 * archipelago ferries). Get a free API key at https://www.trafiklab.se/
 */

const CONFIG = {
  originStopName: "Köpstadsö",
  destinationStopName: "Saltholmen",
  targetBoatCount: 4, // how many regular upcoming boats to show
  lastBoatCutoffHour: 4, // the last boat is the last one before this hour
  maxNewTripChecksPerRun: 5, // cap on *uncached* Trip Details lookups per
  // widget refresh when searching for the last boat - see getLastBoat()
  maxLookaheadPages: 36, // safety cap: up to ~36 hours of 60-minute windows,
  // enough to page straight through an overnight gap into the next day.
  tripKnowledgeMaxAgeDays: 3, // discard cached per-trip results older than this
  refreshMinutes: 10,
};

const KEYCHAIN_KEY = "boatWidgetTrafiklabApiKey";
const CACHE_FILE_NAME = `boat-widget-cache-${slug(CONFIG.originStopName)}-${slug(CONFIG.destinationStopName)}.json`;
const API_BASE = "https://realtime-api.trafiklab.se/v1";

function slug(name) {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(new RegExp("[\\u0300-\\u036f]", "g"), "") // strip diacritics (ö -> o, etc.)
    .replace(/[^a-z0-9]+/g, "-");
}

// ---------- storage helpers ----------

function cachePath() {
  const fm = FileManager.local();
  return fm.joinPath(fm.documentsDirectory(), CACHE_FILE_NAME);
}

function readCache() {
  const fm = FileManager.local();
  const path = cachePath();
  if (!fm.fileExists(path)) return {};
  try {
    return JSON.parse(fm.readString(path));
  } catch (e) {
    return {};
  }
}

function writeCache(partial) {
  const fm = FileManager.local();
  const current = readCache();
  const next = Object.assign({}, current, partial);
  fm.writeString(cachePath(), JSON.stringify(next));
}

// ---------- API key ----------

async function getApiKey() {
  if (Keychain.contains(KEYCHAIN_KEY)) {
    return Keychain.get(KEYCHAIN_KEY);
  }
  if (config.runsInWidget) {
    // Can't show an interactive prompt from a home screen widget.
    return null;
  }
  const alert = new Alert();
  alert.title = "Trafiklab API key";
  alert.message =
    "Get a free key at trafiklab.se (Realtime APIs), then paste it here. " +
    "It's saved in the iOS Keychain, not in this script.";
  alert.addTextField("API key");
  alert.addAction("Save");
  alert.addCancelAction("Cancel");
  const idx = await alert.present();
  if (idx === -1) return null;
  const key = (alert.textFieldValue(0) || "").trim();
  if (!key) return null;
  Keychain.set(KEYCHAIN_KEY, key);
  return key;
}

// ---------- networking ----------

function delay(ms) {
  return new Promise((resolve) => Timer.schedule(ms, false, resolve));
}

// Two widgets (this one and its return-trip sibling) share one API key and
// can refresh at close to the same moment, which can trip the free tier's
// rate limit. Retry a rate-limited or transiently-failing request once
// with a short backoff before giving up, and add a touch of random jitter
// before it (see main()) so both widgets are less likely to collide in the
// first place. iOS gives home screen widgets a strict time budget to
// finish in, so every request also gets a short timeout and retries are
// kept few and short rather than thorough - a fast failure that falls
// back to cached data beats a slow one that gets the whole widget killed.
async function fetchJSON(url, attempt) {
  attempt = attempt || 1;
  const req = new Request(url);
  req.timeoutInterval = 8;
  const text = await req.loadString();
  const status = req.response ? req.response.statusCode : null;
  let json = null;
  try {
    json = JSON.parse(text);
  } catch (e) {
    json = null;
  }
  if (status && status >= 400) {
    const msg = (json && (json.message || json.error)) || text || `HTTP ${status}`;
    const retryable = status === 429 || status >= 500;
    if (retryable && attempt < 2) {
      await delay(attempt * 800);
      return fetchJSON(url, attempt + 1);
    }
    throw new Error(`API error ${status}: ${msg}`);
  }
  if (json === null) {
    throw new Error("Unexpected (non-JSON) response from API");
  }
  return json;
}

async function findStopId(apiKey, name) {
  const url = `${API_BASE}/stops/name/${encodeURIComponent(name)}?key=${encodeURIComponent(apiKey)}`;
  const json = await fetchJSON(url);
  if (!config.runsInWidget) {
    console.log(`Stop lookup raw response for "${name}": ${JSON.stringify(json)}`);
  }
  // Trafiklab groups platforms/quays for a physical location under
  // stop_groups[].id, with individual stops (e.g. the boat quay vs. the
  // tram/bus stop) listed in stop_groups[].stops[]. The group id gives a
  // departure board across all modes at that hub, which we then filter
  // down to the boat line we want.
  const groups = Array.isArray(json.stop_groups) ? json.stop_groups : [];
  if (!groups.length) return null;

  const lower = name.toLowerCase();
  const matching = groups.filter(
    (g) =>
      (g.name || "").toLowerCase().includes(lower) ||
      (g.stops || []).some((s) => (s.name || "").toLowerCase() === lower)
  );
  const pool = matching.length ? matching : groups;
  const withBoat = pool.find((g) => (g.transport_modes || []).includes("BOAT"));
  const chosen = withBoat || pool[0];
  return chosen.id || null;
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

// The API expects yyyy-MM-dd'T'HH:mm (no seconds) for the optional {time}
// path segment used to page into later departure windows - confirmed via
// its own error message when seconds were included.
function formatApiTime(date) {
  return (
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}` +
    `T${pad2(date.getHours())}:${pad2(date.getMinutes())}`
  );
}

async function fetchDeparturesWindow(apiKey, stopId, time) {
  const url = time
    ? `${API_BASE}/departures/${encodeURIComponent(stopId)}/${encodeURIComponent(time)}?key=${encodeURIComponent(apiKey)}`
    : `${API_BASE}/departures/${encodeURIComponent(stopId)}?key=${encodeURIComponent(apiKey)}`;
  const json = await fetchJSON(url);
  if (!config.runsInWidget) {
    console.log(
      `Departures raw response for stop ${stopId}${time ? " at " + time : ""}: ${JSON.stringify(json).slice(0, 4000)}`
    );
  }
  return Array.isArray(json.departures) ? json.departures : [];
}

function toBoat(dep) {
  const route = dep.route || {};
  const scheduled = new Date(dep.scheduled);
  const realtime = dep.realtime ? new Date(dep.realtime) : scheduled;
  return {
    time: realtime,
    scheduled,
    delayMinutes: Math.round((realtime.getTime() - scheduled.getTime()) / 60000),
    canceled: !!dep.canceled,
    line: route.designation || "",
    destination: (route.destination && route.destination.name) || route.direction || "",
    tripId: dep.trip && dep.trip.trip_id,
    startDate: dep.trip && dep.trip.start_date,
  };
}

// Confirmed trip-details shape: { ..., calls: [{ stop: { name, ... }, ... }] }
// in stop order. We check that destinationName appears *after* originName
// in that order, so a boat already past the destination and heading away
// from it (e.g. continuing on to a further island) doesn't get included.
async function tripGoesToward(apiKey, tripId, startDate, originName, destinationName) {
  const url = `${API_BASE}/trips/${encodeURIComponent(tripId)}/${encodeURIComponent(startDate)}?key=${encodeURIComponent(apiKey)}`;
  const json = await fetchJSON(url);
  if (!config.runsInWidget) {
    console.log(`Trip details raw response for ${tripId}/${startDate}: ${JSON.stringify(json).slice(0, 4000)}`);
  }
  const calls = Array.isArray(json.calls) ? json.calls : [];
  const names = calls.map((c) => ((c.stop && c.stop.name) || "").toLowerCase());
  const originIdx = names.indexOf(originName.toLowerCase());
  const destinationIdx = names.indexOf(destinationName.toLowerCase());
  if (originIdx === -1 || destinationIdx === -1) return false;
  return destinationIdx > originIdx;
}

// Cache per *trip instance* (trip_id + start_date), not per line number.
// The same line can run different stopping patterns on different trips
// (an express that skips a stop vs. a local that calls at it), so "line X
// always/never serves this route" is the wrong granularity - a specific
// trip's own stop order never changes once it's scheduled, though, so
// caching that is safe and saves re-querying Trip Details on every
// refresh for a boat we've already checked.
function tripCacheKey(tripId, startDate) {
  return `${tripId}_${startDate}`;
}

function readTripKnowledge() {
  return readCache().tripKnowledge || {};
}

function pruneTripKnowledge(knowledge) {
  const cutoff = Date.now() - CONFIG.tripKnowledgeMaxAgeDays * 86400000;
  const pruned = {};
  for (const [key, entry] of Object.entries(knowledge)) {
    if (entry && entry.checkedAt && new Date(entry.checkedAt).getTime() >= cutoff) {
      pruned[key] = entry;
    }
  }
  return pruned;
}

async function tripServesRoute(apiKey, tripId, startDate) {
  const knowledge = readTripKnowledge();
  const key = tripCacheKey(tripId, startDate);
  if (knowledge[key]) return knowledge[key].serves;

  const serves = await tripGoesToward(apiKey, tripId, startDate, CONFIG.originStopName, CONFIG.destinationStopName);
  knowledge[key] = { serves, checkedAt: new Date().toISOString() };
  writeCache({ tripKnowledge: pruneTripKnowledge(knowledge) });
  return serves;
}

// Shared pagination: walks forward through 60-minute departure windows,
// verifying each BOAT departure's actual route via tripServesRoute(), and
// stops as soon as shouldStop(results, cursor) says so. shouldCollect(boat)
// decides whether a verified boat is kept in the results. Used both for
// "the next few boats" (stop once we have enough) and "the last boat
// before 04:00" (stop once we've paged past that time) below.
//
// maxNewTripChecks caps how many *not-yet-cached* Trip Details lookups
// this call is willing to make - each trip is checked once per day (every
// day's boats get fresh trip ids, so yesterday's cache never carries
// over), and a cold search covering many hours could need enough of them
// to blow past a widget's strict execution time budget on its own. When
// the cap is hit, the search stops early and reports itself incomplete;
// the boats it did verify are still cached via tripServesRoute() though,
// so a follow-up call (the next refresh) picks up further ahead with that
// much less new work left to do - the search completes over a few
// refreshes instead of risking a timeout trying to finish in one.
async function collectMatchingBoats(apiKey, stopId, { shouldStop, shouldCollect, maxNewTripChecks }) {
  const results = [];
  const seenTripIds = new Set();
  const knowledge = readTripKnowledge();
  let cursor = null; // Date to page into the next 60-minute window
  let newChecks = 0;
  let complete = true;

  for (let page = 0; page < CONFIG.maxLookaheadPages && !shouldStop(results, cursor); page++) {
    const timeParam = cursor ? formatApiTime(cursor) : undefined;
    let raw;
    try {
      raw = await fetchDeparturesWindow(apiKey, stopId, timeParam);
    } catch (err) {
      if (!config.runsInWidget) {
        console.log(`Stopped paging (page ${page}, time ${timeParam || "now"}): ${err.message}`);
      }
      // A failed request is not the same thing as "no boats" - if we have
      // nothing yet, let the failure propagate so the caller falls back to
      // cached data (or shows a real error) instead of wrongly reporting
      // an empty schedule. If earlier pages already found boats, keep them.
      if (!results.length) throw err;
      complete = false;
      break;
    }

    if (raw.length) {
      let hitBudget = false;
      for (const dep of raw) {
        const route = dep.route || {};
        if (route.transport_mode !== "BOAT") continue;
        if (dep.canceled) continue;
        const tripId = dep.trip && dep.trip.trip_id;
        const startDate = dep.trip && dep.trip.start_date;
        if (tripId) {
          if (seenTripIds.has(tripId)) continue;
          seenTripIds.add(tripId);
        }
        if (!tripId || !startDate) continue;

        const isCached = !!knowledge[tripCacheKey(tripId, startDate)];
        if (!isCached && maxNewTripChecks != null && newChecks >= maxNewTripChecks) {
          hitBudget = true;
          continue; // skip further *new* checks this run, but keep collecting cache hits
        }
        if (!isCached) newChecks++;

        const serves = await tripServesRoute(apiKey, tripId, startDate);
        if (!serves) continue;

        const boat = toBoat(dep);
        if (shouldCollect(boat)) results.push(boat);
      }
      if (hitBudget) {
        complete = false;
        break;
      }
    }

    // Advance to the next 60-minute window regardless of whether this one
    // had any departures at all, so an overnight service gap (e.g. no
    // boats/trams/buses for a few hours) doesn't stop the search early.
    const lastRaw = raw[raw.length - 1];
    const lastScheduled = lastRaw ? new Date(lastRaw.scheduled) : null;
    const nextCursor =
      lastScheduled && (!cursor || lastScheduled.getTime() > cursor.getTime())
        ? new Date(lastScheduled.getTime() + 60000)
        : new Date((cursor ? cursor.getTime() : Date.now()) + 60 * 60000);
    cursor = nextCursor;
  }

  results.sort((a, b) => a.time.getTime() - b.time.getTime());
  return { results, complete };
}

async function collectNextBoats(apiKey, stopId, count) {
  const { results } = await collectMatchingBoats(apiKey, stopId, {
    shouldStop: (results) => results.length >= count,
    shouldCollect: () => true,
  });
  return results.slice(0, count);
}

// Returns the next occurrence of `hour`:00 strictly after `from` - today's
// if it hasn't happened yet, otherwise tomorrow's.
function nextClockTime(from, hour) {
  const next = new Date(from);
  next.setHours(hour, 0, 0, 0);
  if (next.getTime() <= from.getTime()) {
    next.setDate(next.getDate() + 1);
  }
  return next;
}

// The archipelago boats run frequently all day, then stop for a few hours
// overnight before the first morning departure (typically ~04:30-05:47).
// The last one you can catch home for the night is simply the last
// matching boat that departs before the next occurrence of
// lastBoatCutoffHour (04:00) - so page forward only as far as that cutoff
// and take the latest boat found before it.
async function collectLastBoatBeforeCutoff(apiKey, stopId, cutoff, maxNewTripChecks) {
  const { results, complete } = await collectMatchingBoats(apiKey, stopId, {
    shouldStop: (results, cursor) => !!cursor && cursor.getTime() >= cutoff.getTime(),
    shouldCollect: (boat) => boat.time.getTime() < cutoff.getTime(),
    maxNewTripChecks,
  });
  return { found: results.length ? results[results.length - 1] : null, complete };
}

// Finding the last boat means checking several boats' Trip Details, which
// is too slow to redo on every ~10-minute widget refresh (iOS gives
// widgets a strict time budget, and doing this every refresh is what
// caused timeouts). Two layers guard against that:
//
// 1. Once found, the result is cached and reused across refreshes until
//    it's actually in the past - so the search only needs to happen
//    roughly once per night, not every refresh.
// 2. Each day's boats get entirely new trip ids (yesterday's cache never
//    carries over), so even that once-a-night search can still be a cold
//    start covering many hours. maxNewTripChecksPerRun caps how much new
//    work a single run is willing to do; if the search doesn't finish
//    within that budget, no (possibly-wrong, since incomplete) guess is
//    cached or shown - the row is just omitted for this refresh. The
//    trips that were checked are still cached via tripServesRoute()
//    though, so the next refresh picks up with that much less new work
//    left, and the search completes - and the row appears - within a few
//    refreshes rather than risking a timeout trying to finish in one.
async function getLastBoat(apiKey, stopId) {
  const cached = readCache().lastBoat;
  if (cached && new Date(cached.time).getTime() > Date.now()) {
    return Object.assign({}, cached, { time: new Date(cached.time) });
  }

  const cutoff = nextClockTime(new Date(), CONFIG.lastBoatCutoffHour);
  // Only cap this in the actual widget, which has proven to have a much
  // stricter time budget than a manual run in the app - no need to slow
  // down manual testing with the same caution.
  const budget = config.runsInWidget ? CONFIG.maxNewTripChecksPerRun : undefined;
  const { found, complete } = await collectLastBoatBeforeCutoff(apiKey, stopId, cutoff, budget);
  if (!complete) {
    if (!config.runsInWidget) {
      console.log("Last-boat search incomplete this run (budget hit) - will resume next refresh.");
    }
    return null;
  }
  if (found) {
    writeCache({
      lastBoat: {
        time: found.time.toISOString(),
        delayMinutes: found.delayMinutes,
        canceled: found.canceled,
        line: found.line,
        tripId: found.tripId,
      },
    });
  }
  return found;
}

// Builds the final 4-regular + 1-last-boat display list. regularBoats
// comes from a small, cheap fetch; lastBoat is looked up (and cached)
// separately so it can be found even when it's well beyond those regular
// departures (e.g. it's currently afternoon and tonight's last boat is
// hours away) without needing a wide fetch on every refresh.
function buildDisplayList(regularBoats, lastBoat) {
  const regular = (lastBoat ? regularBoats.filter((b) => b.tripId !== lastBoat.tripId) : regularBoats).slice(
    0,
    CONFIG.targetBoatCount
  );
  if (!lastBoat) return regular;
  return [...regular, Object.assign({}, lastBoat, { isLastBoat: true })];
}

// ---------- widget rendering ----------

function timeLabel(date) {
  const f = new DateFormatter();
  f.dateFormat = "HH:mm";
  return f.string(date);
}

function addHeader(widget) {
  const title = widget.addText(`⛴️ ${CONFIG.originStopName} → ${CONFIG.destinationStopName}`);
  title.font = Font.boldSystemFont(14);
  title.textColor = Color.white();
  widget.addSpacer(6);
}

function addDepartureRow(widget, dep) {
  if (dep.isLastBoat) widget.addSpacer(8); // set it apart from the regular rows above

  const row = widget.addStack();
  row.centerAlignContent();
  const accentColor = dep.isLastBoat ? new Color("#bf5af2") : Color.white();

  const time = row.addText(timeLabel(dep.time));
  time.font = Font.semiboldSystemFont(20);
  time.textColor = accentColor;

  row.addSpacer(8);

  let statusText = "on time";
  let statusColor = new Color("#4cd964");
  if (dep.canceled) {
    statusText = "cancelled";
    statusColor = new Color("#ff3b30");
  } else if (dep.delayMinutes && dep.delayMinutes > 0) {
    statusText = `+${dep.delayMinutes} min`;
    statusColor = new Color("#ff9500");
  }
  const status = row.addText(statusText);
  status.font = Font.systemFont(13);
  status.textColor = statusColor;

  row.addSpacer();
  const lineLabel = dep.isLastBoat ? `🌙 Last · Line ${dep.line}` : `Line ${dep.line}`;
  const line = row.addText(lineLabel);
  line.font = Font.systemFont(13);
  line.textColor = dep.isLastBoat ? accentColor : new Color("#8e8e93");

  widget.addSpacer(4);
}

function addMessage(widget, text) {
  const t = widget.addText(text);
  t.font = Font.systemFont(13);
  t.textColor = new Color("#8e8e93");
}

function addFooter(widget, updatedAt, note) {
  widget.addSpacer(6);
  const label = note ? note : `Updated ${timeLabel(updatedAt)}`;
  const footer = widget.addText(label);
  footer.font = Font.systemFont(10);
  footer.textColor = new Color("#636366");
}

async function createWidget() {
  const widget = new ListWidget();
  widget.backgroundColor = new Color("#0b1f33");
  widget.setPadding(12, 12, 12, 12);

  const family = config.widgetFamily || (config.runsInWidget ? "medium" : "large");
  const totalRows = CONFIG.targetBoatCount + 1; // regular boats + the last-boat row
  const maxResults = family === "small" ? 1 : totalRows;

  addHeader(widget);

  try {
    const apiKey = await getApiKey();
    if (!apiKey) {
      addMessage(
        widget,
        "Open this script once in Scriptable and enter your free Trafiklab API key."
      );
      widget.refreshAfterDate = new Date(Date.now() + CONFIG.refreshMinutes * 60 * 1000);
      return widget;
    }

    if (config.runsInWidget) {
      // This script and its return-trip sibling share one API key and can
      // both be scheduled to refresh at close to the same moment; a small
      // random delay spreads their requests out so they're less likely to
      // collide and trip the free tier's rate limit. Kept short - widgets
      // have a strict overall time budget.
      await delay(Math.floor(Math.random() * 1200));
    }

    let stopId = readCache().stopId;
    if (!stopId) {
      stopId = await findStopId(apiKey, CONFIG.originStopName);
      if (stopId) writeCache({ stopId });
    }
    if (!stopId) {
      throw new Error(`Could not find stop "${CONFIG.originStopName}"`);
    }

    // Two separate lookups: a small, cheap one for the regular upcoming
    // boats (every refresh), and the last-boat-of-the-night one, which is
    // far more expensive but internally cached and normally only actually
    // searches once per night - see getLastBoat().
    const [regularBoats, lastBoat] = await Promise.all([
      collectNextBoats(apiKey, stopId, CONFIG.targetBoatCount + 2),
      getLastBoat(apiKey, stopId),
    ]);

    if (!regularBoats.length && !lastBoat) {
      addMessage(widget, `No boats to ${CONFIG.destinationStopName} found in the lookahead window.`);
    } else {
      const displayList = buildDisplayList(regularBoats, lastBoat);
      for (const dep of displayList.slice(0, maxResults)) addDepartureRow(widget, dep);
      writeCache({
        lastDepartures: displayList.map((d) => ({
          time: d.time.toISOString(),
          delayMinutes: d.delayMinutes,
          canceled: d.canceled,
          line: d.line,
          isLastBoat: !!d.isLastBoat,
        })),
        lastUpdated: new Date().toISOString(),
      });

      if (!config.runsInWidget) {
        console.log(
          `Showing to ${CONFIG.destinationStopName}: ` +
            displayList
              .map(
                (b) =>
                  `${timeLabel(b.time)}${b.delayMinutes ? ` (+${b.delayMinutes}m)` : ""}${b.isLastBoat ? " [last boat]" : ""}`
              )
              .join(", ")
        );
      }
    }
    addFooter(widget, new Date());
  } catch (err) {
    const cache = readCache();
    const cached = cache.lastDepartures || [];
    if (cached.length) {
      for (const raw of cached.slice(0, maxResults)) {
        addDepartureRow(widget, {
          time: new Date(raw.time),
          delayMinutes: raw.delayMinutes,
          canceled: raw.canceled,
          line: raw.line,
          isLastBoat: !!raw.isLastBoat,
        });
      }
      addFooter(widget, null, `Saved data - ${err.message}`);
    } else {
      addMessage(widget, `Error: ${err.message}`);
    }
  }

  widget.refreshAfterDate = new Date(Date.now() + CONFIG.refreshMinutes * 60 * 1000);
  return widget;
}

async function main() {
  const widget = await createWidget();
  if (config.runsInWidget) {
    Script.setWidget(widget);
  } else {
    await widget.presentLarge();
  }
  Script.complete();
}

// Scriptable's importModule() is synchronous and can't handle a module
// that runs a top-level `await` itself - exporting main() and letting the
// loader call and await it avoids that entirely.
module.exports = main;
