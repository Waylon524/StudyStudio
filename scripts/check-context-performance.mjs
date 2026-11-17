import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {performance} from 'node:perf_hooks';
import {LearningStore} from '../server/learning.mjs';

const root=await fs.mkdtemp(path.join(os.tmpdir(),'study-context-check-'));
const course={id:'context-check',name:'上下文测试'};
class ObservedStore extends LearningStore{
  writes=0;instructionReads=0;scansCount=0;
  async _save(...args){this.writes++;return super._save(...args)}
  async readInstructions(...args){this.instructionReads++;return super.readInstructions(...args)}
  async _scanWorkspace(...args){this.scansCount++;return super._scanWorkspace(...args)}
}
const previousPython=process.env.STUDY_EXTRACT_PYTHON;
try{
  const store=new ObservedStore({root}),base=await store.initCourse(course);
  const marker=path.join(root,'python-was-launched');
  const fakePython=path.join(root,'not-needed-python');
  await fs.writeFile(fakePython,`#!/bin/sh\ntouch '${marker}'\nexit 1\n`,{mode:0o700});process.env.STUDY_EXTRACT_PYTHON=fakePython;
  await fs.writeFile(path.join(base,'AGENTS.md'),'原有说明：讲解时先给直觉。');
  const block='<!-- STUDY-STUDIO REQUIREMENTS START -->\n'+('只在完整历史中保留的旧更正。'.repeat(2500))+'\n<!-- STUDY-STUDIO REQUIREMENTS END -->';
  await fs.writeFile(path.join(base,'课程重要信息.md'),'手写前记：教师强调来源。\n'+block+'\n手写后记：实验报告需要原始记录。');
  const set=await store.registerSet(course,{threadId:'thread',itemId:'q1',spec:{items:[{id:'short',type:'short_answer',prompt:'说明物质与能量的方向。',answer:'参考答案',rubric:'说明循环与单向流动。'}]}});
  const answer='完整真实回答：物质可以循环，能量单向流动。'+('不能把猜中当作掌握。'.repeat(150));
  await store.submitAttempt(course,{questionId:set.items[0].id,answer,hintUsed:true});
  const sourceFile=path.join(base,'资料.txt');await fs.writeFile(sourceFile,'\ufeff原始课程资料。');
  await store.listSources(course);store.writes=0;store.instructionReads=0;store.scansCount=0;
  const snapshot=await store.contextSnapshot(course);
  assert.equal(store.instructionReads,1);assert.equal(store.scansCount,1);assert.equal(store.writes,0);
  assert(snapshot.coursePolicy.includes('原有说明'));assert(!snapshot.context.includes('原有说明'));
  assert(snapshot.context.includes('手写前记'));assert(snapshot.context.includes('手写后记'));assert(!snapshot.context.includes('只在完整历史'));
  assert(snapshot.context.includes(answer));assert(snapshot.context.includes('"hintUsed":true'));assert(snapshot.context.includes('参考答案'));assert(snapshot.context.includes('循环与单向流动'));
  assert((await fs.readFile(path.join(base,'课程重要信息.md'),'utf8')).includes('只在完整历史'));
  const first=snapshot.files.find(file=>file.name==='资料.txt');assert(first);
  await fs.writeFile(path.join(base,'AGENTS.md'),'更新说明：先检查独立作答。');
  assert((await store.contextSnapshot(course)).coursePolicy.includes('更新说明'));
  const plain=await store.readFile(course,'资料.txt');assert.equal(plain.text,'原始课程资料。');
  await store.learning(course);await assert.rejects(fs.access(marker));
  await fs.writeFile(path.join(base,'长文本.md'),'水'.repeat(100001));const long=await store.readFile(course,'长文本.md');assert.equal(long.text.length,100000);assert.equal(long.truncated,true);
  await fs.rename(sourceFile,path.join(base,'改名资料.txt'));const moved=(await store.contextSnapshot(course)).files.find(file=>file.name==='改名资料.txt');assert.equal(moved.id,first.id);
  await fs.symlink('/etc',path.join(base,'逃逸'));await assert.rejects(store.workspaceRead(course,'逃逸/passwd'));
  const validScan=store.scanWorkspace(course);await assert.rejects(store.scanWorkspace({id:'other-course',name:course.name}));await validScan;
  await fs.writeFile(path.join(base,'AGENTS.md'),'\ufeff带 BOM 的原文。');const bom=await store.readInstructions(course);assert(bom.content.startsWith('\ufeff'));await store.updateInstructions(course,{content:bom.content+'\n新的内容。',version:bom.version});
  await fs.rm(path.join(base,'课程重要信息.md'));await store.addCourseNote(course,{text:'缺失模板可恢复。',source:'本轮用户'});assert((await store.learning(course)).importantInfo.includes('缺失模板可恢复'));
  store.scansCount=0;await Promise.all([store.listSources(course),store.listFolders(course)]);assert.equal(store.scansCount,1);
  console.log('Context: fresh policy, single scan/read, intact learner evidence, native text, no unchanged writes, source identity and containment passed.');
  const samples=[];for(let i=0;i<4;i++){const start=performance.now();await store.contextSnapshot(course);samples.push(performance.now()-start)}
  console.log('Small-course context snapshot median ms:',samples.sort((a,b)=>a-b)[Math.floor(samples.length/2)].toFixed(2));
}finally{if(previousPython===undefined)delete process.env.STUDY_EXTRACT_PYTHON;else process.env.STUDY_EXTRACT_PYTHON=previousPython;await fs.rm(root,{recursive:true,force:true})}
