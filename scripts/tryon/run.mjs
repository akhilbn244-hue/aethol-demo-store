/* =====================================================================
   AETHOL TRY-ON ROBOT
   ---------------------------------------------------------------------
   What it does, in plain words:
   1. Makes sure we have two studio models (tryon/models/woman.* and
      man.*). If a photo is missing, it asks Gemini to create one.
   2. Reads the product list in index.html and the garment photos in img/.
   3. For every garment that doesn't have try-on photos yet (or whose
      photos changed), it asks Gemini for:
        - the model wearing it, seen from the FRONT
        - the same model wearing it, seen from the BACK
          (from the real back photo if there is one, otherwise imagined)
   4. Saves the pictures in tryon/ and writes tryon/tryon.json, the list
      the website reads to show the "On model" button.
   5. If Google's free limit is reached, it stops politely and carries on
      next time it runs.

   Runs on GitHub (see .github/workflows/tryon.yml). Needs the secret
   GEMINI_API_KEY. Optional: GEMINI_IMAGE_MODEL to use a different model.
   TRYON_MOCK=1 makes fake pictures without calling Gemini (for testing).
   ===================================================================== */

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const OUT = path.join(ROOT, 'tryon');
const MODELS_DIR = path.join(OUT, 'models');
const MANIFEST = path.join(OUT, 'tryon.json');

const KEY = process.env.GEMINI_API_KEY || '';
const MODEL = process.env.GEMINI_IMAGE_MODEL || 'gemini-2.5-flash-image';
const MOCK = process.env.TRYON_MOCK === '1';
const MAX_PER_RUN = +(process.env.TRYON_MAX_PER_RUN || 40);   // safety cap on images per run
const PAUSE_MS = MOCK ? 0 : 6500;                            // gap between requests (free tier is slow)
const PROMPT_VERSION = 1;                                    // bump to remake every photo with new prompts

const IVORY = '#FCF6F0';

/* ---------- the two studio models ---------- */
const MODEL_PROMPTS = {
  women: `A photorealistic full-body studio photo of a fictional Indian woman in her mid-20s, standing straight and facing the camera, arms relaxed slightly away from her body, neutral friendly expression. She wears a plain fitted beige sleeveless top and fitted beige leggings, barefoot, hair tied back neatly. Plain warm ivory background (${IVORY}), soft even studio lighting, no shadows on the background. Entire body visible from head to feet with space above and below. Vertical portrait, 3:4. No text, no logo, no jewellery.`,
  men: `A photorealistic full-body studio photo of a fictional Indian man in his late 20s, standing straight and facing the camera, arms relaxed slightly away from his body, neutral friendly expression. He wears a plain fitted white crew-neck t-shirt and fitted beige trousers, barefoot, short neat hair, light trimmed beard. Plain warm ivory background (${IVORY}), soft even studio lighting, no shadows on the background. Entire body visible from head to feet with space above and below. Vertical portrait, 3:4. No text, no logo, no jewellery.`,
};
const MODEL_FILE = {women: 'woman', men: 'man'};

/* ---------- prompts for dressing ---------- */
const wearHint = it => ({
  saree: 'Drape the saree the traditional Nivi way: pleats at the front, the pallu over the left shoulder, with its matching blouse.',
  lehenga: 'Wear it as a full lehenga set: the blouse, the flared skirt at the waist, and the dupatta draped as shown in the product photo.',
  anarkali: 'Wear it as a floor-length anarkali with matching churidar.',
  kurti: 'Pair it with simple plain matching trousers.',
  kurta: 'Pair it with simple plain churidar or trousers in a matching neutral tone, and plain mojari footwear.',
  sherwani: 'Pair it with matching churidar and plain mojari footwear.',
  nehru: 'Wear the jacket over a plain ivory kurta with matching churidar.',
  shirt: 'Pair it with simple plain beige trousers.',
  gown: 'Wear it as a full-length gown.',
}[it.type] || 'If the garment is only a top, pair it with simple plain bottoms that suit it.');

