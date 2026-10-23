// Native live-source debugging. No installation or real hardware backend.
import {startDevServer,defaultDataDir} from './dev-server.mjs';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join,dirname,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
const desktopRoot=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const args=process.argv.slice(2),scenario=args.find(arg=>arg.startsWith('--scenario='))?.split('=')[1]||'idle';
const temp=await mkdtemp(join(tmpdir(),'roaster-dev-'));
let host,ownsHost=false;
try {
  try {
    const meta=JSON.parse(await readFile(join(defaultDataDir,'server.json'),'utf8'));
    const health=await fetch(meta.origin+'/__debug__/health',{signal:AbortSignal.timeout(1500)}).then(r=>r.json());
    if(health.mode==='safe-simulator'&&resolve(health.project)===resolve(desktopRoot,'..'))host={origin:meta.origin};
  } catch {}
  if(!host){host=await startDevServer({port:Number(process.env.ROASTER_DEV_PORT||0),scenario,freeze:args.includes('--freeze')});ownsHost=true;}
  console.log('免安装原生调试：'+host.origin+'（浏览器也可打开；安全模拟器）');
  // Invoke the bundled runtime directly, independent of npm or a system Node PATH.
  for(const name of ['prepare-ai.mjs','prepare-workbench.mjs']){
    const preparation=spawn(process.execPath,[join(desktopRoot,'tools',name)],{cwd:desktopRoot,stdio:'inherit',windowsHide:true});
    const status=await new Promise((ok,no)=>{preparation.once('error',no);preparation.once('exit',ok);});
    if(status!==0)throw Error('Desktop resource preparation failed: '+name+' (exit '+status+')');
  }
  const config=join(temp,'tauri.dev.json');await writeFile(config,JSON.stringify({build:{devUrl:host.origin,beforeDevCommand:null}}));
  const cli=resolve(desktopRoot,'tools/tauri-cli.cjs');
  const child=spawn(process.execPath,[cli,'dev','--config',config],{cwd:desktopRoot,stdio:'inherit',windowsHide:true});
  const stop=()=>{child.kill();if(ownsHost)void host.close();};process.once('SIGINT',stop);process.once('SIGTERM',stop);
  const code=await new Promise((ok,no)=>{child.once('error',no);child.once('exit',ok);});process.exitCode=code??1;
}catch(error){console.error(error.message);process.exitCode=1;}
finally{if(ownsHost)await host?.close();if(!resolve(temp).startsWith(resolve(tmpdir())+sep))throw Error('Unexpected temporary path');await rm(temp,{recursive:true,force:true});}
