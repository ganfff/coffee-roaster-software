// Safe simulator bridge: invokes only the pure numerical worker, never main.py.
import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {workbenchPython} from './python-runtime.mjs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
export function workbenchRequest(request) {
  const binary=resolve(root,'desktop/runtime/workbench/RoasterWorkbenchEngine.exe');
  const python=workbenchPython();
  const packed=existsSync(binary)&&process.env.WORKBENCH_SOURCE!=='1';
  return new Promise((ok,fail)=>{
    const child=spawn(packed?binary:python,packed?[]:['-m','src.workbench.engine'],{cwd:resolve(root,'roaster'),env:{...process.env,PYTHONPATH:resolve(root,'roaster')},stdio:['pipe','pipe','pipe'],windowsHide:true});
    let output='',error='',done=false;
    const timer=setTimeout(()=>{child.kill();finish(Error('离线工作台引擎超时'));},30000);
    function finish(err,value){if(done)return;done=true;clearTimeout(timer);if(err)fail(err);else ok(value);}
    child.on('error',error=>finish(error));child.stdin.on('error',error=>finish(error));
    child.stdout.on('data',bytes=>{output+=bytes;});child.stderr.on('data',bytes=>{error+=bytes;});
    child.on('close',code=>{if(code!==0)return finish(Error(error||`workbench exited ${code}`));try{const data=JSON.parse(output);finish(data.ok?null:Error(data.error),data.result);}catch(error){finish(error);}});
    child.stdin.end(JSON.stringify(request)+'\n');
  });
}
