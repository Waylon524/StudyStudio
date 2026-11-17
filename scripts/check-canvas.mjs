import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {validateCanvasSpec} from '../shared/canvas-schema.mjs';
import {LearningStore} from '../server/learning.mjs';

const spec={id:'cell-cycle',title:'细胞周期',html:'<main id="canvas-test">CANVAS_CODE_SENTINEL</main><script>window.animateCell=()=>{};</script>'};
assert.deepEqual(validateCanvasSpec({...spec,unexpected:'ignored'}),{...spec,height:420});
assert.equal(validateCanvasSpec({...spec,title:'  细胞周期  ',height:900}).title,'细胞周期');
for(const invalid of [null,[],{}, {...spec,id:'../outside'},{...spec,id:'x'.repeat(101)},{...spec,title:''},{...spec,title:'x'.repeat(161)},{...spec,html:''},{...spec,html:'x'.repeat(120001)},{...spec,height:239},{...spec,height:901},{...spec,height:420.5}])assert.throws(()=>validateCanvasSpec(invalid));

const root=await fs.mkdtemp(path.join(os.tmpdir(),'study-canvas-check-'));
try{
  let store=new LearningStore({root});const course={id:'canvas-course',name:'画布测试'},other={id:'another-course',name:'另一课程'};
  await store.initCourse(course);await store.initCourse(other);
  const input={threadId:'thread-canvas',itemId:'message-canvas',canvas:spec};
  const saved=(await store.saveCanvas(course,input)).canvas;
  assert.match(saved.id,/^[a-f0-9]{24}$/);assert.equal(saved.sourceId,spec.id);assert.equal(saved.height,420);assert.equal(saved.threadId,input.threadId);assert.equal(saved.html,spec.html);
  assert.deepEqual((await store.saveCanvas(course,input)).canvas,saved);assert.equal((await store.listSavedCanvases(course)).length,1);
  await assert.rejects(store.saveCanvas(course,{...input,canvas:{...spec,html:'changed'}}),/内容发生变化/);
  await assert.rejects(store.saveCanvas(course,{...input,canvas:{...spec,title:'changed'}}),/内容发生变化/);
  await assert.rejects(store.saveCanvas(course,{...input,threadId:''}),/聊天或消息/);
  const anotherMessage=(await store.saveCanvas(course,{...input,itemId:'another-message'})).canvas;assert.notEqual(anotherMessage.id,saved.id);
  const anotherCourse=(await store.saveCanvas(other,input)).canvas;assert.notEqual(anotherCourse.id,saved.id);
  await assert.rejects(store.recordCanvasActivity(other,{canvasId:saved.id,kind:'opened'}),/未找到/);
  await assert.rejects(store.listSavedCanvases({...course,id:'wrong-id'}),/另一课程/);
  const opened=(await store.recordCanvasActivity(course,{canvasId:saved.id,kind:'opened'})).canvas;assert.ok(opened.lastOpenedAt);
  const firstState=await store._load(course),openedEvents=firstState.turns.filter(t=>t.kind==='canvas_opened').length;
  assert.equal((await store.recordCanvasActivity(course,{canvasId:saved.id,kind:'opened'})).canvas.lastOpenedAt,opened.lastOpenedAt);
  assert.equal((await store._load(course)).turns.filter(t=>t.kind==='canvas_opened').length,openedEvents);
  const reported=(await store.recordCanvasActivity(course,{canvasId:saved.id,kind:'reported_interaction',label:'阶段',value:'S 期'})).canvas;
  assert.equal(reported.lastReport.source,'animation_report');assert.equal(reported.lastReport.value,'S 期');
  assert.deepEqual((await store.recordCanvasActivity(course,{canvasId:saved.id,kind:'reported_interaction',label:'阶段',value:'S 期'})).canvas.lastReport,reported.lastReport);
  for(const request of [{kind:'attempt'},{kind:'reported_interaction',label:''},{kind:'reported_interaction',label:'x'.repeat(121)},{kind:'reported_interaction',label:'valid',value:12},{kind:'reported_interaction',label:'valid',value:'x'.repeat(1001)}])await assert.rejects(store.recordCanvasActivity(course,{canvasId:saved.id,...request}),/活动无效|报告无效/);
  await assert.rejects(store.submitAttempt(course,{questionId:saved.id,answer:'S'}),/未找到题目/);
  await assert.rejects(store.reveal(course,saved.id),/未找到题目/);
  store=new LearningStore({root});const learning=await store.learning(course);
  assert.equal(learning.canvases.length,2);assert.equal(learning.canvases[0].html,spec.html);assert.equal(learning.items.length,0);assert.equal(learning.attempts.length,0);
  const snapshot=await store.contextSnapshot(course);assert.ok(snapshot.context.includes(saved.id));assert.ok(snapshot.context.includes('animation_report'));assert.ok(snapshot.context.includes('不是真实作答证据'));assert.ok(!snapshot.context.includes('CANVAS_CODE_SENTINEL'));assert.ok(!snapshot.context.includes('window.animateCell'));assert.ok(!snapshot.context.includes('<script>'));
  const state=await store._load(course);assert.equal(state.turns.filter(t=>t.kind==='canvas_saved').length,2);assert.equal(state.attempts.length,0);
  for(let i=0;i<5;i++){
    const canvas=(await store.saveCanvas(course,{...input,canvas:{...spec,id:'budget-'+i}})).canvas;
    await store.recordCanvasActivity(course,{canvasId:canvas.id,kind:'reported_interaction',label:'参数 '+i,value:'x'.repeat(1000)});
  }
  const boundedContext=(await store.contextSnapshot(course)).context;
  assert.equal((boundedContext.match(/x{500}/g)||[]).length,3);assert.ok(!boundedContext.includes('x'.repeat(501)));assert.ok(boundedContext.includes('"truncated":true'));
  console.log('Canvas validation, idempotent persistence, restart, course isolation, immutable content, bounded reports and non-mastery context passed.');
}finally{await fs.rm(root,{recursive:true,force:true});}