const frontPrompt = (it, hasBack) => `
Image 1 is our studio model. Image 2 is a product photo of a garment (front view, on a hanger)${hasBack ? '. Image 3 shows the back of the same garment, for reference only' : ''}.
Create a new photorealistic full-body photo of the exact same person from image 1 — same face, skin tone, hair, body shape and standing pose, same plain warm ivory studio background and soft lighting — now wearing the garment from image 2 instead of their current clothes.
Reproduce the garment faithfully: the same colours, fabric sheen, embroidery, prints, borders, motifs and silhouette. Do not invent new decoration.
${wearHint(it)}
Garment: ${it.name} (${it.kind}). ${it.desc}
Facing the camera, the whole body visible from head to feet, vertical 3:4 framing. No hanger, no text, no logo, no watermark, no extra people.`.trim();

const backPrompt = (it, fromPhoto) => `
Image 1 is a photo of our model wearing a garment, seen from the front. ${fromPhoto
  ? 'Image 2 is a product photo of the BACK of that same garment.'
  : 'Image 2 is the front product photo of that garment — the back was not photographed, so imagine a simple, plausible back that matches the front exactly in colour, fabric and style, without adding new decoration.'}
Create a new photorealistic full-body photo of the exact same person, in the exact same outfit, same plain warm ivory studio background and lighting, but seen from directly behind: we see the back of their head and hair, their back, and the back of the garment${fromPhoto ? ' exactly as in image 2' : ''}.
${wearHint(it)}
The whole body visible from head to feet, vertical 3:4 framing. No hanger, no text, no logo, no watermark, no extra people.`.trim();

/* ---------- helpers ---------- */
const sleep = ms => new Promise(r => setTimeout(r, ms));
const exists = p => fs.access(p).then(() => true, () => false);
const rel = p => path.relative(ROOT, p).split(path.sep).join('/');
const hash = (...bufs) => { const h = crypto.createHash('sha1'); bufs.forEach(b => h.update(b)); h.update(String(PROMPT_VERSION)); return h.digest('hex').slice(0, 12); };

class QuotaStop extends Error {}

// garment photos have transparent backgrounds: flatten onto white and shrink before sending
async function toPart(file) {
  const png = await sharp(file).flatten({background: '#ffffff'}).resize({width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true}).png().toBuffer();
  return {inline_data: {mime_type: 'image/png', data: png.toString('base64')}};
}
async function bufToPart(buf) {
  const png = await sharp(buf).resize({width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true}).png().toBuffer();
  return {inline_data: {mime_type: 'image/png', data: png.toString('base64')}};
}
async function saveWebp(buf, file) {
  await sharp(buf).resize({height: 1400, withoutEnlargement: true}).webp({quality: 84}).toFile(file);
}

