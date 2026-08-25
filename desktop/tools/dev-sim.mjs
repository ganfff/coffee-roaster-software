import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, '..');
const simulator = spawn(process.execPath, [resolve(here, 'roaster-simulator.mjs'), ...process.argv.slice(2)], {
  cwd: desktopRoot,
  stdio: ['ignore', 'pipe', 'inherit'],
});

let tauri = null;
simulator.stdout.on('data', chunk => {
  const text = String(chunk);
  process.stdout.write(text);
  if (!tauri && text.includes('Roaster simulator ready')) {
    const windows = process.platform === 'win32';
    const executable = windows ? (process.env.ComSpec || 'cmd.exe') : 'npx';
    const args = windows ? ['/d', '/s', '/c', 'npx', 'tauri', 'dev'] : ['tauri', 'dev'];
    tauri = spawn(executable, args, {
      cwd: desktopRoot,
      stdio: 'inherit',
    });
    tauri.on('exit', code => {
      simulator.kill();
      process.exit(code ?? 0);
    });
  }
});

function shutdown() {
  if (tauri) tauri.kill();
  simulator.kill();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
