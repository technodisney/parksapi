/**
 * Ocean Park Hong Kong — snapshot analyser
 *
 * Reads all snapshots produced by oceanpark-monitor.js and outputs:
 *   - Per-entity status timeline (operating/closed/down over time)
 *   - Wait time history per ride
 *   - Show schedule accuracy (did showtimes appear as expected?)
 *   - Park open/closed windows inferred from data
 *
 * Usage:
 *   node --experimental-sqlite scripts/oceanpark-analyse.js
 *   node --experimental-sqlite scripts/oceanpark-analyse.js > report.txt
 */

import {promises as fs} from 'fs';
import path from 'path';
import {fileURLToPath} from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_DIR = path.join(__dirname, '..', 'snapshots');

// ─── load data ───────────────────────────────────────────────────────────────

async function loadManifest() {
  const raw = await fs.readFile(path.join(SNAPSHOT_DIR, 'manifest.json'), 'utf8');
  return JSON.parse(raw);
}

async function loadEntities() {
  const raw = await fs.readFile(path.join(SNAPSHOT_DIR, 'entities_reference.json'), 'utf8');
  return JSON.parse(raw);
}

async function loadSnapshot(filename) {
  const raw = await fs.readFile(path.join(SNAPSHOT_DIR, filename), 'utf8');
  return JSON.parse(raw);
}

// ─── analysis helpers ────────────────────────────────────────────────────────

function statusSymbol(status) {
  switch (status) {
    case 'OPERATING':    return '●';
    case 'CLOSED':       return '○';
    case 'DOWN':         return '✕';
    case 'REFURBISHMENT': return 'R';
    default:             return '?';
  }
}

function pad(str, len) {
  return String(str).padEnd(len).slice(0, len);
}

function hhmm(iso) {
  return iso ? new Date(iso).toLocaleTimeString('en-HK', {
    hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Hong_Kong',
  }) : '??:??';
}

function dateStr(iso) {
  return iso ? new Date(iso).toLocaleDateString('en-HK', {
    month: 'short', day: 'numeric', timeZone: 'Asia/Hong_Kong',
  }) : '???';
}

// ─── report sections ─────────────────────────────────────────────────────────

function printHeader(title) {
  console.log('\n' + '═'.repeat(80));
  console.log(`  ${title}`);
  console.log('═'.repeat(80));
}

function printOverview(manifest, entities) {
  printHeader('OVERVIEW');
  console.log(`Snapshots:    ${manifest.length}`);
  console.log(`First:        ${manifest[0]?.timestamp}`);
  console.log(`Last:         ${manifest[manifest.length - 1]?.timestamp}`);
  const durationMs = new Date(manifest[manifest.length - 1]?.timestamp) - new Date(manifest[0]?.timestamp);
  const durationH = (durationMs / 3600000).toFixed(1);
  console.log(`Duration:     ${durationH} hours`);
  console.log(`Entities:     ${entities.length} total`);

  const byType = {};
  for (const e of entities) {
    byType[e.entityType] = (byType[e.entityType] || 0) + 1;
  }
  for (const [type, count] of Object.entries(byType)) {
    console.log(`              ${count} ${type}`);
  }

  // operating range across run
  const maxOp = Math.max(...manifest.map((m) => m.summary.operating));
  const minOp = Math.min(...manifest.map((m) => m.summary.operating));
  console.log(`Operating:    min=${minOp}  max=${maxOp} (across all snapshots)`);
}

function printStatusTimeline(manifest, snapshots, entities) {
  printHeader('STATUS TIMELINE  (● operating  ○ closed  ✕ down)');

  const attractions = entities.filter((e) =>
    e.entityType === 'ATTRACTION' && e.attractionType === 'RIDE',
  );

  // Print time header
  const times = manifest.map((m) => hhmm(m.timestamp));
  const colW = 3;
  console.log(pad('Ride', 32) + times.map((t) => pad(t.slice(0, 2), colW)).join(''));
  console.log(' '.repeat(32) + times.map((t) => pad(t.slice(3), colW)).join(''));
  console.log('-'.repeat(32 + times.length * colW));

  for (const entity of attractions.sort((a, b) => a.name.localeCompare(b.name))) {
    const row = snapshots.map((snap) => {
      const live = snap.liveData.find((l) => l._id === entity._id);
      return pad(live ? statusSymbol(live.status) : '-', colW);
    }).join('');
    console.log(pad(entity.name, 32) + row);
  }
}

