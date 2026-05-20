#!/usr/bin/env node
/**
 * sync-images.js — Download board game box art from Notion pages into images/
 *
 * Usage:
 *   node sync-images.js --token=secret_xxx --db=xxxxxxxx
 *   node sync-images.js --token=secret_xxx --db=xxxxxxxx --force   # re-download all
 *
 * Or via env vars:
 *   NOTION_TOKEN=... NOTION_DB_ID=... node sync-images.js
 *
 * Requires Node.js 18+ (built-in fetch).
 * After running: git add images/ && git commit -m "sync box art" && git push
 */

const fs   = require('fs');
const path = require('path');

// --- CLI args ---
const ARGS = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => { const [k, ...v] = a.slice(2).split('='); return [k, v.join('=')]; })
);
const TOKEN = ARGS.token || process.env.NOTION_TOKEN;
const DB_ID = (ARGS.db   || process.env.NOTION_DB_ID || '').replace(/-/g, '');
const FORCE = 'force' in ARGS;
const DELAY = 400; // ms between Notion API calls to stay under rate limit

if (!TOKEN || !DB_ID) {
  console.error('Usage: node sync-images.js --token=<notion_token> --db=<database_id> [--force]');
  process.exit(1);
}

const IMG_DIR = path.join(__dirname, 'images');
if (!fs.existsSync(IMG_DIR)) fs.mkdirSync(IMG_DIR, { recursive: true });

const NOTION_HEADERS = {
  'Authorization': `Bearer ${TOKEN}`,
  'Content-Type':  'application/json',
  'Notion-Version': '2022-06-28',
};

// Format raw 32-char ID to UUID format
const formattedDbId = DB_ID.replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5');

async function notionGet(endpoint) {
  const res = await fetch(`https://api.notion.com/v1${endpoint}`, { headers: NOTION_HEADERS });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Notion ${res.status}: ${t.slice(0, 200)}`);
  }
  return res.json();
}

async function notionPost(endpoint, body) {
  const res = await fetch(`https://api.notion.com/v1${endpoint}`, {
    method: 'POST', headers: NOTION_HEADERS, body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Notion ${res.status}: ${t.slice(0, 200)}`);
  }
  return res.json();
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function queryAll() {
  const pages = [];
  let cursor = null;
  do {
    const body = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    const data = await notionPost(`/databases/${formattedDbId}/query`, body);
    pages.push(...data.results);
    cursor = data.has_more ? data.next_cursor : null;
    if (cursor) await sleep(DELAY);
  } while (cursor);
  return pages;
}

async function getPageImageUrl(pageId) {
  const data = await notionGet(`/blocks/${pageId}/children?page_size=20`);
  const block = (data.results || []).find(b => b.type === 'image');
  if (!block) return null;
  return block.image?.file?.url || block.image?.external?.url || null;
}

function extFromUrlOrType(url, contentType) {
  if (contentType?.includes('png'))                                 return '.png';
  if (contentType?.includes('webp'))                                return '.webp';
  if (contentType?.includes('gif'))                                 return '.gif';
  if (contentType?.includes('jpeg') || contentType?.includes('jpg')) return '.jpg';
  try {
    const p   = new URL(url).pathname.split('?')[0];
    const ext = path.extname(p).toLowerCase();
    if (['.jpg','.jpeg','.png','.webp','.gif'].includes(ext)) return ext === '.jpeg' ? '.jpg' : ext;
  } catch(_) {}
  return '.jpg';
}

async function downloadImage(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const contentType = res.headers.get('content-type') || '';
  const buf = await res.arrayBuffer();
  return { buf, contentType };
}

function getPageName(page) {
  for (const val of Object.values(page.properties || {})) {
    if (val.type === 'title' && val.title?.length) return val.title.map(t => t.plain_text).join('').trim();
  }
  return page.id;
}

async function main() {
  console.log('📚 Fetching game list from Notion…');
  const pages = await queryAll();
  console.log(`   Found ${pages.length} pages\n`);

  // Load existing manifest (for incremental updates)
  const manifestPath = path.join(IMG_DIR, 'manifest.json');
  let manifest = {};
  if (fs.existsSync(manifestPath)) {
    try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch(_) {}
  }

  let downloaded = 0, skipped = 0, noImage = 0, failed = 0;

  for (const page of pages) {
    const notionId = page.id;
    const name     = getPageName(page);

    // Skip if already on disk unless --force
    if (!FORCE && manifest[notionId] && fs.existsSync(path.join(IMG_DIR, manifest[notionId]))) {
      skipped++;
      process.stdout.write(`  ⏭  ${name}\n`);
      continue;
    }

    try {
      await sleep(DELAY);
      const imgUrl = await getPageImageUrl(notionId);
      if (!imgUrl) { noImage++; process.stdout.write(`  —  ${name} (pas d'image)\n`); continue; }

      const { buf, contentType } = await downloadImage(imgUrl);
      const ext  = extFromUrlOrType(imgUrl, contentType);
      const file = `${notionId}${ext}`;
      fs.writeFileSync(path.join(IMG_DIR, file), Buffer.from(buf));
      manifest[notionId] = file;
      downloaded++;
      process.stdout.write(`  ✓  ${name}\n`);
    } catch(e) {
      failed++;
      process.stdout.write(`  ✗  ${name}: ${e.message}\n`);
    }
  }

  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  console.log(`\n✅ Terminé : ${downloaded} téléchargées, ${skipped} déjà présentes, ${noImage} sans image, ${failed} en erreur`);
  console.log(`📄 Manifest : images/manifest.json (${Object.keys(manifest).length} entrées)`);
  console.log(`\nProchaine étape :`);
  console.log(`  git add images/ && git commit -m "sync: box art" && git push`);
}

main().catch(e => { console.error('Erreur fatale:', e.message); process.exit(1); });
