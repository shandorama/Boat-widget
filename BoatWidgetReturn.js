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
 * If fetching the latest core fails (offline, GitHub down) but a
 * previously-downloaded copy exists on disk, that copy is used instead so
 * the widget keeps working. All the real logic, setup docs, and CONFIG
 * live in BoatWidgetCoreReturn.js - this file has nothing worth editing.
 */

const CORE_NAME = "BoatWidgetCoreReturn"; // local module filename, no .js
const CORE_URL = "https://raw.githubusercontent.com/shandorama/Boat-widget/main/BoatWidgetCoreReturn.js";
const CORE_SIGNATURE = "// BoatWidgetCore"; // matches both BoatWidgetCore.js and BoatWidgetCoreReturn.js

function loaderFileManager() {
  // Scripts can live in Scriptable's local storage or in iCloud - match
  // whichever one actually holds this file, so the core file we write ends
  // up wherever importModule() will actually look for it.
  const icloud = FileManager.iCloud();
  return icloud.fileExists(module.filename) ? icloud : FileManager.local();
}

function corePath(fm) {
  return fm.joinPath(fm.documentsDirectory(), `${CORE_NAME}.js`);
}

async function ensureLatestCore() {
  const fm = loaderFileManager();
  const path = corePath(fm);
  try {
    const req = new Request(CORE_URL);
    const latest = await req.loadString();
    const status = req.response ? req.response.statusCode : null;
    if (status === 200 && latest.startsWith(CORE_SIGNATURE)) {
      const current = fm.fileExists(path) ? fm.readString(path) : null;
      if (latest !== current) {
        fm.writeString(path, latest);
      }
      return;
    }
  } catch (e) {
    // Offline or GitHub unreachable - fall through to whatever is cached.
  }
  if (!fm.fileExists(path)) {
    throw new Error(`Couldn't download ${CORE_NAME}.js and no cached copy exists - check your connection.`);
  }
}

async function main() {
  try {
    await ensureLatestCore();
    const runCore = importModule(CORE_NAME); // synchronous - returns the exported main()
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
