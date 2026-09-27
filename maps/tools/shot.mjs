// Renders the map headless and saves a screenshot (for checking a new hospital without a browser):
// node tools/shot.mjs <id> [pin] [out.png] [w] [h]   — needs `npx http-server -p 8080` running in this folder
import { chromium } from 'playwright';
const [id='vumc', pin='', out='tiles/shot.png', w='1400', h='900'] = process.argv.slice(2);
const b = await chromium.launch({ args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'] });
const p = await b.newPage({ viewport: { width: +w, height: +h } }); const logs = []; p.on('console', m => logs.push(m.type() + ' ' + m.text())); p.on('pageerror', e => logs.push('pageerror ' + e.message));
await p.goto('http://localhost:8080/?h=' + id + (pin ? '&pin=' + pin : ''));
await p.waitForFunction(() => document.querySelectorAll('.pin').length > 0, null, { timeout: 30000 }).catch(e => logs.push('no pins ' + e.message));
await p.waitForTimeout(4000); await p.screenshot({ path: out }); console.log(logs.slice(0, 10).join('\n')); await b.close();
