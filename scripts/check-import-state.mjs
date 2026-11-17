import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {LearningStore} from '../server/learning.mjs';
import {ImportOrganizer} from '../server/import-organizer.mjs';
const root=await fs.mkdtemp(path.join(os.tmpdir(),'study-import-state-'));
const course={id:'state-test',name:'整理状态测试'},store=new LearningStore({root});
const upload=name=>store.upload(course,{name,mime:'text/plain',data:Buffer.from('课程教材正文'),folder:'待整理'});
const success=async({attachments})=>({items:attachments.map(a=>({attachmentId:a.attachmentId,category:'教材',reason:'依据本文件已提取的教材正文。'}))});
try {
 await store.initCourse(course);
 const a=await upload('重试.txt');
 const org=new ImportOrganizer({store,classify:async()=>{throw Error('temporarily unavailable')}});
 const failed=await org.enqueue(course,[a.id]);await org.wait(course);
 assert.equal((await org.list(course)).pending[0].attachmentId,a.id);
 org.classify=success;
 const retry=await org.retry(course,failed.id);await org.wait(course);
 let state=await org.list(course);
 assert.equal(state.pending.length,0);assert.equal(state.active,false);
 assert.equal(state.jobs.find(j=>j.id===failed.id).status,'failed','original failure remains truthful history');
 await assert.rejects(org.retry(course,failed.id),/无需重试/);
 assert.equal(state.jobs.find(j=>j.id===retry.id).status,'completed');

 const b=await upload('部分甲.txt'),c=await upload('部分乙.txt');
 org.classify=async({attachments})=>({items:attachments.map(a=>({attachmentId:a.attachmentId,category:'其他资料',reason:'尚不能确认用途。'}))});
 const mixed=await org.enqueue(course,[b.id,c.id]);await org.wait(course);
 org.classify=success;
 await org.enqueue(course,[b.id]);await org.wait(course);
 state=await org.list(course);
 assert.deepEqual(state.pending.map(x=>x.attachmentId),[c.id],'later success supersedes only its own attachment');
 assert.equal(state.pending[0].jobId,mixed.id);assert.equal(state.pending[0].name,c.name);assert.ok(state.pending[0].sourceId);

 let release,entered;
 const started=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
 org.classify=async args=>{entered();await gate;return success(args)};
 const [one,two]=await Promise.all([org.retry(course,mixed.id),org.retry(course,mixed.id)]);
 assert.equal(one.id,two.id,'concurrent retries share one active job');
 await started;
 assert.deepEqual(one.attachmentIds,[c.id]);
 const third=await org.retry(course,mixed.id);assert.equal(third.id,one.id);
 assert.equal((await org.list(course)).active,true);
 release();await org.wait(course);assert.equal((await org.list(course)).pending.length,0);

 const d=await store.upload(course,{name:'数据.bin',mime:'application/octet-stream',data:Buffer.from([0,1,2]),folder:'待整理'});
 org.classify=success;
 const unreadable=await org.enqueue(course,[d.id]);await org.wait(course);
 let pending=(await org.list(course)).pending;
 assert.equal(pending.length,1);assert.match(pending[0].reason,/未能读取/);
 const current=await store.attachment(course,d.id),source=await store.sourceForPath(course,current.relativePath);
 await org.confirmSource(course,source.id);
 assert.equal((await org.list(course)).pending.length,0,'explicit same-folder category confirmation clears pending');
 assert.equal((await org.list(course)).jobs.find(j=>j.id===unreadable.id).status,'needs_review','manual resolution does not falsify model history');
 await fs.appendFile(current.absolutePath,Buffer.from([3]));
 assert.equal((await org.list(course)).pending.length,1,'changed file invalidates old confirmation');
 await org.confirmSource(course,source.id);

 const old=await upload('很早的待确认.txt');
 org.classify=async({attachments})=>({items:attachments.map(a=>({attachmentId:a.attachmentId,category:'其他资料',reason:'仍需用户判断。'}))});
 const oldJob=await org.enqueue(course,[old.id]);await org.wait(course);
 await store._mutate(course,s=>{for(let n=0;n<85;n++)s.importJobs.push({id:'history-'+n,attachmentIds:[a.id],status:'completed',items:[{attachmentId:a.id,status:'completed'}]})});
 state=await org.list(course);
 assert.equal(state.jobs.length,80);assert.ok(!state.jobs.some(j=>j.id===oldJob.id));
 assert.equal(state.pending.length,1);assert.equal(state.pending[0].jobId,oldJob.id,'aggregate uses complete history, independent of returned history window');

 const e=await upload('人工选择优先.txt');let releaseMove,enteredMove;
 const movedStarted=new Promise(r=>enteredMove=r),moveGate=new Promise(r=>releaseMove=r);
 org.classify=async args=>{enteredMove();await moveGate;return success(args)};
 await org.enqueue(course,[e.id]);await movedStarted;
 const eSource=await store.sourceForPath(course,e.relativePath);
 await store.moveSource(course,{sourceId:eSource.id,folder:'笔记'});await org.confirmSource(course,eSource.id);
 releaseMove();await org.wait(course);
 assert.equal((await store.attachment(course,e.id)).relativePath,'笔记/人工选择优先.txt','classifier cannot overwrite confirmed user choice');
 // Pause after the automatic confirmation check but before its move. A user
 // choosing the current folder must run after that entire atomic file change.
 const f=await upload('精确交错.txt'),fSource=await store.sourceForPath(course,f.relativePath);
 let unblockMove,enteredLockedMove;
 const lockedEntered=new Promise(r=>enteredLockedMove=r),lockedGate=new Promise(r=>unblockMove=r);
 const attachmentMethod=store.attachment.bind(store);
 let paused=false;
 store.attachment=async (selectedCourse,id)=>{
   const result=await attachmentMethod(selectedCourse,id);
   if(id===f.id&&org.fileChanges.has(course.id)&&!paused){paused=true;enteredLockedMove();await lockedGate;}
   return result;
 };
 org.classify=success;
 await org.enqueue(course,[f.id]);await lockedEntered;
 let manualFinished=false;
 const chosen=org.moveAndConfirmSource(course,{sourceId:fSource.id,folder:'待整理'}).then(value=>{manualFinished=true;return value});
 await new Promise(r=>setTimeout(r,10));assert.equal(manualFinished,false,'manual choice waits for automatic file transaction');
 unblockMove();await chosen;await org.wait(course);
 assert.equal((await store.attachment(course,f.id)).relativePath,'待整理/精确交错.txt','explicit same-folder choice survives the automatic move interleaving');
 assert.equal(org.fileChanges.size,0,'file queue drains');
 assert.ok((await store._load(course)).importConfirmations[f.id]);
 console.log('Import state passed: truthful history, latest-per-attachment, partial retry, concurrent retry deduplication, manual confirmation/file-version guard, >80 history, in-flight user choice and exact file-move serialization.');
}finally{await fs.rm(root,{recursive:true,force:true})}
