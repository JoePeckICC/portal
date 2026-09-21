'use strict';
// HTML -> PDF with headless Chromium (playwright-core against the image's chromium). One browser per process, reused.
let browserP = null;
async function browser() {
  if (!browserP) {
    browserP = (async () => {
      const { chromium } = require('playwright-core');
      return chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    })().catch(e => { browserP = null; throw e; });
  }
  return browserP;
}
async function render(html) {
  const b = await browser();
  const page = await b.newPage();
  try { await page.setContent(html, { waitUntil: 'load' }); return await page.pdf({ format: 'Letter', printBackground: true }); }
  finally { await page.close(); }
}
async function close() { if (browserP) { try { (await browserP).close(); } catch {} browserP = null; } }
module.exports = { render, close };
