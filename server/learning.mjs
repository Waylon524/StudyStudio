import {MAX_MATERIAL_BYTES,MATERIAL_SIZE_LABEL} from '../shared/file-limits.mjs';
import { promises as fs, constants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { validateStudySpec, gradeAnswer } from '../shared/study-schema.mjs';
import { validateCanvasSpec } from '../shared/canvas-schema.mjs';
import { pdfInfo } from './pdf-reader.mjs';
import {prepareAnswerImage,MAX_ANSWER_IMAGE_BYTES,MAX_ANSWER_IMAGES,ANSWER_IMAGE_ID} from './answer-images.mjs';

const exec = promisify(execFile);
const extractor = fileURLToPath(new URL('./file-extract.py', import.meta.url));
const now = () => new Date().toISOString();
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);
const blank = () => ({version:1, courseId:null, sets:[], items:[], attempts:[], attachments:[], turns:[], readingPositions:{}, canvases:[]});
const memoryStart='<!-- STUDY-STUDIO MEMORY START -->', memoryEnd='<!-- STUDY-STUDIO MEMORY END -->';
const internalFiles=new Set(['AGENTS.md','学习进度.md','课程重要信息.md']);
const nativeTextExtensions=new Set(['.txt','.md','.csv','.json','.tex','.tsv']);
const mimeTypes={'.pdf':'application/pdf','.txt':'text/plain','.md':'text/markdown','.csv':'text/csv','.json':'application/json','.tex':'text/plain','.docx':'application/vnd.openxmlformats-officedocument.wordprocessingml.document','.pptx':'application/vnd.openxmlformats-officedocument.presentationml.presentation','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif'};
const renderMemory=m=>{const escape=x=>x.replace(/[\r\n]+/g,' ').replace(/<!--/g,'&lt;!--');return [memoryStart,'## 已记录的课程偏好与约定','',...['preferences','courseRules'].flatMap(k=>[`### ${k==='preferences'?'学习偏好':'课程规则'}`,...m[k].map(x=>`- ${escape(x.text)}（依据：${escape(x.source)}；${escape(x.evidence)}；ID：${x.id}）`),'']),memoryEnd].join('\n');};
const decorated = (s, item) => { const attempts=s.attempts.filter(a=>a.questionId===item.id); return {...item,attempts,latestAttempt:attempts.at(-1) || null,reveals:s.turns.filter(e=>e.kind==='reveal' && e.questionId===item.id)}; };
const brief = value => String(value ?? '').replace(/[\r\n]+/g,' ').replace(/\s+/g,' ').slice(0,120);
const answerImageDescriptor=(course,image)=>({id:image.id,name:image.name,mime:'image/png',originalMime:image.originalMime,size:image.size,width:image.width,height:image.height,url:'/api/courses/'+encodeURIComponent(course.id)+'/answer-images/'+image.id,...(image.warning?{warning:image.warning}:{})});
const imageDigest=bytes=>createHash('sha256').update(bytes).digest('hex');
const templates = {
  'AGENTS.md': '# 课程学习说明\n\n请结合本课程资料辅导，明确区分资料原文、推断和待核实内容。不要把一次提示后的作答认定为独立掌握。\n',
  '学习进度.md': '# 学习进度\n\n这里记录真实发生的学习活动；自评和已掌握是不同的。\n',
  '课程重要信息.md': '# 课程重要信息\n\n记录来源和时间；教师原话、个人补充和待核实信息应分清。\n',
};

