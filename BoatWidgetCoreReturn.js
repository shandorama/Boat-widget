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
  lastBoatGapMinutes: 90, // a gap at least this long marks the overnight break
  lastBoatSearchCount: 25, // how many boats ahead to look at when finding it
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
// rate limit. Retry a rate-limited or transiently-failing request a few
// times with backoff before giving up, and add a touch of random jitter
// before it (see main()) so both widgets are less likely to collide in the
// first place.
async function fetchJSON(url, attempt) {
  attempt = attempt || 1;
  const req = new Request(url);
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
    if (retryable && attempt < 4) {
      await delay(attempt * 1500);
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

async function collectUpcomingBoats(apiKey, stopId, count) {
  const results = [];
  const seenTripIds = new Set();
  let cursor = null; // Date to page into the next 60-minute window

  for (let page = 0; page < CONFIG.maxLookaheadPages && results.length < count; page++) {
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
      break;
    }

    if (raw.length) {
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

        const serves = await tripServesRoute(apiKey, tripId, startDate);
        if (!serves) continue;

        results.push(toBoat(dep));
      }
    }

    // Advance to the next 60-minute window regardless of whether this one
    // had any departures at all, so an overnight service gap (e.g. no
    // boats/trams/buses for a few hours) doesn't stop the search early -
    // we want the next N boats "regardless of end of day".
    const lastRaw = raw[raw.length - 1];
    const lastScheduled = lastRaw ? new Date(lastRaw.scheduled) : null;
    const nextCursor =
      lastScheduled && (!cursor || lastScheduled.getTime() > cursor.getTime())
        ? new Date(lastScheduled.getTime() + 60000)
        : new Date((cursor ? cursor.getTime() : Date.now()) + 60 * 60000);
    cursor = nextCursor;
  }

  results.sort((a, b) => a.time.getTime() - b.time.getTime());
  return results.slice(0, count);
}

// The archipelago boats run frequently all day and then stop for a few
// hours overnight before the first morning departure. The boat right
// before that gap is the last one you can catch home for the night - find
// it by walking the (chronologically sorted) upcoming boats and returning
// the one right before the first gap that's at least lastBoatGapMinutes
// long. Returns null if no such gap shows up within the fetched boats.
function findLastBoatBeforeGap(sortedBoats) {
  for (let i = 0; i < sortedBoats.length - 1; i++) {
    const gapMinutes = (sortedBoats[i + 1].time.getTime() - sortedBoats[i].time.getTime()) / 60000;
    if (gapMinutes >= CONFIG.lastBoatGapMinutes) {
      return sortedBoats[i];
    }
  }
  return null;
}

// Builds the final 4-regular + 1-last-boat display list from a single
// fetch, so the "last boat of the night" row can be found even when it's
// well beyond the next 4 regular departures (e.g. it's currently
// afternoon and tonight's last boat is hours away).
function buildDisplayList(allBoats) {
  const lastBoat = findLastBoatBeforeGap(allBoats);
  const regular = (lastBoat ? allBoats.filter((b) => b.tripId !== lastBoat.tripId) : allBoats).slice(
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
      // collide and trip the free tier's rate limit.
      await delay(Math.floor(Math.random() * 4000));
    }

    let stopId = readCache().stopId;
    if (!stopId) {
      stopId = await findStopId(apiKey, CONFIG.originStopName);
      if (stopId) writeCache({ stopId });
    }
    if (!stopId) {
      throw new Error(`Could not find stop "${CONFIG.originStopName}"`);
    }

    const boats = await collectUpcomingBoats(apiKey, stopId, CONFIG.lastBoatSearchCount);

    if (!boats.length) {
      addMessage(widget, `No boats to ${CONFIG.destinationStopName} found in the lookahead window.`);
    } else {
      const displayList = buildDisplayList(boats);
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
