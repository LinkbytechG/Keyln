import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {syncBuiltinESMExports} from 'node:module';
import {prepareService,readService,servicePaths} from '../dist/apps/host/service.js';
import {installService} from '../dist/apps/host/service-cli.js';

// T109 R5: real file transactions with injected failures; job lifecycle is a fake, no launchctl calls or Host startup.
function fixture(t,installed=true){
  const dir=fs.mkdtempSync(join(tmpdir(),'keyln-install-rollback-')),source=join(dir,'source'),data=join(dir,'data');
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  for(const name of ['dist/apps/host','dist/packages','node_modules/ws'])fs.mkdirSync(join(source,name),{recursive:true,mode:0o700});
  fs.mkdirSync(join(data,'tls'),{recursive:true,mode:0o700});
  for(const name of ['host.json','config.json','tls/server.key','tls/server.pem','tls/rootCA.pem'])fs.writeFileSync(join(data,name),'Fixture private data',{mode:0o600});
  fs.writeFileSync(join(source,'dist/apps/host/main.js'),'OLDER');fs.writeFileSync(join(source,'dist/apps/host/service-runner.js'),'Never started');fs.writeFileSync(join(source,'node_modules/ws/package.json'),'{}');
  fs.copyFileSync('dist/keyln-helper',join(source,'dist/keyln-helper'));
  const paths=servicePaths(data,'local.keyln.host.test.1234abcd',join(dir,'agents'));
  const main=base=>join(base,'dist/apps/host/main.js');
  if(installed){prepareService(paths,source);fs.writeFileSync(main(source),'OLD');prepareService(paths,source);}
  fs.writeFileSync(main(source),'NEW');
  return {dir,source,paths,main};
}
function snapshot(f){
  return Object.fromEntries([f.paths.manifest,f.paths.plist,f.main(f.paths.runtime),f.main(f.paths.runtime+'.previous'),join(f.paths.data,'config.json')].map(path=>[path,fs.existsSync(path)?fs.readFileSync(path,'utf8'):null]));
}
const noStaging=f=>assert.ok(!fs.readdirSync(f.paths.data).some(name=>name.startsWith('runtime-stage-')||name.startsWith('runtime-rollback-')));
function failRename(t,where){
  const original=fs.renameSync;let fired=false;
  fs.renameSync=(from,to)=>{if(!fired&&where(String(from),String(to))){fired=true;throw Object.assign(new Error('Injected write failure'),{code:'EACCES'});}return original(from,to);};
  syncBuiltinESMExports();t.after(()=>{fs.renameSync=original;syncBuiltinESMExports();});
  return ()=>assert.equal(fired,true,'the intended failure point was reached');
}
for(const point of ['old-runtime','new-runtime','plist','manifest','backup-retire','backup-publish'])test(`T109 R5 failed ${point} commit restores runtime, prior backup and exact metadata`,t=>{
  const f=fixture(t),before=snapshot(f);
  const fired=failRename(t,(from,to)=>point==='old-runtime'?from===f.paths.runtime:point==='new-runtime'?from.includes('runtime-stage-')&&to===f.paths.runtime:point==='plist'?to===f.paths.plist:point==='manifest'?to===f.paths.manifest:point==='backup-retire'?from===f.paths.runtime+'.previous':from.includes('runtime-rollback-')&&to===f.paths.runtime+'.previous');
  assert.throws(()=>prepareService(f.paths,f.source),/Injected write failure/);fired();assert.deepEqual(snapshot(f),before);assert.equal(readService(f.paths).node,process.execPath);noStaging(f);
});
test('T109 R5 a read-only LaunchAgents directory fails in staging and leaves the old installation intact',t=>{
  const f=fixture(t),before=snapshot(f),agents=join(f.dir,'agents');fs.chmodSync(agents,0o500);
  try{assert.throws(()=>prepareService(f.paths,f.source),error=>error.code==='EACCES');}finally{fs.chmodSync(agents,0o700);}
  assert.deepEqual(snapshot(f),before);noStaging(f);
});

