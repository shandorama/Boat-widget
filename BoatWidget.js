// Variables used by Scriptable.
// icon-color: deep-blue; icon-glyph: ship;

/**
 * Saltholmen -> Köpstadsö boat departures widget.
 *
 * Data source: Trafiklab Realtime API (covers Västtrafik / Styrsöbolaget
 * archipelago ferries). Get a free API key at https://www.trafiklab.se/
 *
 * First-time setup:
 *   1. Install "Scriptable" from the App Store.
 *   2. Create a new script, paste this whole file in, name it "BoatWidget".
 *   3. Tap the ▶️ Play button once (run it inside the app, not as a widget
 *      yet). It will ask for your Trafiklab API key and save it in the iOS
 *      Keychain (never stored in this file). It will also look up the
 *      Saltholmen stop id once and cache it locally.
 *   4. Long-press your home screen -> add a widget -> Scriptable -> choose
 *      the "BoatWidget" script and "Medium" size.
 *
 * See CONFIG below to change the route or refresh interval.
 */

const CONFIG = {
  originStopName: "Saltholmen",
  destinationName: "Köpstadsö",
  refreshMinutes: 10,
  // The API always returns a 60 minute look-ahead window per call.
};

const KEYCHAIN_KEY = "boatWidgetTrafiklabApiKey";
const CACHE_FILE_NAME = "boat-widget-cache.json";
const API_BASE = "https://realtime-api.trafiklab.se/v1";

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

async function fetchJSON(url) {
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
  // The Trafiklab Realtime API groups platforms/quays for a physical
  // location under stop_groups[].id, with the individual stops (e.g. the
  // boat quay vs. the tram/bus stop) listed in stop_groups[].stops[].
  // Using the group id gives departures across all modes at that hub,
  // which we then filter down to BOAT + destination further on.
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

async function fetchDepartures(apiKey, stopId) {
  const url = `${API_BASE}/departures/${encodeURIComponent(stopId)}?key=${encodeURIComponent(apiKey)}`;
  const json = await fetchJSON(url);
  if (!config.runsInWidget) {
    console.log(`Departures raw response for stop ${stopId}: ${JSON.stringify(json)}`);
  }
  return extractArray(json, ["departures", "data", "results", "Departure"]);
}

function extractArray(json, keys) {
  if (Array.isArray(json)) return json;
  if (!json || typeof json !== "object") return [];
  for (const key of keys) {
    const value = json[key];
    if (Array.isArray(value)) return value;
    if (value && typeof value === "object") {
      const nested = extractArray(value, keys);
      if (nested.length) return nested;
    }
  }
  return [];
}

// ---------- flexible field extraction ----------
// The exact JSON field names for the (newer) Trafiklab Realtime API weren't
// verifiable from this environment, so instead of hardcoding brittle paths
// we scan each departure object (a couple of levels deep, e.g. dep.route.x)
// for keys that *look* like what we need. Run the script manually once and
// check the on-screen "debug" preview / console log if a field ever looks
// wrong - the raw JSON is logged there.

function collectPaths(obj, prefix, depth, out) {
  if (!obj || typeof obj !== "object" || depth > 2) return;
  for (const key of Object.keys(obj)) {
    const value = obj[key];
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      collectPaths(value, path, depth + 1, out);
    } else {
      out.push([path.toLowerCase(), value]);
    }
  }
}

function findValue(dep, patterns) {
  const kv = [];
  collectPaths(dep, "", 0, kv);
  for (const pattern of patterns) {
    const hit = kv.find(([path]) => pattern.test(path));
    if (hit && hit[1] !== null && hit[1] !== undefined && hit[1] !== "") {
      return hit[1];
    }
  }
  return null;
}

function parseTimeValue(raw) {
  if (!raw) return null;
  const d = new Date(raw);
  if (!isNaN(d.getTime())) return d;
  // Fall back for a bare "HH:mm[:ss]" string: attach to today.
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(raw).trim());
  if (m) {
    const now = new Date();
    now.setHours(Number(m[1]), Number(m[2]), Number(m[3] || 0), 0);
    return now;
  }
  return null;
}

