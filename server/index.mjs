import {MAX_MATERIAL_BYTES,MATERIAL_SIZE_LABEL} from '../shared/file-limits.mjs';
import http from 'node:http';
import { randomUUID, createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodexBridge } from './codex.mjs';
import {checkedModel,checkedTurn,validatePresetConfigs} from './model-policy.mjs';
import {DEFAULT_PRESET_CONFIGS,isValidEffort,normalizePresetConfigs} from '../shared/model-presets.mjs';
import {isValidLocale} from '../shared/i18n.mjs';
import { handleChemistry } from './chemistry.mjs';
import { LearningStore } from './learning.mjs';
import { createPageAccess } from './lazy-pdf.mjs';
import {pdfSelectionContext} from './pdf-selection-context.mjs';
import {PdfAnnotations} from './pdf-annotations.mjs';
import {annotatePdf} from './pdf-annotation-tool.mjs';
import {PdfOutlines,PdfOutlineGenerator} from './pdf-outlines.mjs';
import {managePdfOutline} from './pdf-outline-tool.mjs';
import {writeWorkspaceFileForAgent} from './workspace-write-tool.mjs';
import {boundPdfRegion} from '../shared/pdf-markup.mjs';
import { CourseRequirements } from './requirements.mjs';
import { CourseSchedule } from './course-schedule.mjs';
import { ImportOrganizer } from './import-organizer.mjs';
import { CourseAvatars } from './course-avatar.mjs';
import { prepareTeachingSpec } from '../shared/teaching-ui.mjs';
import { dataRoot } from './data-path.mjs';
import {calculate,analyze,readSpreadsheet,analyzeSpreadsheet} from './analysis.mjs';
import {parseAnalysisRequest} from './analysis-tools.mjs';
import {readAttemptForAgent,requireViewedAttempt} from './attempt-vision.mjs';
import {submittedAnswers} from './attempt-context.mjs';
import {listWorkspaceEpub,readWorkspaceEpub} from './epub-workspace.mjs';
import {CONTINUE_INPUT,hideContinuationInputs} from '../shared/continuation.mjs';

