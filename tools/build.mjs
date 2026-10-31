#!/usr/bin/env node
/**
 * Builds the extension for one browser from the same sources.
 *
 *     node tools/build.mjs chrome            # → dist/chrome
 *     node tools/build.mjs safari            # → dist/safari
 *     node tools/build.mjs safari --out DIR  # → DIR (TerrierGPT Menu's SafariExtension/Resources)
 *     node tools/build.mjs safari-ios        # → dist/safari-ios (TerrierGPT for iPhone)
 *
 * Chrome gets the files as they are. Safari differs in three ways:
 *
 * - No module service worker. `background.type: "module"` is unsupported, so
 *   the worker and the lib modules it imports are joined into one classic
 *   script, each module in its own function scope.
 * - No side panel or omnibox. Those manifest keys go, and the panel page is
 *   made web-accessible so `content/dock.js` can dock it inside the tab.
 * - Native messages go to TerrierGPT Menu's app extension, not a host
 *   process. `globalThis.TG_TARGET = 'safari'` tells the worker so.
 *
 * Safari on iOS starts from the Safari build and goes further: no context
 * menus or keyboard commands, and the toolbar button opens `popup/`, which
 * sends the page or ticket to TerrierGPT for iPhone (`TG_TARGET = 'safari-ios'`).
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const RUNTIME = ['manifest.json', 'service-worker.js', 'lib', 'content', 'sidepanel', 'options', 'icons'];

const [target = 'chrome', ...rest] = process.argv.slice(2);
if (!['chrome', 'safari', 'safari-ios'].includes(target)) {
  console.error(`Unknown target "${target}". Use chrome, safari, or safari-ios.`);
  process.exit(1);
}
const outFlag = rest.indexOf('--out');
const OUT = outFlag >= 0 ? resolve(rest[outFlag + 1]) : join(ROOT, 'dist', target);

/**
 * Joins the worker and its relative imports into one classic script.
 *
 * Only the shapes this codebase uses are handled: `import { a, b } from './x.js'`,
 * and `export function` / `export async function` / `export const`. Anything
 * else fails the build rather than shipping a worker that dies on load.
 */
export function bundleWorker(entry, { prelude = '' } = {}) {
  const seen = new Map();
  const order = [];

  function load(file) {
    if (seen.has(file)) return seen.get(file);
    const name = `__tg_${file.replace(/^.*\//, '').replace(/\.js$/, '').replace(/[^A-Za-z0-9_]/g, '_')}`;
    const record = { file, name, body: '', exports: [] };
    seen.set(file, record);

    let source = readFileSync(file, 'utf8');
    source = rewriteImports(source, file);
    const exports = [];
    source = source.replace(/^export\s+(async\s+function|function|const|let|class)\s+([A-Za-z_$][\w$]*)/gm, (_, kind, id) => {
      exports.push(id);
      return `${kind} ${id}`;
    });
    if (/^\s*export\s/m.test(source)) throw new Error(`${file}: an export form the bundler does not handle`);
    record.body = source;
    record.exports = exports;
    order.push(record);
    return record;
  }

  function rewriteImports(source, file) {
    return source.replace(/^import\s*\{([^}]*)\}\s*from\s*['"](\.[^'"]+)['"];?\s*$/gm, (_, names, spec) => {
      const dep = load(resolve(dirname(file), spec));
      return `const {${names}} = ${dep.name};`;
    });
  }

  const entrySource = rewriteImports(readFileSync(entry, 'utf8'), entry);
  if (/^\s*(import|export)\s/m.test(entrySource)) throw new Error(`${entry}: an import or export the bundler does not handle`);

  const modules = order.map((m) =>
    `// ---- ${m.file.slice(ROOT.length + 1)}\nconst ${m.name} = (() => {\n${m.body}\nreturn { ${m.exports.join(', ')} };\n})();\n`);
  return [
    '// Built by tools/build.mjs for Safari. Edit the sources, not this file.',
    prelude,
    ...modules,
    `// ---- ${entry.slice(ROOT.length + 1)}`,
    entrySource,
  ].filter(Boolean).join('\n');
}

export function safariManifest(manifest) {
  const m = structuredClone(manifest);
  delete m.key;
  delete m.side_panel;
  delete m.omnibox;
  delete m.minimum_chrome_version;
  if (m.background) delete m.background.type;
  if (m.options_ui) delete m.options_ui.open_in_tab;
  m.permissions = (m.permissions ?? []).filter((p) => !['sidePanel', 'clipboardRead'].includes(p));
  m.web_accessible_resources = [
    {
      resources: ['sidepanel/*', 'lib/*', 'icons/*'],
      matches: ['<all_urls>'],
    },
  ];
  m.browser_specific_settings = { safari: { strict_min_version: '17.0' } };
  return m;
}

export function safariIOSManifest(manifest) {
  const m = safariManifest(manifest);
  delete m.commands;
  m.permissions = m.permissions.filter((p) => p !== 'contextMenus');
  m.action = { ...m.action, default_popup: 'popup/popup.html' };
  m.browser_specific_settings = { safari: { strict_min_version: '18.0' } };
  return m;
}

function build() {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  for (const item of RUNTIME) {
    const from = join(ROOT, item);
    if (!existsSync(from)) throw new Error(`missing ${item}`);
    cpSync(from, join(OUT, item), { recursive: true, filter: (p) => !p.endsWith('.DS_Store') });
  }
  if (target === 'safari' || target === 'safari-ios') {
    const ios = target === 'safari-ios';
    const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
    const shaped = ios ? safariIOSManifest(manifest) : safariManifest(manifest);
    writeFileSync(join(OUT, 'manifest.json'), `${JSON.stringify(shaped, null, 2)}\n`);
    writeFileSync(
      join(OUT, 'service-worker.js'),
      bundleWorker(join(ROOT, 'service-worker.js'), { prelude: `globalThis.TG_TARGET = '${target}';` }),
    );
    if (ios) cpSync(join(ROOT, 'popup'), join(OUT, 'popup'), { recursive: true, filter: (p) => !p.endsWith('.DS_Store') });
  }
  console.log(`Built ${target} → ${OUT}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) build();