function parseDeparture(dep) {
  const scheduledRaw = findValue(dep, [
    /sched.*dep.*time/,
    /departure.*sched/,
    /^scheduled$/,
    /scheduled.*time/,
  ]);
  const realtimeRaw = findValue(dep, [
    /real.*dep.*time/,
    /departure.*real/,
    /^realtime$/,
    /realtime.*time/,
    /expected/,
  ]);
  const scheduled = parseTimeValue(scheduledRaw);
  const realtime = parseTimeValue(realtimeRaw);
  const time = realtime || scheduled;

  let delayMinutes = null;
  const delayRaw = findValue(dep, [/delay/]);
  if (typeof delayRaw === "number") {
    delayMinutes = Math.round(Math.abs(delayRaw) > 1000 ? delayRaw / 60 : delayRaw);
  } else if (scheduled && realtime) {
    delayMinutes = Math.round((realtime.getTime() - scheduled.getTime()) / 60000);
  }

  const canceledRaw = findValue(dep, [/cancel/]);
  const canceled = canceledRaw === true || canceledRaw === "true" || canceledRaw === 1;

  const destination = findValue(dep, [/destination/, /direction/]) || "";
  const line =
    findValue(dep, [/designation/, /line.*(name|number|id)$/, /route.*(name|short)/]) || "";

  return { time, scheduled, realtime, delayMinutes, canceled, destination: String(destination), line: String(line) };
}

function matchesDestination(dep, filterText) {
  const destination = String(findValue(dep, [/destination/, /direction/]) || "").toLowerCase();
  return destination.includes(filterText.toLowerCase());
}

// ---------- widget rendering ----------

function timeLabel(date) {
  const f = new DateFormatter();
  f.dateFormat = "HH:mm";
  return f.string(date);
}

function addHeader(widget) {
  const title = widget.addText(`⛴️ ${CONFIG.originStopName} → ${CONFIG.destinationName}`);
  title.font = Font.boldSystemFont(14);
  title.textColor = Color.white();
  widget.addSpacer(6);
}

function addDepartureRow(widget, dep, stale) {
  const row = widget.addStack();
  row.centerAlignContent();

  const time = row.addText(timeLabel(dep.time));
  time.font = Font.semiboldSystemFont(20);
  time.textColor = Color.white();

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

  if (dep.line) {
    row.addSpacer();
    const line = row.addText(dep.line);
    line.font = Font.systemFont(13);
    line.textColor = new Color("#8e8e93");
  }

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

  const family = config.widgetFamily || "medium";
  const maxResults = family === "small" ? 1 : family === "large" ? 5 : 3;

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

    let stopId = readCache().stopId;
    if (!stopId) {
      stopId = await findStopId(apiKey, CONFIG.originStopName);
      if (stopId) writeCache({ stopId });
    }
    if (!stopId) {
      throw new Error(`Could not find stop "${CONFIG.originStopName}"`);
    }

    const rawDepartures = await fetchDepartures(apiKey, stopId);
    const parsed = rawDepartures
      .filter((d) => matchesDestination(d, CONFIG.destinationName))
      .map(parseDeparture)
      .filter((d) => d.time && !d.canceled)
      .sort((a, b) => a.time.getTime() - b.time.getTime())
      .slice(0, maxResults);

    if (!parsed.length) {
      addMessage(widget, `No ${CONFIG.destinationName} departures in the next hour.`);
    } else {
      for (const dep of parsed) addDepartureRow(widget, dep);
      writeCache({
        lastDepartures: parsed.map((d) => ({
          time: d.time.toISOString(),
          delayMinutes: d.delayMinutes,
          canceled: d.canceled,
          line: d.line,
        })),
        lastUpdated: new Date().toISOString(),
      });
    }
    addFooter(widget, new Date());
  } catch (err) {
    const cache = readCache();
    const cached = cache.lastDepartures || [];
    if (cached.length) {
      for (const raw of cached) {
        addDepartureRow(widget, {
          time: new Date(raw.time),
          delayMinutes: raw.delayMinutes,
          canceled: raw.canceled,
          line: raw.line,
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
    await widget.presentMedium();
  }
  Script.complete();
}

await main();
