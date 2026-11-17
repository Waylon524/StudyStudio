import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LearningStore } from '../server/learning.mjs';

function pdf(pageCount){
  const fontId=3+pageCount*2,objects=[
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${Array.from({length:pageCount},(_,i)=>`${3+i*2} 0 R`).join(' ')}] /Count ${pageCount} >>`,
  ];
  for(let i=0;i<pageCount;i++){
    const content=`BT /F1 18 Tf 50 200 Td (Page ${i+1}) Tj ET\n`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 300] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${4+i*2} 0 R >>`,`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}endstream`);
  }
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  let data='%PDF-1.4\n';const offsets=[0];
  for(let i=0;i<objects.length;i++){offsets.push(Buffer.byteLength(data));data+=`${i+1} 0 obj\n${objects[i]}\nendobj\n`;}
  const start=Buffer.byteLength(data);
  data+=`xref\n0 ${offsets.length}\n0000000000 65535 f \n`+offsets.slice(1).map(x=>`${String(x).padStart(10,'0')} 00000 n \n`).join('')+`trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  return Buffer.from(data);
}

const root=await fs.mkdtemp(path.join(os.tmpdir(),'study-reading-position-'));
try{
  let store=new LearningStore({root});const course={id:'reading',name:'阅读测试'},other={id:'other',name:'另一门课'},base=await store.initCourse(course);
  const uploadedA=await store.upload(course,{name:'A.pdf',folder:'课件',data:pdf(3)}),uploadedB=await store.upload(course,{name:'B.pdf',folder:'课件',data:pdf(2)});
  const sources=await store.listSources(course),a=sources.find(x=>x.attachmentId===uploadedA.id),b=sources.find(x=>x.attachmentId===uploadedB.id);
  assert.equal((await store.setReader(course,{sourceId:a.id})).page,1);
  await store.setReader(course,{sourceId:a.id,page:2});
  await store.setReader(course,{sourceId:null});assert.equal(await store.getReader(course),null);
  assert.equal((await store.setReader(course,{sourceId:a.id})).page,2);
  assert.equal((await store.setReader(course,{sourceId:b.id})).page,1);
  await store.setReader(course,{sourceId:b.id,page:2});
  assert.equal((await store.setReader(course,{sourceId:a.id})).page,2);
  store=new LearningStore({root});assert.equal((await store.getReader(course)).page,2);
  await store.setReader(course,{sourceId:a.id,page:1});
  await store.setReader(course,{sourceId:b.id});assert.equal((await store.setReader(course,{sourceId:a.id})).page,1);
  assert.equal((await store.setReader(course,{sourceId:b.id})).page,2);
  await store.setReader(course,{sourceId:a.id,page:3});
  await fs.rename(path.join(base,a.relativePath),path.join(base,'课件/重命名.pdf'));
  const renamed=(await store.listSources(course)).find(x=>x.id===a.id);assert.equal(renamed.name,'重命名.pdf');
  assert.equal((await store.setReader(course,{sourceId:a.id})).page,3);
  const moved=await store.moveSource(course,{sourceId:a.id,folder:'课件/章节'});assert.equal(moved.id,a.id);
  assert.equal((await store.setReader(course,{sourceId:a.id})).page,3);
  await fs.writeFile(path.join(base,moved.relativePath),pdf(1));
  const shortened=await store.getReader(course);assert.equal(shortened.page,1);assert.equal(shortened.pages,1);
  await assert.rejects(store.resolveReader(course,{sourceId:a.id,page:2}),/页码超出/);
  await store.setReader(course,{sourceId:null});assert.equal((await store.setReader(course,{sourceId:a.id})).page,1);
  for(const page of [0,-1,1.5,null,'1',NaN])await assert.rejects(store.setReader(course,{sourceId:b.id,page}),/页码无效/);
  await assert.rejects(store.setReader(course,{sourceId:b.id,page:3}),/页码超出/);
  await store.initCourse(other);await assert.rejects(store.setReader(other,{sourceId:b.id}),/课件不存在/);
  await assert.rejects(store.getReader({...course,id:'wrong-course'}),/另一课程/);
  await store.setReader(course,{sourceId:b.id,page:2});
  const replacement=path.join(base,'课件/replacement.pdf');await fs.writeFile(replacement,pdf(2));await fs.rename(replacement,path.join(base,b.relativePath));
  assert.equal(await store.getReader(course),null);
  const replaced=(await store.listSources(course)).find(x=>x.relativePath===b.relativePath);assert.notEqual(replaced.id,b.id);
  assert.equal((await store.setReader(course,{sourceId:replaced.id})).page,1);
  const state=JSON.parse(await fs.readFile(path.join(base,'.study-studio/state.json'),'utf8'));
  assert.deepEqual(state.readingPositions[a.id],{page:1});assert.deepEqual(state.readingPositions[b.id],{page:2});assert.deepEqual(state.readingPositions[replaced.id],{page:1});
  console.log('Reading positions passed: close/reopen, per-PDF pages, restart, exact jumps, stable rename/move, shorter PDFs, replacement identity and course isolation.');
}finally{await fs.rm(root,{recursive:true,force:true});}
