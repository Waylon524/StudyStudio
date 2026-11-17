import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LearningStore } from '../server/learning.mjs';
import { ImportOrganizer } from '../server/import-organizer.mjs';

const root=await fs.mkdtemp(path.join(os.tmpdir(),'study-import-check-'));
const course={id:'imports-test',name:'资料整理测试'};
const store=new LearningStore({root});
const upload=(name,text,folder='待整理')=>store.upload(course,{name,mime:'text/plain',data:Buffer.from(text),folder});
try {
  await store.initCourse(course);
  const source=await upload('课程安排.txt','课程安排：本学期共十六周，平时成绩占百分之三十。');
  const before=await store.sourceForPath(course,source.relativePath);
  const updates=[];
  const organizer=new ImportOrganizer({store,onUpdate:(_,job)=>updates.push(job.status),classify:async({attachments})=>{
    assert.match(attachments[0].text,/课程安排/);
    assert(attachments[0].absolutePath.startsWith(root));
    return {items:attachments.map(a=>({attachmentId:a.attachmentId,category:'课程说明',reason:'内容为课程安排和成绩组成。'}))};
  }});
  const queued=await organizer.enqueue(course,[source.id]);
  assert.equal(queued.status,'queued');
  await organizer.wait(course);
  let listed=await organizer.list(course),job=listed.jobs.find(j=>j.id===queued.id);
  assert.equal(job.status,'completed');assert.equal(listed.active,false);
  const moved=await store.attachment(course,source.id);
  assert.equal(moved.relativePath,'课程说明/课程安排.txt');
  assert.equal((await store.sourceForPath(course,moved.relativePath)).id,before.id);
  await assert.rejects(fs.stat(await store.safePath(course,'待整理')),{code:'ENOENT'});
  assert.deepEqual(await fs.readFile(moved.absolutePath),Buffer.from('课程安排：本学期共十六周，平时成绩占百分之三十。'));
  assert(updates.includes('running') && updates.includes('completed'));

  const nested=await upload('题目.txt','作业一：请完成教材第三章的所有课后题。','待整理/老师资料/第一周');
  const nestedOrg=new ImportOrganizer({store,classify:async({attachments})=>({items:attachments.map(a=>({attachmentId:a.attachmentId,category:'作业',reason:'包含明确的作业题目。'}))})});
  await nestedOrg.enqueue(course,[nested.id]);await nestedOrg.wait(course);
  assert.equal((await store.attachment(course,nested.id)).relativePath,'作业/老师资料/第一周/题目.txt');

  const bad=await upload('保留.txt','这份材料有一些普通的课程内容。');
  const invalid=new ImportOrganizer({store,classify:async({attachments})=>({items:[{attachmentId:attachments[0].attachmentId,category:'../../逃逸',reason:'无效分类'}]})});
  const invalidJob=await invalid.enqueue(course,[bad.id]);await invalid.wait(course);
  assert.equal((await invalid.list(course)).jobs.find(j=>j.id===invalidJob.id).status,'failed');
  assert.equal((await store.attachment(course,bad.id)).relativePath,bad.relativePath);

  const foreign=new ImportOrganizer({store,classify:async()=>({items:[{attachmentId:'not-in-this-job',category:'教材',reason:'不属于本任务。'}]})});
  const foreignJob=await foreign.enqueue(course,[bad.id]);await foreign.wait(course);
  assert.equal((await foreign.list(course)).jobs.find(j=>j.id===foreignJob.id).status,'failed');
  assert.equal((await store.attachment(course,bad.id)).relativePath,bad.relativePath);

  const fail=new ImportOrganizer({store,classify:async()=>{throw Error('模型暂时不可用');}});
  const failed=await fail.enqueue(course,[bad.id]);await fail.wait(course);
  assert.equal((await fail.list(course)).jobs.find(j=>j.id===failed.id).status,'failed');
  assert.equal((await store.attachment(course,bad.id)).relativePath,bad.relativePath);
  fail.classify=async({attachments})=>({items:attachments.map(a=>({attachmentId:a.attachmentId,category:'笔记',reason:'课程笔记。'}))});
  const retry=await fail.retry(course,failed.id);await fail.wait(course);
  assert.equal((await fail.list(course)).jobs.find(j=>j.id===retry.id).status,'completed');
  await assert.rejects(fail.retry(course,retry.id),/无需重试/);

  const unreadable=await store.upload(course,{name:'原始数据.bin',mime:'application/octet-stream',folder:'待整理',data:Buffer.from([0,1,2,3])});
  const uncertain=new ImportOrganizer({store,classify:async({attachments})=>({items:attachments.map(a=>({attachmentId:a.attachmentId,category:'教材',reason:'仅凭文件名猜测。'}))})});
  const uncertainJob=await uncertain.enqueue(course,[unreadable.id]);await uncertain.wait(course);
  const uncertainResult=(await uncertain.list(course)).jobs.find(j=>j.id===uncertainJob.id);
  assert.equal(uncertainResult.status,'needs_review');assert.equal(uncertainResult.items[0].category,'其他资料');
  assert.equal((await store.attachment(course,unreadable.id)).relativePath,'其他资料/原始数据.bin');

  const visuallyRead=await store.upload(course,{name:'扫描讲义.pdf',mime:'application/pdf',folder:'待整理',data:Buffer.from('%PDF-1.4\n%fixture')});
  const visual=new ImportOrganizer({store,classify:async({attachments})=>({items:attachments.map(a=>({attachmentId:a.attachmentId,category:'课件',reason:'已查看讲义页面内容。'})),inspectedAttachmentIds:attachments.map(a=>a.attachmentId)})});
  const visualJob=await visual.enqueue(course,[visuallyRead.id]);await visual.wait(course);
  assert.equal((await visual.list(course)).jobs.find(j=>j.id===visualJob.id).status,'completed');
  assert.equal((await store.attachment(course,visuallyRead.id)).relativePath,'课件/扫描讲义.pdf');

  let active=0,maxActive=0;
  const serial=new ImportOrganizer({store,classify:async({attachments})=>{
    active++;maxActive=Math.max(maxActive,active);await new Promise(resolve=>setTimeout(resolve,15));active--;
    return {items:attachments.map(a=>({attachmentId:a.attachmentId,category:'笔记',reason:'包含笔记内容。'}))};
  }});
  const a=await upload('串行一.txt','第一份课堂笔记，讨论概率分布。'),b=await upload('串行二.txt','第二份课堂笔记，讨论随机过程。');
  await Promise.all([serial.enqueue(course,[a.id]),serial.enqueue(course,[b.id])]);await serial.wait(course);
  assert.equal(maxActive,1);

  const edited=await upload('已整理.txt','这一份笔记最初在待整理目录。');
  const changing=new ImportOrganizer({store,classify:async({attachments})=>{
    const original=attachments[0],current=await store.sourceForPath(course,original.relativePath);
    await store.moveSource(course,{sourceId:current.id,folder:'用户手动分类'});
    return {items:[{attachmentId:original.attachmentId,category:'教材',reason:'包含教材正文。'}]};
  }});
  const changedJob=await changing.enqueue(course,[edited.id]);await changing.wait(course);
  assert.equal((await changing.list(course)).jobs.find(j=>j.id===changedJob.id).status,'needs_review');
  assert.equal((await store.attachment(course,edited.id)).relativePath,'用户手动分类/已整理.txt');

  const recoverable=await upload('恢复.txt','可以恢复的课程讲义内容。');
  await store._mutate(course,state=>{state.importJobs.push({id:'interrupted-job',attachmentIds:[recoverable.id],status:'running',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),items:[]});});
  const recovery=new ImportOrganizer({store,classify:async({attachments})=>({items:attachments.map(a=>({attachmentId:a.attachmentId,category:'课件',reason:'课程讲义。'}))})});
  await recovery.recover(course);await recovery.wait(course);
  assert.equal((await recovery.list(course)).jobs.find(j=>j.id==='interrupted-job').status,'completed');

  const bulk=[];
  for(let i=0;i<9;i++)bulk.push(await upload(`批量${i}.txt`,`批量资料${i}：`+'正文'.repeat(6000)));
  const batches=[];
  const chunked=new ImportOrganizer({store,classify:async({attachments})=>{
    assert(attachments.length<=6);assert(attachments.reduce((n,a)=>n+a.text.length,0)<=48000);
    for(const a of attachments){assert(a.text.length>9000);assert.equal(a.contentAvailable,true);}
    batches.push(attachments.map(a=>a.attachmentId));
    return {items:attachments.map(a=>({attachmentId:a.attachmentId,category:'笔记',reason:'已读取本文件的笔记正文。'}))};
  }});
  const bulkJob=await chunked.enqueue(course,bulk.map(a=>a.id));await chunked.wait(course);
  assert.equal(batches.length,3);assert.equal(batches.flat().length,bulk.length);
  assert.equal((await chunked.list(course)).jobs.find(j=>j.id===bulkJob.id).status,'completed');

  const unviewedImage=await store.upload(course,{name:'未查看.png',mime:'image/png',folder:'待整理',data:Buffer.from([137,80,78,71,13,10,26,10])});
  const imageOrg=new ImportOrganizer({store,classify:async({attachments})=>({items:attachments.map(a=>({attachmentId:a.attachmentId,category:'图片',reason:'仅凭扩展名猜测。'}))})});
  const imageJob=await imageOrg.enqueue(course,[unviewedImage.id]);await imageOrg.wait(course);
  assert.equal((await imageOrg.list(course)).jobs.find(j=>j.id===imageJob.id).status,'needs_review');

  const missingPartial=await upload('部分失败后尚未处理.txt','尚未处理的课堂笔记。');
  await store._mutate(course,state=>state.importJobs.push({id:'partially-failed',attachmentIds:[a.id,missingPartial.id],status:'failed',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),items:[{attachmentId:a.id,status:'completed',category:'笔记'}]}));
  const partial=new ImportOrganizer({store,classify:async({attachments})=>{
    assert.deepEqual(attachments.map(x=>x.attachmentId),[missingPartial.id]);
    return {items:attachments.map(x=>({attachmentId:x.attachmentId,category:'笔记',reason:'未处理的笔记。'}))};
  }});
  const partialRetry=await partial.retry(course,'partially-failed');await partial.wait(course);
  assert.equal((await partial.list(course)).jobs.find(j=>j.id===partialRetry.id).status,'completed');

  // Duplicate basenames retain both files and source IDs after collision handling.
  const first=await upload('同名.txt','第一份课程说明。','待整理/甲'),second=await upload('同名.txt','第二份课程说明。','待整理/乙');
  const firstSource=await store.sourceForPath(course,first.relativePath),secondSource=await store.sourceForPath(course,second.relativePath);
  await store.moveSource(course,{sourceId:firstSource.id,folder:'课程说明'});
  await store.moveSource(course,{sourceId:secondSource.id,folder:'课程说明'});
  const firstNow=await store.attachment(course,first.id),secondNow=await store.attachment(course,second.id);
  assert.notEqual(firstNow.relativePath,secondNow.relativePath);
  assert.equal((await store.sourceForPath(course,secondNow.relativePath)).id,secondSource.id);
  assert.equal(await fs.readFile(firstNow.absolutePath,'utf8'),'第一份课程说明。');
  assert.equal(await fs.readFile(secondNow.absolutePath,'utf8'),'第二份课程说明。');
  console.log('Import organizer: semantic classification, stable citations, hierarchy, serial jobs, evidence fallback, safe failures, retry/recovery, user changes and collisions passed.');
} finally { await fs.rm(root,{recursive:true,force:true}); }
