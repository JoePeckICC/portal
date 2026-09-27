// Manrope → MapLibre glyph PBFs, rendered with tiny-sdf in Chromium (same algorithm MapLibre uses for local glyphs).
import fs from 'node:fs'; import { createRequire } from 'node:module'; import Pbf from 'pbf';
const require = createRequire(import.meta.url); const { chromium } = require('playwright');
const STACKS = { 'Manrope Regular': 500, 'Manrope SemiBold': 600, 'Manrope Bold': 700 };   // label "regular" is Manrope 500: thin text on a map reads weak
const RANGES = [0, 256, 8192];   // Latin, Latin-1 + accents (Spanish), punctuation (’ – — …)
const sdfSrc = fs.readFileSync('node_modules/@mapbox/tiny-sdf/index.js', 'utf8').replace(/export default class/, 'window.TinySDF = class');
const b = await chromium.launch();
const p = await b.newPage(); await p.setContent('<html><body></body></html>');
await p.addScriptTag({ content: sdfSrc });
for (const w of [500, 600, 700]) { const f = fs.readFileSync(`node_modules/@fontsource/manrope/files/manrope-latin-${w}-normal.woff2`).toString('base64');
  const ext = fs.existsSync(`node_modules/@fontsource/manrope/files/manrope-latin-ext-${w}-normal.woff2`) ? fs.readFileSync(`node_modules/@fontsource/manrope/files/manrope-latin-ext-${w}-normal.woff2`).toString('base64') : null;
  await p.evaluate(async ([w, f, ext]) => { const ff = new FontFace('Manrope', `url(data:font/woff2;base64,${f})`, { weight: String(w) }); await ff.load(); document.fonts.add(ff); if (ext) { const fe = new FontFace('Manrope', `url(data:font/woff2;base64,${ext})`, { weight: String(w), unicodeRange: 'U+0100-024F' }); await fe.load(); document.fonts.add(fe); } }, [w, f, ext]); }
for (const [stack, weight] of Object.entries(STACKS)) {
  fs.mkdirSync(`fonts/${stack}`, { recursive: true });
  for (const start of RANGES) {
    const glyphs = await p.evaluate(([weight, start]) => { const s = new TinySDF({ fontSize: 24, buffer: 3, radius: 8, cutoff: 0.25, fontFamily: 'Manrope', fontWeight: String(weight) }); const out = [];
      for (let id = start; id < start + 256; id++) { if (id < 32) continue; const g = s.draw(String.fromCharCode(id)); out.push({ id, w: g.glyphWidth, h: g.glyphHeight, left: Math.round(g.glyphLeft), top: Math.round(g.glyphTop - 27), adv: Math.round(g.glyphAdvance), data: Array.from(g.data) }); } return out; }, [weight, start]);
    const pbf = new Pbf();
    pbf.writeMessage(1, (_, pb) => { pb.writeStringField(1, stack); pb.writeStringField(2, `${start}-${start + 255}`);
      for (const g of glyphs) pb.writeMessage(3, (_, q) => { q.writeVarintField(1, g.id); if (g.w && g.h) q.writeBytesField(2, Buffer.from(g.data)); q.writeVarintField(3, g.w); q.writeVarintField(4, g.h); q.writeSVarintField(5, g.left); q.writeSVarintField(6, g.top); q.writeVarintField(7, g.adv); }, null); }, null);
    fs.writeFileSync(`fonts/${stack}/${start}-${start + 255}.pbf`, pbf.finish());
  }
}
await b.close(); console.log('glyphs ok');