/* ---------- read products from index.html ---------- */
async function readProducts() {
  const html = await fs.readFile(path.join(ROOT, 'index.html'), 'utf8');
  const block = html.match(/const ITEMS = \[([\s\S]*?)\n\];/);
  if (!block) throw new Error('Could not find the ITEMS list in index.html');
  const items = [];
  for (const m of block[1].matchAll(/\{id:'([^']+)'([\s\S]*?)\}(?=,\s*(?:\{|$))/g)) {
    const body = m[2];
    const f = k => (body.match(new RegExp(`${k}:'((?:[^'\\\\]|\\\\.)*)'`)) || [])[1]?.replace(/\\'/g, "'") || '';
    items.push({id: m[1], cat: f('cat'), type: f('type'), kind: f('kind'), name: f('name'), desc: f('desc')});
  }
  return items.filter(i => i.cat === 'women' || i.cat === 'men');
}

/* ---------- Gemini call ---------- */
let calls = 0;
async function gemini(parts, label) {
  if (calls >= MAX_PER_RUN) throw new QuotaStop(`Reached the cap of ${MAX_PER_RUN} pictures for this run.`);
  calls++;
  if (MOCK) return mockImage(parts, label);
  if (!KEY) throw new QuotaStop('No GEMINI_API_KEY secret is set on GitHub, so the robot cannot make pictures yet.');

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
  let withRatio = true;
  for (let attempt = 1; attempt <= 4; attempt++) {
    const body = {
      contents: [{role: 'user', parts}],
      generationConfig: {responseModalities: ['TEXT', 'IMAGE'], ...(withRatio ? {imageConfig: {aspectRatio: '3:4'}} : {})},
    };
    const res = await fetch(url, {method: 'POST', headers: {'content-type': 'application/json', 'x-goog-api-key': KEY}, body: JSON.stringify(body)});
    const text = await res.text();
    let json = {}; try { json = JSON.parse(text); } catch {}

    if (res.ok) {
      const cand = json.candidates?.[0];
      const img = cand?.content?.parts?.find(p => p.inlineData || p.inline_data);
      if (img) return Buffer.from((img.inlineData || img.inline_data).data, 'base64');
      const why = json.promptFeedback?.blockReason || cand?.finishReason || 'no image returned';
      const said = cand?.content?.parts?.map(p => p.text).filter(Boolean).join(' ').slice(0, 200);
      throw new Error(`Gemini returned no picture (${why})${said ? ': ' + said : ''}`);
    }

    const msg = json.error?.message || text.slice(0, 300);
    if (res.status === 400 && withRatio && /aspect|imageConfig|image_config/i.test(msg)) { withRatio = false; continue; }
    if (res.status === 429) {
      if (/limit:\s*0\b/.test(msg)) throw new QuotaStop('This Gemini key has no free image allowance (Google says the limit is 0). Turn on billing for the key, then run the robot again.');
      const retry = json.error?.details?.find(d => d.retryDelay)?.retryDelay;
      const secs = retry ? parseFloat(retry) : NaN;
      if (/per.?day|daily|PerDay/i.test(msg) || !(secs <= 90) || attempt === 4) throw new QuotaStop('Google\'s free limit is used up for now. The robot will carry on at its next run.');
      console.log(`   …busy, waiting ${Math.ceil(secs)}s`);
      await sleep((secs + 2) * 1000); continue;
    }
    if (res.status >= 500 && attempt < 4) { console.log('   …Google had a hiccup, retrying'); await sleep(15000); continue; }
    if (res.status === 403 || res.status === 401) throw new QuotaStop(`Gemini refused the key (${res.status}): ${msg}`);
    if (res.status === 404) throw new QuotaStop(`The image model "${MODEL}" was not found. Set GEMINI_IMAGE_MODEL to a current one.`);
    throw new Error(`Gemini error ${res.status}: ${msg}`);
  }
}

// test mode: a placeholder "photo" — the garment on an ivory card with a label
async function mockImage(parts, label) {
  const imgs = parts.filter(p => p.inline_data);
  const W = 900, H = 1200;
  const layers = [];
  const g = imgs.length > 1 ? imgs[1] : imgs[0];
  if (g) {
    const garment = await sharp(Buffer.from(g.inline_data.data, 'base64')).resize({width: 640, height: 900, fit: 'inside'}).png().toBuffer();
    layers.push({input: garment, top: 150, left: 130});
  }
  const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg"><text x="${W / 2}" y="90" font-size="38" font-family="sans-serif" text-anchor="middle" fill="#0D1A11">TEST · ${label}</text></svg>`;
  layers.push({input: Buffer.from(svg), top: 0, left: 0});
  return sharp({create: {width: W, height: H, channels: 3, background: IVORY}}).composite(layers).png().toBuffer();
}

/* ---------- main ---------- */
async function findModelPhoto(cat) {
  for (const ext of ['webp', 'png', 'jpg', 'jpeg']) {
    const p = path.join(MODELS_DIR, `${MODEL_FILE[cat]}.${ext}`);
    if (await exists(p)) return p;
  }
  return null;
}

async function main() {
  await fs.mkdir(MODELS_DIR, {recursive: true});
  let manifest = {models: {}, items: {}};
  try { manifest = {...manifest, ...JSON.parse(await fs.readFile(MANIFEST, 'utf8'))}; } catch {}
  const save = async () => { manifest.updated = new Date().toISOString(); await fs.writeFile(MANIFEST, JSON.stringify(manifest, null, 2) + '\n'); };

  console.log(`AETHOL try-on robot · model: ${MOCK ? 'TEST MODE' : MODEL}`);
  const products = await readProducts();
  let made = 0, failed = 0, stopped = '';

  try {
    // 1. studio models
    for (const cat of ['women', 'men']) {
      let p = await findModelPhoto(cat);
      if (!p) {
        console.log(`• Creating the ${MODEL_FILE[cat]} model…`);
        const buf = await gemini([{text: MODEL_PROMPTS[cat]}], `${MODEL_FILE[cat]} model`);
        p = path.join(MODELS_DIR, `${MODEL_FILE[cat]}.webp`);
        await saveWebp(buf, p); made++;
        await sleep(PAUSE_MS);
      }
      manifest.models[cat] = rel(p);
    }
    await save();

    // 2. dress every garment
    for (const it of products) {
      const frontImg = path.join(ROOT, 'img', `${it.id}-front.webp`);
      const backImg = path.join(ROOT, 'img', `${it.id}-back.webp`);
      if (!(await exists(frontImg))) { console.log(`• ${it.id}: no front photo in img/, skipped`); continue; }
      const hasBack = await exists(backImg);
      const modelPhoto = await findModelPhoto(it.cat);
      const [mBuf, fBuf, bBuf] = await Promise.all([fs.readFile(modelPhoto), fs.readFile(frontImg), hasBack ? fs.readFile(backImg) : Buffer.alloc(0)]);

      const entry = manifest.items[it.id] || {};
      const frontOut = path.join(OUT, `${it.id}-front.webp`);
      const backOut = path.join(OUT, `${it.id}-back.webp`);
      const frontKey = hash(mBuf, fBuf, bBuf);

      // front view
      if (entry.frontKey !== frontKey || !(await exists(frontOut))) {
        console.log(`• ${it.name}: dressing the model (front)…`);
        try {
          const parts = [{text: frontPrompt(it, hasBack)}, await bufToPart(mBuf), await toPart(frontImg)];
          if (hasBack) parts.push(await toPart(backImg));
          await saveWebp(await gemini(parts, `${it.id} front`), frontOut);
          Object.assign(entry, {model: it.cat, front: rel(frontOut), frontKey});
          delete entry.backKey;                       // new front → remake the back so they match
          manifest.items[it.id] = entry; await save(); made++;
        } catch (e) { if (e instanceof QuotaStop) throw e; console.log(`   ✗ ${e.message}`); failed++; await sleep(PAUSE_MS); continue; }
        await sleep(PAUSE_MS);
      }

      // back view
      const backKey = hash(Buffer.from(frontKey), bBuf);
      if (entry.backKey !== backKey || !(await exists(backOut))) {
        console.log(`• ${it.name}: turning the model around (back, ${hasBack ? 'from photo' : 'AI-imagined'})…`);
        try {
          const frontTry = await fs.readFile(frontOut);
          const parts = [{text: backPrompt(it, hasBack)}, await bufToPart(frontTry), await toPart(hasBack ? backImg : frontImg)];
          await saveWebp(await gemini(parts, `${it.id} back`), backOut);
          Object.assign(entry, {back: rel(backOut), backFrom: hasBack ? 'photo' : 'ai', backKey});
          manifest.items[it.id] = entry; await save(); made++;
        } catch (e) { if (e instanceof QuotaStop) throw e; console.log(`   ✗ ${e.message}`); failed++; }
        await sleep(PAUSE_MS);
      }
    }
  } catch (e) {
    if (!(e instanceof QuotaStop)) throw e;
    stopped = e.message;
  }

  // forget garments that were removed from the store
  const ids = new Set(products.map(p => p.id));
  for (const id of Object.keys(manifest.items)) if (!ids.has(id)) delete manifest.items[id];
  await save();

  const ready = Object.values(manifest.items).filter(x => x.front).length;
  console.log(`\nDone: ${made} new picture(s), ${failed} failed. ${ready} of ${products.length} garments are ready on a model.`);
  if (stopped) console.log(`Stopped early: ${stopped}`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    await fs.appendFile(process.env.GITHUB_STEP_SUMMARY,
      `### AETHOL try-on robot\n- New pictures: **${made}**\n- Failed: **${failed}**\n- Garments ready on a model: **${ready} / ${products.length}**\n${stopped ? `- ⚠️ Stopped early: ${stopped}\n` : ''}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