const port=Number(process.env.STUDY_PORT || 4317);
if(!Number.isInteger(port)||port<1||port>65535)throw Error('服务端口无效');
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const appVersion=JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8')).version||'0.21.0';
const dataDir=dataRoot, indexFile=path.join(dataDir,'chats.json'), coursesFile=path.join(dataDir,'courses.json'), settingsFile=path.join(dataDir,'settings.json');
let userSettings={};
try {const parsed=JSON.parse(await fs.readFile(settingsFile,'utf8'));if(parsed&&typeof parsed==='object'&&!Array.isArray(parsed))userSettings=parsed;} catch(e){if(e.code!=='ENOENT')throw e}
let settingsSave=Promise.resolve();
function saveUserSettings(update){
  const job=settingsSave.catch(()=>{}).then(async()=>{
    const next=structuredClone(userSettings);
    const result=await update(next);
    await fs.mkdir(dataDir,{recursive:true,mode:0o700});
    const temp=settingsFile+'.'+randomUUID()+'.tmp';
    try{await fs.writeFile(temp,JSON.stringify(next,null,2),{flag:'wx',mode:0o600});await fs.rename(temp,settingsFile);}
    catch(error){await fs.unlink(temp).catch(()=>{});throw error;}
    userSettings=next;
    return result;
  });
  settingsSave=job;return job;
}
function currentPresetConfigs(){return normalizePresetConfigs(userSettings.presets);}
function currentLocaleSetting(){return isValidLocale(userSettings.locale)?userSettings.locale:null;}
const defaultCourse={id:'general',name:'通用学习'};
let courses=[defaultCourse];
try {const parsed=JSON.parse(await fs.readFile(coursesFile,'utf8'));if(Array.isArray(parsed)){const savedGeneral=parsed.find(x=>x?.id==='general'),general={...savedGeneral,...defaultCourse};delete general.archivedAt;courses=[general,...parsed.filter(x=>x && x.id!=='general' && typeof x.id==='string' && typeof x.name==='string').map(course=>({...course}))];}} catch(e){if(e.code!=='ENOENT')throw e}
const modes=new Set(['explain','practice','review']);
function courseById(id){return courses.find(c=>c.id===id)}
function httpError(status,message){return Object.assign(new Error(message),{status})}
const archiveReservations=new Map();
function isArchived(course){return !!courseById(course?.id)?.archivedAt||archiveReservations.has(course?.id)}
function requireActiveCourse(course){if(!course)throw httpError(404,'课程不存在');if(isArchived(course))throw httpError(409,'课程已归档，请先在设置中恢复。');return course}
const preparingTurns=new Set(),courseWrites=new Map();
function retainCourseWrite(course){courseWrites.set(course.id,(courseWrites.get(course.id)||0)+1);return ()=>{const count=courseWrites.get(course.id)||0;if(count<=1)courseWrites.delete(course.id);else courseWrites.set(course.id,count-1)}}
const store=new LearningStore();
const pdfAnnotations=new PdfAnnotations({store});
const pdfOutlines=new PdfOutlines({store});
const organizingPractice=new Map();
const bridge=new CodexBridge(), clients=new Map(), resumed=new Set(), activeTurns=new Map(), freshThreads=new Map();
const requirements=new CourseRequirements(store);
const schedule=new CourseSchedule({store,requirements});
const avatars=new CourseAvatars({store,generate:args=>bridge.generateCourseAvatar(args),onUpdate:course=>{if(course.threadId)sse(course.threadId,{method:'avatar/updated',params:{threadId:course.threadId}})}});
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function courseIdle(course){while([...activeTurns.values()].some(turn=>turn.course.id===course.id))await pause(200);}
const organizer=new ImportOrganizer({store,onUpdate:(course)=>{if(course.threadId)sse(course.threadId,{method:'sources/updated',params:{threadId:course.threadId}})},classify:async({course,attachments})=>{
  await courseIdle(course);const images=[],materials=[],accesses=[],inspectedAttachmentIds=[];
  try{
    for(const a of attachments){
      const item={attachmentId:a.attachmentId,name:a.name,path:a.relativePath,mime:a.mime,text:a.text,truncated:a.truncated,warning:a.warning};
      if(images.length<8&&a.kind==='image'){images.push(a.absolutePath);item.imageIndex=images.length;inspectedAttachmentIds.push(a.attachmentId)}
      else if(images.length<8&&path.extname(a.name).toLowerCase()==='.pdf'&&a.text.replace(/\s+/g,'').length<80){
        const source=await store.sourceForPath(course,a.relativePath),access=createPageAccess(store,course,{sourceId:source.id,name:source.name,page:1,source});accesses.push(access);
        try{const page=await access.read();if(page.imagePath){images.push(page.imagePath);item.imageIndex=images.length;item.imagePage=1;inspectedAttachmentIds.push(a.attachmentId)}}catch{item.warning='未能读取封面图像，保留为待确认资料。'}
      }
      materials.push(item);
    }
    const value=await bridge.classifyMaterials({courseName:course.name,cwd:store.coursePath(course),materials,images});
    await courseIdle(course);return {items:value.items,inspectedAttachmentIds};
  }finally{await Promise.allSettled(accesses.map(access=>access.close()));}
}});
const pdfOutlineGenerator=new PdfOutlineGenerator({
  store,
  pdfOutlines,
  generate:args=>bridge.generatePdfOutline(args),
  write:(course,operation)=>organizer._withFileChange(course,async()=>{requireActiveCourse(course);return operation();}),
  onUpdate:scope=>pdfOutlineUpdated(scope),
});
const pendingImports=new Map(),importEnqueues=new Map();
async function enqueueImports(course,ids){
  if(isArchived(course))return null;
  const pending=pendingImports.get(course.id);if(pending){clearTimeout(pending.timer);pendingImports.delete(course.id);ids=[...new Set([...pending.ids,...ids])];}
  const previous=importEnqueues.get(course.id)||Promise.resolve();
  const task=previous.catch(()=>{}).then(async()=>{if(isArchived(course))return null;const state=await store._load(course);if(isArchived(course))return null;const known=new Set((state.importJobs||[]).flatMap(job=>job.attachmentIds));const fresh=[...new Set(ids)].filter(id=>!known.has(id));let job=null;for(let offset=0;offset<fresh.length;offset+=100)job=await organizer.enqueue(course,fresh.slice(offset,offset+100));return job;});
  importEnqueues.set(course.id,task);try{return await task}finally{if(importEnqueues.get(course.id)===task)importEnqueues.delete(course.id);}
}
function scheduleImport(course,id){if(isArchived(course))return;let pending=pendingImports.get(course.id);if(pending)clearTimeout(pending.timer);else pending={ids:new Set()};pending.ids.add(id);pending.timer=setTimeout(()=>enqueueImports(course,[]).catch(()=>{}),2500);pending.timer.unref();pendingImports.set(course.id,pending);}
async function rememberRead(threadId,sourceId,page,relativePath,result,locator){
  const active=activeTurns.get(threadId);if(!active||!sourceId)return;
  const file=await store.safePath(active.course,relativePath),hash=createHash('sha256').update(await fs.readFile(file)).digest('hex');
  active.readEvidence.set(`${sourceId}:${page||locator||''}`,{text:result.text||'',relativePath,hash,readAt:new Date().toISOString(),imageAvailable:!!result.imageAvailable||!!result.imagePath||result.kind==='image',...(locator?{locator}:{})});
}
let chats=[];
try {const parsed=JSON.parse(await fs.readFile(indexFile,'utf8'));if(Array.isArray(parsed)) chats=parsed.filter(x=>typeof x.id==='string' && typeof x.title==='string').map(x=>({...x,courseId:courseById(x.courseId)?x.courseId:'general',mode:modes.has(x.mode)?x.mode:'explain',attachments:x.attachments||{},studyRenders:x.studyRenders||{},toolVersion:x.toolVersion||2,hasTurns:x.hasTurns!==false}));} catch(e){if(e.code!=='ENOENT')throw e}
let chatSave=Promise.resolve();
function save(){const job=chatSave.catch(()=>{}).then(async()=>{await fs.mkdir(dataDir,{recursive:true,mode:0o700});const temp=indexFile+'.'+randomUUID()+'.tmp';await fs.writeFile(temp,JSON.stringify(chats,null,2),{mode:0o600});await fs.rename(temp,indexFile)});chatSave=job;return job}
let courseSave=Promise.resolve();
function updateCourses(update){
  const job=courseSave.catch(()=>{}).then(async()=>{
    const next=courses.map(course=>({...course})),result=await update(next);
    await fs.mkdir(dataDir,{recursive:true,mode:0o700});const temp=coursesFile+'.'+randomUUID()+'.tmp';
    try{await fs.writeFile(temp,JSON.stringify(next,null,2),{flag:'wx',mode:0o600});await fs.rename(temp,coursesFile)}catch(error){await fs.unlink(temp).catch(()=>{});throw error}
    // Existing runtime work keeps these course identities. Commit only after
    // the new catalog is safely persisted; a failed write leaves memory intact.
    courses=next.map(value=>{const current=courseById(value.id);if(!current)return value;for(const key of Object.keys(current))if(!(key in value))delete current[key];return Object.assign(current,value)});
    return result;
  });courseSave=job;return job;
}
function saveCourseThread(course,id){return updateCourses(next=>{const current=next.find(item=>item.id===course.id);if(!current)throw httpError(404,'课程不存在');if(current.archivedAt)throw httpError(409,'课程已归档，请先在设置中恢复。');current.threadId=id})}
function courseTurnBusy(course){return preparingTurns.has(course.id)||[...activeTurns.values()].some(turn=>turn.course.id===course.id)}
function archiveBusy(course){return courseTurnBusy(course)||courseWrites.has(course.id)||courseCreation.has(course.id)||pendingImports.has(course.id)||importEnqueues.has(course.id)||organizer.queues.has(course.id)||organizingPractice.has(course.id)||pdfOutlineGenerator.isCourseBusy(course.id)}
async function recoverCourse(course){
  if(isArchived(course))return;const release=retainCourseWrite(course);
  try{await organizer.recover(course);if(isArchived(course))return;
    const state=await store._load(course),known=new Set((state.importJobs||[]).flatMap(job=>job.attachmentIds));
    const pending=state.attachments.filter(a=>a.relativePath.startsWith('待整理/')&&!known.has(a.id));
    if(pending.length)await enqueueImports(course,pending.map(a=>a.id));
  }finally{release()}
}
function owned(id){return typeof id==='string' && chats.some(x=>x.id===id)}
const courseCreation=new Map();
async function courseConversation(course,model){
  requireActiveCourse(course);
  if(courseCreation.has(course.id))return courseCreation.get(course.id);
  const task=(async()=>{
    let row=course.threadId?chats.find(x=>x.id===course.threadId && x.courseId===course.id && x.toolVersion===4):null;
    // Codex does not persist a rollout until the first turn. Only a course
    // explicitly marked as never started can receive a fresh empty runtime.
    if(row && row.hasTurns===false && !resumed.has(row.id))row=null;
    if(row){if(course.threadId!==row.id)await saveCourseThread(course,row.id);return {threadId:row.id};}
    const coursePath=await store.initCourse(course),created=await bridge.newThread(model,course.name,'explain',coursePath),id=created.thread.id;
    chats.unshift({id,title:'新对话',courseId:course.id,mode:'explain',toolVersion:4,hasTurns:false});await save();await saveCourseThread(course,id);resumed.add(id);freshThreads.set(id,created.thread);return {threadId:id};
  })();courseCreation.set(course.id,task);try{return await task}finally{if(courseCreation.get(course.id)===task)courseCreation.delete(course.id)}
}
function json(res,status,value){if(res.writableEnded)return;res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(value))}
async function body(req,maxBytes=128*1024){const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>maxBytes)throw new Error('请求过大');chunks.push(chunk)}const v=JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');if(!v||typeof v!=='object'||Array.isArray(v))throw new Error('无效请求');return v}
function validModel(value){try{checkedModel(value);return true}catch{return false}}
function safeOrigin(req){const host=req.headers.host;if(![`127.0.0.1:${port}`,`localhost:${port}`,'127.0.0.1:5173','localhost:5173'].includes(host))return false;const origin=req.headers.origin;if(!origin)return req.method==='GET';return [`http://127.0.0.1:${port}`,`http://localhost:${port}`,'http://127.0.0.1:5173','http://localhost:5173'].includes(origin)}
async function bytes(req){const declared=Number(req.headers['content-length']);if(Number.isFinite(declared)&&declared>MAX_MATERIAL_BYTES)throw httpError(413,'附件超过 '+MATERIAL_SIZE_LABEL);const chunks=[];let n=0;for await(const chunk of req){n+=chunk.length;if(n>MAX_MATERIAL_BYTES)throw httpError(413,'附件超过 '+MATERIAL_SIZE_LABEL);chunks.push(chunk)}return Buffer.concat(chunks)}
function sse(id,event){for(const res of clients.get(id)||[])res.write('data: '+JSON.stringify(event)+'\n\n')}
function pdfAnnotationsUpdated(scope){for(const id of clients.keys())if(chats.some(row=>row.id===id&&row.courseId===scope.courseId))sse(id,{method:'pdf/annotations-updated',params:scope})}
function pdfOutlineUpdated(scope){for(const id of clients.keys())if(chats.some(row=>row.id===id&&row.courseId===scope.courseId))sse(id,{method:'pdf/outline-updated',params:scope})}
function sourcesUpdated(course){for(const id of clients.keys())if(chats.some(row=>row.id===id&&row.courseId===course.id))sse(id,{method:'sources/updated',params:{threadId:id}})}
function studyUpdated(course){for(const id of clients.keys())if(chats.some(row=>row.id===id&&row.courseId===course.id))sse(id,{method:'study/updated',params:{threadId:id}})}
async function organizeCoursePractice(course,{mode='smart',locale}={}){
  if(organizingPractice.has(course.id))return organizingPractice.get(course.id);
  const task=(async()=>{
    const state=await store._load(course);
    const allItems=state.items||[];
    if(!allItems.length)return {organizedCount:0,totalCount:0,categories:store._collectPracticeCategories(state),items:[]};
    const uncategorized=allItems.filter(item=>!(item.unit||'').trim()&&!(item.knowledgePoint||'').trim());
    const targetItems=mode==='all'||!uncategorized.length?allItems:uncategorized;
    const scan=await store.scanWorkspace(course);
    const fileManifest=scan.files.slice(0,80).map(file=>file.relativePath);
    const resolvedLocale=isValidLocale(locale)?locale:(currentLocaleSetting()||'zh-CN');
    const existingCategories=store._collectPracticeCategories(state);
    const batchSize=40;
    const assignments=[];
    const runningCategories=[...existingCategories];
    const seenCatKeys=new Set(runningCategories.map(c=>`${c.unit}\0${c.knowledgePoint}`));
    for(let offset=0;offset<targetItems.length;offset+=batchSize){
      const batch=targetItems.slice(offset,offset+batchSize).map(item=>({
        questionId:item.id,
        type:item.type,
        prompt:String(item.prompt||'').slice(0,600),
        ...(Array.isArray(item.options)?{options:item.options.slice(0,8).map(o=>String(o.text||'').slice(0,120))}:{}),
        ...(item.explanation?{explanation:String(item.explanation).slice(0,300)}:{}),
        ...(Array.isArray(item.tags)&&item.tags.length?{tags:item.tags.slice(0,8)}:{}),
      }));
      const response=await bridge.organizePracticeQuestions({
        courseName:course.name,
        cwd:store.coursePath(course),
        questions:batch,
        existingCategories:runningCategories.slice(0,80),
        fileManifest,
        locale:resolvedLocale,
      });
      const validIds=new Set(batch.map(item=>item.questionId));
      for(const entry of response?.items||[]){
        if(!entry||!validIds.has(entry.questionId))continue;
        const unit=String(entry.unit||'').trim().slice(0,120);
        const knowledgePoint=String(entry.knowledgePoint||'').trim().slice(0,120);
        if(!unit&&!knowledgePoint)continue;
        assignments.push({questionId:entry.questionId,unit,knowledgePoint});
        const key=`${unit}\0${knowledgePoint}`;
        if(!seenCatKeys.has(key)){seenCatKeys.add(key);runningCategories.push({unit,knowledgePoint});}
      }
    }
    const result=await store.applyPracticeOrganization(course,assignments);
    studyUpdated(course);
    return result;
  })();
  organizingPractice.set(course.id,task);
  try{return await task;}finally{if(organizingPractice.get(course.id)===task)organizingPractice.delete(course.id);}
}
function normalizeStudy(spec){
  return prepareTeachingSpec(spec).questionSpec;
}
bridge.toolHandler=async ({threadId,turnId,tool,arguments:args,callId})=>{
  const row=chats.find(x=>x.id===threadId);if(!row)throw Error('对话不存在');const course=courseById(row.courseId);if(!course||!args||typeof args!=='object')throw Error('课程或工具参数无效');
  if(tool==='study_render'&&args.spec?.operation==='pdf_annotate'){tool='study_pdf_annotate';args=args.spec.arguments;if(!args||typeof args!=='object'||Array.isArray(args))throw Error('PDF 批注参数无效。');}
  if(tool==='study_render'&&args.spec?.operation==='pdf_outline'){tool='study_pdf_outline';args=args.spec.arguments;if(!args||typeof args!=='object'||Array.isArray(args))throw Error('PDF 目录参数无效。');}
  if(tool==='study_render'&&args.spec?.operation==='workspace_write'){tool='study_workspace_write';args=args.spec.arguments;if(!args||typeof args!=='object'||Array.isArray(args))throw Error('创建资料文件参数无效。');}
  if(tool==='study_render'){const request=parseAnalysisRequest(args.spec);if(request){tool=request.tool;args=request.arguments;}}
  const updateMemory=async value=>{const active=activeTurns.get(threadId),evidence=value.evidence;if(typeof evidence!=='string'||!evidence.trim()||evidence.length>1000||!active?.text.includes(evidence))throw Error('记忆依据必须是本轮用户消息中的原话。');const result=await store.updateMemory(course,{...value,source:`用户本轮消息（会话 ${threadId}）`});sse(threadId,{method:'study/updated',params:{threadId}});return result};
  if(tool==='study_pdf_annotate'){
    requireActiveCourse(course);const active=activeTurns.get(threadId),release=retainCourseWrite(course);
    try{return await annotatePdf({pdfAnnotations,course,active,args,threadId,turnId,callId,isActive:()=>activeTurns.get(threadId)===active&&!active?.completion,write:operation=>organizer._withFileChange(course,async()=>{requireActiveCourse(course);return operation()}),onUpdate:pdfAnnotationsUpdated})}finally{release()}
  }
  if(tool==='study_pdf_outline'){
    requireActiveCourse(course);const active=activeTurns.get(threadId),release=retainCourseWrite(course);
    try{return await managePdfOutline({pdfOutlines,course,active,args,threadId,turnId,callId,isActive:()=>activeTurns.get(threadId)===active&&!active?.completion,write:operation=>organizer._withFileChange(course,async()=>{requireActiveCourse(course);return operation()}),onUpdate:scope=>{pdfOutlineGenerator.clearSource(course,scope.sourceId);pdfOutlineUpdated(scope);}})}finally{release()}
  }
  if(tool==='study_workspace_write'){
    requireActiveCourse(course);const active=activeTurns.get(threadId),release=retainCourseWrite(course);
    try{return await writeWorkspaceFileForAgent({store,course,active,args,callId,isActive:()=>activeTurns.get(threadId)===active&&!active?.completion,write:operation=>organizer._withFileChange(course,async()=>{requireActiveCourse(course);return operation()}),onUpdate:sourcesUpdated})}finally{release()}
  }
  if(tool==='study_calculate')return calculate(args);
  if(tool==='study_analyze'){
    if(!args.source)return analyze(args);
    if(args.values!==undefined||args.x!==undefined||args.y!==undefined)throw Error('请选择 Excel 来源或数值数组中的一种。');
    const source=await store.sourceForPath(course,args.source.path),file=await store.safePath(course,source.relativePath);
    const {source:inputSource,...options}=args;
    return {sourceId:source.id,sourceName:source.name,relativePath:source.relativePath,...await analyzeSpreadsheet(file,{...options,sheet:inputSource.sheet,range:inputSource.range})};
  }
  if(tool==='study_spreadsheet'){
    const source=await store.sourceForPath(course,args.path),file=await store.safePath(course,source.relativePath);
    const {path:inputPath,...options}=args,result=await readSpreadsheet(file,options);
    return {sourceId:source.id,sourceName:source.name,relativePath:source.relativePath,...result};
  }
  if(tool==='study_workspace_list')return await listWorkspaceEpub(store,course,args)||store.listWorkspace(course,args);
  if(tool==='study_current_slide'){const active=activeTurns.get(threadId);if(!active?.pageAccess)return {message:'本轮没有打开 PDF 页面。'};try{const slide=await active.pageAccess.read();const meta={sourceId:slide.sourceId,name:slide.name,page:slide.page,pages:slide.pages,text:slide.text,warnings:slide.warnings,imageAvailable:!!slide.imagePath};const items=[{type:'inputText',text:JSON.stringify(meta)}];if(slide.imagePath){const data=await fs.readFile(slide.imagePath);items.push({type:'inputImage',imageUrl:`data:image/png;base64,${data.toString('base64')}`})}await rememberRead(threadId,slide.sourceId,slide.page,active.readerSnapshot.source.relativePath,slide);return {toolContentItems:items}}catch(error){return {message:'本轮页面读取失败，未查看页面内容。',warning:String(error.message||'未知错误')}}}
  if(tool==='study_workspace_read'){
    const epub=await readWorkspaceEpub(store,course,args);
    if(epub){await rememberRead(threadId,epub.source.id,undefined,epub.source.relativePath,epub.metadata,'epub:'+String(epub.metadata.section||args.path));return epub.toolResult;}
    if(args.page!==undefined){if(!Number.isInteger(args.page)||args.page<1||(args.pageCount!==undefined&&args.pageCount!==1))throw Error('请指定单个有效页码。');const source=await store.sourceForPath(course,args.path);if(source.mime!=='application/pdf')throw Error('指定文件不是课程内的 PDF。');const snapshot={sourceId:source.id,name:source.name,page:args.page,source};const access=createPageAccess(store,course,snapshot);try{const slide=await access.read();const meta={sourceId:source.id,sourceName:source.name,relativePath:source.relativePath,page:slide.page,pages:slide.pages,text:slide.text,warnings:slide.warnings,imageAvailable:!!slide.imagePath};const items=[{type:'inputText',text:JSON.stringify(meta)}];if(slide.imagePath){const data=await fs.readFile(slide.imagePath);items.push({type:'inputImage',imageUrl:`data:image/png;base64,${data.toString('base64')}`})}await rememberRead(threadId,source.id,slide.page,source.relativePath,slide);return {toolContentItems:items}}finally{await access.close()}}
    const item=await store.workspaceRead(course,args.path);if(item.kind!=='image')await rememberRead(threadId,item.sourceId,undefined,item.relativePath,item);if(item.kind==='image'){
    const file=await fs.open(item.absolutePath,fsConstants.O_RDONLY|fsConstants.O_NOFOLLOW);let data;try{const st=await file.stat();if(!st.isFile()||st.size>MAX_MATERIAL_BYTES)throw Error('图片不存在或超过 '+MATERIAL_SIZE_LABEL);data=await file.readFile()}finally{await file.close()}
    const png=data.length>=8&&data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
    const jpeg=data.length>=3&&data[0]===255&&data[1]===216&&data[2]===255;
    const webp=data.length>=12&&data.toString('ascii',0,4)==='RIFF'&&data.toString('ascii',8,12)==='WEBP';
    const gif=data.length>=6&&['GIF87a','GIF89a'].includes(data.toString('ascii',0,6));
    const mime=png?'image/png':jpeg?'image/jpeg':webp?'image/webp':gif?'image/gif':null;if(!mime)throw Error('图片格式无法识别');
    await rememberRead(threadId,item.sourceId,undefined,item.relativePath,item);return {toolContentItems:[{type:'inputText',text:JSON.stringify({relativePath:item.relativePath,sourceId:item.sourceId,sourceName:item.sourceName,kind:'image',mime})},{type:'inputImage',imageUrl:`data:${mime};base64,${data.toString('base64')}`} ]};
  }return item}
  if(tool==='study_update_memory')return updateMemory(args);
  if(tool==='study_record_note'){
    if(args.kind==='study_attempt_read'){
      let value;try{value=JSON.parse(args.text)}catch{throw Error('请用 JSON 提供 attemptId。')}
      return readAttemptForAgent(store,course,value,activeTurns.get(threadId));
    }
    if(typeof args.kind==='string'&&args.kind.startsWith('course_requirement')&&!['course_requirement','course_requirement_change','course_requirement_list'].includes(args.kind))throw Error('日常管理请使用 course_requirement_change；读取最新记录请使用 course_requirement_list。');
    if(args.kind==='course_requirement_list')return {requirements:await requirements.list(course,{includeHistory:false})};
    const active=activeTurns.get(threadId);let result;
    if(['course_requirement','course_requirement_change'].includes(args.kind)){
      let value;try{value=JSON.parse(args.text)}catch{throw Error('课程要求内容需要有效的 JSON。')}
      const context={text:active?.text,threadId,turnId:active?.turnId,readEvidence:active?.readEvidence,now:active?.timeContext?.now,timezone:active?.timeContext?.timezone};
      result=args.kind==='course_requirement_change'?await requirements.changeFromConversation(course,value,context):await requirements.record(course,value,context);
    }else result=await store.addCourseNote(course,args);
    sse(threadId,{method:'study/updated',params:{threadId}});return result;
  }
  if(tool==='study_feedback'){await requireViewedAttempt(store,course,args.attemptId,activeTurns.get(threadId));const result=await store.applyFeedback(course,args);sse(threadId,{method:'study/updated',params:{threadId}});return result}
  if(tool==='study_render'){const itemId='tool-'+callId,prepared=prepareTeachingSpec(args.spec),spec={...prepared.spec,id:prepared.spec.id||itemId};const result=prepared.questionSpec?await store.registerSet(course,{threadId,itemId,spec:{...prepared.questionSpec,id:spec.id}}):{};row.studyRenders ||= {};row.studyRenders[callId]={itemId,spec};await save();sse(threadId,{method:'study/render',params:{threadId,itemId,spec}});sse(threadId,{method:'study/updated',params:{threadId}});return {...result,rendered:true,canvases:prepared.canvases.map(({id,title})=>({id,title})),canvasSave:'Learner can click 保存到练习; rendering alone does not save a canvas or prove learning.'}}
  throw Error('不支持的工具');
};
function completeTurn(id,state){
  if(!state.turnId||!state.completion||state.completion.id!==state.turnId)return;
  activeTurns.delete(id);
  state.pageAccess?.close().catch(()=>{});
  if(state.completion.status!=='completed')return;
  if(state.submissions.throughAttemptId){const row=chats.find(row=>row.id===id);if(row){row.attemptContextThrough=state.submissions.throughAttemptId;save().catch(error=>sse(id,{method:'study/error',params:{threadId:id,message:'作答上下文状态保存失败：'+String(error.message||'未知错误')}}));}}
  const subject=(state.text.trim()?`用户提问：${state.text.trim().slice(0,3500)}`:`用户发送了附件：${state.names.join('、').slice(0,500)}`)+(state.readerSnapshot?`；阅读课件：${state.readerSnapshot.name}，第 ${state.readerSnapshot.page} 页`:'');
  store.recordTurn(state.course,{threadId:id,text:subject+'；已收到回复。'}).then(()=>sse(id,{method:'study/updated',params:{threadId:id}})).catch(error=>sse(id,{method:'study/error',params:{threadId:id,message:'学习记录保存失败：'+String(error.message||'未知错误')}}));
}
bridge.on('event',evt=>{const id=evt.params.threadId;if(!owned(id))return;sse(id,evt);
  if(evt.method==='turn/completed'){const active=activeTurns.get(id);if(active){active.completion=evt.params.turn;completeTurn(id,active)}}
  if(evt.method==='item/completed' && evt.params.item?.type==='agentMessage' && evt.params.item.phase==='final_answer'){
    const text=evt.params.item.text||'', itemId=evt.params.item.id, row=chats.find(x=>x.id===id);const regex=/```(?:study|ui)\s*\n([\s\S]*?)\n```/g;
    for(const match of text.matchAll(regex)){try{const spec=normalizeStudy(JSON.parse(match[1]));if(!spec)continue;if(!spec.id)spec.id='block-'+match.index;store.registerSet(courseById(row.courseId),{threadId:id,itemId,spec}).then(()=>sse(id,{method:'study/updated',params:{threadId:id}})).catch(()=>{});}catch{}}
  }
});
bridge.on('disconnected',()=>{resumed.clear();freshThreads.clear();for(const state of activeTurns.values())state.pageAccess?.close().catch(()=>{});activeTurns.clear();for(const id of clients.keys())sse(id,{method:'connection/error',params:{threadId:id,message:'Codex 连接已关闭'}})});
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.wasm':'application/wasm','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.woff2':'font/woff2','.otf':'font/otf'};
const server=http.createServer(async(req,res)=>{
 try{
  if(!safeOrigin(req))return json(res,403,{error:'访问来源不被允许'});
  const url=new URL(req.url,'http://127.0.0.1:4317');
  if(req.method==='GET'&&url.pathname==='/api/health')return json(res,200,{app:'study-studio',version:appVersion,instanceToken:process.env.STUDY_INSTANCE_TOKEN||null});
  if(req.method==='GET'&&url.pathname==='/api/settings/info')return json(res,200,{version:appVersion,workspaceRoot:store.root,maxMaterialBytes:MAX_MATERIAL_BYTES,maxMaterialLabel:MATERIAL_SIZE_LABEL,presets:currentPresetConfigs(),defaultPresets:DEFAULT_PRESET_CONFIGS,locale:currentLocaleSetting()});
  if(req.method==='GET'&&url.pathname==='/api/settings/locale')return json(res,200,{locale:currentLocaleSetting()});
  if(req.method==='POST'&&url.pathname==='/api/settings/locale'){
    const v=await body(req);
    if(!isValidLocale(v.locale))return json(res,400,{error:'不支持的语言设置。'});
    await saveUserSettings(next=>{next.locale=v.locale;});
    return json(res,200,{locale:currentLocaleSetting()});
  }
  if(req.method==='GET'&&url.pathname==='/api/settings/presets')return json(res,200,{presets:currentPresetConfigs(),defaultPresets:DEFAULT_PRESET_CONFIGS});
  if(req.method==='POST'&&url.pathname==='/api/settings/presets'){
    const v=await body(req);
    if(v.reset===true){
      await saveUserSettings(next=>{delete next.presets;});
      return json(res,200,{presets:currentPresetConfigs(),defaultPresets:DEFAULT_PRESET_CONFIGS});
    }
    await bridge.start();
    const catalog=await bridge.modelCatalog();
    let validated;
    try{validated=validatePresetConfigs(catalog,v.presets);}catch(error){return json(res,400,{error:error.message});}
    await saveUserSettings(next=>{next.presets=validated;});
    return json(res,200,{presets:currentPresetConfigs(),defaultPresets:DEFAULT_PRESET_CONFIGS});
  }
  if(url.pathname==='/api/chem/render' && req.method==='POST'){await handleChemistry(req,res,url);return}
  if(req.method==='GET' && url.pathname==='/api/status')return json(res,200,{...await bridge.status({force:url.searchParams.get('refresh')==='1'}),presets:currentPresetConfigs(),defaultPresets:DEFAULT_PRESET_CONFIGS,locale:currentLocaleSetting()});
  if(req.method==='GET' && url.pathname==='/api/courses'){
    await courseSave.catch(()=>{});const visible=courses.filter(course=>url.searchParams.get('includeArchived')==='true'||!course.archivedAt);
    const includeStats=url.searchParams.get('stats')==='true';
    const results=await Promise.allSettled(visible.map(course=>course.archivedAt?undefined:store.initCourse(course)));
    const statsList=includeStats?await Promise.allSettled(visible.map((course,i)=>results[i].status==='rejected'?Promise.reject(results[i].reason):store.courseStats(course,{readonly:!!course.archivedAt}))):null;
    return json(res,200,{courses:visible.map((course,i)=>({...(results[i].status==='rejected'?{...course,workspaceError:String(results[i].reason?.message||'课程工作区初始化失败')}:course),...(statsList&&statsList[i].status==='fulfilled'?{stats:statsList[i].value}:{})}))});
  }
  if(req.method==='POST' && url.pathname==='/api/courses'){
    const v=await body(req);if(typeof v.name!=='string'||!v.name.trim()||v.name.trim().length>80)return json(res,400,{error:'课程名称无效'});
    const course={id:randomUUID(),name:v.name.trim()};
    await updateCourses(async next=>{if(next.some(item=>item.name.normalize('NFC')===course.name.normalize('NFC')))throw httpError(409,'已有同名课程，请在设置中打开或恢复。');await store.initCourse(course);next.push(course)});
    void avatars.ensure(course).catch(()=>{});return json(res,201,{course});
  }
  const courseUpdate=/^\/api\/courses\/([0-9a-z-]+)$/.exec(url.pathname);
  if(courseUpdate&&req.method==='PATCH'){
    const v=await body(req);if(Object.keys(v).length!==1||typeof v.archived!=='boolean')return json(res,400,{error:'课程归档参数无效'});
    let updated,reservation;try{await updateCourses(next=>{const course=next.find(item=>item.id===courseUpdate[1]);if(!course)throw httpError(404,'课程不存在');if(course.id==='general'&&v.archived)throw httpError(400,'通用学习保持可用，其他课程可以归档。');if(v.archived&&archiveBusy(course))throw httpError(409,'这门课程正在回复或整理资料，请完成后再归档。');if(v.archived){reservation=Symbol();archiveReservations.set(course.id,reservation);course.archivedAt ||= new Date().toISOString()}else delete course.archivedAt;updated={...course}})}finally{if(reservation&&archiveReservations.get(courseUpdate[1])===reservation)archiveReservations.delete(courseUpdate[1])}
    if(!v.archived)void recoverCourse(courseById(courseUpdate[1])).catch(error=>console.error('资料整理恢复未完成：'+String(error.message||'未知错误')));
    return json(res,200,{course:updated});
  }
  if(req.method==='GET' && url.pathname==='/api/threads')return json(res,200,{threads:chats.filter(row=>!isArchived(courseById(row.courseId)))});
  if(req.method==='POST' && url.pathname==='/api/threads'){const v=await body(req);const courseId=v.courseId??'general',mode=v.mode??'explain',course=courseById(courseId);if(!validModel(v.model)||!course||!modes.has(mode))return json(res,400,{error:'课程、模式或模型无效'});return json(res,200,await courseConversation(course,v.model))}
  const conversation=/^\/api\/courses\/([0-9a-z-]+)\/conversation$/.exec(url.pathname);
  if(conversation){const course=requireActiveCourse(courseById(conversation[1]));if(req.method==='GET'){const row=chats.find(x=>x.id===course.threadId&&x.courseId===course.id&&x.toolVersion===4);return json(res,200,{threadId:row?.id||null})}if(req.method==='POST'){const v=await body(req);if(!validModel(v.model))return json(res,400,{error:'模型无效'});return json(res,200,await courseConversation(course,v.model))}return json(res,405,{error:'方法不支持'})}
  const match=/^\/api\/threads\/([0-9a-f-]+)$/.exec(url.pathname);
  if(req.method==='GET' && match){const id=match[1];if(!owned(id))return json(res,404,{error:'对话不存在'});const row=chats.find(c=>c.id===id),course=requireActiveCourse(courseById(row.courseId)),coursePath=await store.initCourse(course);let thread;if(resumed.has(id)&&freshThreads.has(id))thread=freshThreads.get(id);else if(resumed.has(id))thread=(await bridge.read(id)).thread;else{thread=(await bridge.resume(id,course.name,row.mode,coursePath)).thread;resumed.add(id)}return json(res,200,{thread:{id,courseId:row.courseId,mode:row.mode,turns:hideContinuationInputs(thread.turns,row.turnActions),turnActions:row.turnActions||{},attachments:row.attachments||{},studyRenders:row.studyRenders||{},readerContexts:row.readerContexts||{}}})}
  if(req.method==='GET' && url.pathname==='/api/events'){const id=url.searchParams.get('threadId');if(!owned(id))return json(res,404,{error:'对话不存在'});res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache, no-transform','Connection':'keep-alive','X-Accel-Buffering':'no'});res.write(': connected\n\n');if(!clients.has(id))clients.set(id,new Set());clients.get(id).add(res);req.on('close',()=>{clients.get(id)?.delete(res);if(!clients.get(id)?.size)clients.delete(id)});return}
  const annotationRoute=/^\/api\/courses\/([0-9a-z-]+)\/pdf-annotations$/.exec(url.pathname);
  if(annotationRoute){
    const course=requireActiveCourse(courseById(annotationRoute[1])),release=retainCourseWrite(course);
    try{
      if(req.method!=='GET'&&req.method!=='POST')return json(res,405,{error:'方法不支持'});
      let request;
      try{
        const allPages=req.method==='GET'&&url.searchParams.has('all');
        if(allPages&&(url.searchParams.get('all')!=='1'||url.searchParams.has('page')))throw new TypeError('整份课件批注请求应使用 all=1，且不指定单页。');
        request=req.method==='GET'?{sourceId:url.searchParams.get('sourceId'),...(allPages?{}:{page:Number(url.searchParams.get('page'))})}:await body(req);
        const result=await organizer._withFileChange(course,async()=>{
          requireActiveCourse(course);
          return req.method==='GET'?(allPages?pdfAnnotations.listAll(course,request):pdfAnnotations.list(course,request)):pdfAnnotations.change(course,request);
        });
        if(req.method==='POST')pdfAnnotationsUpdated({courseId:course.id,sourceId:request.sourceId,page:request.page});
        return json(res,200,result);
      }catch(error){if(error instanceof TypeError||error instanceof SyntaxError)throw httpError(400,error.message);throw error}
    }finally{release()}
  }
  const outlineRoute=/^\/api\/courses\/([0-9a-z-]+)\/pdf-outline$/.exec(url.pathname);
  if(outlineRoute){
    const course=requireActiveCourse(courseById(outlineRoute[1])),release=retainCourseWrite(course);
    try{
      if(req.method!=='GET'&&req.method!=='POST')return json(res,405,{error:'方法不支持'});
      try{
        if(req.method==='GET'){
          const sourceId=url.searchParams.get('sourceId');
          const inspect=url.searchParams.get('inspect')==='1';
          const result=await organizer._withFileChange(course,async()=>{
            requireActiveCourse(course);
            return inspect?pdfOutlines.inspect(course,{sourceId}):pdfOutlines.get(course,{sourceId});
          });
          return json(res,200,{...result,generation:pdfOutlineGenerator.status(course,result.sourceId)});
        }
        const request=await body(req,2*1024*1024);
        if(request.op==='regenerate'){
          const resolvedLocale=isValidLocale(request.locale)?request.locale:(currentLocaleSetting()||'zh-CN');
          const generation=await organizer._withFileChange(course,async()=>{
            requireActiveCourse(course);
            return pdfOutlineGenerator.regenerate(course,{sourceId:request.sourceId,locale:resolvedLocale});
          });
          return json(res,202,{ok:true,sourceId:request.sourceId,generation});
        }
        const result=await organizer._withFileChange(course,async()=>{
          requireActiveCourse(course);
          if(request.op==='reset'){pdfOutlineGenerator.clearSource(course,request.sourceId);return pdfOutlines.reset(course,{sourceId:request.sourceId});}
          if(request.op==='replace'){pdfOutlineGenerator.clearSource(course,request.sourceId);return pdfOutlines.replace(course,{sourceId:request.sourceId,items:request.items},{kind:'user'});}
          throw new TypeError('PDF 目录操作无效，仅支持 regenerate、replace 或 reset。');
        });
        pdfOutlineUpdated({courseId:course.id,sourceId:request.sourceId});
        return json(res,200,{...result,generation:pdfOutlineGenerator.status(course,request.sourceId)});
      }catch(error){if(error instanceof TypeError||error instanceof SyntaxError)throw httpError(400,error.message);throw error}
    }finally{release()}
  }
  const cr=/^\/api\/courses\/([0-9a-z-]+)\/(learning|workspace|instructions|attachments|answer-images|attempts|reveal|feedback|files\/list|files\/read|study\/register|sources|sources\/select|sources\/move|sources\/move-batch|sources\/rename|sources\/delete|folders|folders\/rename|folders\/delete|reader|requirements|imports|imports\/retry|avatar|schedule|canvas\/save|canvas\/activity|practice\/organize|practice\/categories|practice\/categories\/rename|practice\/categories\/delete|practice\/questions\/update|practice\/questions\/categorize|practice\/questions\/delete)$/.exec(url.pathname);
  if(cr){const course=requireActiveCourse(courseById(cr[1])),release=req.method==='GET'?()=>{}:retainCourseWrite(course);try{const action=cr[2];
    if(req.method==='GET'&&action==='schedule')return json(res,200,await schedule.list(course));
    if(req.method==='GET'&&action==='avatar')return json(res,200,{avatar:await avatars.ensure(course)});
    if(req.method==='POST'&&action==='avatar')return json(res,202,{avatar:await avatars.regenerate(course)});
    if(req.method==='GET'&&action==='requirements')return json(res,200,{requirements:await requirements.list(course)});
    if(req.method==='GET'&&action==='imports')return json(res,200,await organizer.list(course));
    if(req.method==='POST'&&action==='imports'){const v=await body(req);if(!Array.isArray(v.attachmentIds)||v.attachmentIds.length>100||v.attachmentIds.some(x=>typeof x!=='string'))throw Error('待整理资料无效。');return json(res,202,{job:await enqueueImports(course,v.attachmentIds)})}
    if(req.method==='POST'&&action==='imports/retry'){const v=await body(req);return json(res,202,{job:await organizer.retry(course,v.jobId)})}
    if(req.method==='GET'&&action==='learning')return json(res,200,await store.learning(course));
    if(req.method==='POST'&&action==='practice/organize'){const v=await body(req);return json(res,200,await organizeCoursePractice(course,{mode:v.mode==='all'?'all':'smart',locale:v.locale}))}
    if(req.method==='POST'&&action==='practice/categories'){const v=await body(req);const result=await store.createPracticeCategory(course,v);studyUpdated(course);return json(res,200,result)}
    if(req.method==='POST'&&action==='practice/categories/rename'){const v=await body(req);const result=await store.renamePracticeCategory(course,v);studyUpdated(course);return json(res,200,result)}
    if(req.method==='POST'&&action==='practice/categories/delete'){const v=await body(req);const result=await store.deletePracticeCategory(course,v);studyUpdated(course);return json(res,200,result)}
    if(req.method==='POST'&&action==='practice/questions/update'){const v=await body(req);const result=await store.updateQuestion(course,v);studyUpdated(course);return json(res,200,result)}
    if(req.method==='POST'&&action==='practice/questions/categorize'){const v=await body(req);const result=await store.categorizeQuestions(course,v);studyUpdated(course);return json(res,200,result)}
    if(req.method==='POST'&&action==='practice/questions/delete'){const v=await body(req);const result=await store.deleteQuestions(course,v.questionIds);studyUpdated(course);return json(res,200,result)}
    if(req.method==='POST'&&action==='canvas/save'){const v=await body(req,512*1024);if(!owned(v.threadId)||chats.find(x=>x.id===v.threadId)?.courseId!==course.id)return json(res,403,{error:'对话不属于此课程'});const result=await store.saveCanvas(course,v);sse(v.threadId,{method:'study/updated',params:{threadId:v.threadId}});return json(res,200,result)}
    if(req.method==='POST'&&action==='canvas/activity')return json(res,200,await store.recordCanvasActivity(course,await body(req)));
    if(req.method==='GET'&&action==='sources')return json(res,200,{sources:await store.listSources(course)});
    if(req.method==='POST'&&action==='sources/select'){const v=await body(req);return json(res,200,{sources:await store.selectSources(course,v.sourceIds)})}
    if(req.method==='POST'&&action==='sources/move'){const v=await body(req);return json(res,200,{source:await organizer.moveAndConfirmSource(course,v)})}
    if(req.method==='POST'&&action==='sources/move-batch'){const v=await body(req);return json(res,200,await organizer.moveAndConfirmSources(course,v))}
    if(req.method==='POST'&&action==='sources/rename'){if(courseTurnBusy(course))throw httpError(409,'当前课程正在回复，请等待回复完成后再重命名文件。');const v=await body(req);return json(res,200,{source:await organizer.renameSource(course,v)})}
    if(req.method==='POST'&&action==='sources/delete'){if(courseTurnBusy(course))throw httpError(409,'当前课程正在回复，请等待回复完成后再删除文件。');const v=await body(req);return json(res,200,await organizer.deleteSources(course,v.sourceIds,{onSourceDeleted:async sourceId=>{pdfOutlineGenerator.clearSource(course,sourceId);await pdfAnnotations.removeSource(course,sourceId);await pdfOutlines.removeSource(course,sourceId);}}))}
    if(req.method==='GET'&&action==='folders')return json(res,200,{folders:await store.listFolders(course)});
    if(req.method==='POST'&&action==='folders'){const v=await body(req);await store.makeFolder(course,v.path);if(course.threadId)sse(course.threadId,{method:'sources/updated',params:{threadId:course.threadId}});return json(res,200,{folders:await store.listFolders(course)})}
    if(req.method==='POST'&&action==='folders/rename'){if(courseTurnBusy(course))throw httpError(409,'当前课程正在回复，请等待回复完成后再重命名分类。');const v=await body(req);return json(res,200,await organizer.renameFolder(course,v))}
    if(req.method==='POST'&&action==='folders/delete'){if(courseTurnBusy(course))throw httpError(409,'当前课程正在回复，请等待回复完成后再删除分类。');const v=await body(req);return json(res,200,await organizer.deleteFolder(course,v.path))}
    if(req.method==='GET'&&action==='reader')return json(res,200,{reader:await store.getReader(course)});
    if(req.method==='POST'&&action==='reader')return json(res,200,{reader:await store.setReader(course,await body(req))});
    if(req.method==='GET'&&action==='workspace'){const instructions=await store.readInstructions(course), files=await store.listFiles(course);const summary=await store.learning(course);return json(res,200,{workspacePath:instructions.workspacePath,files,instructions:instructions.content,instructionsVersion:instructions.version,memory:await store.listMemory(course),progress:summary.progress,importantInfo:summary.importantInfo})}
    if((req.method==='PUT'||req.method==='POST')&&action==='instructions'){const v=await body(req);return json(res,200,await store.updateInstructions(course,v))}
    if(req.method==='GET'&&action==='files/list')return json(res,200,{files:await store.listFiles(course)});
    if(req.method==='GET'&&action==='files/read'){const readerMode=url.searchParams.get('mode')==='reader';const value=await store.readFile(course,url.searchParams.get('path'),readerMode?{limit:500000}:{});if(value.absolutePath)delete value.absolutePath;return json(res,200,{...value,path:value.relativePath})}
    if(req.method==='POST'&&action==='attachments'){let name,folder;try{name=decodeURIComponent(req.headers['x-file-name']||'');folder=req.headers['x-folder']===undefined?'待整理':decodeURIComponent(req.headers['x-folder'])}catch{return json(res,400,{error:'附件名称或目录无效'})}const intent=req.headers['x-upload-intent'],attachment=await store.upload(course,{name,folder,intent,mime:req.headers['content-type']||'application/octet-stream',data:await bytes(req)});if(intent!=='courseware'&&intent!=='direct')scheduleImport(course,attachment.id);if(course.threadId)sse(course.threadId,{method:'sources/updated',params:{threadId:course.threadId}});return json(res,201,{attachment:{...attachment,url:`/api/courses/${course.id}/attachments/${attachment.id}`}})}
    if(req.method==='POST'&&action==='answer-images')return json(res,201,await store.uploadAnswerImage(course,await body(req,15*1024*1024)));
    if(req.method==='POST'&&action==='attempts')return json(res,200,await store.submitAttempt(course,await body(req)));
    if(req.method==='POST'&&action==='reveal'){const v=await body(req);return json(res,200,await store.reveal(course,v.questionId))}
    if(req.method==='POST'&&action==='feedback')return json(res,200,await store.applyFeedback(course,await body(req)));
    if(req.method==='POST'&&action==='study/register'){const v=await body(req);if(!owned(v.threadId)||chats.find(x=>x.id===v.threadId)?.courseId!==course.id)return json(res,403,{error:'对话不属于此课程'});return json(res,200,await store.registerSet(course,v))}
    return json(res,405,{error:'方法不支持'});
    }finally{release()}
  }
  const answerImageRoute=/^\/api\/courses\/([0-9a-z-]+)\/answer-images\/([0-9a-f-]{36})$/.exec(url.pathname);
  if(answerImageRoute&&req.method==='GET'){
    const course=courseById(answerImageRoute[1]);if(!course)return json(res,404,{error:'课程不存在'});
    const image=await store.getAnswerImage(course,answerImageRoute[2]),data=image.data;
    if(!Buffer.isBuffer(data)||data.length>40*1024*1024)throw Error('作答图片不可用。');res.writeHead(200,{'Content-Type':'image/png','Content-Length':data.length,'X-Content-Type-Options':'nosniff','Cache-Control':'no-store','Content-Security-Policy':"default-src 'none'; sandbox"});return res.end(data);
  }
  if(answerImageRoute&&req.method==='DELETE'){
    const course=requireActiveCourse(courseById(answerImageRoute[1])),release=retainCourseWrite(course);
    try{return json(res,200,await store.removeAnswerImage(course,answerImageRoute[2]))}finally{release()}
  }
  const requirementRoute=/^\/api\/courses\/([0-9a-z-]+)\/requirements\/(req-[0-9a-f-]{36})$/.exec(url.pathname);
  if(['PATCH','DELETE'].includes(req.method)&&requirementRoute){const course=requireActiveCourse(courseById(requirementRoute[1])),release=retainCourseWrite(course);try{const value=await body(req),result=await requirements[req.method==='PATCH'?'manualCorrection':'manualRemove'](course,requirementRoute[2],value);if(course.threadId)sse(course.threadId,{method:'study/updated',params:{threadId:course.threadId}});return json(res,200,result)}finally{release()}}
  const scheduleRoute=/^\/api\/courses\/([0-9a-z-]+)\/schedule\/(req-[0-9a-f-]{36})$/.exec(url.pathname);
  if(req.method==='DELETE'&&scheduleRoute){const course=requireActiveCourse(courseById(scheduleRoute[1])),release=retainCourseWrite(course);try{const result=await schedule.remove(course,scheduleRoute[2]);if(course.threadId)sse(course.threadId,{method:'study/updated',params:{threadId:course.threadId}});return json(res,200,result)}finally{release()}}
  const sourceRoute=/^\/api\/courses\/([0-9a-z-]+)\/sources\/([0-9a-f]{24})\/file$/.exec(url.pathname);
  if(req.method==='GET'&&sourceRoute){const course=courseById(sourceRoute[1]);if(!course)return json(res,404,{error:'课程不存在'});const source=await store.sourceById(course,sourceRoute[2]);if(!source)return json(res,404,{error:'资料不存在'});const target=await store.safePath(course,source.relativePath),file=await fs.open(target,fsConstants.O_RDONLY|fsConstants.O_NOFOLLOW);try{const st=await file.stat();if(!st.isFile()||st.size>MAX_MATERIAL_BYTES)throw Error('资料不存在或超过 '+MATERIAL_SIZE_LABEL);let start=0,end=st.size-1,status=200;const range=req.headers.range;if(range){const match=/^bytes=(\d*)-(\d*)$/.exec(range);if(!match||(!match[1]&&!match[2])){res.writeHead(416,{'Content-Range':`bytes */${st.size}`});return res.end()}if(!match[1]){const count=Number(match[2]);start=Math.max(st.size-count,0)}else{start=Number(match[1]);if(match[2])end=Math.min(Number(match[2]),end)}if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>end||start>=st.size){res.writeHead(416,{'Content-Range':`bytes */${st.size}`});return res.end()}status=206}const data=Buffer.alloc(end-start+1);let bytesRead=0;while(bytesRead<data.length){const read=await file.read(data,bytesRead,data.length-bytesRead,start+bytesRead);if(!read.bytesRead)throw Error('资料读取未完成，文件可能已更改。');bytesRead+=read.bytesRead;}const forceDownload=url.searchParams.get('download')==='1';const inline=!forceDownload&&['image/png','image/jpeg','image/webp','image/gif','application/pdf'].includes(source.mime);res.writeHead(status,{'Content-Type':inline?source.mime:'application/octet-stream','Content-Length':bytesRead,'Accept-Ranges':'bytes',...(status===206?{'Content-Range':`bytes ${start}-${end}/${st.size}`} : {}),'Content-Disposition':(inline?'inline':'attachment')+`; filename*=UTF-8''${encodeURIComponent(source.name)}`,'X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; sandbox",'Cache-Control':'no-store'});return res.end(data)}finally{await file.close()}}
  const attachmentRoute=/^\/api\/courses\/([0-9a-z-]+)\/attachments\/([0-9a-f-]+)$/.exec(url.pathname);
  if(req.method==='GET'&&attachmentRoute){const course=courseById(attachmentRoute[1]);if(!course)return json(res,404,{error:'课程不存在'});const a=await store.attachment(course,attachmentRoute[2]);const file=await fs.open(a.absolutePath,fsConstants.O_RDONLY|fsConstants.O_NOFOLLOW);let data;try{const stat=await file.stat();if(!stat.isFile()||stat.size>MAX_MATERIAL_BYTES)throw Error('附件不存在或超过 '+MATERIAL_SIZE_LABEL);data=await file.readFile()}finally{await file.close()}const inline=['image/png','image/jpeg','image/webp','image/gif'].includes(a.mime);res.writeHead(200,{'Content-Type':inline?a.mime:'application/octet-stream','Content-Disposition':(inline?'inline':'attachment')+`; filename*=UTF-8''${encodeURIComponent(a.name)}`,'X-Content-Type-Options':'nosniff','Cache-Control':'no-store'});return res.end(data)}
  if(req.method==='POST' && url.pathname==='/api/turn'){
    const v=await body(req),continuing=v.action==='continue',text=continuing?'继续讲解':v.text??'',attachments=v.attachmentIds??[];
    if(!(v.action==null||continuing)||(continuing&&(!v.threadId||v.text!=null&&v.text!==''||attachments.length))||(v.threadId!=null&&!owned(v.threadId))||typeof text!=='string'||text.length>50000||!Array.isArray(attachments)||attachments.length>10||attachments.some(x=>typeof x!=='string')||(!text.trim()&&!attachments.length)||!validModel(v.model)||!(v.effort===undefined||isValidEffort(v.effort)))return json(res,400,{error:'消息参数无效'});
    try{checkedTurn(v.model,v.effort)}catch(error){return json(res,400,{error:error.message})}
    const requestedCourse=requireActiveCourse(courseById(v.threadId?chats.find(row=>row.id===v.threadId)?.courseId:v.courseId??'general'));
    if(preparingTurns.has(requestedCourse.id))return json(res,409,{error:'当前对话正在准备，请稍候'});preparingTurns.add(requestedCourse.id);try{
    if(!v.threadId){const courseId=v.courseId??'general',mode=v.mode??'explain',course=courseById(courseId);if(!course||!modes.has(mode))return json(res,400,{error:'课程或模式无效'});v.threadId=(await courseConversation(course,v.model)).threadId}
    else {const requested=chats.find(x=>x.id===v.threadId),course=courseById(requested.courseId);v.threadId=(await courseConversation(course,v.model)).threadId}
    const row=chats.find(c=>c.id===v.threadId),course=courseById(row.courseId),coursePath=await store.initCourse(course);
    if(activeTurns.has(v.threadId))return json(res,409,{error:'当前对话正在回复，请稍候'});
    if(continuing&&row.hasTurns===false)return json(res,409,{error:'请先开始一段学习对话。'});
    await enqueueImports(course,[]);await organizer.wait(course);
    let readerSnapshot=null;
    if(Object.prototype.hasOwnProperty.call(v,'reader')){if(v.reader!==null){if(!v.reader||typeof v.reader!=='object'||Array.isArray(v.reader))throw Error('阅读器状态无效。');readerSnapshot=await store.resolveReader(course,v.reader);}}
    else {const current=await store.getReader(course);if(current)readerSnapshot=await store.resolveReader(course,current);}
    let activeDocReference=null;
    if(!readerSnapshot&&v.activeDocument&&typeof v.activeDocument==='object'&&!Array.isArray(v.activeDocument)){
      if(['markdown','html'].includes(v.activeDocument.kind)&&typeof v.activeDocument.sourceId==='string'&&/^[0-9a-f]{24}$/.test(v.activeDocument.sourceId)){
        const docSource=await store.sourceById(course,v.activeDocument.sourceId).catch(()=>null);
        if(docSource)activeDocReference={kind:v.activeDocument.kind,sourceId:docSource.id,name:docSource.name,relativePath:docSource.relativePath};
      }else if(v.activeDocument.kind==='canvas'&&typeof v.activeDocument.title==='string'&&v.activeDocument.title.trim()){
        activeDocReference={kind:'canvas',title:v.activeDocument.title.trim().slice(0,160)};
      }
    }
    const selectedPassage=pdfSelectionContext(v.reader,readerSnapshot,course.id);
    const infos=await Promise.all(attachments.map(id=>store.attachment(course,id))),images=[],material=[],sources=await store.listSources(course);
    for(const a of infos){const sourceId=(sources.find(x=>x.relativePath===a.relativePath)||await store.sourceForPath(course,a.relativePath)).id;if(path.extname(a.relativePath).toLowerCase()==='.pdf'){material.push({attachmentId:a.id,name:a.name,sourceId,relativePath:a.relativePath,note:'PDF 附件仅提供文件定位；如需内容请按需读取。'});}else if(['image/png','image/jpeg','image/webp','image/gif'].includes(a.mime)){images.push(a.absolutePath);material.push({attachmentId:a.id,name:a.name,sourceId,kind:'image',note:'本轮已作为图片输入'})}else {const read=await store.readFile(course,a.relativePath);material.push({attachmentId:a.id,name:a.name,sourceId,text:read.text,warning:read.warning,truncated:read.truncated})}}
    const timeContext={now:new Date().toISOString(),timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,localDate:new Intl.DateTimeFormat('en-CA',{year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date())};
    const snapshot=await store.contextSnapshot(course);
    const submissions=submittedAnswers(snapshot.state,{afterAttemptId:row.attemptContextThrough});
    const currentRequirements=await requirements.list(course,{includeHistory:false,state:snapshot.state});
    const compactSource=source=>{if(!source)return source;const {type,quote,sourceId,page,name,relativePath,verification}=source;return {type,quote,sourceId,page,name,relativePath,verification};};
    const compactRequirements=currentRequirements.map(item=>{const stored=snapshot.state.requirements?.find(entry=>entry.id===item.id);return {...item,source:compactSource(item.source),historyAvailable:(stored?.revisions.length||0)>1};});
    const currentSchedule=await schedule.list(course,{state:snapshot.state,records:currentRequirements});
    const context=snapshot.context+'\n\n课程要求当前版本（更正使用 id/revision，历史可读取课程重要信息.md）：\n'+JSON.stringify(compactRequirements)+'\n\n本机当前时间（解析本轮相对日期，不代替来源）：\n'+JSON.stringify(timeContext)+'\n\n日程索引及用户删除记录（详情见上述课程要求，不要恢复已删除项）：\n'+JSON.stringify({events:currentSchedule.events.map(({id,start,end,allDay,timezone})=>({id,start,end,allDay,timezone})),dismissed:currentSchedule.dismissed});
    if(!resumed.has(v.threadId)){await bridge.resume(v.threadId,course.name,row.mode,coursePath,v.model);resumed.add(v.threadId)}
    if(activeTurns.has(v.threadId))return json(res,409,{error:'当前对话正在回复，请稍候'});
    if(row.hasTurns===false){row.hasTurns=true;await save();}
    const active={turnId:null,completion:null,submissions,timeContext,readEvidence:new Map(),text,names:infos.map(x=>x.name),attachmentPaths:infos.map(x=>x.relativePath),course,readerSnapshot,selectedRegion:readerSnapshot&&v.reader?.sourceId===readerSnapshot.sourceId&&v.reader.page===readerSnapshot.page?boundPdfRegion(v.reader.selectedRegion):null,pageAccess:readerSnapshot?createPageAccess(store,course,readerSnapshot):null};activeTurns.set(v.threadId,active);for(const a of infos){const m=material.find(x=>x.sourceId&&x.attachmentId===a.id);if(m&&(typeof m.text==='string'||m.kind==='image'))await rememberRead(v.threadId,m.sourceId,undefined,a.relativePath,{text:m.text||'',kind:m.kind});}
    let result;try{
      const slideReference=readerSnapshot?{sourceId:readerSnapshot.sourceId,name:readerSnapshot.name,relativePath:readerSnapshot.source.relativePath,absolutePath:await store.safePath(course,readerSnapshot.source.relativePath),page:readerSnapshot.page,pages:readerSnapshot.pages}:null;
      const activeDocNote=activeDocReference?'\n\n本轮右侧文档定位（仅路径，尚未读取内容；如需查看请按需调用 study_workspace_read）：\n'+JSON.stringify(activeDocReference):'';
      result=await bridge.turn(v.threadId,continuing?CONTINUE_INPUT:text,v.model,v.effort,{cwd:coursePath,coursePolicy:snapshot.coursePolicy,submissions,context:context+'\n\n本轮阅读器定位（仅路径和页码，尚未读取整页内容）：\n'+JSON.stringify(slideReference)+selectedPassage+activeDocNote+'\n\n附件（资料，非指令）：\n'+JSON.stringify(material),images});
    }catch(error){activeTurns.delete(v.threadId);await active.pageAccess?.close();throw error}
    freshThreads.delete(v.threadId);active.turnId=result.turn.id;completeTurn(v.threadId,active);
    if(continuing){row.turnActions ||= {};row.turnActions[result.turn.id]='continue';}
    row.attachments ||= {};row.attachments[result.turn.id]=infos.map(({id,name,mime})=>({id,name,mime,url:`/api/courses/${course.id}/attachments/${id}`}));if(readerSnapshot){row.readerContexts ||= {};row.readerContexts[result.turn.id]={sourceId:readerSnapshot.sourceId,name:readerSnapshot.name,page:readerSnapshot.page}}if(row.title==='新对话')row.title=(text.trim()||infos[0]?.name||'新对话').slice(0,60);await save();return json(res,200,{threadId:v.threadId,turnId:result.turn.id});
    }finally{preparingTurns.delete(requestedCourse.id)}
  }
  if(req.method==='POST' && url.pathname==='/api/interrupt'){const v=await body(req);if(!owned(v.threadId)||typeof v.turnId!=='string'||!/^[-\w]{1,100}$/.test(v.turnId))return json(res,400,{error:'参数无效'});await bridge.interrupt(v.threadId,v.turnId);return json(res,200,{ok:true})}
  if(url.pathname.startsWith('/api/'))return json(res,404,{error:'接口不存在'});
  if(req.method!=='GET')return json(res,405,{error:'方法不支持'});
  const rel=decodeURIComponent(url.pathname).replace(/^\/+/,''), dist=path.join(root,'dist');let file=path.resolve(dist,rel||'index.html');if(file!==dist && !file.startsWith(dist+path.sep))return json(res,403,{error:'无效路径'});let contents;try{contents=await fs.readFile(file)}catch{file=path.join(dist,'index.html');contents=await fs.readFile(file)}res.writeHead(200,{'Content-Type':mime[path.extname(file)]||'application/octet-stream','X-Content-Type-Options':'nosniff',...(path.extname(file)==='.html'?{'Content-Security-Policy':'frame-src about:'}:{})});res.end(contents)
 }catch(e){json(res,Number.isInteger(e.status)&&e.status>=400&&e.status<600?e.status:500,{error:e.message||'请求失败'})}
});
server.listen(port,'127.0.0.1',()=>console.log(`Study Studio: http://127.0.0.1:${port}`));
for(const course of courses){if(course.archivedAt)continue;try{await recoverCourse(course)}catch(error){console.error('资料整理恢复未完成：'+String(error.message||'未知错误'));}}
let stopping=false;
function stop(){if(stopping)return;stopping=true;for(const pending of pendingImports.values())clearTimeout(pending.timer);bridge.child?.kill();for(const group of clients.values())for(const res of group)res.end();server.close(()=>process.exit(0));setTimeout(()=>process.exit(0),1500).unref()}
process.on('SIGTERM',stop);process.on('SIGINT',stop);
server.on('error',error=>{console.error('服务启动失败：'+error.message);bridge.child?.kill();process.exit(1)});
