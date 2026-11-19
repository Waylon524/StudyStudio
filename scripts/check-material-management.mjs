import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {LearningStore} from '../server/learning.mjs';
import {ImportOrganizer} from '../server/import-organizer.mjs';
import {PdfAnnotations} from '../server/pdf-annotations.mjs';

const root=await fs.mkdtemp(path.join(os.tmpdir(),'study-material-mgmt-'));
const course={id:'mgmt-course',name:'资料管理测试'};
const archivedCourse={id:'archived-course',name:'未初始化归档课程',archivedAt:'2026-01-01T00:00:00.000Z'};
const store=new LearningStore({root});
const pdfAnnotations=new PdfAnnotations({store});
const minimalPdf=Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Count 1/Kids[3 0 R]>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\nxref\n0 4\n0000000000 65535 f \n0000000009 00000 n \n0000000054 00000 n \n0000000105 00000 n \ntrailer<</Size 4/Root 1 0 R>>\nstartxref\n169\n%%EOF\n');

try {
  await store.initCourse(course);
  const org=new ImportOrganizer({store,classify:async({attachments})=>({items:attachments.map(a=>({attachmentId:a.attachmentId,category:'教材',reason:'测试'}))})});

  // 1. Upload courseware PDF and regular materials
  const slideAttachment=await store.upload(course,{name:'chapter1.pdf',mime:'application/pdf',data:minimalPdf,intent:'courseware'});
  const noteAttachment=await store.upload(course,{name:'notes.md',mime:'text/markdown',data:Buffer.from('# 第一章笔记'),folder:'笔记'});
  const pdfMaterialAttachment=await store.upload(course,{name:'handout.pdf',mime:'application/pdf',data:minimalPdf,folder:'教材'});
  const fakePdfAttachment=await store.upload(course,{name:'fake.pdf',mime:'application/pdf',data:Buffer.from('not really a pdf'),folder:'教材'});

  let sources=await store.listSources(course);
  assert.equal(sources.length,4);
  const slide=sources.find(s=>s.attachmentId===slideAttachment.id);
  const note=sources.find(s=>s.attachmentId===noteAttachment.id);
  const pdfMaterial=sources.find(s=>s.attachmentId===pdfMaterialAttachment.id);
  const fakePdf=sources.find(s=>s.attachmentId===fakePdfAttachment.id);
  assert.equal(slide.kind,'courseware');
  assert.ok(slide.modifiedAt,'source includes modifiedAt timestamp');
  assert.ok(slide.uploadedAt,'source includes uploadedAt timestamp');

  // 2. Course stats check (active + readonly archived without creating folder)
  let stats=await store.courseStats(course);
  assert.equal(stats.coursewareCount,1);
  assert.equal(stats.materialCount,3);
  assert.equal(stats.fileCount,4);
  assert.ok(stats.totalBytes>0);

  const archivedStats=await store.courseStats(archivedCourse,{readonly:true});
  assert.equal(archivedStats.fileCount,0);
  await assert.rejects(fs.lstat(store.coursePath(archivedCourse)),{code:'ENOENT'});

  // 3. Rename source preserves sourceId, blocks collisions, enforces .pdf on courseware, supports case-only rename
  const renamedSlide=await org.renameSource(course,{sourceId:slide.id,name:'Lecture 01.pdf'});
  assert.equal(renamedSlide.id,slide.id,'rename preserves sourceId');
  assert.equal(renamedSlide.name,'Lecture 01.pdf');
  assert.equal(renamedSlide.relativePath,'课件/Lecture 01.pdf');

  // Case-only rename on case-insensitive FS
  const caseRenamed=await org.renameSource(course,{sourceId:slide.id,name:'lecture 01.pdf'});
  assert.equal(caseRenamed.id,slide.id);
  assert.equal(caseRenamed.name,'lecture 01.pdf');

  // Reject removing .pdf suffix from courseware PDF
  await assert.rejects(org.renameSource(course,{sourceId:slide.id,name:'lecture 01.txt'}),/保留 \.pdf/);

  // Reject collision with existing file
  await assert.rejects(org.renameSource(course,{sourceId:pdfMaterial.id,name:'fake.pdf'}),/已存在同名文件/);

  // Reject invalid/traversal/reserved names
  await assert.rejects(org.renameSource(course,{sourceId:note.id,name:'../escape.md'}),/名称无效/);
  await assert.rejects(org.renameSource(course,{sourceId:note.id,name:'.hidden'}),/名称无效/);
  await store.moveSource(course,{sourceId:note.id,folder:''});
  await assert.rejects(org.renameSource(course,{sourceId:note.id,name:'AGENTS.md'}),/系统保留/);
  await store.moveSource(course,{sourceId:note.id,folder:'笔记'});

  // 4. Batch move with requirePdf validation
  await assert.rejects(org.moveAndConfirmSources(course,{sourceIds:[fakePdf.id],folder:'课件',requirePdf:true}),/不是可识别的 PDF/);
  const promoted=await org.moveAndConfirmSources(course,{sourceIds:[pdfMaterial.id],folder:'课件',requirePdf:true});
  assert.equal(promoted.sources[0].kind,'courseware');
  assert.equal(promoted.sources[0].relativePath,'课件/handout.pdf');

  // 5. Folder rename updates sourceIndex and attachments cleanly
  await org.renameFolder(course,{path:'笔记',newPath:'课堂笔记'});
  sources=await store.listSources(course);
  const movedNote=sources.find(s=>s.id===note.id);
  assert.equal(movedNote.folder,'课堂笔记');
  assert.equal(movedNote.relativePath,'课堂笔记/notes.md');
  assert.equal((await store.attachment(course,noteAttachment.id)).relativePath,'课堂笔记/notes.md');

  // Reject renaming folder into itself or existing folder
  await assert.rejects(org.renameFolder(course,{path:'课堂笔记',newPath:'课堂笔记/子目录'}),/自身目录/);
  await assert.rejects(org.renameFolder(course,{path:'课堂笔记',newPath:'课件'}),/已存在/);

  // 6. Folder deletion: refuses non-empty, allows empty (even with .DS_Store)
  await assert.rejects(org.deleteFolder(course,'课堂笔记'),/仍有文件/);
  await store.makeFolder(course,'空分类');
  await fs.writeFile(await store.safePath(course,'空分类/.DS_Store'),Buffer.from([0]));
  const deletedFolder=await org.deleteFolder(course,'空分类');
  assert.equal(deletedFolder.deleted,true);
  assert.ok(!deletedFolder.folders.some(f=>f.path==='空分类'));

  // 7. Delete source cleans disk, reader, readingPositions, attachments, and PDF annotations
  await store.setReader(course,{sourceId:slide.id,page:1});
  await pdfAnnotations.change(course,{sourceId:slide.id,page:1,op:'upsert',annotation:{id:'11111111-1111-4111-8111-111111111111',kind:'text',x:0.1,y:0.1,color:'red',text:'重点',fontSize:16}});
  assert.equal((await pdfAnnotations.list(course,{sourceId:slide.id,page:1})).annotations.length,1);

  const delResult=await org.deleteSources(course,[slide.id,fakePdf.id],{onSourceDeleted:id=>pdfAnnotations.removeSource(course,id)});
  assert.deepEqual(delResult.deletedIds,[slide.id,fakePdf.id]);
  assert.equal(delResult.closedReader,true);
  assert.equal(await store.getReader(course),null);
  assert.equal(await store.sourceById(course,slide.id),null);
  await assert.rejects(fs.lstat(await store.safePath(course,`.study-studio/pdf-annotations/${slide.id}`)),{code:'ENOENT'});

  // 8. Deleting a file while an import job is in flight finishes cleanly without failing job
  const staged=await store.upload(course,{name:'pending-del.txt',mime:'text/plain',data:Buffer.from('暂存内容'),folder:'待整理'});
  const stagedSource=await store.sourceForPath(course,staged.relativePath);
  let entered,release;
  const started=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
  org.classify=async args=>{entered();await gate;return {items:args.attachments.map(a=>({attachmentId:a.attachmentId,category:'笔记',reason:'测试'}))};};
  const job=await org.enqueue(course,[staged.id]);
  await started;
  await org.deleteSources(course,[stagedSource.id]);
  release();
  await org.wait(course);
  const importState=await org.list(course);
  assert.equal(importState.pending.length,0);
  assert.equal(importState.jobs.find(j=>j.id===job.id).status,'completed');

  console.log('Material management checks passed: stats, rename, case-only rename, collision/PDF guards, batch move, folder rename/delete, source delete with reader & annotation cleanup, and in-flight import deletion.');
} finally {
  await fs.rm(root,{recursive:true,force:true});
}
