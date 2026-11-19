import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {LearningStore} from '../server/learning.mjs';
import {writeWorkspaceFileForAgent} from '../server/workspace-write-tool.mjs';

const root=await fs.mkdtemp(path.join(os.tmpdir(),'study-workspace-write-'));
try{
  const store=new LearningStore({root});
  const course={id:'chem-notes',name:'有机化学测试'};
  const base=await store.initCourse(course);

  // 1. Create Markdown & HTML files in folders
  const md=await store.writeWorkspaceFile(course,{
    path:'笔记/亲核取代总结.md',
    content:'# 亲核取代反应\n\n$$\\ce{CH3Br + OH- -> CH3OH + Br-}$$\n\n```smiles\nCCO\n```\n'
  });
  assert.equal(md.action,'created');
  assert.equal(md.relativePath,'笔记/亲核取代总结.md');
  assert.equal(md.folder,'笔记');
  assert.equal(md.mime,'text/markdown');
  assert.match(md.sourceId,/^[0-9a-f]{24}$/);
  assert.equal(md.citation,`[亲核取代总结.md](study-source:${md.sourceId})`);

  const html=await store.writeWorkspaceFile(course,{
    path:'互动页面/能量曲线.html',
    content:'<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>反应坐标</title></head><body><h1>SN2 能量曲线</h1></body></html>'
  });
  assert.equal(html.action,'created');
  assert.equal(html.mime,'text/html');
  assert.equal(html.folder,'互动页面');

  // Verify listed in sources and readable via readFile (including reader limit > 100k)
  const sources=await store.listSources(course);
  assert.ok(sources.some(s=>s.id===md.sourceId&&s.mime==='text/markdown'));
  assert.ok(sources.some(s=>s.id===html.sourceId&&s.mime==='text/html'));
  const readHtml=await store.readFile(course,html.relativePath);
  assert.equal(readHtml.kind,'text');
  assert.ok(readHtml.text.includes('SN2 能量曲线'));

  const bigContent='A'.repeat(150000);
  const big=await store.writeWorkspaceFile(course,{path:'笔记/长笔记.md',content:bigContent});
  const defaultRead=await store.readFile(course,big.relativePath);
  assert.equal(defaultRead.truncated,true);
  assert.equal(defaultRead.text.length,100000);
  const readerRead=await store.readFile(course,big.relativePath,{limit:500000});
  assert.equal(readerRead.truncated,false);
  assert.equal(readerRead.text.length,150000);

  // 2. Overwrite behavior: default rejects; overwrite:true updates agent file and preserves sourceId
  await assert.rejects(store.writeWorkspaceFile(course,{path:'笔记/亲核取代总结.md',content:'updated'}),/已存在/);
  const updated=await store.writeWorkspaceFile(course,{path:'笔记/亲核取代总结.md',content:'# 亲核取代反应（修订）\n\n补充 E2 对比。',overwrite:true});
  assert.equal(updated.action,'updated');
  assert.equal(updated.sourceId,md.sourceId,'updating an agent-created file must preserve sourceId');
  assert.ok((await store.readFile(course,md.relativePath)).text.includes('补充 E2 对比'));

  // 3. Protect user-uploaded & pre-existing unmanaged files from overwrite:true
  await store.upload(course,{name:'用户笔记.md',folder:'笔记',mime:'text/markdown',data:Buffer.from('# 用户原件\n')});
  await assert.rejects(store.writeWorkspaceFile(course,{path:'笔记/用户笔记.md',content:'# 篡改',overwrite:true}),/原件不能直接覆盖/);
  await fs.writeFile(path.join(base,'笔记/外部放入.md'),'# 外部文件\n');
  await assert.rejects(store.writeWorkspaceFile(course,{path:'笔记/外部放入.md',content:'# 篡改',overwrite:true}),/原件不能直接覆盖/);

  // 4. Reject internal files, hidden paths, traversal, forbidden folders, disallowed extensions, empty/oversized
  const forbiddenPaths=[
    'AGENTS.md','agents.md','学习进度.md','课程重要信息.md',
    '.hidden.md','.study-studio/state.json','.codex/config.toml',
    '../escape.md','笔记/../../escape.md','/abs/test.md','笔记\\test.md',
    '课件/讲义.md','Courseware/notes.html','待整理/draft.md',
    '笔记/script.js','笔记/run.sh','笔记/tool.py','笔记/doc.pdf','笔记/noext',
    'a/b/c/d/e/f/too-deep.md','笔记/ trailing.md'
  ];
  for(const badPath of forbiddenPaths){
    await assert.rejects(store.writeWorkspaceFile(course,{path:badPath,content:'ok'}),`should reject path: ${badPath}`);
  }
  await assert.rejects(store.writeWorkspaceFile(course,{path:'笔记/empty.md',content:'   \n'}),/不能为空/);
  await assert.rejects(store.writeWorkspaceFile(course,{path:'笔记/huge.md',content:'x'.repeat(500*1024+1)}),/超过 500 KB/);

  // Symlink protection
  const outsideDir=await fs.mkdtemp(path.join(os.tmpdir(),'study-symlink-outside-'));
  try{
    await fs.symlink(outsideDir,path.join(base,'链接目录'));
    await assert.rejects(store.writeWorkspaceFile(course,{path:'链接目录/evil.md',content:'hi'}),/符号链接/);
  }finally{await fs.rm(outsideDir,{recursive:true,force:true});}

  // 5. Agent tool wrapper: active-turn guard, idempotency, SSE notification, per-turn cap
  let updates=0;
  const active={course,turnId:'turn-1'};
  let turnOpen=true;
  const runWrite=(callId,args)=>writeWorkspaceFileForAgent({
    store,course,active,args,callId,
    write:op=>op(),
    onUpdate:()=>{updates++},
    isActive:()=>turnOpen
  });
  const r1=await runWrite('call-1',{path:'笔记/工具创建.md',content:'# 工具生成\n'});
  assert.equal(r1.saved,true);
  assert.equal(updates,1);
  // Idempotent retry on same callId
  const r1Retry=await runWrite('call-1',{path:'笔记/工具创建.md',content:'# 工具生成\n'});
  assert.deepEqual(r1Retry,r1);
  assert.equal(updates,1,'duplicate callId must not rewrite or notify twice');

  // Cap at 12 writes per turn (1 already written -> 11 more succeed, 13th rejects)
  for(let i=2;i<=12;i++){
    const res=await runWrite('call-'+i,{path:`笔记/批量-${i}.md`,content:`# 第 ${i} 份\n`});
    assert.equal(res.saved,true);
  }
  await assert.rejects(runWrite('call-13',{path:'笔记/批量-13.md',content:'# 13\n'}),/最多创建或更新 12 份/);

  // Inactive turn rejected
  turnOpen=false;
  await assert.rejects(runWrite('call-after',{path:'笔记/after.md',content:'# after\n'}),/本轮对话已经结束/);

  // 6. Deleting an agent-created file cleans up agentFiles tracking
  await store.deleteSource(course,md.sourceId);
  const stateAfterDelete=await store._load(course);
  assert.equal(stateAfterDelete.agentFiles?.[md.sourceId],undefined);

  console.log('Workspace write checks passed: MD/HTML creation, MIME & reader limits, sourceId-preserving overwrite, user-file protection, path/symlink/extension containment, turn idempotency/caps and delete cleanup.');
}finally{
  await fs.rm(root,{recursive:true,force:true});
}
