#!/usr/bin/env node
/**
 * sync-images.js — Sync board game box art to Notion pages and local images/
 *
 * For each game in your Notion DB:
 *   1. If the Notion page already has an image block → download it locally
 *   2. Otherwise → search BoardGameGeek (French edition preferred, main image fallback)
 *   3. Found externally → add image block to the Notion page, download locally
 *
 * Usage:
 *   node sync-images.js --token=secret_xxx --db=xxxxxxxx --bgg-token=yyy
 *   node sync-images.js --token=secret_xxx --db=xxxxxxxx --bgg-token=yyy --force
 *
 * Or via env vars:
 *   NOTION_TOKEN=... NOTION_DB_ID=... BGG_TOKEN=... node sync-images.js
 *
 * Requires Node.js 18+ (built-in fetch).
 * First run on 200 games ~15 min (BGG rate limit). Subsequent runs are instant.
 * After running: git add images/ && git commit -m "sync: box art" && git push
 */

const fs   = require('fs');
const path = require('path');

// ── CLI ─────────────────────────────────────────────────────────────────────
const ARGS = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => { const [k, ...v] = a.slice(2).split('='); return [k, v.join('=')]; })
);
const TOKEN     = ARGS['token']     || process.env.NOTION_TOKEN;
const DB_ID     = (ARGS['db']       || process.env.NOTION_DB_ID  || '').replace(/-/g, '');
const BGG_TOKEN = ARGS['bgg-token'] || process.env.BGG_TOKEN;
const FORCE     = 'force' in ARGS;

if (!TOKEN || !DB_ID) {
  console.error('Usage: node sync-images.js --token=<notion_token> --db=<database_id> --bgg-token=<bgg_token> [--force]');
  process.exit(1);
}
if (!BGG_TOKEN) {
  console.warn('⚠  --bgg-token not provided — BGG search disabled, only existing Notion images will be downloaded');
}

const IMG_DIR          = path.join(__dirname, 'images');
const NOTION_DELAY_MS  = 400;
const BGG_DELAY_MS     = 2200;  // BGG asks to be polite
const UA               = 'Mozilla/5.0 (compatible; ludo-sync/2.0)';
const BGG_FRENCH_LANG  = '2187'; // BGG language ID for French

if (!fs.existsSync(IMG_DIR)) fs.mkdirSync(IMG_DIR, { recursive: true });

const formattedDbId = DB_ID.replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5');
const NOTION_HEADERS = {
  'Authorization': `Bearer ${TOKEN}`,
  'Content-Type':  'application/json',
  'Notion-Version': '2022-06-28',
};

// ── Utilities ────────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

function isValidHttpUrl(str) {
  try { const u = new URL(str); return u.protocol === 'http:' || u.protocol === 'https:'; }
  catch(_) { return false; }
}

function extFromUrlOrType(url, contentType) {
  if (contentType?.includes('png'))                                  return '.png';
  if (contentType?.includes('webp'))                                 return '.webp';
  if (contentType?.includes('gif'))                                  return '.gif';
  if (contentType?.includes('jpeg') || contentType?.includes('jpg')) return '.jpg';
  try {
    const ext = path.extname(new URL(url).pathname.split('?')[0]).toLowerCase();
    if (['.jpg','.jpeg','.png','.webp','.gif'].includes(ext)) return ext === '.jpeg' ? '.jpg' : ext;
  } catch(_) {}
  return '.jpg';
}

async function downloadImage(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status} downloading image`);
  return { buf: await res.arrayBuffer(), contentType: res.headers.get('content-type') || '' };
}

function getPageName(page) {
  for (const v of Object.values(page.properties || {}))
    if (v.type === 'title' && v.title?.length) return v.title.map(t => t.plain_text).join('').trim();
  return page.id;
}

// ── Notion API ───────────────────────────────────────────────────────────────
async function notionFetch(endpoint, opts = {}) {
  const res = await fetch(`https://api.notion.com/v1${endpoint}`, { headers: NOTION_HEADERS, ...opts });
  if (!res.ok) { const t = await res.text().catch(() => ''); throw new Error(`Notion ${res.status}: ${t.slice(0,200)}`); }
  return res.json();
}

