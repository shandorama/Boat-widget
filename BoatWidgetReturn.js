// Variables used by Scriptable.
// icon-color: deep-blue; icon-glyph: ship;

/**
 * BoatWidgetReturn loader - Köpstadsö -> Saltholmen (the return trip).
 *
 * This tiny stub should rarely need to change. Its only job is to download
 * the actual widget logic (BoatWidgetCoreReturn.js) from GitHub, save it
 * as a separate local file, and run it immediately - in THIS same run,
 * not the next one. That's what makes a manual ▶️ Play show a just-pushed
 * fix right away, instead of needing two runs (one to download, one to
 * apply).
 *
 * The background widget refresh (~every 10 min) goes through this same
 * loader too, so it's always current either way.
 *
 * The core is saved under a filename that includes a hash of its own
 * content (e.g. BoatWidgetCoreReturn_a1b2c3.js) rather than a fixed name,
 * and importModule()'d by that exact name. Scriptable's importModule() can
 * cache a module in memory by name for the life of the app session, so
 * reusing one fixed filename risked handing back a stale in-memory copy
 * even after a newer version was written to disk. A name that changes
 * whenever the content does can never collide with something already
 * cached from an older version.
 *
 * If fetching the latest core fails (offline, GitHub down) but a
 * previously-downloaded copy exists on disk, that copy is used instead so
 * the widget keeps working. All the real logic, setup docs, and CONFIG
 * live in BoatWidgetCoreReturn.js - this file has nothing worth editing.
 */

const CORE_BASE_NAME = "BoatWidgetCoreReturn";
const CORE_URL = "https://raw.githubusercontent.com/shandorama/Boat-widget/main/BoatWidgetCoreReturn.js";
const CORE_SIGNATURE = "// BoatWidgetCore"; // matches both BoatWidgetCore.js and BoatWidgetCoreReturn.js

function loaderFileManager() {
  // Scripts can live in Scriptable's local storage or in iCloud - match
  // whichever one actually holds this file, so the core file we write ends
  // up wherever importModule() will actually look for it.
  const icloud = FileManager.iCloud();
  return icloud.fileExists(module.filename) ? icloud : FileManager.local();
}

// A short, stable hash of the content - doesn't need to be cryptographic,
// just needs to change whenever the content does.
function contentHash(text) {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) {
    hash = (hash * 33 + text.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(36);
}

function versionedCoreName(hash) {
  return `${CORE_BASE_NAME}_${hash}`;
}

function versionedCorePath(fm, hash) {
  return fm.joinPath(fm.documentsDirectory(), `${versionedCoreName(hash)}.js`);
}

// Finds any already-downloaded versioned core file, for offline fallback.
function findExistingCoreVersion(fm) {
  const dir = fm.documentsDirectory();
  const names = fm.listContents(dir).filter((n) => n.startsWith(`${CORE_BASE_NAME}_`) && n.endsWith(".js"));
  if (!names.length) return null;
  return versionedCoreName(names[0].slice(CORE_BASE_NAME.length + 1, -3));
}

function cleanupOldCoreVersions(fm, keepHash) {
  const dir = fm.documentsDirectory();
  const keepFile = `${versionedCoreName(keepHash)}.js`;
  for (const name of fm.listContents(dir)) {
    if (name.startsWith(`${CORE_BASE_NAME}_`) && name.endsWith(".js") && name !== keepFile) {
      try {
        fm.remove(fm.joinPath(dir, name));
      } catch (e) {
        // Not worth failing the run over a leftover file.
      }
    }
  }
}

// Returns the local module name (no .js) to importModule().
async function ensureLatestCore() {
  const fm = loaderFileManager();
  try {
    const req = new Request(CORE_URL);
    req.timeoutInterval = 5; // widgets have a strict time budget - fail fast and use the cached core
    const latest = await req.loadString();
    const status = req.response ? req.response.statusCode : null;
    if (status === 200 && latest.startsWith(CORE_SIGNATURE)) {
      const hash = contentHash(latest);
      const path = versionedCorePath(fm, hash);
      if (!fm.fileExists(path)) {
        fm.writeString(path, latest);
      }
      cleanupOldCoreVersions(fm, hash);
      return versionedCoreName(hash);
    }
  } catch (e) {
    // Offline or GitHub unreachable - fall through to whatever is cached.
  }
  const existing = findExistingCoreVersion(fm);
  if (existing) return existing;
  throw new Error(`Couldn't download ${CORE_BASE_NAME}.js and no cached copy exists - check your connection.`);
}

async function main() {
  try {
    const coreName = await ensureLatestCore();
    const runCore = importModule(coreName); // synchronous - returns the exported main()
    await runCore();
  } catch (e) {
    // Something about the loader itself failed (not just a boat-data
    // fetch, which BoatWidgetCore.js already handles on its own) - show a
    // clear message instead of a crash or a blank widget.
    const widget = new ListWidget();
    widget.backgroundColor = new Color("#0b1f33");
    widget.setPadding(12, 12, 12, 12);
    const title = widget.addText("⛴️ Boat widget");
    title.font = Font.boldSystemFont(14);
    title.textColor = Color.white();
    widget.addSpacer(6);
    const msg = widget.addText(`Loader error: ${e.message}`);
    msg.font = Font.systemFont(13);
    msg.textColor = new Color("#ff3b30");
    if (config.runsInWidget) {
      Script.setWidget(widget);
    } else {
      await widget.presentLarge();
    }
    Script.complete();
  }
}

await main();
