#!/usr/bin/env node
/**
 * Pre-load checks. Catches the failures Chrome reports as a blank panel or a
 * silently dead service worker rather than as an error: a manifest pointing at
 * a file that was never written, an icon whose pixels are not the size it
 * claims, an inline script the extension CSP will refuse to run.
 *
 *     node tools/validate.mjs
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const problems = [];
const notes = [];

const fail = (m) => problems.push(m);
const note = (m) => notes.push(m);

// ------------------------------------------------------------------- manifest

const manifestPath = join(ROOT, 'manifest.json');
if (!existsSync(manifestPath)) {
  console.error('no manifest.json');
  process.exit(1);
}
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

if (manifest.manifest_version !== 3) fail('manifest_version must be 3');

const referenced = new Set();
const ref = (p) => p && referenced.add(p.replace(/^\.?\//, ''));

ref(manifest.background?.service_worker);
ref(manifest.side_panel?.default_path);
ref(manifest.options_ui?.page);
Object.values(manifest.icons ?? {}).forEach(ref);
Object.values(manifest.action?.default_icon ?? {}).forEach(ref);
(manifest.content_scripts ?? []).forEach((cs) => {
  (cs.js ?? []).forEach(ref);
  (cs.css ?? []).forEach(ref);
});

for (const rel of referenced) {
  if (!existsSync(join(ROOT, rel))) fail(`manifest references a missing file: ${rel}`);
}

// ---------------------------------------------------------------------- icons

/** Reads width/height straight out of the PNG IHDR chunk. */
function pngSize(path) {
  const buf = readFileSync(path);
  if (buf.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

for (const [declared, rel] of Object.entries(manifest.icons ?? {})) {
  const path = join(ROOT, rel);
  if (!existsSync(path)) continue;
  const size = pngSize(path);
  if (!size) fail(`${rel} is not a valid PNG`);
  else if (String(size.width) !== declared || size.width !== size.height) {
    fail(`${rel} is ${size.width}x${size.height} but declared as ${declared}`);
  }
}

// ----------------------------------------------------------------- html / csp

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.git' || entry === 'dist') continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...walk(path));
    else out.push(path);
  }
  return out;
}

const files = walk(ROOT);

for (const path of files.filter((f) => extname(f) === '.html')) {
  const html = readFileSync(path, 'utf8');
  const rel = path.slice(ROOT.length + 1);

  if (/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?\S[\s\S]*?<\/script>/i.test(html)) {
    fail(`${rel}: inline <script> — blocked by the extension CSP`);
  }
  if (/\son[a-z]+\s*=\s*["']/i.test(html)) {
    fail(`${rel}: inline event handler attribute — blocked by the extension CSP`);
  }
  for (const [, src] of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
    // Any scheme (https:, data:, terriergpt:) is a link, not a file in the package.
    if (/^([a-z][a-z0-9+.-]*:|#)/i.test(src)) continue;
    const resolved = join(dirname(path), src);
    if (!existsSync(resolved)) fail(`${rel}: references a missing file: ${src}`);
  }
}

// An element toggled with the `hidden` attribute stays on screen if any rule
// gives it a `display`, because `[hidden] { display: none }` is only a UA rule
// and loses to any class selector. Checked per page, since a page may pick the
// override up from a stylesheet it shares with another.
for (const path of files.filter((f) => extname(f) === '.html')) {
  const html = readFileSync(path, 'utf8');
  const rel = path.slice(ROOT.length + 1);

  const sheets = [...html.matchAll(/<link[^>]+href="([^"]+\.css)"/g)]
    .map(([, href]) => join(dirname(path), href))
    .filter((f) => existsSync(f));

  // Comments are stripped first: a comment explaining the override is not the
  // override, and reading one as such is how this check first missed the bug.
  const css = sheets
    .map((f) => readFileSync(f, 'utf8'))
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  if (!/\bdisplay\s*:/.test(css) || /\[hidden\]/.test(css)) continue;

  const scripts = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)]
    .map(([, src]) => join(dirname(path), src))
    .filter((f) => existsSync(f));

  if (scripts.some((f) => /\.hidden\s*=/.test(readFileSync(f, 'utf8')))) {
    fail(`${rel}: toggles .hidden, but its CSS sets display and never overrides [hidden]`);
  }
}

// ------------------------------------------------------- javascript sanity

const js = files.filter((f) => extname(f) === '.js' && !f.includes('/tools/'));

for (const path of js) {
  const source = readFileSync(path, 'utf8');
  const rel = path.slice(ROOT.length + 1);

  if (/\bchrome\.(browserAction|pageAction|tabs\.executeScript)\b/.test(source)) {
    fail(`${rel}: Manifest V2 API`);
  }
  if (/\bchrome\.windows\.query\b/.test(source)) {
    fail(`${rel}: chrome.windows.query does not exist`);
  }
  if (/openPanelOnActionIconClick/.test(source)) {
    fail(`${rel}: setPanelBehavior property is openPanelOnActionClick`);
  }
  if (/\bchrome\.[a-zA-Z.]+\([^)]*\)\s*\.then\(/.test(source)) {
    note(`${rel}: a .then() chain on a chrome API — prefer await`);
  }
}

// A side panel needs an explicit way to open.
if (manifest.side_panel) {
  const sw = readFileSync(join(ROOT, manifest.background.service_worker), 'utf8');
  const opens =
    /setPanelBehavior\s*\(\s*\{\s*openPanelOnActionClick\s*:\s*true/.test(sw) ||
    /sidePanel\.open\s*\(/.test(sw);
  if (!opens) fail('side_panel is declared but nothing opens it');
  if (manifest.action?.default_popup && /setPanelBehavior/.test(sw)) {
    fail('default_popup takes priority over setPanelBehavior — remove one');
  }
}

// chrome.action.* needs an "action" key, even an empty one.
if (js.some((f) => /\bchrome\.action\./.test(readFileSync(f, 'utf8'))) && !manifest.action) {
  fail('code calls chrome.action.* but the manifest has no "action" key');
}

// tab.url is undefined without the tabs permission.
const permissions = new Set(manifest.permissions ?? []);
if (js.some((f) => /\btab\??\.(url|title)\b/.test(readFileSync(f, 'utf8'))) && !permissions.has('tabs')) {
  fail('code reads tab.url or tab.title but "tabs" is not in permissions');
}

// Declared commands must be handled, and vice versa.
const sw = readFileSync(join(ROOT, manifest.background.service_worker), 'utf8');
for (const name of Object.keys(manifest.commands ?? {})) {
  if (name.startsWith('_execute')) continue;
  if (!sw.includes(`'${name}'`) && !sw.includes(`"${name}"`)) {
    fail(`command "${name}" is declared but never handled`);
  }
}

// ------------------------------------------------------------------- report

for (const n of notes) console.log(`  note  ${n}`);
for (const p of problems) console.log(`  FAIL  ${p}`);

console.log(
  problems.length
    ? `\n${problems.length} problem${problems.length === 1 ? '' : 's'} found.`
    : `\nAll checks passed (${referenced.size} manifest references, ${js.length} scripts).`,
);
process.exit(problems.length ? 1 : 0);