async function queryAll() {
  const pages = [];
  let cursor = null;
  do {
    const body = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    const data = await notionFetch(`/databases/${formattedDbId}/query`, { method: 'POST', body: JSON.stringify(body) });
    pages.push(...data.results);
    cursor = data.has_more ? data.next_cursor : null;
    if (cursor) await sleep(NOTION_DELAY_MS);
  } while (cursor);
  return pages;
}

// Read cover from the page object already returned by queryAll — no extra API call
function getPageCoverUrl(page) {
  if (!page.cover) return null;
  if (page.cover.type === 'external') return page.cover.external?.url || null;
  if (page.cover.type === 'file')     return page.cover.file?.url     || null;
  return null;
}

// Set page cover image via PATCH /pages/{id}
async function setPageCover(pageId, imageUrl) {
  return notionFetch(`/pages/${pageId}`, {
    method: 'PATCH',
    body: JSON.stringify({ cover: { type: 'external', external: { url: imageUrl } } }),
  });
}

// ── BGG XML helpers ──────────────────────────────────────────────────────────

// BGG now requires Authorization: Bearer — and redirect:'manual' avoids
// Node's undici stripping the auth header when following Cloudflare redirects
async function bggGet(url) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url, {
      headers: { 'Authorization': `Bearer ${BGG_TOKEN}`, 'User-Agent': UA },
      redirect: 'manual',
    });
    if (res.status === 202) { await sleep(3500); continue; } // BGG queued
    if (!res.ok) throw new Error(`BGG HTTP ${res.status}`);
    return res.text();
  }
  throw new Error('BGG: no response after retries');
}

// First attribute match: <tag … attr="VALUE"
function xmlAttr(xml, tag, attr) {
  return xml.match(new RegExp(`<${tag}\\b[^>]*\\s${attr}="([^"]*)"`, 'i'))?.[1] ?? null;
}

// Text content of a tag, normalising protocol-relative URLs. Returns null if empty.
function xmlText(xml, tag) {
  const v = xml.match(new RegExp(`<${tag}[^>]*>([^<]*)`, 'i'))?.[1]?.trim() ?? '';
  if (!v) return null;
  return v.startsWith('//') ? `https:${v}` : v;
}

// All boardgameversion blocks from inside <versions>…</versions>
function bggVersionBlocks(xml) {
  const section = xml.match(/<versions>([\s\S]*?)<\/versions>/i)?.[1] ?? '';
  return [...section.matchAll(/<item\b[^>]*type="boardgameversion"[\s\S]*?<\/item>/gi)].map(m => m[0]);
}

// Main game image — read from the outer item, before <versions> to avoid bleed
function bggMainImage(xml) {
  const outer = xml.match(/([\s\S]*?)(?:<versions>|$)/i)?.[1] ?? xml;
  return xmlText(outer, 'image') || xmlText(outer, 'thumbnail') || null;
}

