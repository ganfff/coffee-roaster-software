import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const staticRoot = resolve(root, 'roaster', 'static');
const jsFiles = ['theme.js', 'utils.js', 'tauri-adapter.js', 'app.js', 'editor.js']
  .map(name => resolve(staticRoot, 'js', name));
const cssFiles = ['theme.css', 'style.css', 'editor.css']
  .map(name => resolve(staticRoot, 'css', name));
const htmlFiles = [resolve(staticRoot, 'index.html'), resolve(staticRoot, 'editor.html')];
const failures = [];

function check(condition, message) {
  if (!condition) failures.push(message);
}

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
}

for (const file of jsFiles) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  check(result.status === 0, `${file}: JavaScript syntax failed\n${result.stderr}`);
}

for (const file of cssFiles) {
  const css = await readFile(file, 'utf8');
  let balance = 0;
  for (const char of css) {
    if (char === '{') balance += 1;
    if (char === '}') balance -= 1;
  }
  check(balance === 0, `${file}: CSS brace balance is ${balance}`);
}

const contracts = [
  [resolve(staticRoot, 'js', 'app.js'), resolve(staticRoot, 'index.html')],
  [resolve(staticRoot, 'js', 'editor.js'), resolve(staticRoot, 'editor.html')],
];
for (const [jsFile, htmlFile] of contracts) {
  const [js, html] = await Promise.all([readFile(jsFile, 'utf8'), readFile(htmlFile, 'utf8')]);
  const htmlIds = [...html.matchAll(/\bid=["']([^"']+)["']/g)].map(match => match[1]);
  const duplicateIds = [...new Set(htmlIds.filter((id, index) => htmlIds.indexOf(id) !== index))];
  const requiredIds = [...new Set([...js.matchAll(/getElementById\(["']([^"']+)["']\)/g)].map(match => match[1]))]
    .filter(id => !id.endsWith('-') && !['app-toast', 'editor-toast', 'drag-tooltip'].includes(id));
  const missingIds = requiredIds.filter(id => !htmlIds.includes(id));
  check(duplicateIds.length === 0, `${htmlFile}: duplicate ids ${duplicateIds.join(', ')}`);
  check(missingIds.length === 0, `${htmlFile}: missing ids ${missingIds.join(', ')}`);
}

const [indexHtml, editorHtml, themeJs, appJs, editorJs, tauriAdapter, styleCss, editorCss, themeCss, iconCss] = await Promise.all([
  readFile(htmlFiles[0], 'utf8'), readFile(htmlFiles[1], 'utf8'),
  readFile(jsFiles[0], 'utf8'), readFile(jsFiles[3], 'utf8'), readFile(jsFiles[4], 'utf8'), readFile(jsFiles[2], 'utf8'),
  readFile(cssFiles[1], 'utf8'), readFile(cssFiles[2], 'utf8'), readFile(cssFiles[0], 'utf8'),
  readFile(resolve(staticRoot, 'assets', 'icons', 'phosphor', 'phosphor.css'), 'utf8'),
]);

for (const [name, html] of [['index.html', indexHtml], ['editor.html', editorHtml]]) {
  check(!html.includes('?v=3.20'), `${name}: stale v3.20 cache key`);
  check(html.indexOf('js/theme.js?v=3.21') < html.indexOf('css/theme.css?v=3.21'), `${name}: theme.js must load before theme.css`);
}

const authoredSources = [indexHtml, editorHtml, appJs, editorJs, tauriAdapter].join('\n');
check(!/<svg\b/i.test(authoredSources), 'Authored frontend contains inline SVG');
const cssWithoutComments = stripComments([styleCss, editorCss, themeCss].join('\n'));
check(!/backdrop-filter\s*:|filter\s*:\s*blur/i.test(cssWithoutComments), 'Blur/backdrop-filter is forbidden');
check(!/#[0-9a-f]{3,8}\b|rgba?\(/i.test(stripComments(styleCss + '\n' + editorCss)), 'Page CSS must consume theme tokens instead of hard-coded colors');
check(/#footer\s*\{[\s\S]*?z-index:\s*1020\b/.test(styleCss), 'Footer/E-STOP layer must remain z-index 1020');
check(/touch-action:\s*none/.test(editorCss), 'Editor canvas must keep touch-action:none');
check(/msg\.error\s*!=\s*null[\s\S]*?return;[\s\S]*?msg\.ok\s*===\s*true\)\s*return;/.test(appJs), 'WebSocket {error}/{ok} replies must short-circuit');
check(/return\s+'auto';/.test(themeJs), 'First-launch theme must default to auto');

const usedIcons = [...new Set([...authoredSources.matchAll(/\bph-([a-z0-9-]+)/g)].map(match => match[1]))];
const missingIcons = usedIcons.filter(name => !iconCss.includes(`.ph.ph-${name}:before`));
check(missingIcons.length === 0, `Missing Phosphor glyphs: ${missingIcons.join(', ')}`);

if (failures.length) {
  console.error(failures.map((failure, index) => `${index + 1}. ${failure}`).join('\n'));
  process.exit(1);
}

console.log(`Frontend checks passed: ${jsFiles.length} JS files, ${cssFiles.length} CSS files, ${htmlFiles.length} HTML contracts, ${usedIcons.length} icons.`);
