import {spawnSync} from 'node:child_process';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {workbenchPython} from './python-runtime.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const result=spawnSync(workbenchPython(),[resolve(root,'desktop/tools/prepare-device.py')],{stdio:'inherit',windowsHide:true});
if(result.error)console.error(result.error.message);
process.exit(result.status??1);
