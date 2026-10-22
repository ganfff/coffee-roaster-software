import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const python=process.env.WORKBENCH_PYTHON || [resolve(root,'kaffelogic逆向/.venv/Scripts/python.exe'),resolve(root,'.venv/Scripts/python.exe')].find(existsSync) || 'python';
const result=spawnSync(python,[resolve(root,'desktop/tools/prepare-workbench.py')],{stdio:'inherit',windowsHide:true});
if(result.error)console.error(result.error.message);
process.exit(result.status??1);
