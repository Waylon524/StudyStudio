import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';
import {execFile} from 'node:child_process';
import {CodexBridge} from '../server/codex.mjs';
import {DISABLED_FEATURES,ENABLED_FEATURES,CLI_FEATURE_ARGS,LEARNING_FEATURES,REQUIRED_TRANSPORT_FEATURES,LEARNING_BASE_INSTRUCTIONS} from '../server/runtime-policy.mjs';

const exec=promisify(execFile),root=await fs.mkdtemp(path.join(os.tmpdir(),'study-runtime-check-'));
const terra={id:'gpt-6.1-terra',model:'gpt-6.1-terra',supportedReasoningEfforts:['medium','high','xhigh'].map(reasoningEffort=>({reasoningEffort}))};
const sol={id:'gpt-6.1-sol',model:'gpt-6.1-sol',supportedReasoningEfforts:[{reasoningEffort:'xhigh'}]};
const astra={id:'gpt-6-astra',model:'gpt-6-astra',supportedReasoningEfforts:[{reasoningEffort:'high'}]};
let clock=1000;
class StubBridge extends CodexBridge{
  constructor({opaque=false}={}){super({now:()=>clock});this.calls=[];this.nextThread=0;this.external=false;this.externalRuntime=false;this.opaque=opaque;this.account={type:'chatgpt'};this.models=[terra,sol,astra];this.catalogFailure=false;}
  async start(){}
  async request(method,params={}){
    this.calls.push({method,params});
    if(method==='config/read')return {config:{mcp_servers:this.external?{foreign:{}}:{}},layers:[{name:this.opaque?{type:'mdm',domain:'test',key:'test'}:{type:'user',file:path.join(root,'app-config.toml')}}],origins:{}};
    if(method==='mcpServerStatus/list')return {data:this.externalRuntime?[{runtimeStatus:'ready',tools:{foreign:{}}}]:[],nextCursor:null};
    if(method==='thread/start'||method==='thread/resume')return {thread:{id:params.threadId||'thread-'+(++this.nextThread)},model:params.model};
    if(method==='turn/start'){if(params.outputSchema)queueMicrotask(()=>{this.emit('event',{method:'item/completed',params:{threadId:params.threadId,item:{type:'agentMessage',phase:'final_answer',text:'{}'}}});this.emit('event',{method:'turn/completed',params:{threadId:params.threadId,turn:{status:'completed'}}})});return {turn:{id:'turn-'+this.calls.length}};}
    if(method==='thread/unsubscribe')return {};
    if(method==='model/list'){if(this.catalogFailure)throw Error('model metadata unavailable');return {data:this.models,nextCursor:null};}
    if(method==='account/read')return {account:this.account,requiresOpenaiAuth:!this.account};
    throw Error('Unexpected test request '+method);
  }
}
try{
  await fs.writeFile(path.join(root,'app-config.toml'),'# private application config\n');
  const bridge=new StubBridge(),course=path.join(root,'course');await fs.mkdir(course);
  const {thread}=await bridge.newThread('gpt-6.1-terra','学习','explain',course);
  assert.equal(bridge.calls.filter(x=>x.method==='config/read').length,1);
  assert.equal(bridge.calls.find(x=>x.method==='thread/start').params.config.web_search,'live');assert.equal(bridge.calls.find(x=>x.method==='thread/start').params.baseInstructions,LEARNING_BASE_INSTRUCTIONS);assert(LEARNING_BASE_INSTRUCTIONS.length<=600,'learning-only base stays compact');
  assert.equal(bridge.calls.filter(x=>x.method==='mcpServerStatus/list').length,1);
  bridge.calls=[];
  const result=await bridge.turn(thread.id,'解释课件','gpt-6.1-terra','high',{cwd:course,context:'真实作答',coursePolicy:'当前 AGENTS',images:['/tmp/lesson.png']});
  assert(result.turn.id);assert.deepEqual(bridge.calls.map(x=>x.method),['turn/start']);
  const params=bridge.calls[0].params;assert.deepEqual(params.sandboxPolicy,{type:'readOnly',networkAccess:false});assert.equal(params.effort,'high');assert.equal(params.model,'gpt-6.1-terra');assert.deepEqual(params.input[1],{type:'localImage',path:'/tmp/lesson.png'});assert.equal(params.additionalContext.course_policy.value,'当前 AGENTS');assert.equal(params.additionalContext.learning_material.value,'真实作答');
  const firstStart=await bridge.newThread(undefined,'另一门课','explain',course);assert(firstStart.thread.id);assert.equal(bridge.calls.filter(x=>x.method==='config/read').length,0,'cached runtime config should serve new threads');assert.equal(bridge.calls.filter(x=>x.method==='mcpServerStatus/list').length,1,'new thread still verified');
  bridge.calls=[];await bridge.resume(thread.id,'学习','explain',course);assert(bridge.calls.some(x=>x.method==='mcpServerStatus/list'),'resume must reverify tools');assert.equal(bridge.calls.find(x=>x.method==='thread/resume').params.config.web_search,'live');assert.equal(bridge.calls.find(x=>x.method==='thread/resume').params.baseInstructions,LEARNING_BASE_INSTRUCTIONS);
  await fs.mkdir(path.join(course,'.codex'));await fs.writeFile(path.join(course,'.codex','config.toml'),'[mcp_servers.changed]\n');bridge.calls=[];
  await assert.rejects(bridge.turn(thread.id,'x'),/配置已变化/);assert.equal(bridge.calls.length,0,'changed local policy must stop before any model request');assert.equal(bridge.isolated.size,0);
  const blocked=new StubBridge();blocked.external=true;await assert.rejects(blocked.newThread(undefined,'x','explain',course),/外部工具/);assert(!blocked.calls.some(x=>x.method==='thread/start'));
  const runtimeBlocked=new StubBridge();runtimeBlocked.externalRuntime=true;await assert.rejects(runtimeBlocked.newThread(undefined,'x','explain',course),/外部工具/);assert.equal(runtimeBlocked.isolated.size,0);await assert.rejects(runtimeBlocked.resume('saved','x','explain',course),/外部工具/);
  const managed=new StubBridge({opaque:true}),managedThread=(await managed.newThread(undefined,'x','explain',course)).thread;managed.calls=[];await managed.turn(managedThread.id,'x');assert.deepEqual(managed.calls.map(x=>x.method),['config/read','mcpServerStatus/list','turn/start'],'opaque managed policy retains fresh guards');
  const graph=new StubBridge(),graphThread=(await graph.newThread(undefined,'学习','explain',course)).thread;
  const resumed=new Set([graphThread.id]),freshThreads=new Map([[graphThread.id,{}]]);let disconnected=0,killed=0;
  graph.on('disconnected',()=>{disconnected++;resumed.clear();freshThreads.clear()});graph.child={kill(){killed++}};graph.ready=Promise.resolve();
  graph.receive({method:'skills/changed',params:{}});graph.receive({method:'study/updated',params:{threadId:graphThread.id}});assert.equal(disconnected,0,'course/skill watch notifications must not restart a learning session');assert(graph.isolated.has(graphThread.id));
  graph.receive({method:'mcpServer/startupStatus/updated',params:{name:'changed'}});assert.equal(disconnected,1);assert.equal(killed,1);assert.equal(graph.ready,null);assert.equal(graph.child,null);assert.equal(graph.isolated.size,0);assert.equal(graph.isolationPromise,null);assert.equal(resumed.size,0);assert.equal(freshThreads.size,0);
  graph.receive({method:'mcpServer/startupStatus/updated',params:{name:'changed'}});assert.equal(disconnected,1,'retired process notifications must not disconnect twice');graph.calls=[];await graph.newThread(undefined,'学习','explain',course);assert.equal(graph.calls.filter(x=>x.method==='config/read').length,1);assert.equal(graph.calls.filter(x=>x.method==='mcpServerStatus/list').length,1,'reopened runtime must reverify tools');
  const imported=new StubBridge();await imported.newThread(undefined,'学习','explain',course);let importDisconnected=0;imported.on('disconnected',()=>importDisconnected++);imported.receive({method:'externalAgentConfig/import/completed',params:{importId:'test'}});assert.equal(importDisconnected,1);assert.equal(imported.isolated.size,0);
  const metadata=new StubBridge();await Promise.all([metadata.status(),metadata.status()]);assert.equal(metadata.calls.filter(x=>x.method==='model/list').length,1);assert.equal(metadata.calls.filter(x=>x.method==='account/read').length,1,'concurrent reads deduplicate');metadata.calls=[];await metadata.status();await metadata.verifyAvatarModel();assert.deepEqual(metadata.calls.map(x=>x.method),['account/read'],'account is fresh, catalog/Avatar reuse bounded cache');
  metadata.account=null;assert.equal((await metadata.status()).authenticated,false,'cached catalog must not imply authentication');
  clock+=60001;metadata.catalogFailure=true;await assert.rejects(metadata.modelCatalog(),/metadata unavailable/);metadata.catalogFailure=false;metadata.calls=[];await metadata.modelCatalog();assert.deepEqual(metadata.calls.map(x=>x.method),['model/list'],'failed refresh must not leave a rejected cache');
  metadata.models=[terra];metadata.catalog=null;await assert.rejects(metadata.verifyAvatarModel(),error=>error.code==='AVATAR_MODEL_UNAVAILABLE');
  await bridge.newThread(undefined,'学习','explain',course);bridge.fail('test reconnect');assert.equal(bridge.isolated.size,0);assert.equal(bridge.isolationPromise,null);assert.equal(bridge.catalog,null);assert.equal(bridge.accountPromise,null);bridge.calls=[];await bridge.newThread(undefined,'学习','explain',course);assert.equal(bridge.calls.filter(x=>x.method==='config/read').length,1,'new process epoch must recheck config');
  const background=new StubBridge();await background.structuredTask({cwd:course,developerInstructions:'Return JSON only',text:'test',schema:{type:'object'}});assert.equal(background.calls.find(x=>x.method==='thread/start').params.config.web_search,'disabled','background avatar/classification tasks do not get web tools');
  // Check the actual installed binary, not just a duplicated list of expected flags.
  const flagsHome=path.join(root,'flags-home');await fs.mkdir(flagsHome);const binary=process.env.STUDY_CODEX_BIN||'/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';
  const {stdout}=await exec(binary,['features','list',...CLI_FEATURE_ARGS],{env:{...process.env,CODEX_HOME:flagsHome},timeout:15000,maxBuffer:50000});
  const actual=new Map(stdout.split('\n').filter(Boolean).map(line=>{const parts=line.trim().split(/\s+/);return [parts[0],parts.at(-1)]}));
  for(const name of DISABLED_FEATURES){assert(actual.has(name),name+' must exist in installed CLI');if(name!=='unified_exec')assert.equal(actual.get(name),'false',name);assert.equal(LEARNING_FEATURES[name],false);}
  for(const name of ENABLED_FEATURES){assert(actual.has(name),name+' must exist in installed CLI');assert.equal(actual.get(name),'true',name);}
  assert.deepEqual(REQUIRED_TRANSPORT_FEATURES,['code_mode_host']);assert.equal(LEARNING_FEATURES.code_mode_host,true,'client study tools need the bounded code-mode transport host');assert.equal(LEARNING_FEATURES.code_mode,false,'native coding mode remains off');assert.equal(LEARNING_FEATURES.shell_tool,false);assert.equal(LEARNING_FEATURES.unified_exec,false);
  // This CLI's `features list` normalizes unified_exec to true even though its
  // effective app-server configuration honors false; shell_tool is off as well.
  // Validate the app-server's actual effective values instead of hiding this edge.
  const native=new CodexBridge();
  try{await native.start();const read=await native.request('config/read',{includeLayers:true,cwd:process.cwd()});for(const name of DISABLED_FEATURES)assert.equal(read.config.features[name],false,'app-server effective '+name);for(const name of ENABLED_FEATURES)assert.equal(read.config.features[name],true,'app-server effective '+name);const policy=await native.isolationConfig();assert(policy.paths.length);const old=native.child,exited=new Promise(resolve=>old.once('exit',resolve));native.invalidateRuntime('restart check');await Promise.all([native.start(),exited]);assert(native.child&&native.child!==old);const restarted=await native.isolationConfig();assert(restarted.fingerprint!==policy.fingerprint,'old child exit must not clear new-process readiness');console.log('Native app-server policy: cacheable='+policy.cacheable+', effective native flags verified; unified_exec features-list normalization guarded by shell_tool=false.');}
  finally{native.child?.kill();}
  assert.equal(actual.get('enable_request_compression'),'true');assert.equal(actual.get('compaction_image_budget'),'true');assert.equal(actual.get('retain_client_tool_outputs'),'true');
  console.log(`Runtime checks passed: ${DISABLED_FEATURES.length} unused native features off, required custom-tool transport retained, skill discovery skipped, warm turn 3→1 CLI requests, config guards, per-thread verification, fresh auth, 60s catalog cache, reconnect invalidation and image-input transport.`);
}finally{await fs.rm(root,{recursive:true,force:true})}