export class LearningStore {
  constructor({root} = {}) { this.root = path.resolve(root || process.env.STUDY_WORKSPACE_ROOT || path.join(os.homedir(),'Documents','StudyStudio')); this.locks = new Map(); this.scans=new Map(); }
  coursePath(course) {
    const name = course?.name, id = course?.id;
    if (typeof id !== 'string' || !id.trim() || typeof name !== 'string' || !name.trim() || name === '.' || name === '..' || /[\/\\\x00-\x1f]/.test(name) || name.length > 180) throw Error('无效的课程名称或 ID。');
    return path.join(this.root, name);
  }
  async safePath(course, relative = '') {
    const base = this.coursePath(course);
    if (typeof relative !== 'string' || path.isAbsolute(relative) || relative.split(/[\\/]/).some(x => x === '..') || relative.includes('\0')) throw Error('路径无效。');
    const target = path.resolve(base, relative);
    if (target !== base && !target.startsWith(base + path.sep)) throw Error('路径越界。');
    for (const segment of [base, ...path.relative(base,target).split(path.sep).filter(Boolean).map((_, i, arr) => path.join(base, ...arr.slice(0,i+1)))]) {
      try { if ((await fs.lstat(segment)).isSymbolicLink()) throw Error('不允许访问符号链接。'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
    return target;
  }
  async initCourse(course) {
    const base = this.coursePath(course);
    await fs.mkdir(this.root,{recursive:true});
    await this.safePath(course); await fs.mkdir(base,{recursive:true});
    await this.safePath(course,'.study-studio'); await fs.mkdir(path.join(base,'.study-studio'),{recursive:true});
    const state = await this.safePath(course,'.study-studio/state.json');
    try { await fs.writeFile(state,JSON.stringify({...blank(),courseId:course.id},null,2),{flag:'wx',mode:0o600}); } catch(e) { if (e.code !== 'EEXIST') throw e; }
    const existing = JSON.parse(await fs.readFile(state,'utf8'));
    if (existing.courseId !== course.id) throw Error('该课程目录已属于另一课程，无法复用。');
    await this._ensureTemplates(course);return base;
  }
  async _ensureTemplates(course) {for(const [name,text] of Object.entries(templates)){const target=await this.safePath(course,name);try{await fs.writeFile(target,text,{flag:'wx',mode:0o600})}catch(error){if(error.code!=='EEXIST')throw error;}}}
  async _load(course,{ensureTemplates=false}={}) {
    const read=async()=>{const target=await this.safePath(course,'.study-studio/state.json'),handle=await fs.open(target,constants.O_RDONLY|constants.O_NOFOLLOW);try{const state=JSON.parse(await handle.readFile('utf8'));if(state.courseId!==course.id)throw Error('该课程目录已属于另一课程，无法复用。');if(ensureTemplates)await this._ensureTemplates(course);return state;}finally{await handle.close();}};
    try{return await read()}catch(error){if(error.code!=='ENOENT')throw error;await this.initCourse(course);return read();}
  }
  async _save(course,state) {
    const target = await this.safePath(course,'.study-studio/state.json');
    const tmp = await this.safePath(course,`.study-studio/${randomUUID()}.tmp`);
    await fs.writeFile(tmp,JSON.stringify(state,null,2),{flag:'wx',mode:0o600}); await fs.rename(tmp,target);
  }
  async _mutate(course, fn, {shouldSave=()=>true,ensureTemplates=true}={}) {
    const key = this.coursePath(course), previous = this.locks.get(key) || Promise.resolve();
    const task = previous.catch(()=>{}).then(async()=>{ const state = await this._load(course,{ensureTemplates}); const value = await fn(state); if(shouldSave())await this._save(course,state); return value; });
    this.locks.set(key,task); try { return await task; } finally { if (this.locks.get(key) === task) this.locks.delete(key); }
  }
  async listItems(course, filter = {}) { const s = await this._load(course); return s.items.filter(i => (!filter.threadId || i.threadId === filter.threadId) && (!filter.type || i.type === filter.type) && (!filter.tag || i.tags?.includes(filter.tag))).map(i=>decorated(s,i)); }
  async listSavedCanvases(course) { const s=await this._load(course);return s.canvases||[]; }
  async saveCanvas(course,{threadId,itemId,canvas}) {
    if(typeof threadId!=='string'||!threadId||threadId.length>200||typeof itemId!=='string'||!itemId||itemId.length>200)throw Error('缺少有效的聊天或消息 ID。');
    const spec=validateCanvasSpec(canvas),id=digest([course.id,threadId,itemId,spec.id]);let changed=false;
    return this._mutate(course,async s=>{
      s.canvases ||= [];
      const old=s.canvases.find(item=>item.id===id);
      if(old){
        if(old.sourceId!==spec.id||old.title!==spec.title||old.html!==spec.html||old.height!==spec.height)throw Error('已保存的画布内容发生变化，请使用新的画布 ID。');
        return {canvas:old};
      }
      const saved={...spec,id,sourceId:spec.id,threadId,itemId,savedAt:now()};
      s.canvases.push(saved);s.turns.push({id:randomUUID(),kind:'canvas_saved',canvasId:id,title:saved.title,threadId,createdAt:saved.savedAt,source:'user_save'});
      await this._append(course,'学习进度.md',`\n- ${saved.savedAt} · 保存教学画布：${brief(saved.title)} · 画布 ${id} · 此操作不代表作答或掌握\n`);
      changed=true;return {canvas:saved};
    },{shouldSave:()=>changed});
  }
  async recordCanvasActivity(course,{canvasId,kind,label,value}) {
    if(typeof canvasId!=='string'||!/^[a-f0-9]{24}$/.test(canvasId)||!['opened','reported_interaction'].includes(kind))throw Error('画布活动无效。');
    if(kind==='reported_interaction'&&(typeof label!=='string'||!label.trim()||label.length>120||(value!==undefined&&(typeof value!=='string'||value.length>1000))))throw Error('画布交互报告无效。');
    let changed=false;
    return this._mutate(course,async s=>{
      const canvas=(s.canvases||[]).find(item=>item.id===canvasId);if(!canvas)throw Error('未找到已保存的画布。');
      const createdAt=now();
      if(kind==='opened'){
        if(canvas.lastOpenedAt&&Date.parse(createdAt)-Date.parse(canvas.lastOpenedAt)<60000)return {canvas};
        canvas.lastOpenedAt=createdAt;
        s.turns.push({id:randomUUID(),kind:'canvas_opened',canvasId,title:canvas.title,createdAt,source:'user_open'});
        await this._append(course,'学习进度.md',`\n- ${createdAt} · 打开教学画布：${brief(canvas.title)} · 画布 ${canvasId} · 此操作不计作答\n`);
      }else{
        const next={label:label.trim(),value:value??'',createdAt,source:'animation_report'};
        if(canvas.lastReport?.label===next.label&&canvas.lastReport.value===next.value&&Date.parse(createdAt)-Date.parse(canvas.lastReport.createdAt)<5000)return {canvas};
        canvas.lastReport=next;
      }
      changed=true;return {canvas};
    },{shouldSave:()=>changed});
  }
  async registerSet(course,{threadId,itemId,spec}) {
    if (typeof threadId !== 'string' || !threadId || typeof itemId !== 'string' || !itemId) throw Error('缺少聊天或消息 ID。');
    validateStudySpec(spec);
    return this._mutate(course,s => {
      const setId = digest([course.id,threadId,itemId,spec.id || 'set']);
      const incoming = spec.items.map((q,i) => ({...q,id:digest([course.id,threadId,itemId,spec.id || 'set',q.id ?? String(i+1)]),sourceId:q.id ?? String(i+1),setId,threadId,itemId}));
      const old = s.sets.find(x => x.id === setId);
      if (old) { const existing = s.items.filter(x=>x.setId===setId); if (JSON.stringify(existing) !== JSON.stringify(incoming)) throw Error('已有题组内容发生变化，请使用新的消息 ID。'); return {set:old,items:existing.map(i=>decorated(s,i))}; }
      const set = {id:setId,threadId,itemId,title:spec.title || '',createdAt:now()}; s.sets.push(set); s.items.push(...incoming); return {set,items:incoming.map(i=>decorated(s,i))};
    });
  }
  _answerImagePaths(image) {
    if(!ANSWER_IMAGE_ID.test(image?.id)||!['.png','.jpg','.jpeg','.webp','.gif','.heic','.heif'].includes(image.originalExtension))throw Error('作答图片记录无效。');
    return {original:'.study-studio/answers/'+image.id+'.original'+image.originalExtension,preview:'.study-studio/answers/'+image.id+'.preview.png'};
  }
  async _pruneDraftAnswerImages(course,state) {
    const referenced=new Set(state.attempts.flatMap(attempt=>(attempt.images||[]).map(image=>image.id))),keep=[];
    for(const image of state.answerImages||[]){
      if(referenced.has(image.id)||!Number.isFinite(Date.parse(image.createdAt))||Date.now()-Date.parse(image.createdAt)<7*86400000){keep.push(image);continue;}
      const files=this._answerImagePaths(image);
      for(const relative of Object.values(files))await fs.rm(await this.safePath(course,relative),{force:true});
    }
    state.answerImages=keep;
  }
  async uploadAnswerImage(course,{questionId,name,mime,data}) {
    const state=await this._load(course),question=state.items.find(item=>item.id===questionId);
    if(!question||question.type!=='short_answer')throw Error('仅简答题可以上传作答图片。');
    const prepared=await prepareAnswerImage({name,mime,data});
    let written=[];
    try{return await this._mutate(course,async state=>{
      if(!state.items.some(item=>item.id===questionId&&item.type==='short_answer'))throw Error('未找到可上传图片的简答题。');
      await this._pruneDraftAnswerImages(course,state);
      const folder=await this.safePath(course,'.study-studio/answers');await fs.mkdir(folder,{recursive:true,mode:0o700});
      const image={id:randomUUID(),questionId,name:prepared.name,originalExtension:path.extname(prepared.name).toLowerCase(),originalMime:prepared.originalMime,size:prepared.bytes.length,width:prepared.width,height:prepared.height,originalWidth:prepared.originalWidth,originalHeight:prepared.originalHeight,sha256:imageDigest(prepared.bytes),previewSHA256:imageDigest(prepared.preview),previewSize:prepared.preview.length,createdAt:now(),...(prepared.warning?{warning:prepared.warning}:{})};
      const files=this._answerImagePaths(image);
      for(const [kind,relative] of Object.entries(files)){
        const absolute=await this.safePath(course,relative);await fs.writeFile(absolute,kind==='original'?prepared.bytes:prepared.preview,{flag:'wx',mode:0o600});written.push(absolute);
      }
      state.answerImages ||= [];state.answerImages.push(image);
      return {image:answerImageDescriptor(course,image)};
    });}catch(error){await Promise.allSettled(written.map(file=>fs.rm(file,{force:true})));throw error;}
  }
  async getAnswerImage(course,id) {
    if(typeof id!=='string'||!ANSWER_IMAGE_ID.test(id))throw Error('作答图片 ID 无效。');
    const state=await this._load(course),image=state.answerImages?.find(image=>image.id===id);
    if(!image)throw Error('作答图片不存在或未提交的草稿已过期。');
    const paths=this._answerImagePaths(image),content={};
    for(const [kind,relative] of Object.entries(paths)){
      const absolute=await this.safePath(course,relative),handle=await fs.open(absolute,constants.O_RDONLY|constants.O_NOFOLLOW);
      try{
        const stat=await handle.stat();if(!stat.isFile()||stat.size>MAX_ANSWER_IMAGE_BYTES||stat.size!==image[kind==='original'?'size':'previewSize'])throw Error('作答图片已变化，无法使用。');
        const data=await handle.readFile();if(imageDigest(data)!==image[kind==='original'?'sha256':'previewSHA256'])throw Error('作答图片已变化，无法使用。');
        if(kind==='preview'){content.absolutePath=absolute;content.data=data;}
      }finally{await handle.close();}
    }
    return {image:answerImageDescriptor(course,image),mime:'image/png',...content};
  }
  async removeAnswerImage(course,id) {
    if(typeof id!=='string'||!ANSWER_IMAGE_ID.test(id))throw Error('作答图片 ID 无效。');
    return this._mutate(course,async state=>{
      if(state.attempts.some(attempt=>(attempt.images||[]).some(image=>image.id===id)))throw Error('已提交作答的图片不能作为草稿删除。');
      const image=state.answerImages?.find(image=>image.id===id);if(!image)return {removed:true};
      const files=this._answerImagePaths(image);
      for(const relative of Object.values(files))await fs.rm(await this.safePath(course,relative),{force:true});
      state.answerImages=state.answerImages.filter(image=>image.id!==id);return {removed:true};
    });
  }
  async readAttemptImages(course,attemptId) {
    const state=await this._load(course),attempt=state.attempts.find(attempt=>attempt.id===attemptId);
    if(!attempt)throw Error('未找到作答。');
    const question=state.items.find(question=>question.id===attempt.questionId),images=[];
    for(const descriptor of attempt.images||[]){
      const saved=state.answerImages?.find(image=>image.id===descriptor.id);if(!saved||saved.questionId!==attempt.questionId)throw Error('作答图片不属于这道题。');
      const loaded=await this.getAnswerImage(course,saved.id);images.push({...loaded.image,absolutePath:loaded.absolutePath,data:loaded.data});
    }
    return {attempt,question,images};
  }
  async submitAttempt(course,{questionId,answer,hintUsed=false,revealed=false,clientId,imageIds=[]}) {
    if (clientId !== undefined && (typeof clientId !== 'string' || !clientId || clientId.length > 200)) throw Error('提交 ID 无效。');
    if(!Array.isArray(imageIds)||imageIds.length>MAX_ANSWER_IMAGES||new Set(imageIds).size!==imageIds.length||imageIds.some(id=>typeof id!=='string'||!ANSWER_IMAGE_ID.test(id)))throw Error('每条简答题作答最多附 4 张不同图片。');
    return this._mutate(course,async s => {
      const item=s.items.find(x=>x.id===questionId); if (!item) throw Error('未找到题目。');
      const old=clientId && s.attempts.find(x=>x.clientId===clientId);
      if (old) { if (old.questionId !== questionId || JSON.stringify(old.answer)!==JSON.stringify(answer)||JSON.stringify((old.images||[]).map(image=>image.id))!==JSON.stringify(imageIds)) throw Error('提交 ID 已用于不同答案。'); return {attempt:old,item:decorated(s,item)}; }
      if(imageIds.length&&item.type!=='short_answer')throw Error('仅简答题可以提交作答图片。');
      const images=[];
      for(const id of imageIds){const image=s.answerImages?.find(image=>image.id===id);if(!image||image.questionId!==questionId)throw Error('作答图片不属于这道题或已过期。');await this.getAnswerImage(course,id);images.push(answerImageDescriptor(course,image));}
      const grade=item.type==='short_answer'&&imageIds.length&&typeof answer==='string'?{status:'pending_feedback',correct:null}:gradeAnswer(item,answer); if (grade.status === 'invalid') throw Error('作答格式无效。');
      const attempt={id:randomUUID(),questionId,answer,...(images.length?{images}:{}),hintUsed:!!hintUsed,revealed:!!revealed || s.turns.some(e=>e.kind==='reveal' && e.questionId===questionId),clientId:clientId || null,createdAt:now(),grade,feedback:null};
      const outcome=grade.status==='graded' ? (grade.correct ? '客观题判定正确' : '客观题判定错误') : grade.status==='pending_feedback' ? '简答题等待反馈' : `闪卡自评 ${brief(answer)}（不代表掌握）`;
      await this._append(course,'学习进度.md',`\n- ${attempt.createdAt} · 作答 ${attempt.id} · 题目：${brief(item.prompt)} · ${outcome}${images.length?` · 图片作答 ${images.length} 张`:''} · ${attempt.hintUsed?'使用过提示':'未记录使用提示'} · ${attempt.revealed?'作答前已揭晓':'未记录事先揭晓'}\n`);
      s.attempts.push(attempt); return {attempt,item:decorated(s,item)};
    });
  }
  async reveal(course,questionId) { return this._mutate(course,async s=>{ const item=s.items.find(x=>x.id===questionId); if (!item) throw Error('未找到题目。'); const event={id:randomUUID(),questionId,createdAt:now(),kind:'reveal'}; await this._append(course,'学习进度.md',`\n- ${event.createdAt} · 揭晓 ${event.id} · 题目：${brief(item.prompt)} · 此操作不计作答\n`); s.turns.push(event); return event; }); }
  async applyFeedback(course,{attemptId,feedback,correct,score}) { return this._mutate(course,async s=>{ const a=s.attempts.find(x=>x.id===attemptId); if (!a) throw Error('未找到作答。'); if (typeof feedback !== 'string' || !feedback.trim() || feedback.length > 12000 || (correct !== undefined && typeof correct !== 'boolean') || (score !== undefined && (typeof score !== 'number' || !Number.isFinite(score)))) throw Error('反馈无效。'); const entry={text:feedback,correct:correct ?? null,score:score ?? null,createdAt:now(),source:'agent'}; const item=s.items.find(x=>x.id===a.questionId); await this._append(course,'学习进度.md',`\n- ${entry.createdAt} · AI 反馈 · 作答 ${a.id} · 题目：${brief(item?.prompt)} · ${brief(feedback)}${correct===undefined?'':` · AI 判断：${correct?'正确':'错误'}`}${score===undefined?'':` · AI 评分：${score}`}\n`); a.feedbackHistory ||= []; a.feedbackHistory.push(entry); a.feedback=entry; return {attempt:a,feedback:entry}; }); }
  async scanWorkspace(course) {
    const key=this.coursePath(course)+'\0'+course.id;if(this.scans.has(key))return this.scans.get(key);
    const job=this._scanWorkspace(course);this.scans.set(key,job);try{return await job}finally{if(this.scans.get(key)===job)this.scans.delete(key);}
  }
  async _scanWorkspace(course) {
    await this._load(course);const files=[],folders=[{path:'',name:'全部资料',kind:'material'}];
    const walk=async(relative,depth)=>{
      const dir=await this.safePath(course,relative);
      for(const entry of await fs.readdir(dir,{withFileTypes:true})){
        if(entry.name.startsWith('.')||entry.isSymbolicLink())continue;
        const relativePath=relative?`${relative}/${entry.name}`:entry.name;
        if(entry.isDirectory()){
          if(depth<5&&folders.length<500){await this.safePath(course,relativePath);folders.push({path:relativePath,name:entry.name,kind:relativePath.split('/').some(segment=>segment==='课件'||segment.toLowerCase()==='courseware')?'courseware':'material'});}
          if(depth<5&&files.length<500)await walk(relativePath,depth+1);
        }else if(entry.isFile()&&files.length<500){const stat=await fs.stat(await this.safePath(course,relativePath));if(stat.isFile())files.push({relativePath,name:entry.name,size:stat.size,identity:`${stat.dev}:${stat.ino}`});}
      }
    };
    await walk('',0);return {files,folders};
  }
  async listFiles(course) { return (await this.scanWorkspace(course)).files; }
  async makeFolder(course,folder) {
    if(typeof folder!=='string'||path.isAbsolute(folder)||folder.includes('\\')||folder.split('/').some(x=>!x||x==='.'||x==='..'||x.startsWith('.')||/[\x00-\x1f]/.test(x))||folder.length>500) throw Error('文件夹路径无效。');
    await this.initCourse(course); let current=''; for(const part of folder.split('/')) {current=current?`${current}/${part}`:part; const target=await this.safePath(course,current); try{await fs.mkdir(target)}catch(e){if(e.code!=='EEXIST')throw e;if(!(await fs.lstat(target)).isDirectory())throw Error('文件夹路径被文件占用。');}} return folder;
  }
  async listFolders(course) { return (await this.scanWorkspace(course)).folders; }
  async listSources(course) {
    const files=(await this.listFiles(course)).filter(file=>!internalFiles.has(file.relativePath));
    return this.indexSources(course,files);
  }
  async indexSources(course,files) {
    let changed=false;return this._mutate(course,async s=>{
      if(!s.sourceIndex){s.sourceIndex=[];changed=true;}const currentIdentityByPath=new Map(files.map(f=>[f.relativePath,f.identity])),used=new Set(),selection=s.sourceSelection||{};
      const result=[];for(const f of files){
        let record=s.sourceIndex.find(x=>!used.has(x.id)&&x.relativePath===f.relativePath&&x.identity===f.identity);
        if(!record){for(const candidate of s.sourceIndex.filter(x=>!used.has(x.id)&&x.identity===f.identity&&currentIdentityByPath.get(x.relativePath)!==x.identity)){let stillExists=false;try{const st=await fs.lstat(await this.safePath(course,candidate.relativePath));stillExists=!st.isSymbolicLink()&&`${st.dev}:${st.ino}`===candidate.identity}catch(e){if(e.code!=='ENOENT')throw e}if(!stillExists){record=candidate;break}}}
        if(!record){let id=digest([course.id,'source',f.relativePath]);if(s.sourceIndex.some(x=>x.id===id))id=digest([course.id,'source',randomUUID()]);record={id,relativePath:f.relativePath,identity:f.identity,attachmentId:s.attachments.find(a=>a.relativePath===f.relativePath)?.id||null};s.sourceIndex.push(record);changed=true;}
        used.add(record.id);if(record.relativePath!==f.relativePath||record.identity!==f.identity)changed=true;record.relativePath=f.relativePath;record.identity=f.identity;
        const attachment=record.attachmentId&&s.attachments.find(a=>a.id===record.attachmentId);if(attachment&&attachment.relativePath!==f.relativePath){attachment.relativePath=f.relativePath;changed=true;}
        const folder=path.dirname(f.relativePath)==='.'?'':path.dirname(f.relativePath);const ext=path.extname(f.name).toLowerCase(),kind=folder.split('/').some(x=>x==='课件'||x.toLowerCase()==='courseware')||['.ppt','.pptx'].includes(ext)?'courseware':'material';
        result.push({id:record.id,name:f.name,originalName:attachment?.name||f.name,relativePath:f.relativePath,path:f.relativePath,folder,category:folder,kind,mime:ext==='.pdf'?'application/pdf':attachment?.mime||mimeTypes[ext]||'application/octet-stream',attachmentId:attachment?.id||null,url:`/api/courses/${encodeURIComponent(course.id)}/sources/${record.id}/file`,size:f.size,selected:selection[record.id]!==false});
      }return result;
    },{shouldSave:()=>changed,ensureTemplates:false});
  }
  async sourceForPath(course,relativePath) {
    if(typeof relativePath!=='string'||!relativePath||relativePath.split(/[\\/]/).some(x=>x.startsWith('.')))throw Error('资料路径无效。');
    const file=await this.safePath(course,relativePath),st=await fs.stat(file);if(!st.isFile())throw Error('资料不是文件。');
    return (await this.indexSources(course,[{relativePath,name:path.basename(relativePath),size:st.size,identity:`${st.dev}:${st.ino}`}]))[0];
  }
  async sourceById(course,id) {const s=await this._load(course);const record=s.sourceIndex?.find(x=>x.id===id);if(!record)return null;try{const source=await this.sourceForPath(course,record.relativePath);return source.id===id?source:null}catch(e){if(e.code==='ENOENT')return null;throw e}}
  async listWorkspace(course,{path:relative='',offset=0,limit=100}={}) {
    if(typeof relative!=='string'||relative.split(/[\\/]/).some(x=>x.startsWith('.')&&x!=='')||!Number.isInteger(offset)||offset<0||!Number.isInteger(limit)||limit<1||limit>200)throw Error('资料目录分页参数无效。');
    await this.initCourse(course);const dir=await this.safePath(course,relative),all=(await fs.readdir(dir,{withFileTypes:true})).filter(e=>!e.name.startsWith('.')&&!e.isSymbolicLink()&&(e.isFile()||e.isDirectory())).sort((a,b)=>a.name.localeCompare(b.name,'zh-CN'));
    const selected=all.slice(offset,offset+limit),files=[],folders=[],fileEntries=[];
    for(const e of selected){const p=relative?`${relative}/${e.name}`:e.name;if(e.isDirectory()){await this.safePath(course,p);folders.push({path:p,name:e.name});}else if(internalFiles.has(p)){files.push({relativePath:p,name:e.name,kind:'state'});}else{const st=await fs.stat(await this.safePath(course,p));if(!st.isFile())throw Error('资料不是文件。');fileEntries.push({relativePath:p,name:e.name,size:st.size,identity:`${st.dev}:${st.ino}`});}}
    if(fileEntries.length)files.push(...await this.indexSources(course,fileEntries));
    const next=offset+selected.length;return {path:relative,files,folders,hasMore:next<all.length,nextOffset:next<all.length?next:null};
  }
  async selectSources(course,sourceIds) {
    if(!Array.isArray(sourceIds)||sourceIds.some(x=>typeof x!=='string')||new Set(sourceIds).size!==sourceIds.length) throw Error('资料选择无效。');
    const available=await this.listSources(course), valid=new Set(available.map(s=>s.id)); if(sourceIds.some(id=>!valid.has(id))) throw Error('所选资料不存在。');
    await this._mutate(course,s=>{s.sourceSelection ||= {}; for(const x of available) s.sourceSelection[x.id]=sourceIds.includes(x.id);}); return this.listSources(course);
  }
  async selectedSourceRead(course,relativePath) {
    if(internalFiles.has(relativePath)) return this.readFile(course,relativePath);
    const src=(await this.listSources(course)).find(x=>x.relativePath===relativePath); if(!src||!src.selected) throw Error('资料不存在或未被选中。');
    return {...await this.readFile(course,src.relativePath),sourceId:src.id,sourceName:src.name};
  }
  async workspaceRead(course,relativePath) {
    if(internalFiles.has(relativePath))return this.readFile(course,relativePath);
    const src=await this.sourceForPath(course,relativePath);
    return {...await this.readFile(course,src.relativePath),sourceId:src.id,sourceName:src.name};
  }
  async getReader(course) {
    const s=await this._load(course);if(!s.reader)return null;const source=await this.sourceById(course,s.reader.sourceId);if(!source)return null;
    const reader=await this._readerAt(course,source,s.reader.page,{clamp:true});
    if(reader.page!==s.reader.page||reader.pages!==s.reader.pages){
      let changed=false;await this._mutate(course,current=>{
        if(current.reader?.sourceId!==s.reader.sourceId||current.reader.page!==s.reader.page)return;
        current.reader={sourceId:reader.sourceId,page:reader.page,pages:reader.pages};
        current.readingPositions ||= {};current.readingPositions[reader.sourceId]={page:reader.page};changed=true;
      },{shouldSave:()=>changed,ensureTemplates:false});
    }
    return reader;
  }
  async resolveReader(course,{sourceId,page}) {
    if(sourceId===null)return null;
    if(typeof sourceId!=='string'||(page!==undefined&&(!Number.isInteger(page)||page<1)))throw Error('课件或页码无效。');
    const source=await this.sourceById(course,sourceId);if(!source)throw Error('课件不存在。');
    if(page===undefined){const s=await this._load(course);const saved=s.readingPositions?.[sourceId]?.page??(s.reader?.sourceId===sourceId?s.reader.page:1);return this._readerAt(course,source,saved,{clamp:true});}
    return this._readerAt(course,source,page);
  }
  async _readerAt(course,source,page,{clamp=false}={}) {
    if(path.extname(source.relativePath).toLowerCase()!=='.pdf')throw Error('当前阅读器仅支持 PDF；PPTX 请先转换为 PDF。');
    const {pages}=await pdfInfo(await this.safePath(course,source.relativePath));
    if(clamp)page=Number.isInteger(page)?Math.max(1,Math.min(page,pages)):1;
    else if(page>pages)throw Error('PDF 页码超出范围。');
    return {sourceId:source.id,page,pages,name:source.name,url:source.url,folder:source.folder,source};
  }
  async setReader(course,request) {
    const reader=await this.resolveReader(course,request);
    await this._mutate(course,s=>{
      s.readingPositions ||= {};
      if(s.reader)s.readingPositions[s.reader.sourceId]={page:s.reader.page};
      if(reader)s.readingPositions[reader.sourceId]={page:reader.page};
      s.reader=reader?{sourceId:reader.sourceId,page:reader.page,pages:reader.pages}:null;
    });
    return reader;
  }
  async updateMemory(course,{operation,category,id,text,source,evidence}) {
    if(!['upsert','delete'].includes(operation)||!['preferences','courseRules'].includes(category)||typeof id!=='string'||! /^[\w.-]{1,100}$/.test(id)) throw Error('记忆操作无效。');
    if(operation==='upsert' && (typeof text!=='string'||!text.trim()||text.length>2000||typeof source!=='string'||!source.trim()||source.length>500||typeof evidence!=='string'||!evidence.trim()||evidence.length>1000)) throw Error('记忆必须包含内容、来源和真实依据。');
    if([text,source,evidence].some(x=>typeof x==='string' && (x.includes(memoryStart)||x.includes(memoryEnd)))) throw Error('记忆内容包含保留标记。');
    return this._mutate(course,async s=>{
      s.memory ||= {preferences:[],courseRules:[],history:[]}; const list=s.memory[category], old=list.find(x=>x.id===id);
      if(operation==='delete'&&!old)return {changed:false,operation,id};
      const entry=operation==='upsert'?{id,text:text.trim(),source:source.trim(),evidence:evidence.trim()}:null;
      if(old && entry && JSON.stringify(old)===JSON.stringify(entry))return {changed:false,operation,id};
      const instructions=await this.readInstructions(course), start=instructions.content.indexOf(memoryStart),end=instructions.content.indexOf(memoryEnd);
      if((start===-1)!==(end===-1) || (start!==-1&&(end<start||instructions.content.indexOf(memoryStart,start+1)!==-1||instructions.content.indexOf(memoryEnd,end+1)!==-1))) throw Error('课程记忆区标记异常，已保护原文。');
      if(start===-1 && (s.memory.preferences.length||s.memory.courseRules.length)) throw Error('课程记忆区已被移除，请先核对原文。');
      if(start!==-1 && instructions.content.slice(start,end+memoryEnd.length)!==renderMemory(s.memory)) throw Error('课程记忆区已被手动修改，已保护原文。');
      if(old) list.splice(list.indexOf(old),1); if(entry)list.push(entry);
      if(operation==='delete') s.memory.history=s.memory.history.filter(h=>!(h.category===category&&h.id===id));
      s.memory.history.push({operation,category,id,createdAt:now(),...(operation==='upsert'?{before:old||null,after:entry}:{})});
      const lines=renderMemory(s.memory);
      const content=start===-1?instructions.content.replace(/\s*$/,'')+'\n\n'+lines+'\n':instructions.content.slice(0,start)+lines+instructions.content.slice(end+memoryEnd.length);
      if(content.length>100000)throw Error('课程说明超过长度限制。');
      const target=await this.safePath(course,'AGENTS.md'),mode=(await fs.stat(target)).mode&0o777,tmp=await this.safePath(course,`.study-studio/memory-${randomUUID()}.tmp`);
      try{await fs.writeFile(tmp,content,{flag:'wx',mode});await this.safePath(course,'AGENTS.md');if(digest(await fs.readFile(target,'utf8'))!==instructions.version)throw Error('课程说明已被修改，请重试。');await fs.rename(tmp,target);}finally{await fs.rm(tmp,{force:true});}
      return {changed:true,operation,category,id,entry};
    });
  }
  async _nativeText(course,relativePath,limit=100000) {
    const target=await this.safePath(course,relativePath);let handle;
    try{handle=await fs.open(target,constants.O_RDONLY|constants.O_NOFOLLOW)}catch(error){if(error.code!=='ENOENT'||!Object.hasOwn(templates,relativePath))throw error;try{await fs.writeFile(target,templates[relativePath],{flag:'wx',mode:0o600})}catch(writeError){if(writeError.code!=='EEXIST')throw writeError}handle=await fs.open(await this.safePath(course,relativePath),constants.O_RDONLY|constants.O_NOFOLLOW);}
    try{
      const stat=await handle.stat();if(!stat.isFile()||stat.size>MAX_MATERIAL_BYTES)throw Error('文件不存在或超过 '+MATERIAL_SIZE_LABEL+'。');
      const data=Buffer.alloc(Math.min(stat.size,(limit+1)*4)),{bytesRead}=await handle.read(data,0,data.length,0);
      let decoded;try{decoded=new TextDecoder('utf-8',{fatal:true}).decode(data.subarray(0,bytesRead),{stream:bytesRead<stat.size});}catch{return {relativePath,kind:'text',text:'',truncated:false,warning:'文本编码无法按 UTF-8 读取；原文件仍然保留。'};}
      const characters=Array.from(decoded),truncated=bytesRead<stat.size||characters.length>limit;
      return {relativePath,kind:'text',text:characters.slice(0,limit).join(''),truncated,warning:truncated?`提取文字超过 ${limit} 字符，已截断。`:null};
    }finally{await handle.close();}
  }
  async readFile(course,relativePath) {
    await this._load(course); const target=await this.safePath(course,relativePath); const st=await fs.stat(target);
    if (!st.isFile() || st.size>MAX_MATERIAL_BYTES) throw Error('文件不存在或超过 '+MATERIAL_SIZE_LABEL+'。');
    const ext=path.extname(target).toLowerCase();
    if (['.png','.jpg','.jpeg','.webp','.gif'].includes(ext)) return {relativePath,kind:'image',absolutePath:target,text:'',warning:null};
    if(nativeTextExtensions.has(ext))return this._nativeText(course,relativePath);
    const python=process.env.STUDY_EXTRACT_PYTHON || '/usr/bin/python3';
    try { const {stdout}=await exec(python,['-B',extractor,target],{timeout:15000,maxBuffer:600000}); const result=JSON.parse(stdout); return {relativePath,kind:'text',...result}; } catch { return {relativePath,kind:'text',text:'',warning:'文本提取不可用；原文件仍然保留。'}; }
  }
  async upload(course,{name,mime,data,folder='附件'}) {
    if (!Buffer.isBuffer(data) || data.length>MAX_MATERIAL_BYTES || !data.length || typeof name !== 'string' || !name || name.startsWith('.') || name.length>240 || /[\/\\\x00-\x1f]/.test(name)) throw Error('附件无效或超过 '+MATERIAL_SIZE_LABEL+'。');
    if(folder)await this.makeFolder(course,folder);else await this.initCourse(course);
    return this._mutate(course,async s=>{ const id=randomUUID(),ext=path.extname(name),stem=name.slice(0,name.length-ext.length);let relativePath,dest;for(let n=0;n<10000;n++){const filename=n?`${stem} (${n})${ext}`:name;relativePath=folder?`${folder}/${filename}`:filename;if(internalFiles.has(relativePath))continue;dest=await this.safePath(course,relativePath);try{await fs.writeFile(dest,data,{flag:'wx',mode:0o600});break}catch(e){if(e.code!=='EEXIST'||n===9999)throw e;}}if(!dest)throw Error('无法保存附件。');const info={id,name,mime:typeof mime==='string'?mime.slice(0,200):'application/octet-stream',relativePath,size:data.length,createdAt:now()};s.attachments.push(info);return info; });
  }
  async attachment(course,id) { await this.listSources(course); const s=await this._load(course); const info=s.attachments.find(x=>x.id===id); if (!info) throw Error('未找到附件。'); return {...info,absolutePath:await this.safePath(course,info.relativePath)}; }
  async moveSource(course,{sourceId,folder}) {
    if(typeof folder!=='string')throw Error('目标文件夹无效。');if(folder)await this.makeFolder(course,folder);
    const source=await this.sourceById(course,sourceId);if(!source)throw Error('资料不存在。');
    if(source.folder===folder)return source;
    const from=await this.safePath(course,source.relativePath),filename=path.basename(source.relativePath),ext=path.extname(filename),stem=filename.slice(0,filename.length-ext.length);let target,movedPath;
    for(let n=0;n<10000;n++){
      const name=n?`${stem} (${n})${ext}`:filename,relativePath=folder?`${folder}/${name}`:name;
      if(internalFiles.has(relativePath))continue;
      target=await this.safePath(course,relativePath);
      try{await fs.link(from,target);movedPath=relativePath;break}catch(e){target=null;if(e.code!=='EEXIST'||n===9999)throw e;}
    }
    if(!target)throw Error('无法找到可用的资料名称。');
    try{await fs.unlink(from)}catch(e){await fs.unlink(target).catch(()=>{});throw e;}
    await this._mutate(course,s=>{const record=s.sourceIndex.find(x=>x.id===sourceId);record.relativePath=movedPath;const attachment=record.attachmentId&&s.attachments.find(x=>x.id===record.attachmentId);if(attachment)attachment.relativePath=movedPath;});
    return this.sourceById(course,sourceId);
  }
  async listMemory(course) { const s=await this._load(course),memory=s.memory||{}; return ['preferences','courseRules'].flatMap(category=>(memory[category]||[]).map(entry=>({...entry,category}))); }
  async readInstructions(course,{state}={}) {
    if(!state)await this._load(course);else if(state.courseId!==course.id)throw Error('课程状态无效。');
    const target=await this.safePath(course,'AGENTS.md');let handle;
    try{handle=await fs.open(target,constants.O_RDONLY|constants.O_NOFOLLOW)}catch(error){if(error.code!=='ENOENT')throw error;await this._nativeText(course,'AGENTS.md');handle=await fs.open(await this.safePath(course,'AGENTS.md'),constants.O_RDONLY|constants.O_NOFOLLOW);}
    try{const stat=await handle.stat();if(!stat.isFile()||stat.size>400004)throw Error('课程 AGENTS.md 超过 100000 字符，请缩短后再继续。');const content=await handle.readFile('utf8');if(content.length>100000)throw Error('课程 AGENTS.md 超过 100000 字符，请缩短后再继续。');return {content,version:digest(content),workspacePath:this.coursePath(course)};}finally{await handle.close();}
  }
  async updateInstructions(course,{content,version}) {
    if (typeof content!=='string' || content.length>100000 || typeof version!=='string') throw Error('课程说明无效。');
    return this._mutate(course,async()=>{ const target=await this.safePath(course,'AGENTS.md'); const current=await fs.readFile(target,'utf8'); if(digest(current)!==version) throw Error('课程说明已被其他操作修改，请重新读取后再保存。'); const mode=(await fs.stat(target)).mode & 0o777; const tmp=await this.safePath(course,`.study-studio/instructions-${randomUUID()}.tmp`); try { await fs.writeFile(tmp,content,{flag:'wx',mode}); await this.safePath(course,'AGENTS.md'); if(digest(await fs.readFile(target,'utf8'))!==version) throw Error('课程说明已被其他操作修改，请重新读取后再保存。'); await fs.rename(tmp,target); } finally { await fs.rm(tmp,{force:true}); } return {content,version:digest(content),workspacePath:this.coursePath(course)}; });
  }
  async _append(course,name,text) { const target=await this.safePath(course,name); const h=await fs.open(target,constants.O_WRONLY|constants.O_APPEND|constants.O_NOFOLLOW); try { await h.writeFile(text); } finally { await h.close(); } }
  async _textTail(course,name,chars=20000) { const target=await this.safePath(course,name); const h=await fs.open(target,constants.O_RDONLY|constants.O_NOFOLLOW); try { const size=(await h.stat()).size, bytes=Math.min(size,chars*4), buffer=Buffer.alloc(bytes); const {bytesRead}=await h.read(buffer,0,bytes,size-bytes); return buffer.subarray(0,bytesRead).toString('utf8').slice(-chars); } finally { await h.close(); } }
  async addCourseNote(course,{text,source='',kind='AI 归纳（待核实）'}) { if (typeof text!=='string'||!text.trim()||text.length>20000) throw Error('记录内容无效。'); return this._mutate(course,async s=>{const entry={id:randomUUID(),text,source:String(source).slice(0,1000),kind:String(kind).slice(0,100),createdAt:now()}; await this._append(course,'课程重要信息.md',`\n## ${entry.createdAt} · ${entry.kind}\n\n${text}\n\n来源：${entry.source || '未注明'}\n`); return entry;}); }
  async recordTurn(course,{threadId,text}) { if(typeof threadId!=='string'||!threadId||typeof text!=='string'||!text.trim()||text.length>4000) throw Error('学习记录无效。'); return this._mutate(course,async s=>{ const entry={id:randomUUID(),threadId,text,createdAt:now(),kind:'learning_event'}; s.turns.push(entry); await this._append(course,'学习进度.md',`\n- ${entry.createdAt}：${text}\n`); return entry; }); }
  async learning(course) {
    const state=await this._load(course),[progress,importantInfo]=await Promise.all([this._nativeText(course,'学习进度.md'),this._nativeText(course,'课程重要信息.md')]);
    return {items:state.items.map(item=>decorated(state,item)),attempts:state.attempts,canvases:state.canvases||[],progress:progress.text,importantInfo:importantInfo.text,workspacePath:this.coursePath(course)};
  }
  async contextSnapshot(course) {
    // A chat sent immediately after submission must not snapshot a queued write.
    while(this.locks.has(this.coursePath(course)))await this.locks.get(this.coursePath(course)).catch(()=>{});
    const state=await this._load(course),[instructions,scan]=await Promise.all([this.readInstructions(course,{state}),this.scanWorkspace(course)]),files=await this.indexSources(course,scan.files.filter(file=>!internalFiles.has(file.relativePath))),folders=scan.folders;
    return {context:await this.context(course,{state,instructions,files,folders,includeInstructions:false,omitRequirementsHistory:true}),coursePolicy:instructions.content,instructions,state,files,folders};
  }
  async context(course,{state,instructions,files,folders,includeInstructions=true,omitRequirementsHistory=false}={}) {
    const s=state||await this._load(course);if(s.courseId!==course.id)throw Error('课程状态无效。');
    const policy=instructions||await this.readInstructions(course,{state:s});
    let scan;if(!files||!folders)scan=await this.scanWorkspace(course);
    if(!files)files=await this.indexSources(course,scan.files.filter(file=>!internalFiles.has(file.relativePath)));
    if(!folders)folders=scan.folders;
    let important;
    if(omitRequirementsHistory){
      let handle;try{handle=await fs.open(await this.safePath(course,'课程重要信息.md'),constants.O_RDONLY|constants.O_NOFOLLOW)}catch(error){if(error.code!=='ENOENT')throw error;await this._nativeText(course,'课程重要信息.md');handle=await fs.open(await this.safePath(course,'课程重要信息.md'),constants.O_RDONLY|constants.O_NOFOLLOW);}
      try{const stat=await handle.stat();if(!stat.isFile()||stat.size>MAX_MATERIAL_BYTES)throw Error('课程重要信息文件不存在或超过 '+MATERIAL_SIZE_LABEL+'。');important=await handle.readFile('utf8');}finally{await handle.close();}
      const startMarker='<!-- STUDY-STUDIO REQUIREMENTS START -->',endMarker='<!-- STUDY-STUDIO REQUIREMENTS END -->',start=important.indexOf(startMarker),end=important.indexOf(endMarker);
      if(start!==-1&&end>start&&important.indexOf(startMarker,start+startMarker.length)===-1&&important.indexOf(endMarker,end+endMarker.length)===-1)important=important.slice(0,start)+important.slice(end+endMarker.length);
      important=important.slice(-20000)+'\n课程要求当前版本在本轮结构记录中提供；完整更正历史可按需读取课程重要信息.md。';
    }else{try{important=await this._textTail(course,'课程重要信息.md')}catch(error){if(error.code!=='ENOENT')throw error;important=(await this._nativeText(course,'课程重要信息.md')).text;}}
    const questions=new Map(),attempts=s.attempts.slice(-12).map(attempt=>{
      const question=s.items.find(item=>item.id===attempt.questionId);
      if(question&&!questions.has(question.id))questions.set(question.id,{id:question.id,prompt:question.prompt,type:question.type,options:question.options,multiple:question.multiple,expected_answer:question.answer,acceptedAnswers:question.acceptedAnswers,rubric:question.rubric,explanation:question.explanation});
      return {attemptId:attempt.id,questionId:question?.id||null,user_answer:attempt.answer,...(attempt.images?.length?{answer_images:attempt.images,image_content:'尚未查看图片；点评前必须读取本条作答的实际图片。'}:{}),grade:attempt.grade,hintUsed:attempt.hintUsed,revealed:attempt.revealed,feedback:attempt.feedback,createdAt:attempt.createdAt};
    });
    const reportIds=new Set((s.canvases||[]).filter(canvas=>canvas.lastReport).sort((a,b)=>Date.parse(b.lastReport.createdAt)-Date.parse(a.lastReport.createdAt)).slice(0,3).map(canvas=>canvas.id));
    const canvases=(s.canvases||[]).slice(-20).map(({id,title,savedAt,lastOpenedAt,lastReport})=>({id,title,savedAt,...(lastOpenedAt?{lastOpenedAt}:{}),...(lastReport&&reportIds.has(id)?{lastReport:{...lastReport,value:lastReport.value.slice(0,500),...(lastReport.value.length>500?{truncated:true}:{})}}:{})}));
    const manifest={folders:[],files:[],truncated:false},budget=16000;
    for(const folder of folders){const entry={path:folder.path,kind:folder.kind};if(JSON.stringify(manifest.folders).length+JSON.stringify(entry).length>4000){manifest.truncated=true;break}manifest.folders.push(entry);}
    for(const file of files){const entry={id:file.id,path:file.relativePath,kind:file.kind};if(JSON.stringify(manifest).length+JSON.stringify(entry).length>budget){manifest.truncated=true;break}manifest.files.push(entry);}
    return `课程工作区：${this.coursePath(course)}${includeInstructions?`\n\n课程说明：\n${policy.content}`:''}\n\n课程重要信息（按记录中的来源判断，未标明来源的内容需核实）：\n${important}\n\n最近真实学习记录：\n${JSON.stringify(s.turns.slice(-12))}\n\n最近真实作答（questions 为参考题目，未必经过核实；attempts.user_answer 是完整实际作答，自评不代表掌握）：\n${JSON.stringify({questions:[...questions.values()],attempts})}\n\n已保存教学画布（最近 20 个，仅元数据；保存和打开不代表掌握。lastReport 由动画自行上报，不是真实作答证据，不能据此判分或推定掌握）：\n${JSON.stringify(canvases)}\n\n课程资料与文件夹目录（仅路径，尚未读取；truncated 为 true 时用目录工具继续读取）：\n${JSON.stringify(manifest)}`;
  }
}
