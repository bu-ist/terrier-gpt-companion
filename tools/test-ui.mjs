#!/usr/bin/env node
/**
 * UI checks that do not need a browser: status text is readable in light and
 * dark mode, motion stays short, feedback stays up long enough to read, a
 * closed Safari dock is out of the tab order, and controls carry the ARIA a
 * screen reader needs.
 *
 *     node tools/test-ui.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

let failures = 0;
const check = (name, ok) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}`);
  if (!ok) failures += 1;
};

// ------------------------------------------------------------------ contrast
function luminance(hex) {
  const value = hex.replace('#', '');
  const full = value.length === 3 ? value.split('').map((c) => c + c).join('') : value;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
/** Custom properties set in the light `:root` and in the dark-mode `:root`. */
function tokens(css) {
  const dark = css.indexOf('@media (prefers-color-scheme: dark)');
  const pick = (chunk) => Object.fromEntries([...chunk.matchAll(/(--[\w-]+):\s*(#[0-9a-f]{3,6}\b|var\(--[\w-]+\))/gi)].map((m) => [m[1], m[2]]));
  const light = pick(css.slice(0, dark));
  const darkBlock = css.slice(dark, css.indexOf('}\n}', dark));
  return { light, dark: { ...light, ...pick(darkBlock) } };
}
/** The colour a status rule resolves to in one mode. */
function resolve(rule, set) {
  let value = rule?.match(/color:\s*(var\(--[\w-]+\)|#[0-9a-f]{3,6})/i)?.[1];
  for (let hops = 0; value?.startsWith('var(') && hops < 5; hops += 1) value = set[value.slice(4, -1)];
  return value;
}

for (const [file, selectors] of [
  ['sidepanel/sidepanel.css', { error: '.status[data-tone="error"]', ok: '.status[data-tone="ok"]' }],
  ['popup/popup.css', { error: '.status.error' }],
]) {
  const css = read(file);
  const set = tokens(css);
  for (const [tone, selector] of Object.entries(selectors)) {
    const at = css.indexOf(`${selector} {`);
    const rule = at >= 0 ? css.slice(at, css.indexOf('}', at)) : '';
    for (const mode of ['light', 'dark']) {
      const color = resolve(rule, set[mode]);
      const ratio = color && set[mode]['--bg'] ? contrast(color, set[mode]['--bg']) : 0;
      check(`${file}: ${tone} status is at least 4.5:1 in ${mode} mode (${ratio.toFixed(2)}:1)`, ratio >= 4.5);
    }
  }
}
const optionsJs = read('options/options.js');
check('options status sets a tone, so its errors use the readable error colour', /status\.dataset\.tone\s*=/.test(optionsJs));

// ---------------------------------------------------------------- streaming
const panel = read('sidepanel/sidepanel.js');
check('a streaming answer does not force the scroll to the bottom on every update',
  !/if \(streaming\) el\.responseBody\.scrollTop = el\.responseBody\.scrollHeight;/.test(panel));
check('it sticks to the bottom only when the reader is already near it', /STICK_PX\s*=\s*40/.test(panel) && /scrollHeight - [\w.]+scrollTop - [\w.]+clientHeight\s*<=?\s*STICK_PX/.test(panel));
check('streamed updates render at most once per frame', /requestAnimationFrame\([^)]*\)/.test(panel) && /streamFrame/.test(panel));

// ----------------------------------------------------------------- feedback
const worker = read('service-worker.js');
check('an error toast in the page stays at least 8 seconds', /tone === 'error' \? (\d+)/.test(worker) && Number(worker.match(/tone === 'error' \? (\d+)/)[1]) >= 8000);
const sayFn = optionsJs.slice(optionsJs.indexOf('function say('), optionsJs.indexOf('}\n', optionsJs.indexOf('function say(')) + 2);
check('options errors stay at least 8 seconds', /tone === 'error' \? (\d[\d_]*)/.test(sayFn) && Number(sayFn.match(/tone === 'error' \? (\d[\d_]*)/)[1].replace(/_/g, '')) >= 8000);
const maxHandler = optionsJs.slice(optionsJs.indexOf("el.maxChars.addEventListener('change'"));
check('an invalid maximum says which range is allowed, next to the field',
  /1,000/.test(maxHandler.slice(0, 900)) && /200,000/.test(maxHandler.slice(0, 900)) && /maxCharsError\.hidden = false/.test(maxHandler.slice(0, 900))
  && /id="max-chars-error"[^>]*role="alert"/.test(read('options/options.html')) && /aria-describedby="[^"]*max-chars-error/.test(read('options/options.html')));

// ------------------------------------------------------------------- motion
const durations = (css, name) => Number(css.match(new RegExp(`${name}:\\s*(\\d+)ms`))?.[1] ?? NaN);
const overshoots = (css, name) => {
  const bez = css.match(new RegExp(`${name}:\\s*\\d+ms cubic-bezier\\(([^)]*)\\)`))?.[1];
  return !bez || bez.split(',').map(Number).some((n, i) => i % 2 === 1 && (n > 1 || n < 0));
};
const sidepanelCss = read('sidepanel/sidepanel.css');
const popupCss = read('popup/popup.css');
for (const [file, css, names] of [['sidepanel.css', sidepanelCss, ['--snap', '--morph']], ['popup.css', popupCss, ['--snap']]]) {
  for (const name of names) {
    const ms = durations(css, name);
    check(`${file}: ${name} is 180-240ms (${ms}ms)`, ms >= 180 && ms <= 240);
    check(`${file}: ${name} does not overshoot`, !overshoots(css, name));
  }
}
const dock = read('content/dock.js');
const dockMs = Number(dock.match(/transition: transform (\d+)ms/)?.[1] ?? NaN);
check(`the dock slides in 180-240ms (${dockMs}ms)`, dockMs >= 180 && dockMs <= 240);
check('the dock keeps its reduced-motion rule', /prefers-reduced-motion: reduce[\s\S]{0,80}transition: none/.test(dock));
check('the panel keeps its reduced-motion rule', /prefers-reduced-motion: reduce[\s\S]{0,300}transition-duration: 0ms/.test(sidepanelCss));

// --------------------------------------------------------------- the dock
const closeFn = dock.slice(dock.indexOf('function close()'), dock.indexOf('function toggle('));
const openFn = dock.slice(dock.indexOf('async function open('), dock.indexOf('function close()'));
check('a closed dock is inert and hidden from screen readers', /inert = true|setAttribute\('inert'/.test(closeFn) && /aria-hidden', 'true'/.test(closeFn));
check('an open dock is not', /inert = false|removeAttribute\('inert'\)/.test(openFn) && /removeAttribute\('aria-hidden'\)/.test(openFn));
const buildFn = dock.slice(dock.indexOf('function build('), dock.indexOf('function startResize('));
check('a dock built closed starts inert', /inert = true|setAttribute\('inert'/.test(buildFn));

// --------------------------------------------------------------------- a11y
const html = read('sidepanel/sidepanel.html');
check('the ask field has an aria-label', /<input id="instruction"[^>]*aria-label="[^"]+"/.test(html));
const segment = html.slice(html.indexOf('role="radiogroup"'), html.indexOf('</div>', html.indexOf('role="radiogroup"')));
check('Prod and Test are radios in their radiogroup', /id="instance-prod"[^>]*role="radio"/.test(segment) && /id="instance-test"[^>]*role="radio"/.test(segment));
check('Prod and Test say which is checked, not pressed', /aria-checked=/.test(segment) && !/aria-pressed/.test(segment));
check('the panel toggles aria-checked on Prod and Test', /el\.prod\.setAttribute\('aria-checked'/.test(panel) && /el\.test\.setAttribute\('aria-checked'/.test(panel));
check('the checked instance is styled by aria-checked', /\.segment button\[aria-checked="true"\]/.test(sidepanelCss) && !/\.segment button\[[^\]]*aria-pressed/.test(sidepanelCss));
check('sidepanel (and options, which shares it) shows focus on buttons and inputs', /button:focus-visible/.test(sidepanelCss) && /input:focus-visible/.test(sidepanelCss));
check('the options page loads the shared stylesheet', read('options/options.html').includes('../sidepanel/sidepanel.css'));
check('the popup shows focus on buttons and links', /button:focus-visible/.test(popupCss) && /a:focus-visible/.test(popupCss));

console.log(failures ? `\n${failures} failing.` : '\nAll UI checks passed.');
process.exit(failures ? 1 : 0);