async function bggFrenchImage(name) {
  // 1. Exact search
  let xml    = await bggGet(`https://boardgamegeek.com/xmlapi2/search?query=${encodeURIComponent(name)}&type=boardgame&exact=1`);
  let gameId = xmlAttr(xml, 'item', 'id');

  // 2. Fuzzy search fallback
  if (!gameId) {
    await sleep(BGG_DELAY_MS);
    xml    = await bggGet(`https://boardgamegeek.com/xmlapi2/search?query=${encodeURIComponent(name)}&type=boardgame`);
    gameId = xmlAttr(xml, 'item', 'id');
  }
  if (!gameId) return null;

  // 3. Game details + all versions
  await sleep(BGG_DELAY_MS);
  xml = await bggGet(`https://boardgamegeek.com/xmlapi2/thing?id=${gameId}&versions=1`);

  // 4. Find French edition
  //    BGG language ID 2187 = French; value="French" in the link tag
  const frVersion = bggVersionBlocks(xml).find(v =>
    new RegExp(`<link[^>]*type="language"[^>]*id="${BGG_FRENCH_LANG}"`).test(v) ||
    /<link[^>]*type="language"[^>]*value="French"/.test(v)
  );

  if (frVersion) {
    const img = xmlText(frVersion, 'image') || xmlText(frVersion, 'thumbnail');
    if (img) return img;
    // French version exists but has no image — fall through to main image
  }

  // 5. Main game image fallback
  return bggMainImage(xml);
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('📚 Fetching game list from Notion…');
  const pages = await queryAll();
  console.log(`   ${pages.length} jeux trouvés\n`);

  const manifestPath = path.join(IMG_DIR, 'manifest.json');
  let manifest = {};
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch(_) {}

  let nNotion = 0, nBgg = 0, nSkipped = 0, nNoImg = 0, nFailed = 0;

  for (const page of pages) {
    const notionId = page.id;
    const name     = getPageName(page);

    // Already on disk and not forcing → skip
    if (!FORCE && manifest[notionId] && fs.existsSync(path.join(IMG_DIR, manifest[notionId]))) {
      nSkipped++;
      process.stdout.write(`  ⏭  ${name}\n`);
      continue;
    }

    process.stdout.write(`  …  ${name}\r`);

    try {
      // Step 1: page cover already in query response — zero extra API call
      let imageUrl = getPageCoverUrl(page);
      let source   = 'notion';

      // Step 2: no cover → search BGG (French edition preferred)
      if (!imageUrl && BGG_TOKEN) {
        await sleep(BGG_DELAY_MS);
        imageUrl = await bggFrenchImage(name).catch(e => {
          process.stdout.write(`  ⚠  BGG error for "${name}": ${e.message}\n`);
          return null;
        });
        source = 'bgg';
      }

      if (!imageUrl) {
        nNoImg++;
        process.stdout.write(`  —  ${name} (aucune image trouvée)\n`);
        continue;
      }

      if (!isValidHttpUrl(imageUrl)) {
        nNoImg++;
        process.stdout.write(`  —  ${name} (URL invalide: ${imageUrl})\n`);
        continue;
      }

      // Step 3: if found on BGG, set it as the Notion page cover
      if (source === 'bgg') {
        await sleep(NOTION_DELAY_MS);
        await setPageCover(notionId, imageUrl).catch(e => {
          process.stdout.write(`  ⚠  "${name}": cover Notion échoué — ${e.message}\n`);
        });
      }

      // Step 4: download locally
      const { buf, contentType } = await downloadImage(imageUrl);
      const ext  = extFromUrlOrType(imageUrl, contentType);
      const file = `${notionId}${ext}`;
      fs.writeFileSync(path.join(IMG_DIR, file), Buffer.from(buf));
      manifest[notionId] = file;

      const tag = source === 'bgg' ? '🎲 BGG' : '🗂 Notion';
      process.stdout.write(`  ✓  ${name}  ${tag}\n`);
      if (source === 'bgg') nBgg++; else nNotion++;

    } catch(e) {
      nFailed++;
      process.stdout.write(`  ✗  ${name}: ${e.message}\n`);
    }
  }

  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  const total = nNotion + nBgg;
  console.log(`\n✅ ${total} téléchargées  (🗂 Notion: ${nNotion}  🎲 BGG: ${nBgg})`);
  console.log(`   ⏭ ${nSkipped} déjà présentes  —  ${nNoImg} sans image  ✗ ${nFailed} en erreur`);
  console.log(`📄 Manifest: images/manifest.json  (${Object.keys(manifest).length} entrées)\n`);
  console.log(`Prochaine étape:`);
  console.log(`  git add images/ && git commit -m "sync: box art" && git push`);
}

main().catch(e => { console.error('\nErreur fatale:', e.message); process.exit(1); });
