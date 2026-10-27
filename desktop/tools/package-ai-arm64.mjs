// Reproducible AI-capable Raspberry Pi backend bundle; never starts a controller.
import {build} from 'esbuild';
import {createHash,randomUUID} from 'node:crypto';
import {cp,mkdir,readFile,writeFile,access,chmod} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const desktop=resolve(root,'desktop');
const pinned=JSON.parse(await readFile(resolve(desktop,'ai/runtime-manifest.json'),'utf8'));
const version=JSON.parse(await readFile(resolve(desktop,'package.json'),'utf8')).version;
const artifact=`node-${pinned.version}-linux-arm64.tar.xz`;
const cache=resolve(desktop,'build/ai-downloads');await mkdir(cache,{recursive:true});
const archive=resolve(cache,artifact);
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
try{await access(archive);}catch{
  const response=await fetch(`https://nodejs.org/dist/${pinned.version}/${artifact}`);
  if(!response.ok)throw Error(`Node ARM64 下载失败 (${response.status})`);
  const bytes=Buffer.from(await response.arrayBuffer());
  if(digest(bytes)!==pinned.linux_arm64_sha256)throw Error('Node ARM64 SHA256 校验失败');
  await writeFile(archive,bytes);
}
if(digest(await readFile(archive))!==pinned.linux_arm64_sha256)throw Error('缓存 Node ARM64 完整性校验失败');
const staging=resolve(desktop,'build',`ai-arm64-${randomUUID()}`);
await mkdir(resolve(staging,'runtime/ai'),{recursive:true});await mkdir(resolve(staging,'runtime/node'),{recursive:true});
for(const name of ['main.py','device_main.py','requirements.txt'])await cp(resolve(root,'roaster',name),resolve(staging,name));
await cp(resolve(root,'docs/guides/real-device-setup.md'),resolve(staging,'README.md'));
await mkdir(resolve(staging,'data/profiles'),{recursive:true});
await cp(resolve(root,'roaster/data/profiles/default-light-roast.json'),resolve(staging,'data/profiles/default-light-roast.json'));
for(const name of ['install-roaster.sh','start-roaster.sh','open-roaster.sh'])await cp(resolve(root,'scripts/pi',name),resolve(staging,name));
await cp(resolve(root,'docs/guides/real-device-setup.md'),resolve(staging,'DEVICE-SETUP.md'));
for(const name of ['src','static'])await cp(resolve(root,'roaster',name),resolve(staging,name),{recursive:true,filter:path=>!path.includes('__pycache__')&&!path.endsWith('.pyc')});
await cp(resolve(root,'roaster/config.yaml'),resolve(staging,'config.example.yaml'));
await build({entryPoints:[resolve(desktop,'ai/service.mjs')],outdir:resolve(staging,'runtime/ai'),outExtension:{'.js':'.mjs'},bundle:true,platform:'node',format:'esm',splitting:true,target:'node24',banner:{js:'import {createRequire as __aiCreateRequire} from "node:module"; const require=__aiCreateRequire(import.meta.url);'},logLevel:'warning'});
const extraction=spawnSync('tar',['-xf',archive,'--strip-components=1','-C',resolve(staging,'runtime/node')],{windowsHide:true,encoding:'utf8'});
if(extraction.status!==0)throw Error(`Node ARM64 解包失败：${extraction.stderr||extraction.error}`);
await chmod(resolve(staging,'runtime/node/bin/node'),0o755);
await writeFile(resolve(staging,'AI-HOST-INSTALL.md'),`# Raspberry Pi ARM64 AI host ${version}\n\n需要 64 位 Linux ARM64、Python 3.11+ 与符合 Node ${pinned.version} 要求的系统。\n\n1. 将压缩包解到新的目录。已有设备先备份配置和 data，保留设备串口等设置。\n2. 建立 Python 虚拟环境并安装 requirements.txt；将现有 config.yaml 复制到新目录，首次安装用 config.example.yaml。\n3. 安装阶段不启动 main.py。确认设备安全并按原流程启动后端后，AI 会按需启动独立 Node 子进程。\n4. 在此目录运行 .venv/bin/python -m src.ai pair-code，将本机显示的 8 位配对码填写到同源网页或桌面的远程 AI 宿主设置。配对码 10 分钟有效，最多 5 次尝试，成功即失效。\n5. .venv/bin/python -m src.ai clients 查看客户端；revoke --client-id ID 撤销。浏览器使用 HttpOnly / SameSite=Strict Cookie；Windows 桌面凭据保存在系统凭据管理器。\n\nAI 数据默认保存在 data/ai，目录权限 0700，主密钥权限 0600。OAuth/API 凭据由主密钥加密。备份需同时保留该目录中的主密钥与加密数据；不要将其加入 Git。AI 运行时不可用不会阻断控机。AI 不连接串口，不驱动加热，不应用曲线。\n\n已固定 Node ${pinned.version}，原始 ARM64 压缩包 SHA256：${pinned.linux_arm64_sha256}。本机只能验证归档与协议；ARM64 执行、树莓派浏览器和实机尚需目标设备验收。\n`);
await writeFile(resolve(staging,'runtime/node-manifest.json'),JSON.stringify({version:pinned.version,architecture:'linux-arm64',archive:artifact,sha256:pinned.linux_arm64_sha256},null,2));
const dist=resolve(root,'dist');await mkdir(dist,{recursive:true});const output=resolve(dist,`RoasterDevice_${version}_linux_arm64.tar.gz`);
// Windows tar preserves mode 0666 for an extensionless binary; normalize Unix modes explicitly.
const python=process.env.AI_PACKAGE_PYTHON||[resolve(root,'roaster/.venv/Scripts/python.exe'),resolve(root,'roaster/.venv/bin/python')].find(existsSync)||(process.platform==='win32'?'python':'python3');
const packed=spawnSync(python,[resolve(desktop,'tools/package-ai-archive.py'),staging,output],{windowsHide:true,encoding:'utf8'});
if(packed.status!==0)throw Error(`ARM64 打包失败：${packed.stderr||packed.error}`);
const sha=digest(await readFile(output));await writeFile(output+'.sha256',`${sha}  ${output.split(/[\\/]/).pop()}\n`);
console.log(JSON.stringify({output,sha256:sha,staging,node_archive_sha256:pinned.linux_arm64_sha256}));