function control(f,initial,{notReady=false,stopNewFails=false}={}){
  const calls=[],state={...initial};let readyCalls=0,stops=0;
  return {calls,
    state(){calls.push('state');return {...initial};},
    async stop(){calls.push('stop');if(++stops===2&&stopNewFails)throw new Error('New job cannot stop');state.loaded=false;state.running=false;state.enabled=false;},
    async start(){calls.push('start');assert.equal(fs.readFileSync(f.main(f.paths.runtime),'utf8'),'NEW');state.loaded=true;state.running=true;state.enabled=true;},
    async ready(){calls.push('ready');if(++readyCalls===1&&notReady)throw new Error('New job not ready');},
    async restore(paths,prior){calls.push('restore');assert.deepEqual(prior,initial);assert.deepEqual(fs.existsSync(f.paths.manifest),fs.existsSync(f.main(f.paths.runtime)));Object.assign(state,prior);},
  };
}
test('T109 R5 staging failure does not stop a running previous service',async t=>{
  const f=fixture(t),before=snapshot(f),job=control(f,{loaded:true,enabled:true,running:true});fs.rmSync(join(f.source,'dist/keyln-helper'));
  await assert.rejects(installService(f.paths,f.source,process.execPath,job));assert.deepEqual(job.calls,['state']);assert.deepEqual(snapshot(f),before);noStaging(f);
});
test('T109 R5 readiness failure restores previous files, backup and running startup state',async t=>{
  const f=fixture(t),before=snapshot(f),initial={loaded:true,enabled:true,running:true},job=control(f,initial,{notReady:true});
  await assert.rejects(installService(f.paths,f.source,process.execPath,job),/previous files and startup state were preserved or restored.*New job not ready/);
  assert.deepEqual(job.calls,['state','stop','start','ready','stop','restore','ready']);assert.deepEqual(snapshot(f),before);noStaging(f);
});
test('T109 R5 recovery preserves a previously disabled, unloaded service without starting the old job',async t=>{
  const f=fixture(t),before=snapshot(f),job=control(f,{loaded:false,enabled:false,running:false},{notReady:true});
  await assert.rejects(installService(f.paths,f.source,process.execPath,job),/previous files and startup state/);
  assert.deepEqual(job.calls,['state','stop','start','ready','stop','restore']);assert.deepEqual(snapshot(f),before);noStaging(f);
});
test('T109 R5 a failed first installation removes only its new files and restores the prior startup flag',async t=>{
  const f=fixture(t,false),before=snapshot(f),job=control(f,{loaded:false,enabled:false,running:false},{notReady:true});
  await assert.rejects(installService(f.paths,f.source,process.execPath,job),/previous files and startup state/);
  assert.deepEqual(job.calls,['state','start','ready','stop','restore']);assert.deepEqual(snapshot(f),before);noStaging(f);
});
test('T109 R5 successful readiness finalizes the backup only after the new service is ready',async t=>{
  const f=fixture(t),before=snapshot(f),job=control(f,{loaded:true,enabled:true,running:true});
  const ready=job.ready;job.ready=async()=>{assert.equal(fs.readFileSync(f.main(f.paths.runtime+'.previous'),'utf8'),'OLDER');await ready();};
  await installService(f.paths,f.source,process.execPath,job);
  assert.deepEqual(job.calls,['state','stop','start','ready']);assert.equal(fs.readFileSync(f.main(f.paths.runtime),'utf8'),'NEW');assert.equal(fs.readFileSync(f.main(f.paths.runtime+'.previous'),'utf8'),'OLD');
  assert.equal(fs.readFileSync(join(f.paths.data,'config.json'),'utf8'),before[join(f.paths.data,'config.json')]);noStaging(f);
});
test('T109 R5 if the new job cannot stop, no files are exchanged under it and rollback material is preserved',async t=>{
  const f=fixture(t),job=control(f,{loaded:true,enabled:true,running:true},{notReady:true,stopNewFails:true});
  await assert.rejects(installService(f.paths,f.source,process.execPath,job),/new job could not be stopped; rollback files were preserved/);
  assert.equal(fs.readFileSync(f.main(f.paths.runtime),'utf8'),'NEW');assert.ok(readService(f.paths));assert.ok(fs.readdirSync(f.paths.data).some(name=>name.startsWith('runtime-rollback-')));assert.ok(!job.calls.includes('restore'));
});
