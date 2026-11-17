import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {LearningStore} from '../server/learning.mjs';
import {CourseAvatars,validateCourseAvatar} from '../server/course-avatar.mjs';
import {CodexBridge} from '../server/codex.mjs';
const icon={elements:[{type:'path',d:'M8 24 C8 12 16 6 26 8 C40 9 42 20 38 32 C32 44 12 42 8 24 Z'},{type:'circle',cx:24,cy:23,r:7},{type:'path',d:'M12 27 Q16 24 18 29'},{type:'ellipse',cx:31,cy:34,rx:4,ry:2}]};
assert.deepEqual(validateCourseAvatar(icon),icon);
for(const bad of [
 {elements:[{type:'path',d:'M4 4 <script>alert(1)</script>'}]},
 {elements:[{type:'path',d:'M4 4 L999 8'}]},
 {elements:[{type:'path',d:'M4 4 L-1 8'}]},
 {elements:[{type:'path',d:'M4 4 C10 10 20'}]},
 {elements:[{type:'path',d:'M4 4Z 10 10'}]},
 {elements:[{type:'path',d:'M4 4L8 8',onload:'alert(1)'}]},
 {elements:[{type:'image',href:'https://example.com/'}]},
 {elements:[{type:'circle',cx:NaN,cy:24,r:5}]},
 {elements:[{type:'circle',cx:46,cy:24,r:5}]},
 {elements:[{type:'polyline',points:[[1,2],[3,100]]}]},
 {elements:[{type:'circle',cx:24,cy:24,r:2}],svg:'<svg/>'},
])assert.throws(()=>validateCourseAvatar(bad));
const root=await fs.mkdtemp(path.join(os.tmpdir(),'study-avatar-check-'));
try{
 const store=new LearningStore({root}),course={id:'cells',name:'细胞生物学'};let calls=0,finish;
 const avatars=new CourseAvatars({store,generate:async({courseName,cwd})=>{calls++;assert.equal(courseName,course.name);assert.equal(cwd,store.coursePath(course));return await new Promise(resolve=>{finish=resolve})}});
 const responses=await Promise.all(Array.from({length:8},()=>avatars.ensure(course)));assert(responses.every(a=>a.status==='pending'));assert.equal(calls,1);finish(icon);const ready=await avatars.wait(course);assert.equal(ready.status,'ready');assert.deepEqual(ready.icon,icon);
 const another=new CourseAvatars({store,generate:()=>{throw Error('should not generate again')}});assert.equal((await another.ensure(course)).status,'ready');assert.equal(calls,1);
 const updatedIcon={elements:[{type:'circle',cx:24,cy:24,r:18},{type:'ellipse',cx:25,cy:23,rx:7,ry:5}]};
 const beforeRequestId=ready.requestId;const regeneration=await Promise.all(Array.from({length:6},()=>avatars.regenerate(course)));assert(regeneration.every(a=>a.status==='pending'));assert.equal(calls,2);assert(regeneration.every(a=>a.requestId!==beforeRequestId));assert(regeneration.every(a=>JSON.stringify(a.icon)===JSON.stringify(icon)));finish(updatedIcon);const replaced=await avatars.wait(course);assert.equal(replaced.status,'ready');assert.equal(replaced.model,'gpt-6-astra');assert.equal(replaced.effort,'high');assert.deepEqual(replaced.icon,updatedIcon);
 const failure=new CourseAvatars({store,generate:async()=>{throw Error('temporary failure')}});assert.deepEqual((await failure.regenerate(course)).icon,updatedIcon);const retained=await failure.wait(course);assert.equal(retained.status,'failed');assert.deepEqual(retained.icon,updatedIcon);assert.equal((await failure.ensure(course)).status,'failed');
 const recoverIcon=new CourseAvatars({store,generate:async()=>icon});await recoverIcon.regenerate(course);assert.equal((await recoverIcon.wait(course)).status,'ready');
 let finishOld;const stale=new CourseAvatars({store,generate:()=>new Promise(resolve=>{finishOld=resolve})});const stalePending=await stale.regenerate(course);await store._mutate(course,s=>{s.avatar={...s.avatar,status:'ready',requestId:'newer-request',icon:updatedIcon}});finishOld(icon);assert.deepEqual((await stale.wait(course)).icon,updatedIcon);assert.notEqual((await stale.ensure(course)).requestId,stalePending.requestId);
 const bridge=new CodexBridge();bridge.start=async()=>{};bridge.request=async()=>({data:[{model:'gpt-6-astra',supportedReasoningEfforts:[{reasoningEffort:'high'}]}]});await bridge.verifyAvatarModel();let config;bridge.structuredTask=async options=>{config=options;return icon};await bridge.generateCourseAvatar({courseName:'细胞生物学'});assert.equal(config.model,'gpt-6-astra');assert.equal(config.effort,'high');bridge.catalog=null;bridge.request=async()=>({data:[{model:'gpt-6.1-terra',supportedReasoningEfforts:[{reasoningEffort:'high'}]}]});await assert.rejects(bridge.verifyAvatarModel(),e=>e.code==='AVATAR_MODEL_UNAVAILABLE');
 let overlapCalls=0;const overlap=new CourseAvatars({store,generate:async()=>{overlapCalls++;return updatedIcon}});await Promise.all([overlap.ensure(course),overlap.regenerate(course)]);await overlap.wait(course);assert.equal(overlapCalls,1,'regeneration must not be swallowed by a concurrent cached GET');
 const invalid={id:'bad',name:'无效测试'};let failures=0;const bad=new CourseAvatars({store,generate:async()=>{failures++;return {elements:[{type:'path',d:'javascript:alert(1)'}]}}});await bad.ensure(invalid);assert.equal((await bad.wait(invalid)).status,'failed');await bad.ensure(invalid);assert.equal(failures,1);
 const restart={id:'restart',name:'重启测试'};await store._mutate(restart,s=>{s.avatar={status:'pending',createdAt:'2026-11-13T00:00:00Z'}});const restarted=new CourseAvatars({store,generate:async()=>icon});assert.equal((await restarted.ensure(restart)).status,'pending');assert.equal((await restarted.wait(restart)).status,'ready');
 console.log('Course avatars: bounded vector validation, injection rejection, concurrent deduplication, persistent cache, regeneration preservation/deduplication, stale request protection, explicit Astra High/no fallback, restart recovery and failure retention passed.');
}finally{await fs.rm(root,{recursive:true,force:true})}
