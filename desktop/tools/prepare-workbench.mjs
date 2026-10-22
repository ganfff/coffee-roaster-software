import {spawnSync} from 'node:child_process';
import {workbenchPython} from './python-runtime.mjs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const python=workbenchPython();
const result=spawnSync(python,[resolve(root,'desktop/tools/prepare-workbench.py')],{stdio:'inherit',windowsHide:true});
if(result.error)console.error(result.error.message);
process.exit(result.status??1);
