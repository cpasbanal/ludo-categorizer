#!/usr/bin/env node
/**
 * sync-images.js — Sync board game box art to Notion pages and local images/
 *
 * For each game in your Notion DB:
 *   1. If the Notion page already has an image block → download it locally
 *   2. Otherwise → search BoardGameGeek (French edition first, then main)
 *   3. BGG fallback → search Philibert (French retailer)
 *   4. Found externally → add image block to the Notion page, download locally
 *
 * Usage:
 *   node sync-images.js --token=secret_xxx --db=xxxxxxxx
 *   node sync-images.js --token=secret_xxx --db=xxxxxxxx --force  # re-download all
 *
 * Or via env vars: NOTION_TOKEN=... NOTION_DB_ID=... node sync-images.js
 *
 * Requires Node.js 18+ (built-in fetch).
 * First run on 200 games takes ~15 min (BGG rate limit). Subsequent runs are instant.
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
const TOKEN = ARGS.token || process.env.NOTION_TOKEN;
const DB_ID = (ARGS.db   || process.env.NOTION_DB_ID || '').replace(/-/g, '');
const FORCE = 'force' in ARGS;

if (!TOKEN || !DB_ID) {
  console.error('Usage: node sync-images.js --token=<notion_token> --db=<database_id> [--force]');
  process.exit(1);
}

const IMG_DIR       = path.join(__dirname, 'images');
const NOTION_DELAY  = 400;   // ms between Notion API calls
const BGG_DELAY     = 2200;  // ms between BGG calls — BGG asks to be polite
const UA            = 'Mozilla/5.0 (compatible; ludo-sync/2.0; +https://github.com/cpasbanal/ludo-categorizer)';

if (!fs.existsSync(IMG_DIR)) fs.mkdirSync(IMG_DIR, { recursive: true });

const formattedDbId = DB_ID.replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5');
const NOTION_HEADERS = {
  'Authorization': `Bearer ${TOKEN}`,
  'Content-Type':  'application/json',
  'Notion-Version': '2022-06-28',
};

// ── Utilities ────────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

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

async function download(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status} — ${url}`);
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
    if (cursor) await sleep(NOTION_DELAY);
  } while (cursor);
  return pages;
}

async function getPageImageUrl(pageId) {
  const data  = await notionFetch(`/blocks/${pageId}/children?page_size=20`);
  const block = (data.results || []).find(b => b.type === 'image');
  if (!block) return null;
  return block.image?.file?.url || block.image?.external?.url || null;
}

async function addExternalImageBlock(pageId, imageUrl) {
  await notionFetch(`/blocks/${pageId}/children`, {
    method: 'POST',
    body: JSON.stringify({ children: [{ type: 'image', image: { type: 'external', external: { url: imageUrl } } }] }),
  });
}

// ── BGG XML parser (no dependency, hand-rolled) ──────────────────────────────

// Fetch BGG XML, handling 202 "still processing" with retries
async function bggFetch(url) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url, { headers: { 'User-Agent': UA } });
    if (res.status === 202) { await sleep(3500); continue; }
    if (!res.ok) throw new Error(`BGG HTTP ${res.status}`);
    return res.text();
  }
  throw new Error('BGG: no response after retries');
}

// Get first attribute value: <tag ... attr="VALUE"
function xmlAttr(xml, tag, attr) {
  return xml.match(new RegExp(`<${tag}\\b[^>]*\\s${attr}="([^"]*)"`, 'i'))?.[1] ?? null;
}

// Get text content of a tag, normalising protocol-relative URLs
function xmlText(xml, tag) {
  const v = xml.match(new RegExp(`<${tag}[^>]*>([^<]*)`, 'i'))?.[1]?.trim() ?? '';
  return v.startsWith('//') ? `https:${v}` : v;
}

// Extract all <item type="boardgameversion"> blocks from the <versions> section
function bggVersions(xml) {
  const section = xml.match(/<versions>([\s\S]*?)<\/versions>/i)?.[1] ?? '';
  return [...section.matchAll(/<item\b[^>]*type="boardgameversion"[\s\S]*?<\/item>/gi)].map(m => m[0]);
}

// Extract the main game image (before any <versions> block, to avoid version bleed)
function bggMainImage(xml) {
  const beforeVersions = xml.match(/([\s\S]*?)(?:<versions>|$)/i)?.[1] ?? xml;
  return xmlText(beforeVersions, 'image') || xmlText(beforeVersions, 'thumbnail') || null;
}

async function bggFrenchImage(name) {
  // 1. Exact name search
  let xml = await bggFetch(
    `https://boardgamegeek.com/xmlapi2/search?query=${encodeURIComponent(name)}&type=boardgame&exact=1`
  );
  let gameId = xmlAttr(xml, 'item', 'id');

  // 2. Fuzzy search fallback (first result)
  if (!gameId) {
    await sleep(BGG_DELAY);
    xml    = await bggFetch(`https://boardgamegeek.com/xmlapi2/search?query=${encodeURIComponent(name)}&type=boardgame`);
    gameId = xmlAttr(xml, 'item', 'id');
  }
  if (!gameId) return null;

  // 3. Fetch game details + all versions
  await sleep(BGG_DELAY);
  xml = await bggFetch(`https://boardgamegeek.com/xmlapi2/thing?id=${gameId}&versions=1`);

  // 4. Find a French-language version
  //    BGG language link: <link type="language" id="2193" value="Français"/>
  //    id 2193 = French in BGG's taxonomy
  const frenchVersion = bggVersions(xml).find(v =>
    v.includes('"2193"') ||               // reliable: BGG language ID for French
    /value="[Ff]ran[çc]ais"/.test(v) ||   // French name variant
    /value="[Ff]rench"/.test(v)            // English name variant
  );

  if (frenchVersion) {
    const img = xmlText(frenchVersion, 'image') || xmlText(frenchVersion, 'thumbnail');
    if (img) return img;
  }

  // 5. Fall back to the main game image
  return bggMainImage(xml);
}

// ── Philibert scraper ────────────────────────────────────────────────────────
async function philibertImage(name) {
  try {
    const res = await fetch(
      `https://www.philibert.fr/index.php?controller=search&s=${encodeURIComponent(name)}`,
      { headers: { 'User-Agent': UA, 'Accept': 'text/html', 'Accept-Language': 'fr-FR,fr;q=0.9' } }
    );
    if (!res.ok) return null;
    const html = await res.text();

    // Try multiple CSS patterns — Philibert's PrestaShop theme evolves
    const patterns = [
      /data-full-size-image-url="(https?:\/\/[^"]+philibert[^"]+)"/i,
      /<img\b[^>]+class="[^"]*product[^"]*"[^>]+src="(https?:\/\/[^"]+)"/i,
      /<article\b[^>]*class="[^"]*product[^>]*>[\s\S]{0,600}?<img\b[^>]+src="(https?:\/\/[^"]+\.(?:jpg|jpeg|png|webp))(?:[^"]*)?"/i,
      /<img\b[^>]+src="(https?:\/\/(?:www\.)?philibert\.fr\/img\/[^"]+)"/i,
    ];
    for (const re of patterns) {
      const m = html.match(re);
      if (m?.[1]) return m[1];
    }
    return null;
  } catch(_) { return null; }
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('📚 Fetching game list from Notion…');
  const pages = await queryAll();
  console.log(`   ${pages.length} jeux trouvés\n`);

  const manifestPath = path.join(IMG_DIR, 'manifest.json');
  let manifest = {};
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch(_) {}

  let nNotion = 0, nBgg = 0, nPhilibert = 0, nSkipped = 0, nNoImg = 0, nFailed = 0;

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
      await sleep(NOTION_DELAY);

      // ── Step 1: existing Notion image block?
      let imageUrl = await getPageImageUrl(notionId);
      let source   = 'notion';

      // ── Step 2: no Notion image → BGG (French edition preferred)
      if (!imageUrl) {
        await sleep(BGG_DELAY);
        imageUrl = await bggFrenchImage(name).catch(() => null);
        source   = 'bgg';
      }

      // ── Step 3: BGG failed → Philibert
      if (!imageUrl) {
        imageUrl = await philibertImage(name).catch(() => null);
        source   = 'philibert';
      }

      if (!imageUrl) {
        nNoImg++;
        process.stdout.write(`  —  ${name} (aucune image trouvée)\n`);
        continue;
      }

      // ── Step 4: if found externally, add block to Notion page
      if (source !== 'notion') {
        await sleep(NOTION_DELAY);
        await addExternalImageBlock(notionId, imageUrl).catch(e => {
          process.stdout.write(`  ⚠  ${name}: ajout Notion échoué (${e.message})\n`);
        });
      }

      // ── Step 5: download image locally
      const { buf, contentType } = await download(imageUrl);
      const ext  = extFromUrlOrType(imageUrl, contentType);
      const file = `${notionId}${ext}`;
      fs.writeFileSync(path.join(IMG_DIR, file), Buffer.from(buf));
      manifest[notionId] = file;

      const tag = { notion: '🗂 Notion', bgg: '🎲 BGG', philibert: '🏪 Philibert' }[source];
      process.stdout.write(`  ✓  ${name}  ${tag}\n`);
      if (source === 'notion')    nNotion++;
      if (source === 'bgg')       nBgg++;
      if (source === 'philibert') nPhilibert++;

    } catch(e) {
      nFailed++;
      process.stdout.write(`  ✗  ${name}: ${e.message}\n`);
    }
  }

  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  const total = nNotion + nBgg + nPhilibert;
  console.log(`\n✅ ${total} téléchargées  (🗂 Notion: ${nNotion}  🎲 BGG: ${nBgg}  🏪 Philibert: ${nPhilibert})`);
  console.log(`   ⏭ ${nSkipped} déjà présentes  —  ${nNoImg} sans image  ✗ ${nFailed} en erreur`);
  console.log(`📄 Manifest: images/manifest.json  (${Object.keys(manifest).length} entrées)\n`);
  console.log(`Prochaine étape:`);
  console.log(`  git add images/ && git commit -m "sync: box art" && git push`);
}

main().catch(e => { console.error('\nErreur fatale:', e.message); process.exit(1); });
