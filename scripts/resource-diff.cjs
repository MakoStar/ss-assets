const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { pipeline } = require('node:stream/promises');
const { parseArgs } = require('node:util');

const ASSET_EXT = '.unity3d';
const CONCURRENCY = Math.min(8, os.cpus().length);
const SORT_ENTRIES = true;

const log = {
  head: (m) => console.log(`\n===== ${m} =====`),
  step: (m) => console.log(`[step] ${m}`),
  info: (m) => console.log(`[info] ${m}`),
  error: (m) => console.error(`[error] ${m}`),
  warn: (m) => console.warn(`[warn] ${m}`),
};

function collectFiles(root) {
  const map = new Map();
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return map;
  walk(root, root, map);
  return map;
}

function walk(current, root, map) {
  let entries;
  try {
    entries = fs.readdirSync(current, { withFileTypes: true });
  } catch (e) {
    log.warn(`readdir failed: ${current} (${e.message})`);
    return;
  }

  if (SORT_ENTRIES) entries.sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    const full = path.join(current, entry.name);
    if (entry.isDirectory()) {
      walk(full, root, map);
    } else if (entry.isFile() && entry.name.endsWith(ASSET_EXT)) {
      const rel = path.relative(root, full);
      map.set(rel, full);
    }
  }
}

async function fileHash(filePath) {
  const hash = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(filePath), hash);
  return hash.digest('hex');
}

async function pool(items, limit, fn) {
  let idx = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (idx < items.length) {
      const i = idx++;
      await fn(items[i], i);
    }
  });
  await Promise.all(workers);
}

async function copyAsset(srcPath, destRoot, relPath) {
  const destPath = path.join(destRoot, relPath);
  await fsp.mkdir(path.dirname(destPath), { recursive: true });
  await fsp.copyFile(srcPath, destPath);
}

async function syncDiff(dirA, dirB, diffOut) {
  log.head('DETECT UNITY3D CHANGES');
  log.step(`Scanning A: ${dirA}`);
  const mapA = collectFiles(dirA);
  log.step(`Scanning B: ${dirB}`);
  const mapB = collectFiles(dirB);
  log.info(`A: ${mapA.size} files, B: ${mapB.size} files`);

  await fsp.mkdir(diffOut, { recursive: true });

  const onlyB = [];
  const common = [];
  for (const [rel, fullB] of mapB) {
    if (mapA.has(rel)) common.push({ rel, a: mapA.get(rel), b: fullB });
    else onlyB.push({ rel, b: fullB });
  }
  log.info(`only_b: ${onlyB.length}, common: ${common.length}`);

  let newCount = 0;
  for (const { rel, b } of onlyB) {
    try {
      await copyAsset(b, diffOut, rel);
      newCount++;
    } catch (e) {
      log.error(`Copy new failed ${rel}: ${e.message}`);
    }
  }

  const sizeDiff = [];
  const needHash = [];
  for (const item of common) {
    try {
      const [sa, sb] = await Promise.all([
        fsp.stat(item.a),
        fsp.stat(item.b),
      ]);
      if (sa.size !== sb.size) sizeDiff.push(item);
      else needHash.push(item);
    } catch (e) {
      log.error(`stat failed ${item.rel}: ${e.message}`);
    }
  }
  log.info(`size-diff: ${sizeDiff.length}, need-hash: ${needHash.length}`);

  let changedCount = sizeDiff.length;
  for (const { rel, b } of sizeDiff) {
    try {
      await copyAsset(b, diffOut, rel);
    } catch (e) {
      log.error(`Copy size-changed failed ${rel}: ${e.message}`);
      changedCount--;
    }
  }

  let hashChanged = 0;
  await pool(needHash, CONCURRENCY, async ({ rel, a, b }) => {
    try {
      const [ha, hb] = await Promise.all([fileHash(a), fileHash(b)]);
      if (ha !== hb) {
        await copyAsset(b, diffOut, rel);
        hashChanged++;
      }
    } catch (e) {
      log.error(`Hash compare failed ${rel}: ${e.message}`);
    }
  });
  changedCount += hashChanged;

  log.step(
    `Completed: new=${newCount} changed=${changedCount} total=${newCount + changedCount}`,
  );
  return { newCount, changedCount };
}

async function main() {
  const { values } = parseArgs({
    options: {
      'a-dir':    { type: 'string', short: 'a' },
      'b-dir':    { type: 'string', short: 'b' },
      'out-diff': { type: 'string', short: 'o', default: './diff_out' },
    },
  });

  const a = values['a-dir']?.trim();
  const b = values['b-dir']?.trim();
  const o = values['out-diff']?.trim() ?? './diff_out';

  if (!a || !b) {
    console.error('Usage: node resource-diff.cjs -a <dirA> -b <dirB> [-o <outDir>]');
    process.exit(1);
  }

  const t0 = Date.now();
  try {
    const result = await syncDiff(a, b, o);
    log.step(`Done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    if (result.newCount + result.changedCount === 0) {
      log.info('✅ No changes detected');
    }
    process.exit(0);
  } catch (e) {
    log.error(e.stack || e.message);
    process.exit(1);
  }
}

main();
