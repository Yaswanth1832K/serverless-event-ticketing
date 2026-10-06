// Builds docs/diagrams/architecture-clean.svg (hand-laid-out, 1920 x 1080 design units) and renders
// docs/diagrams/architecture-clean.png at 3840 x 2160 with the Chromium that Playwright already installed.
//
//   node scripts/render-architecture.mjs
//
// Every box is a real resource of template.yaml (the SSM parameter and the delivery strip are the two
// things that live outside the template, and are labelled as such). Text is 28 design units or larger,
// which is 28 px on a 1920 px wide slide.
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'docs/diagrams');
mkdirSync(outDir, { recursive: true });

const C = { bg: '#F6F3EC', ink: '#0F1B2D', orange: '#F5A33B', teal: '#0E7C6E', slate: '#5A6B82', box: '#FFFDF8' };
const FONT = "'Segoe UI', 'Helvetica Neue', Arial, sans-serif";
const FS = 28;
const LH = 36;

const parts = [];
const add = (s) => parts.push(s);
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

// text lines centred in a box; first line bold when bold = true
function lines(cx, cy, arr, { bold = true, color = C.ink, anchor = 'middle' } = {}) {
  arr.forEach((t, i) => {
    const y = cy + (i - (arr.length - 1) / 2) * LH;
    add(`<text x="${cx}" y="${y}" text-anchor="${anchor}" dominant-baseline="central" font-size="${FS}" font-weight="${bold && i === 0 ? 700 : 400}" fill="${color}">${esc(t)}</text>`);
  });
}
function box(x, y, w, h, arr, { stroke = C.ink, fill = C.box, sw = 3, dash = false, color = C.ink } = {}) {
  add(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="14" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"${dash ? ' stroke-dasharray="12 8"' : ''}/>`);
  lines(x + w / 2, y + h / 2, arr, { color });
}
function arrow(points, { color = C.ink, dash = false, marker = 'navy', sw = 4 } = {}) {
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${p[0]} ${p[1]}`).join(' ');
  add(`<path d="${d}" fill="none" stroke="${color}" stroke-width="${sw}" stroke-linejoin="round"${dash ? ' stroke-dasharray="10 8"' : ''} marker-end="url(#m-${marker})"/>`);
}
function label(x, y, text, { color = C.ink, anchor = 'start', bold = false } = {}) {
  add(`<text x="${x}" y="${y}" text-anchor="${anchor}" dominant-baseline="central" font-size="${FS}" font-weight="${bold ? 700 : 400}" fill="${color}" stroke="${C.bg}" stroke-width="9" paint-order="stroke" stroke-linejoin="round">${esc(text)}</text>`);
}

// ---------------------------------------------------------------- canvas
add(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080" width="1920" height="1080" font-family="${FONT}">`);
add(`<title>Event ticketing platform: architecture</title>`);
add(`<defs>`);
for (const [id, col] of [['navy', C.ink], ['teal', C.teal], ['slate', C.slate]]) {
  add(`<marker id="m-${id}" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="${col}"/></marker>`);
}
add(`</defs>`);
add(`<rect width="1920" height="1080" fill="${C.bg}"/>`);

// columns
const X = { c1: 60, c2: 340, c3: 700, c4: 1050, c5: 1430 };
const W = { c1: 220, c2: 300, c3: 290, c4: 320, c5: 400 };

// layer titles with an orange bar
for (const [k, t] of [['c1', 'CLIENT'], ['c2', 'EDGE'], ['c3', 'API'], ['c4', 'COMPUTE'], ['c5', 'DATA']]) {
  add(`<text x="${X[k]}" y="44" font-size="${FS}" font-weight="700" letter-spacing="3" fill="${C.ink}">${t}</text>`);
  add(`<rect x="${X[k]}" y="58" width="${W[k]}" height="6" rx="3" fill="${C.orange}"/>`);
}

// ---------------------------------------------------------------- top band: Cognito + auth triggers + SSM
box(660, 85, 330, 130, ['Cognito user pool', 'groups: Organizer,', 'Attendee, Staff']);
box(X.c4, 85, W.c4, 130, ['auth-triggers', 'PreSignUp +', 'PostConfirmation']);
box(X.c5, 90, W.c5, 120, ['SSM Parameter Store', 'QR signing key', 'created with the CLI'], { stroke: C.ink });
arrow([[990, 150], [1050, 150]]);                                   // Cognito -> auth-triggers lambda

// ---------------------------------------------------------------- client + edge
box(X.c1, 250, W.c1, 500, ['Browser', 'React SPA', 'ID token only', 'no AWS keys'], { sw: 4 });
box(X.c2, 250, W.c2, 80, ['CloudFront', 'website + headers']);
box(X.c2, 370, W.c2, 80, ['S3 bucket', 'website, private']);
box(X.c2, 550, W.c2, 80, ['CloudFront', 'event images']);
box(X.c2, 670, W.c2, 80, ['S3 bucket', 'images, private']);
arrow([[280, 290], [340, 290]]);
arrow([[490, 330], [490, 370]]);
arrow([[280, 590], [340, 590]]);
arrow([[490, 630], [490, 670]]);

// browser -> Cognito (sign in), routed over the empty top of the edge column
arrow([[170, 250], [170, 150], [660, 150]]);
label(310, 124, 'sign in', { color: C.ink });

// ---------------------------------------------------------------- API
box(X.c3, 420, W.c3, 140, ['API Gateway', 'REST, prod stage', 'Cognito authorizer'], { sw: 4 });
arrow([[280, 490], [700, 490]]);                                    // browser -> API Gateway, between the two edge pairs
label(490, 524, 'HTTPS + token', { anchor: 'middle' });
arrow([[845, 215], [845, 420]], { dash: true, marker: 'slate', color: C.slate });   // Cognito authorizer
label(862, 300, 'authorizer', { color: C.slate });

// ---------------------------------------------------------------- compute: one tight group
const gx = X.c4, gy = 330, gw = W.c4, gh = 320;
add(`<rect x="${gx}" y="${gy}" width="${gw}" height="${gh}" rx="16" fill="${C.box}" stroke="${C.orange}" stroke-width="6"/>`);
add(`<text x="${gx + gw / 2}" y="${gy + 38}" text-anchor="middle" dominant-baseline="central" font-size="${FS}" font-weight="700" fill="${C.ink}">API Lambdas</text>`);
const rows = [['tickets', true], ['checkin', true], ['health', false], ['events', false], ['booking', false], ['analytics', false]];
rows.forEach(([name, ssm], i) => {
  const y = gy + 88 + i * 38;
  if (ssm) add(`<circle cx="${gx + 40}" cy="${y}" r="9" fill="${C.orange}" stroke="${C.ink}" stroke-width="2"/>`);
  add(`<text x="${gx + 70}" y="${y}" dominant-baseline="central" font-size="${FS}" fill="${C.ink}">${name}</text>`);
});
arrow([[990, 490], [1050, 490]]);                                   // API Gateway -> group
arrow([[1370, 490], [1430, 490]]);                                  // group -> DynamoDB
// the two readers of the QR secret: one arrow from the group to SSM, routed through the gap between columns
arrow([[1370, 420], [1400, 420], [1400, 150], [1430, 150]]);
add(`<circle cx="1424" cy="300" r="9" fill="${C.orange}" stroke="${C.ink}" stroke-width="2"/>`);
label(1442, 300, 'read QR key', { color: C.ink });

// ---------------------------------------------------------------- data
box(X.c5, 420, W.c5, 140, ['DynamoDB table', 'GSI1 + GSI2', 'Streams, TTL'], { sw: 4 });

// ---------------------------------------------------------------- second path (teal): streams -> processor -> table, failures -> DLQ
box(X.c5, 670, W.c5, 100, ['stream-processor', 'Lambda, idempotent'], { stroke: C.teal, sw: 5 });
box(1110, 680, 260, 80, ['SQS dead-letter', 'queue'], { stroke: C.teal, sw: 5 });
arrow([[1560, 560], [1560, 670]], { color: C.teal, marker: 'teal', sw: 5 });
label(1548, 615, 'Streams', { color: C.teal, anchor: 'end', bold: true });
arrow([[1690, 670], [1690, 560]], { color: C.teal, marker: 'teal', sw: 5 });
label(1704, 615, 'counters', { color: C.teal, bold: true });
arrow([[1430, 720], [1370, 720]], { color: C.teal, marker: 'teal', dash: true, sw: 5 });

// ---------------------------------------------------------------- monitoring strip
add(`<rect x="30" y="812" width="1860" height="150" rx="18" fill="${C.ink}" fill-opacity="0.06"/>`);
add(`<text x="60" y="887" dominant-baseline="central" font-size="${FS}" font-weight="700" letter-spacing="2" fill="${C.slate}">MONITORING</text>`);
box(700, 830, 290, 118, ['CloudWatch', 'logs, metrics', 'dashboard'], { stroke: C.slate });
box(1050, 830, 320, 118, ['4 alarms', 'errors, 5xx', 'DLQ, throttles'], { stroke: C.slate });
box(1430, 830, 400, 118, ['SNS topic', 'e-mail subscription'], { stroke: C.slate });
arrow([[990, 889], [1050, 889]], { color: C.slate, marker: 'slate' });
arrow([[1370, 889], [1430, 889]], { color: C.slate, marker: 'slate' });
// ONE arrow from the Lambda group to CloudWatch
arrow([[1074, 650], [1074, 790], [845, 790], [845, 830]], { color: C.slate, marker: 'slate' });

// ---------------------------------------------------------------- delivery strip (muted, dashed)
add(`<rect x="30" y="976" width="1860" height="100" rx="18" fill="${C.ink}" fill-opacity="0.03"/>`);
add(`<text x="60" y="1026" dominant-baseline="central" font-size="${FS}" font-weight="700" letter-spacing="2" fill="${C.slate}">DELIVERY</text>`);
box(340, 986, 360, 80, ['GitHub Actions', 'OIDC, no stored keys'], { stroke: C.slate, dash: true, color: C.slate });
box(780, 986, 400, 80, ['CloudFormation (SAM)', 'stacks: platform, dev'], { stroke: C.slate, dash: true, color: C.slate });
arrow([[700, 1026], [780, 1026]], { color: C.slate, marker: 'slate', dash: true });
// legend
add(`<line x1="1260" y1="1012" x2="1330" y2="1012" stroke="${C.ink}" stroke-width="4" marker-end="url(#m-navy)"/>`);
add(`<text x="1350" y="1012" dominant-baseline="central" font-size="${FS}" fill="${C.ink}">request path</text>`);
add(`<line x1="1260" y1="1052" x2="1330" y2="1052" stroke="${C.teal}" stroke-width="5" marker-end="url(#m-teal)"/>`);
add(`<text x="1350" y="1052" dominant-baseline="central" font-size="${FS}" fill="${C.teal}" font-weight="700">analytics stream</text>`);

add(`</svg>`);
const svg = parts.join('\n');
const svgPath = join(outDir, 'architecture-clean.svg');
writeFileSync(svgPath, svg);
console.log(`wrote ${svgPath}`);

// ---------------------------------------------------------------- PNG, 3840 x 2160
const require = createRequire(join(root, 'frontend/package.json'));
const { chromium } = require('@playwright/test');
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 2 });
await page.setContent(`<!doctype html><html><body style="margin:0;background:${C.bg}">${svg}</body></html>`);
await page.screenshot({ path: join(outDir, 'architecture-clean.png'), clip: { x: 0, y: 0, width: 1920, height: 1080 } });
// report any text that the browser measured wider than its box area, to catch overflow without eyeballing
const wide = await page.evaluate(() => {
  const out = [];
  for (const t of document.querySelectorAll('text')) {
    const b = t.getBBox();
    out.push({ s: t.textContent, x: Math.round(b.x), w: Math.round(b.width), y: Math.round(b.y), h: Math.round(b.height) });
  }
  return out;
});
await browser.close();
console.log('wrote architecture-clean.png (3840 x 2160)');

// Automatic layout checks on the measured text boxes. getBBox() includes line spacing, so the glyph area is
// approximated by shrinking each box by 7 units top and bottom before testing for overlap.
let issues = 0;
const ink = (t) => ({ ...t, y: t.y + 7, h: t.h - 14 });
for (const t of wide) {
  if (t.x < 0 || t.x + t.w > 1920 || t.y < 0 || t.y + t.h > 1080) { console.log(`OUT OF CANVAS: ${t.s}`); issues++; }
}
for (let i = 0; i < wide.length; i++) {
  for (let j = i + 1; j < wide.length; j++) {
    const a = ink(wide[i]); const b = ink(wide[j]);
    if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) { console.log(`TEXT OVERLAP: "${a.s}" / "${b.s}"`); issues++; }
  }
}
console.log(`layout check: ${wide.length} texts, ${issues} issue(s)`);
process.exit(issues ? 1 : 0);
