import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LearningStore } from '../server/learning.mjs';
import { pdfPage } from '../server/pdf-reader.mjs';
import { createPageAccess } from '../server/lazy-pdf.mjs';

function twoPagePdf(){
  const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 300] /Resources << /Font << /F1 7 0 R >> >> /Contents 4 0 R >>','<< /Length 43 >>\nstream\nBT /F1 18 Tf 50 200 Td (First page) Tj ET\nendstream','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 300] /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>','<< /Length 44 >>\nstream\nBT /F1 18 Tf 50 200 Td (Second page) Tj ET\nendstream','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  let data='%PDF-1.4\n',offsets=[0];for(let i=0;i<objects.length;i++){offsets.push(Buffer.byteLength(data));data+=`${i+1} 0 obj\n${objects[i]}\nendobj\n`;}const start=Buffer.byteLength(data);data+=`xref\n0 ${offsets.length}\n0000000000 65535 f \n`+offsets.slice(1).map(x=>`${String(x).padStart(10,'0')} 00000 n \n`).join('')+`trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;return Buffer.from(data);
}
const root=await fs.mkdtemp(path.join(os.tmpdir(),'study-v4-check-'));
try{
  const store=new LearningStore({root}),course={id:'v4',name:'测试课程'},base=await store.initCourse(course);
  const a=await store.upload(course,{name:'lecture.pdf',folder:'课件/第一章',mime:'application/pdf',data:twoPagePdf()});
  const b=await store.upload(course,{name:'lecture.pdf',folder:'课件/第一章',mime:'application/pdf',data:twoPagePdf()});
  assert.equal(a.relativePath,'课件/第一章/lecture.pdf');assert.equal(b.relativePath,'课件/第一章/lecture (1).pdf');
  await assert.rejects(store.upload(course,{name:'x.txt',folder:'../外部',data:Buffer.from('x')}));
  await fs.symlink('/tmp',path.join(base,'跳转'));await assert.rejects(store.upload(course,{name:'x.txt',folder:'跳转',data:Buffer.from('x')}));
  let sources=await store.listSources(course);const original=sources.find(x=>x.attachmentId===a.id);assert.equal(original.kind,'courseware');assert.equal(original.folder,'课件/第一章');assert.equal(original.name,'lecture.pdf');
  await store.selectSources(course,sources.filter(x=>x.id!==original.id).map(x=>x.id));
  await fs.rename(path.join(base,a.relativePath),path.join(base,'课件/第一章/更名.pdf'));
  sources=await store.listSources(course);const renamed=sources.find(x=>x.id===original.id);assert.equal(renamed.name,'更名.pdf');assert.equal(renamed.selected,false);assert((await store.attachment(course,a.id)).relativePath.endsWith('更名.pdf'));
  const moved=await store.moveSource(course,{sourceId:original.id,folder:'课件/第二章'});assert.equal(moved.id,original.id);assert.equal(moved.selected,false);assert.equal(moved.folder,'课件/第二章');assert.equal((await store.attachment(course,a.id)).relativePath,moved.relativePath);
  assert.equal((await store.workspaceRead(course,moved.relativePath)).sourceId,original.id);
  const unselectedReader=await store.setReader(course,{sourceId:original.id,page:1});assert.equal(unselectedReader.page,1);
  sources=await store.listSources(course);await store.selectSources(course,sources.map(x=>x.id));
  const reader=await store.setReader(course,{sourceId:original.id,page:2});assert.equal(reader.pages,2);assert.equal((await store.getReader(course)).source.id,original.id);
  await assert.rejects(store.setReader(course,{sourceId:original.id,page:3}));
  const rendered=await pdfPage(await store.safePath(course,moved.relativePath),2,await store.safePath(course,'.study-studio'));assert(rendered.text.includes('Second page'));assert(rendered.imagePath);await fs.rm(rendered.tempDir,{recursive:true,force:true});
  const snapshot=await store.resolveReader(course,{sourceId:original.id,page:1});let calls=0,observedPage;
  const access=createPageAccess(store,course,snapshot,{render:async(file,page,cache)=>{calls++;observedPage=page;const tempDir=await fs.mkdtemp(path.join(cache,'test-'));return {page,pages:2,text:'only after read',imagePath:null,tempDir,warnings:[]}}});
  await store.setReader(course,{sourceId:original.id,page:2});assert.equal(calls,0);assert.equal((await access.read()).text,'only after read');assert.equal(calls,1);assert.equal(observedPage,1);await access.read();assert.equal(calls,1);await access.close();
  await store.makeFolder(course,'深/一/二/三/四/五/六/七');await fs.writeFile(path.join(base,'深/一/二/三/四/五/六/七/深处.txt'),'深层资料');assert.equal((await store.workspaceRead(course,'深/一/二/三/四/五/六/七/深处.txt')).text,'深层资料');
  await store.makeFolder(course,'分页');await Promise.all(Array.from({length:205},(_,i)=>fs.writeFile(path.join(base,'分页',String(i).padStart(3,'0')+'.txt'),'x')));const first=await store.listWorkspace(course,{path:'分页',limit:100});const second=await store.listWorkspace(course,{path:'分页',offset:first.nextOffset,limit:200});assert.equal(first.hasMore,true);assert.equal(first.files.length,100);assert.equal(second.files.length,105);assert.equal(second.hasMore,false);
  await store.setReader(course,{sourceId:null});assert.equal(await store.getReader(course),null);
  console.log('V4 folders, collision protection, stable IDs, rename/move, selection, reader and PDF page passed.');
}finally{await fs.rm(root,{recursive:true,force:true})}
