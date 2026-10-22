// Workbench development uses this repository's environment, never a nested clone.
import {existsSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
export function workbenchPython() {
  const executable=process.platform==='win32'?'Scripts/python.exe':'bin/python';
  return process.env.WORKBENCH_PYTHON || ['desktop/.venv','roaster/.venv','.venv']
    .map(directory=>resolve(root,directory,executable)).find(existsSync) || (process.platform==='win32'?'python':'python3');
}
