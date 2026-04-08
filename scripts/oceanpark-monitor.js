/**
 * Ocean Park Hong Kong — 24-hour live data monitor
 *
 * Runs for 24 hours, taking snapshots every 1–30 minutes (randomised).
 * Saves all results to ./snapshots/ for later analysis.
 *
 * Usage:
 *   node --experimental-sqlite scripts/oceanpark-monitor.js
 */

import parksapi from '../lib/index.js';
import {promises as fs} from 'fs';
import path from 'path';
import {fileURLToPath} from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_DIR = path.join(__dirname, '..', 'snapshots');

const DURATION_MS = 24 * 60 * 60 * 1000;   // 24 hours total run time
const MIN_INTERVAL_MS = 1 * 60 * 1000;      // 1 minute minimum gap
const MAX_INTERVAL_MS = 20 * 60 * 1000;     // 20 minutes maximum gap

// ─── helpers ────────────────────────────────────────────────────────────────

const log = (...args) => console.log(`[${new Date().toISOString()}]`, ...args);

function randomInterval() {
  return Math.floor(Math.random() * (MAX_INTERVAL_MS - MIN_INTERVAL_MS) + MIN_INTERVAL_MS);
}

function safeTimestamp(iso) {
  return iso.replace(/[:.]/g, '-');
}

// ─── snapshot ───────────────────────────────────────────────────────────────

async function takeSnapshot(destination, index) {
  const timestamp = new Date().toISOString();
  const liveData = await destination.getEntityLiveData();
  const scheduleData = await destination.getEntitySchedules();

  const snapshot = {
    index,
    timestamp,
    summary: {
      total: liveData.length,
      operating: liveData.filter((e) => e.status === 'OPERATING').length,
      closed: liveData.filter((e) => e.status === 'CLOSED').length,
      down: liveData.filter((e) => e.status === 'DOWN').length,
      withWaitTime: liveData.filter((e) => e.queue?.STANDBY?.waitTime >= 0).length,
    },
    liveData,
    scheduleData,
  };

  const filename = `snapshot_${String(index).padStart(4, '0')}_${safeTimestamp(timestamp)}.json`;
  await fs.writeFile(
    path.join(SNAPSHOT_DIR, filename),
    JSON.stringify(snapshot, null, 2),
  );

  return {snapshot, filename};
}

// ─── main ────────────────────────────────────────────────────────────────────

async function main() {
  await fs.mkdir(SNAPSHOT_DIR, {recursive: true});

  log('Initialising Ocean Park destination…');
  const destination = new parksapi.destinations.OceanPark();

  // Save entity reference once — names, IDs, types, tags
  log('Fetching entity reference…');
  const entities = await destination.getAllEntities();
  const refFile = path.join(SNAPSHOT_DIR, 'entities_reference.json');
  await fs.writeFile(refFile, JSON.stringify(entities, null, 2));
  log(`Saved entity reference: ${entities.length} entities → entities_reference.json`);

  const startTime = Date.now();
  const endTime = startTime + DURATION_MS;
  const manifest = [];
  let snapshotIndex = 1;

  log(`Starting 24-hour monitor. Will run until ${new Date(endTime).toISOString()}`);
  log('─'.repeat(70));

  while (Date.now() < endTime) {
    try {
      const {snapshot, filename} = await takeSnapshot(destination, snapshotIndex);
      const {summary} = snapshot;

      manifest.push({
        index: snapshot.index,
        timestamp: snapshot.timestamp,
        filename,
        summary,
      });

      // Update manifest after every snapshot so it's usable mid-run
      await fs.writeFile(
        path.join(SNAPSHOT_DIR, 'manifest.json'),
        JSON.stringify(manifest, null, 2),
      );

      log(
        `Snapshot #${snapshotIndex} saved → ${filename}`,
        `| ${summary.operating}/${summary.total} operating`,
        `| ${summary.withWaitTime} with wait time`,
      );
    } catch (err) {
      log(`ERROR taking snapshot #${snapshotIndex}:`, err.message);
    }

    snapshotIndex++;

    const remaining = endTime - Date.now();
    if (remaining <= MIN_INTERVAL_MS) break;

    const interval = Math.min(randomInterval(), remaining);
    const nextInMins = (interval / 60000).toFixed(1);
    log(`Next snapshot in ${nextInMins} min  (${new Date(Date.now() + interval).toISOString()})`);
    await new Promise((resolve) => setTimeout(resolve, interval));
  }

  log('─'.repeat(70));
  log(`Done. ${snapshotIndex - 1} snapshots saved to ${SNAPSHOT_DIR}`);
  log(`Run analyse:  node --experimental-sqlite scripts/oceanpark-analyse.js`);
  process.exit(0);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