function printWaitTimeSummary(snapshots, entities) {
  printHeader('WAIT TIME SUMMARY  (rides only)');

  const rides = entities.filter((e) =>
    e.entityType === 'ATTRACTION' && e.attractionType === 'RIDE',
  );

  // For each ride, collect all non-null wait times
  const rows = [];
  for (const entity of rides) {
    const waits = snapshots.flatMap((snap) => {
      const live = snap.liveData.find((l) => l._id === entity._id);
      const wt = live?.queue?.STANDBY?.waitTime;
      return (wt != null && wt >= 0) ? [wt] : [];
    });

    if (waits.length === 0) continue;

    const avg = (waits.reduce((a, b) => a + b, 0) / waits.length).toFixed(0);
    const max = Math.max(...waits);
    const min = Math.min(...waits);
    rows.push({name: entity.name, avg: Number(avg), max, min, samples: waits.length});
  }

  if (rows.length === 0) {
    console.log('No wait time data recorded (park may have been closed during entire run).');
    return;
  }

  rows.sort((a, b) => b.avg - a.avg);
  console.log(pad('Ride', 36) + pad('avg', 6) + pad('max', 6) + pad('min', 6) + 'samples');
  console.log('-'.repeat(70));
  for (const r of rows) {
    console.log(pad(r.name, 36) + pad(r.avg + 'm', 6) + pad(r.max + 'm', 6) + pad(r.min + 'm', 6) + r.samples);
  }
}

function printShowtimeSummary(snapshots, entities) {
  printHeader('SHOW SCHEDULE SIGHTINGS');

  const shows = entities.filter((e) => e.entityType === 'SHOW');

  for (const show of shows.sort((a, b) => a.name.localeCompare(b.name))) {
    // Collect all unique showtimes seen across snapshots
    const seen = new Map(); // startTime ISO → count
    let operatingCount = 0;

    for (const snap of snapshots) {
      const live = snap.liveData.find((l) => l._id === show._id);
      if (!live) continue;
      if (live.status === 'OPERATING') operatingCount++;
      for (const st of (live.showtimes || [])) {
        const key = st.startTime;
        seen.set(key, (seen.get(key) || 0) + 1);
      }
    }

    if (seen.size === 0) continue;

    const times = [...seen.keys()].sort().map((t) =>
      `${dateStr(t)} ${hhmm(t)}`
    );
    console.log(`\n${show.name}  (operating in ${operatingCount}/${snapshots.length} snapshots)`);
    for (const t of times) {
      console.log(`  ${t}  (seen in ${seen.get([...seen.keys()].find((k) => `${dateStr(k)} ${hhmm(k)}` === t))} snapshots)`);
    }
  }
}

function printParkOpenWindows(manifest) {
  printHeader('PARK OPEN WINDOWS  (inferred from operating entity count)');

  let inOpenWindow = false;
  let windowStart = null;

  for (const m of manifest) {
    const isOpen = m.summary.operating > 0;
    if (isOpen && !inOpenWindow) {
      inOpenWindow = true;
      windowStart = m.timestamp;
    } else if (!isOpen && inOpenWindow) {
      console.log(`  Open: ${hhmm(windowStart)} → ${hhmm(m.timestamp)}  (${dateStr(windowStart)})`);
      inOpenWindow = false;
      windowStart = null;
    }
  }

  if (inOpenWindow) {
    console.log(`  Open: ${hhmm(windowStart)} → (still open at end of run)  (${dateStr(windowStart)})`);
  }
}

function printStatusChanges(snapshots, entities) {
  printHeader('STATUS CHANGES  (entity transitions between snapshots)');

  const entityMap = new Map(entities.map((e) => [e._id, e.name]));
  let changeCount = 0;

  for (let i = 1; i < snapshots.length; i++) {
    const prev = snapshots[i - 1];
    const curr = snapshots[i];
    const timeLabel = `${hhmm(prev.timestamp)}→${hhmm(curr.timestamp)}`;

    for (const currLive of curr.liveData) {
      const prevLive = prev.liveData.find((l) => l._id === currLive._id);
      if (!prevLive) continue;
      if (prevLive.status !== currLive.status) {
        const name = entityMap.get(currLive._id) || currLive._id;
        console.log(`  ${timeLabel}  ${pad(name, 36)} ${prevLive.status} → ${currLive.status}`);
        changeCount++;
      }
    }
  }

  if (changeCount === 0) {
    console.log('  No status changes detected between consecutive snapshots.');
  }
  console.log(`\n  Total changes: ${changeCount}`);
}

// ─── main ────────────────────────────────────────────────────────────────────

async function main() {
  let manifest;
  try {
    manifest = await loadManifest();
  } catch (e) {
    console.error(`Cannot read ${SNAPSHOT_DIR}/manifest.json — has the monitor run yet?`);
    process.exit(1);
  }

  if (manifest.length === 0) {
    console.error('No snapshots in manifest yet.');
    process.exit(1);
  }

  const entities = await loadEntities();

  console.log(`Loading ${manifest.length} snapshots…`);
  const snapshots = await Promise.all(
    manifest.map((m) => loadSnapshot(m.filename)),
  );

  printOverview(manifest, entities);
  printParkOpenWindows(manifest);
  printStatusTimeline(manifest, snapshots, entities);
  printWaitTimeSummary(snapshots, entities);
  printStatusChanges(snapshots, entities);
  printShowtimeSummary(snapshots, entities);

  console.log('\n' + '═'.repeat(80));
  console.log('  Analysis complete.');
  console.log('═'.repeat(80) + '\n');
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
