import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, '..');
const packageRoot = resolve(desktopRoot, 'node_modules', '@phosphor-icons', 'web');
const sourceRoot = resolve(packageRoot, 'src', 'regular');
const outputRoot = resolve(desktopRoot, '..', 'roaster', 'static', 'assets', 'icons', 'phosphor');
const staticRoot = resolve(desktopRoot, '..', 'roaster', 'static');
const runtimeSources = [
  'index.html', 'editor.html', 'js/app.js', 'js/editor.js', 'js/tauri-adapter.js',
].map(file => resolve(staticRoot, file));

await mkdir(outputRoot, { recursive: true });

const sourceCss = await readFile(resolve(sourceRoot, 'style.css'), 'utf8');
const runtimeText = (await Promise.all(runtimeSources.map(file => readFile(file, 'utf8')))).join('\n');
const icons = [...new Set(runtimeText.match(/\bph-[a-z0-9-]+\b/g) || [])].sort();
const baseRule = sourceCss.match(/\.ph\s*\{[\s\S]*?\n\}/)?.[0];
if (!baseRule || icons.length === 0) throw new Error('No Phosphor runtime classes found.');

const iconRules = icons.map(icon => {
  const escaped = icon.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rule = sourceCss.match(new RegExp(`\\.ph\\.${escaped}:before\\s*\\{[^}]+\\}`))?.[0];
  if (!rule) throw new Error(`Missing Phosphor CSS rule for ${icon}`);
  return rule;
});

const runtimeCss =
  '@font-face {\n' +
    '  font-family: "Phosphor";\n' +
    '  src: url("./Phosphor.woff2") format("woff2");\n' +
    '  font-weight: normal;\n' +
    '  font-style: normal;\n' +
    '  font-display: block;\n' +
    '}\n\n' + baseRule + '\n\n' + iconRules.join('\n') + '\n';

await Promise.all([
  writeFile(resolve(outputRoot, 'phosphor.css'), runtimeCss, 'utf8'),
  copyFile(resolve(sourceRoot, 'Phosphor.woff2'), resolve(outputRoot, 'Phosphor.woff2')),
  copyFile(resolve(packageRoot, 'LICENSE'), resolve(outputRoot, 'LICENSE')),
]);

console.log(`Synced ${icons.length} Phosphor icons to ${outputRoot}`);
