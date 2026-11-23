import {MAX_MATERIAL_BYTES,MATERIAL_SIZE_LABEL} from '../shared/file-limits.mjs';
import { promises as fs, constants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { validateStudySpec, gradeAnswer, checkedCategory, categoryKey, normalizeCategoryText } from '../shared/study-schema.mjs';
import { validateCanvasSpec } from '../shared/canvas-schema.mjs';
import { pdfInfo } from './pdf-reader.mjs';
import {validateCoursewareUpload} from './upload-policy.mjs';
import {prepareAnswerImage,MAX_ANSWER_IMAGE_BYTES,MAX_ANSWER_IMAGES,ANSWER_IMAGE_ID} from './answer-images.mjs';

const exec = promisify(execFile);
const extractor = fileURLToPath(new URL('./file-extract.py', import.meta.url));
const now = () => new Date().toISOString();
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);
const blank = () => ({version:1, courseId:null, sets:[], items:[], attempts:[], attachments:[], turns:[], readingPositions:{}, canvases:[], practiceCategories:[], deletedQuestionIds:[]});
const PRACTICE_META_KEYS = new Set(['unit', 'knowledgePoint', 'organizedBy', 'organizedAt', 'editedAt', 'createdAt']);
const stripPracticeMeta = item => Object.fromEntries(Object.entries(item).filter(([key]) => !PRACTICE_META_KEYS.has(key)));
const memoryStart='<!-- STUDY-STUDIO MEMORY START -->', memoryEnd='<!-- STUDY-STUDIO MEMORY END -->';
const internalFiles=new Set(['AGENTS.md','学习进度.md','课程重要信息.md']);
const internalFilesLower=new Set([...internalFiles].map(name=>name.toLowerCase()));
const nativeTextExtensions=new Set(['.txt','.md','.markdown','.html','.htm','.csv','.json','.tex','.tsv']);
const agentWritableExtensions=new Set(['.md','.markdown','.html','.htm','.txt','.csv','.tsv','.json','.tex']);
const MAX_AGENT_FILE_BYTES=500*1024;
const mimeTypes={'.pdf':'application/pdf','.txt':'text/plain','.md':'text/markdown','.markdown':'text/markdown','.html':'text/html','.htm':'text/html','.csv':'text/csv','.tsv':'text/tab-separated-values','.json':'application/json','.tex':'text/plain','.docx':'application/vnd.openxmlformats-officedocument.wordprocessingml.document','.pptx':'application/vnd.openxmlformats-officedocument.presentationml.presentation','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif'};
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
      const specHash = digest(incoming);
      const old = s.sets.find(x => x.id === setId);
      if (old) {
        const existing = s.items.filter(x=>x.setId===setId);
        if (old.specHash) {
          if (old.specHash !== specHash) throw Error('已有题组内容发生变化，请使用新的消息 ID。');
        } else {
          const deleted = new Set(s.deletedQuestionIds || []);
          const survivingIncoming = incoming.filter(item => !deleted.has(item.id));
          const anyEdited = existing.some(item => Boolean(item.editedAt));
          if (!anyEdited && JSON.stringify(existing.map(stripPracticeMeta)) !== JSON.stringify(survivingIncoming)) {
            throw Error('已有题组内容发生变化，请使用新的消息 ID。');
          }
          old.specHash = specHash;
        }
        return {set:old,items:existing.map(i=>decorated(s,i))};
      }
      const set = {id:setId,threadId,itemId,title:spec.title || '',specHash,createdAt:now()}; s.sets.push(set); s.items.push(...incoming); return {set,items:incoming.map(i=>decorated(s,i))};
    });
  }
  _collectPracticeCategories(state) {
    const map = new Map();
    const add = (unit, knowledgePoint) => {
      const u = typeof unit === 'string' ? unit.trim() : '';
      const kp = typeof knowledgePoint === 'string' ? knowledgePoint.trim() : '';
      if (!u && !kp) return;
      const key = categoryKey(u, kp);
      if (!map.has(key)) map.set(key, { unit: u, knowledgePoint: kp });
    };
    for (const entry of state.practiceCategories || []) add(entry?.unit, entry?.knowledgePoint);
    for (const item of state.items || []) add(item?.unit, item?.knowledgePoint);
    const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });
    return [...map.values()].sort((a, b) => collator.compare(a.unit, b.unit) || collator.compare(a.knowledgePoint, b.knowledgePoint));
  }
  _ensureCategoryEntry(state, { unit, knowledgePoint }) {
    if (!unit && !knowledgePoint) return;
    state.practiceCategories ||= [];
    const key = categoryKey(unit, knowledgePoint);
    if (!state.practiceCategories.some(entry => categoryKey(entry?.unit, entry?.knowledgePoint) === key)) {
      state.practiceCategories.push({ unit, knowledgePoint, createdAt: now() });
    }
  }
  async createPracticeCategory(course, input) {
    const category = checkedCategory(input, { requireAny: true });
    return this._mutate(course, s => {
      this._ensureCategoryEntry(s, category);
      return { category, categories: this._collectPracticeCategories(s) };
    });
  }
  async renamePracticeCategory(course, { oldUnit = '', oldKnowledgePoint, unit = '', knowledgePoint = '' } = {}) {
    const fromUnit = normalizeCategoryText(oldUnit);
    const unitOnly = oldKnowledgePoint === undefined;
    const fromKp = unitOnly ? '' : normalizeCategoryText(oldKnowledgePoint);
    if (!fromUnit && !fromKp) throw Object.assign(Error('未指定要修改的原分类。'), { status: 400 });
    const nextUnit = normalizeCategoryText(unit);
    const nextKp = unitOnly ? '' : normalizeCategoryText(knowledgePoint);
    if (unitOnly && !nextUnit) throw Object.assign(Error('新单元名称不能为空。'), { status: 400 });
    if (!unitOnly && !nextUnit && !nextKp) throw Object.assign(Error('请至少填写单元或知识点名称。'), { status: 400 });
    return this._mutate(course, s => {
      s.practiceCategories ||= [];
      let updatedQuestions = 0;
      const ts = now();
      if (unitOnly) {
        for (const item of s.items) {
          if ((item.unit || '').trim() === fromUnit) {
            item.unit = nextUnit;
            item.organizedBy = 'user';
            item.organizedAt = ts;
            updatedQuestions++;
          }
        }
        const dedup = new Map();
        for (const entry of s.practiceCategories) {
          const u = (entry?.unit || '').trim() === fromUnit ? nextUnit : (entry?.unit || '').trim();
          const kp = (entry?.knowledgePoint || '').trim();
          if (!u && !kp) continue;
          const key = categoryKey(u, kp);
          if (!dedup.has(key)) dedup.set(key, { unit: u, knowledgePoint: kp, createdAt: entry?.createdAt || ts });
        }
        s.practiceCategories = [...dedup.values()];
      } else {
        const oldKey = categoryKey(fromUnit, fromKp);
        for (const item of s.items) {
          if (categoryKey(item.unit, item.knowledgePoint) === oldKey) {
            item.unit = nextUnit;
            item.knowledgePoint = nextKp;
            item.organizedBy = 'user';
            item.organizedAt = ts;
            updatedQuestions++;
          }
        }
        const dedup = new Map();
        for (const entry of s.practiceCategories) {
          const isTarget = categoryKey(entry?.unit, entry?.knowledgePoint) === oldKey;
          const u = isTarget ? nextUnit : (entry?.unit || '').trim();
          const kp = isTarget ? nextKp : (entry?.knowledgePoint || '').trim();
          if (!u && !kp) continue;
          const key = categoryKey(u, kp);
          if (!dedup.has(key)) dedup.set(key, { unit: u, knowledgePoint: kp, createdAt: entry?.createdAt || ts });
        }
        const nextKey = categoryKey(nextUnit, nextKp);
        if (!dedup.has(nextKey)) dedup.set(nextKey, { unit: nextUnit, knowledgePoint: nextKp, createdAt: ts });
        s.practiceCategories = [...dedup.values()];
      }
      return { updatedQuestions, categories: this._collectPracticeCategories(s) };
    });
  }
  async deletePracticeCategory(course, { unit = '', knowledgePoint } = {}) {
    const targetUnit = normalizeCategoryText(unit);
    const unitOnly = knowledgePoint === undefined;
    const targetKp = unitOnly ? '' : normalizeCategoryText(knowledgePoint);
    if (!targetUnit && !targetKp) throw Object.assign(Error('未指定要删除的分类。'), { status: 400 });
    return this._mutate(course, s => {
      let clearedQuestions = 0;
      const matches = (u, kp) => unitOnly ? (u || '').trim() === targetUnit : categoryKey(u, kp) === categoryKey(targetUnit, targetKp);
      for (const item of s.items) {
        if (matches(item.unit, item.knowledgePoint)) {
          delete item.unit;
          delete item.knowledgePoint;
          delete item.organizedBy;
          delete item.organizedAt;
          clearedQuestions++;
        }
      }
      s.practiceCategories = (s.practiceCategories || []).filter(entry => !matches(entry?.unit, entry?.knowledgePoint));
      return { deleted: true, clearedQuestions, categories: this._collectPracticeCategories(s) };
    });
  }
  async categorizeQuestions(course, { questionIds, unit = '', knowledgePoint = '', organizedBy = 'user' } = {}) {
    if (!Array.isArray(questionIds) || !questionIds.length || questionIds.length > 200 || questionIds.some(id => typeof id !== 'string' || !id) || new Set(questionIds).size !== questionIds.length) {
      throw Object.assign(Error('请选择要分类的题目。'), { status: 400 });
    }
    const category = checkedCategory({ unit, knowledgePoint }, { requireAny: false });
    const idSet = new Set(questionIds);
    return this._mutate(course, s => {
      const ts = now();
      let updatedCount = 0;
      for (const item of s.items) {
        if (!idSet.has(item.id)) continue;
        if (category.unit || category.knowledgePoint) {
          item.unit = category.unit;
          item.knowledgePoint = category.knowledgePoint;
          item.organizedBy = organizedBy === 'ai' ? 'ai' : 'user';
          item.organizedAt = ts;
        } else {
          delete item.unit;
          delete item.knowledgePoint;
          delete item.organizedBy;
          delete item.organizedAt;
        }
        updatedCount++;
      }
      if (!updatedCount) throw Object.assign(Error('未找到指定的题目。'), { status: 404 });
      if (category.unit || category.knowledgePoint) this._ensureCategoryEntry(s, category);
      return { updatedCount, categories: this._collectPracticeCategories(s), items: s.items.filter(item => idSet.has(item.id)).map(item => decorated(s, item)) };
    });
  }
  async applyPracticeOrganization(course, assignments) {
    if (!Array.isArray(assignments)) throw Object.assign(Error('整理结果无效。'), { status: 400 });
    const byId = new Map();
    for (const entry of assignments) {
      if (!entry || typeof entry.questionId !== 'string' || !entry.questionId) continue;
      const category = checkedCategory({ unit: entry.unit, knowledgePoint: entry.knowledgePoint }, { requireAny: false });
      if (!category.unit && !category.knowledgePoint) continue;
      byId.set(entry.questionId, category);
    }
    return this._mutate(course, s => {
      const ts = now();
      let organizedCount = 0;
      for (const item of s.items) {
        const assigned = byId.get(item.id);
        if (!assigned) continue;
        item.unit = assigned.unit;
        item.knowledgePoint = assigned.knowledgePoint;
        item.organizedBy = 'ai';
        item.organizedAt = ts;
        this._ensureCategoryEntry(s, assigned);
        organizedCount++;
      }
      return { organizedCount, totalCount: s.items.length, categories: this._collectPracticeCategories(s), items: s.items.map(item => decorated(s, item)) };
    });
  }
  async updateQuestion(course, patch = {}) {
    if (!patch || typeof patch !== 'object' || typeof patch.questionId !== 'string' || !patch.questionId) {
      throw Object.assign(Error('题目 ID 无效。'), { status: 400 });
    }
    return this._mutate(course, s => {
      const index = s.items.findIndex(item => item.id === patch.questionId);
      if (index < 0) throw Object.assign(Error('未找到指定题目。'), { status: 404 });
      const current = s.items[index];
      const next = { ...current };
      let contentChanged = false;
      if (patch.prompt !== undefined) {
        if (typeof patch.prompt !== 'string' || !patch.prompt.trim() || patch.prompt.length > 5000) throw Object.assign(Error('题干无效。'), { status: 400 });
        if (patch.prompt.trim() !== current.prompt) contentChanged = true;
        next.prompt = patch.prompt.trim();
      }
      if (patch.explanation !== undefined) {
        if (patch.explanation !== null && (typeof patch.explanation !== 'string' || patch.explanation.length > 10000)) throw Object.assign(Error('解析内容无效。'), { status: 400 });
        const cleaned = typeof patch.explanation === 'string' ? patch.explanation.trim() : '';
        if (cleaned) next.explanation = cleaned; else delete next.explanation;
        contentChanged = true;
      }
      if (patch.rubric !== undefined) {
        if (patch.rubric !== null && (typeof patch.rubric !== 'string' || patch.rubric.length > 5000)) throw Object.assign(Error('评分标准无效。'), { status: 400 });
        const cleaned = typeof patch.rubric === 'string' ? patch.rubric.trim() : '';
        if (cleaned) next.rubric = cleaned; else delete next.rubric;
        contentChanged = true;
      }
      if (patch.multiple !== undefined && current.type === 'choice') {
        if (typeof patch.multiple !== 'boolean') throw Object.assign(Error('多选标识无效。'), { status: 400 });
        next.multiple = patch.multiple;
        contentChanged = true;
      }
      if (patch.options !== undefined && current.type === 'choice') {
        next.options = patch.options;
        contentChanged = true;
      }
      if (patch.answer !== undefined) {
        next.answer = patch.answer;
        contentChanged = true;
      }
      if (patch.acceptedAnswers !== undefined && current.type === 'fill_blank') {
        if (!Array.isArray(patch.acceptedAnswers) || patch.acceptedAnswers.some(a => typeof a !== 'string')) throw Object.assign(Error('备选答案无效。'), { status: 400 });
        const cleaned = patch.acceptedAnswers.map(a => a.trim()).filter(Boolean);
        if (cleaned.length) next.acceptedAnswers = cleaned; else delete next.acceptedAnswers;
        contentChanged = true;
      }
      if (patch.unit !== undefined || patch.knowledgePoint !== undefined) {
        const category = checkedCategory({
          unit: patch.unit !== undefined ? patch.unit : (current.unit || ''),
          knowledgePoint: patch.knowledgePoint !== undefined ? patch.knowledgePoint : (current.knowledgePoint || ''),
        }, { requireAny: false });
        if (category.unit || category.knowledgePoint) {
          next.unit = category.unit;
          next.knowledgePoint = category.knowledgePoint;
          next.organizedBy = 'user';
          next.organizedAt = now();
          this._ensureCategoryEntry(s, category);
        } else {
          delete next.unit;
          delete next.knowledgePoint;
          delete next.organizedBy;
          delete next.organizedAt;
        }
      }
      const specCandidate = stripPracticeMeta(next);
      try {
        validateStudySpec({ items: [specCandidate] });
      } catch (error) {
        throw Object.assign(Error(error.message || '题目内容无效。'), { status: 400 });
      }
      if (contentChanged) next.editedAt = now();
      s.items[index] = next;
      return { item: decorated(s, next), categories: this._collectPracticeCategories(s) };
    });
  }
  async deleteQuestions(course, questionIds) {
    if (!Array.isArray(questionIds) || !questionIds.length || questionIds.length > 200 || questionIds.some(id => typeof id !== 'string' || !id) || new Set(questionIds).size !== questionIds.length) {
      throw Object.assign(Error('请选择要删除的题目。'), { status: 400 });
    }
    const idSet = new Set(questionIds);
    return this._mutate(course, async s => {
      const removed = s.items.filter(item => idSet.has(item.id));
      if (!removed.length) throw Object.assign(Error('未找到要删除的题目。'), { status: 404 });
      const removedIds = new Set(removed.map(item => item.id));
      s.items = s.items.filter(item => !removedIds.has(item.id));
      s.attempts = s.attempts.filter(attempt => !removedIds.has(attempt.questionId));
      s.turns = s.turns.filter(turn => !(turn.kind === 'reveal' && removedIds.has(turn.questionId)));
      s.deletedQuestionIds = [...new Set([...(s.deletedQuestionIds || []), ...removedIds])];
      const keepImages = [];
      for (const image of s.answerImages || []) {
        if (!removedIds.has(image.questionId)) { keepImages.push(image); continue; }
        const files = this._answerImagePaths(image);
        for (const relative of Object.values(files)) await fs.rm(await this.safePath(course, relative), { force: true });
      }
      s.answerImages = keepImages;
      return { deletedIds: [...removedIds], categories: this._collectPracticeCategories(s) };
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
        }else if(entry.isFile()&&files.length<500){const stat=await fs.stat(await this.safePath(course,relativePath));if(stat.isFile())files.push({relativePath,name:entry.name,size:stat.size,modifiedAt:stat.mtime.toISOString(),identity:`${stat.dev}:${stat.ino}`});}
      }
    };
    await walk('',0);return {files,folders};
  }
  async courseStats(course,{readonly=false}={}) {
    const workspacePath=this.coursePath(course);
    let files;
    if(readonly){
      try{const st=await fs.lstat(workspacePath);if(st.isSymbolicLink()||!st.isDirectory())return {coursewareCount:0,materialCount:0,fileCount:0,questionCount:0,totalBytes:0,workspacePath};}catch(e){if(e.code==='ENOENT')return {coursewareCount:0,materialCount:0,fileCount:0,questionCount:0,totalBytes:0,workspacePath};throw e;}
      files=[];
      const walk=async(relative,depth)=>{
        const dir=await this.safePath(course,relative);
        for(const entry of await fs.readdir(dir,{withFileTypes:true})){
          if(entry.name.startsWith('.')||entry.isSymbolicLink())continue;
          const relativePath=relative?`${relative}/${entry.name}`:entry.name;
          if(entry.isDirectory()){if(depth<5&&files.length<500)await walk(relativePath,depth+1);}
          else if(entry.isFile()&&files.length<500){const stat=await fs.stat(await this.safePath(course,relativePath));if(stat.isFile())files.push({relativePath,name:entry.name,size:stat.size});}
        }
      };
      await walk('',0);
    }else{
      files=(await this.scanWorkspace(course)).files;
    }
    let coursewareCount=0,materialCount=0,totalBytes=0;
    for(const file of files){
      if(internalFiles.has(file.relativePath))continue;
      const folder=path.dirname(file.relativePath)==='.'?'':path.dirname(file.relativePath);
      const ext=path.extname(file.name).toLowerCase();
      const inCourseware=folder.split('/').some(x=>x==='课件'||x.toLowerCase()==='courseware');
      if(inCourseware&&ext==='.pdf')coursewareCount++;else materialCount++;
      totalBytes+=file.size||0;
    }
    let questionCount=0;
    try{
      const stateHandle=await fs.open(await this.safePath(course,'.study-studio/state.json'),constants.O_RDONLY|constants.O_NOFOLLOW);
      try{const parsed=JSON.parse(await stateHandle.readFile('utf8'));if(Array.isArray(parsed?.items))questionCount=parsed.items.length;}finally{await stateHandle.close();}
    }catch{}
    return {coursewareCount,materialCount,fileCount:coursewareCount+materialCount,questionCount,totalBytes,workspacePath};
  }
  async listFiles(course) { return (await this.scanWorkspace(course)).files; }
  _validateFolderPath(folder) {
    if(typeof folder!=='string'||!folder||path.isAbsolute(folder)||folder.includes('\\')||folder.split('/').some(x=>!x||x==='.'||x==='..'||x.startsWith('.')||/[\x00-\x1f]/.test(x))||folder.length>500) throw Object.assign(Error('文件夹路径无效。'),{status:400});
    return folder;
  }
  async makeFolder(course,folder) {
    this._validateFolderPath(folder);
    await this.initCourse(course); let current=''; for(const part of folder.split('/')) {current=current?`${current}/${part}`:part; const target=await this.safePath(course,current); try{await fs.mkdir(target)}catch(e){if(e.code!=='EEXIST')throw e;if(!(await fs.lstat(target)).isDirectory())throw Error('文件夹路径被文件占用。');}} return folder;
  }
  async renameFolder(course,{path:oldPath,newPath}) {
    this._validateFolderPath(oldPath);this._validateFolderPath(newPath);
    if(oldPath===newPath)return {path:newPath,folders:await this.listFolders(course)};
    if(newPath.startsWith(`${oldPath}/`))throw Object.assign(Error('不能将分类移动到自身目录内。'),{status:400});
    await this.initCourse(course);
    const from=await this.safePath(course,oldPath);
    let fromStat;try{fromStat=await fs.lstat(from)}catch(e){if(e.code==='ENOENT')throw Object.assign(Error('分类不存在。'),{status:404});throw e;}
    if(fromStat.isSymbolicLink()||!fromStat.isDirectory())throw Object.assign(Error('无效的分类目录。'),{status:400});
    const parent=path.posix.dirname(newPath);
    if(parent&&parent!=='.')await this.makeFolder(course,parent);
    const target=await this.safePath(course,newPath);
    let caseOnly=false;
    try{
      const targetStat=await fs.lstat(target);
      if(targetStat.dev===fromStat.dev&&targetStat.ino===fromStat.ino)caseOnly=true;
      else throw Object.assign(Error('目标分类名称已存在。'),{status:409});
    }catch(e){if(e.code!=='ENOENT')throw e;}
    if(!caseOnly)await this.safePath(course,newPath);
    await fs.rename(from,target);
    const prefix=`${oldPath}/`,replacement=`${newPath}/`;
    const rewrite=value=>typeof value==='string'&&value.startsWith(prefix)?replacement+value.slice(prefix.length):value;
    await this._mutate(course,s=>{
      for(const record of s.sourceIndex||[])record.relativePath=rewrite(record.relativePath);
      for(const attachment of s.attachments||[])attachment.relativePath=rewrite(attachment.relativePath);
      for(const confirmation of Object.values(s.importConfirmations||{}))if(confirmation)confirmation.relativePath=rewrite(confirmation.relativePath);
    });
    return {path:newPath,folders:await this.listFolders(course)};
  }
  async deleteFolder(course,folderPath) {
    this._validateFolderPath(folderPath);
    await this.initCourse(course);
    const dir=await this.safePath(course,folderPath);
    let stat;try{stat=await fs.lstat(dir)}catch(e){if(e.code==='ENOENT')throw Object.assign(Error('分类不存在。'),{status:404});throw e;}
    if(stat.isSymbolicLink()||!stat.isDirectory())throw Object.assign(Error('无效的分类目录。'),{status:400});
    const entries=await fs.readdir(dir,{withFileTypes:true});
    const realEntries=entries.filter(entry=>entry.name!=='.DS_Store');
    if(realEntries.length)throw Object.assign(Error('该分类下仍有文件或子分类，请先移出或删除后再删除分类。'),{status:409});
    if(entries.some(entry=>entry.name==='.DS_Store'))await fs.unlink(path.join(dir,'.DS_Store')).catch(()=>{});
    await fs.rmdir(dir);
    return {deleted:true,path:folderPath,folders:await this.listFolders(course)};
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
        result.push({id:record.id,name:f.name,originalName:attachment?.name||f.name,relativePath:f.relativePath,path:f.relativePath,folder,category:folder,kind,mime:ext==='.pdf'?'application/pdf':attachment?.mime||mimeTypes[ext]||'application/octet-stream',attachmentId:attachment?.id||null,url:`/api/courses/${encodeURIComponent(course.id)}/sources/${record.id}/file`,size:f.size,modifiedAt:f.modifiedAt||null,uploadedAt:attachment?.createdAt||null,selected:selection[record.id]!==false});
      }return result;
    },{shouldSave:()=>changed,ensureTemplates:false});
  }
  async sourceForPath(course,relativePath) {
    if(typeof relativePath!=='string'||!relativePath||relativePath.split(/[\\/]/).some(x=>x.startsWith('.')))throw Error('资料路径无效。');
    const file=await this.safePath(course,relativePath),st=await fs.stat(file);if(!st.isFile())throw Error('资料不是文件。');
    return (await this.indexSources(course,[{relativePath,name:path.basename(relativePath),size:st.size,modifiedAt:st.mtime.toISOString(),identity:`${st.dev}:${st.ino}`}]))[0];
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
  async readFile(course,relativePath,{limit=100000}={}) {
    await this._load(course); const target=await this.safePath(course,relativePath); const st=await fs.stat(target);
    if (!st.isFile() || st.size>MAX_MATERIAL_BYTES) throw Error('文件不存在或超过 '+MATERIAL_SIZE_LABEL+'。');
    const ext=path.extname(target).toLowerCase();
    if (['.png','.jpg','.jpeg','.webp','.gif'].includes(ext)) return {relativePath,kind:'image',absolutePath:target,text:'',warning:null};
    const safeLimit=Number.isInteger(limit)?Math.max(1000,Math.min(500000,limit)):100000;
    if(nativeTextExtensions.has(ext))return this._nativeText(course,relativePath,safeLimit);
    const python=process.env.STUDY_EXTRACT_PYTHON || '/usr/bin/python3';
    try { const {stdout}=await exec(python,['-B',extractor,target],{timeout:15000,maxBuffer:600000}); const result=JSON.parse(stdout); return {relativePath,kind:'text',...result}; } catch { return {relativePath,kind:'text',text:'',warning:'文本提取不可用；原文件仍然保留。'}; }
  }
  async writeWorkspaceFile(course,{path:inputPath,content,overwrite=false}) {
    if(typeof inputPath!=='string'||!inputPath.trim()||inputPath.length>400||inputPath.includes('\0')||inputPath.includes('\\')||/[\x00-\x1f]/.test(inputPath))throw Object.assign(Error('文件路径无效。'),{status:400});
    const raw=inputPath.trim();
    if(raw.startsWith('/')||raw.endsWith('/'))throw Object.assign(Error('请提供课程内的相对文件路径，不要以斜杠开头或结尾。'),{status:400});
    const segments=raw.split('/');
    if(segments.length>6)throw Object.assign(Error('目录层级过深，最多支持 5 层子目录。'),{status:400});
    for(const seg of segments){
      if(!seg||seg==='.'||seg==='..'||seg.startsWith('.')||seg.length>200||/[\/\\\x00-\x1f]/.test(seg)||seg!==seg.trim())throw Object.assign(Error('路径包含无效的文件名或隐藏目录。'),{status:400});
    }
    const folderSegments=segments.slice(0,-1),filename=segments[segments.length-1];
    if(folderSegments.some(s=>s==='课件'||s.toLowerCase()==='courseware'))throw Object.assign(Error('「课件」目录仅用于存放 PDF 课件，请将生成的文档保存到「笔记」「互动页面」等资料目录。'),{status:400});
    if(folderSegments[0]==='待整理')throw Object.assign(Error('请直接将文件保存到合适的资料目录（如「笔记/」「互动页面/」），不要写入「待整理/」。'),{status:400});
    if(segments.length===1&&internalFilesLower.has(filename.toLowerCase()))throw Object.assign(Error('系统保留文件不可直接写入，请使用其他文件名。'),{status:400});
    const ext=path.extname(filename).toLowerCase();
    if(!ext||!agentWritableExtensions.has(ext))throw Object.assign(Error('仅支持创建 .md、.html、.txt、.csv、.tsv、.json、.tex 格式的学习资料文件。'),{status:400});
    if(typeof content!=='string'||!content.trim())throw Object.assign(Error('文件内容不能为空。'),{status:400});
    if(typeof overwrite!=='boolean')throw Object.assign(Error('overwrite 参数必须为布尔值。'),{status:400});
    const bytes=Buffer.from(content,'utf8');
    if(bytes.length>MAX_AGENT_FILE_BYTES)throw Object.assign(Error('文件内容超过 500 KB 上限，请精简后再保存。'),{status:400});
    const relativePath=segments.join('/'),folder=folderSegments.join('/');
    if(folder)await this.makeFolder(course,folder);else await this.initCourse(course);
    const {action,recordId}=await this._mutate(course,async s=>{
      s.sourceIndex ||= [];s.agentFiles ||= {};
      const target=await this.safePath(course,relativePath);
      let existingStat=null;
      try{existingStat=await fs.lstat(target)}catch(e){if(e.code!=='ENOENT')throw e;}
      if(!existingStat){
        await fs.writeFile(target,bytes,{flag:'wx',mode:0o600});
        const stat=await fs.stat(target),identity=`${stat.dev}:${stat.ino}`;
        let id=digest([course.id,'source',relativePath]);
        if(s.sourceIndex.some(x=>x.id===id))id=digest([course.id,'source',randomUUID()]);
        const record={id,relativePath,identity,attachmentId:null};
        s.sourceIndex.push(record);
        const ts=now();
        s.agentFiles[id]={createdAt:ts,updatedAt:ts};
        return {action:'created',recordId:id};
      }
      if(existingStat.isSymbolicLink()||!existingStat.isFile())throw Object.assign(Error('目标路径不是可写入的普通文件。'),{status:400});
      if(!overwrite)throw Object.assign(Error(`文件「${relativePath}」已存在。请使用新的文件名，或如确认要更新你之前创建的文档，请设置 overwrite: true。`),{status:409});
      const existingIdentity=`${existingStat.dev}:${existingStat.ino}`;
      const record=s.sourceIndex.find(x=>x.relativePath===relativePath)||s.sourceIndex.find(x=>x.identity===existingIdentity);
      const isUserAttachment=!!record?.attachmentId||(s.attachments||[]).some(a=>a.relativePath===relativePath);
      if(!record||!s.agentFiles[record.id]||isUserAttachment)throw Object.assign(Error(`「${relativePath}」是课程原有资料，为保护原件不能直接覆盖；请另存为新文件名（如放到「笔记/」或加上版本后缀）。`),{status:409});
      const tmp=await this.safePath(course,`.study-studio/write-${randomUUID()}.tmp`);
      try{
        await fs.writeFile(tmp,bytes,{flag:'wx',mode:0o600});
        await this.safePath(course,relativePath);
        await fs.rename(tmp,target);
      }finally{await fs.rm(tmp,{force:true});}
      const nextStat=await fs.stat(target);
      record.relativePath=relativePath;record.identity=`${nextStat.dev}:${nextStat.ino}`;
      s.agentFiles[record.id]={...s.agentFiles[record.id],updatedAt:now()};
      return {action:'updated',recordId:record.id};
    });
    const source=await this.sourceById(course,recordId);
    if(!source)throw Error('文件已写入但索引读取失败。');
    return {action,source,sourceId:source.id,name:source.name,relativePath:source.relativePath,folder:source.folder,size:source.size,mime:source.mime,citation:`[${source.name}](study-source:${source.id})`};
  }
  async upload(course,{name,mime,data,folder='附件',intent}) {
    if (!Buffer.isBuffer(data) || data.length>MAX_MATERIAL_BYTES || (!data.length&&intent!=='courseware') || typeof name !== 'string' || !name || name.startsWith('.') || name.length>240 || /[\/\\\x00-\x1f]/.test(name)) throw Error('附件无效或超过 '+MATERIAL_SIZE_LABEL+'。');
    if(intent==='courseware'){
      validateCoursewareUpload({name,data});
      folder='课件';mime='application/pdf';
    }
    if(folder)await this.makeFolder(course,folder);else await this.initCourse(course);
    return this._mutate(course,async s=>{ const id=randomUUID(),ext=path.extname(name),stem=name.slice(0,name.length-ext.length);let relativePath,dest;for(let n=0;n<10000;n++){const filename=n?`${stem} (${n})${ext}`:name;relativePath=folder?`${folder}/${filename}`:filename;if(internalFiles.has(relativePath))continue;dest=await this.safePath(course,relativePath);try{await fs.writeFile(dest,data,{flag:'wx',mode:0o600});break}catch(e){if(e.code!=='EEXIST'||n===9999)throw e;}}if(!dest)throw Error('无法保存附件。');const info={id,name,mime:typeof mime==='string'?mime.slice(0,200):'application/octet-stream',relativePath,size:data.length,createdAt:now()};s.attachments.push(info);return info; });
  }
  async attachment(course,id) { await this.listSources(course); const s=await this._load(course); const info=s.attachments.find(x=>x.id===id); if (!info) throw Error('未找到附件。'); return {...info,absolutePath:await this.safePath(course,info.relativePath)}; }
  async _clearEmptyStagingParents(course,relativePath) {
    let folder=path.posix.dirname(relativePath);
    if(folder!=='待整理'&&!folder.startsWith('待整理/'))return;
    while(folder==='待整理'||folder.startsWith('待整理/')){
      try{await fs.rmdir(await this.safePath(course,folder));}
      catch(error){if(['ENOTEMPTY','ENOENT','EEXIST'].includes(error.code))return;throw error;}
      folder=path.posix.dirname(folder);
    }
  }
  async moveSource(course,{sourceId,folder,requirePdf=false}) {
    if(typeof folder!=='string')throw Object.assign(Error('目标文件夹无效。'),{status:400});
    const source=await this.sourceById(course,sourceId);if(!source)throw Object.assign(Error('资料不存在。'),{status:404});
    const from=await this.safePath(course,source.relativePath);
    if(requirePdf){
      const handle=await fs.open(from,constants.O_RDONLY|constants.O_NOFOLLOW);
      try{const head=Buffer.alloc(9);const {bytesRead}=await handle.read(head,0,9,0);validateCoursewareUpload({name:source.name,data:head.subarray(0,bytesRead)});}
      finally{await handle.close();}
    }
    if(folder)await this.makeFolder(course,folder);
    if(source.folder===folder)return source;
    const filename=path.basename(source.relativePath),ext=path.extname(filename),stem=filename.slice(0,filename.length-ext.length);let target,movedPath;
    for(let n=0;n<10000;n++){
      const name=n?`${stem} (${n})${ext}`:filename,relativePath=folder?`${folder}/${name}`:name;
      if(internalFiles.has(relativePath))continue;
      target=await this.safePath(course,relativePath);
      try{await fs.link(from,target);movedPath=relativePath;break}catch(e){target=null;if(e.code!=='EEXIST'||n===9999)throw e;}
    }
    if(!target)throw Error('无法找到可用的资料名称。');
    try{await fs.unlink(from)}catch(e){await fs.unlink(target).catch(()=>{});throw e;}
    await this._clearEmptyStagingParents(course,source.relativePath);
    await this._mutate(course,s=>{const record=s.sourceIndex.find(x=>x.id===sourceId);if(record)record.relativePath=movedPath;const attachment=record?.attachmentId&&s.attachments.find(x=>x.id===record.attachmentId);if(attachment)attachment.relativePath=movedPath;});
    return this.sourceById(course,sourceId);
  }
  async renameSource(course,{sourceId,name}) {
    const trimmed=typeof name==='string'?name.trim():'';
    if(!trimmed||trimmed==='.'||trimmed==='..'||trimmed.startsWith('.')||trimmed.length>240||/[\/\\\x00-\x1f]/.test(trimmed))throw Object.assign(Error('文件名称无效，不能包含斜杠或以点开头。'),{status:400});
    const source=await this.sourceById(course,sourceId);if(!source)throw Object.assign(Error('资料不存在。'),{status:404});
    if(internalFiles.has(source.relativePath))throw Object.assign(Error('系统文件不可重命名。'),{status:400});
    const relativePath=source.folder?`${source.folder}/${trimmed}`:trimmed;
    if(internalFiles.has(relativePath))throw Object.assign(Error('不能使用系统保留文件名。'),{status:400});
    if(source.kind==='courseware'&&path.extname(source.name).toLowerCase()==='.pdf'&&path.extname(trimmed).toLowerCase()!=='.pdf')throw Object.assign(Error('课件文件需要保留 .pdf 后缀。'),{status:400});
    if(relativePath===source.relativePath)return source;
    const from=await this.safePath(course,source.relativePath),target=await this.safePath(course,relativePath);
    const fromStat=await fs.lstat(from);
    if(fromStat.isSymbolicLink()||!fromStat.isFile())throw Object.assign(Error('无效的资料文件。'),{status:400});
    try{
      await fs.link(from,target);
      try{await fs.unlink(from);}catch(e){await fs.unlink(target).catch(()=>{});throw e;}
    }catch(e){
      if(e.code!=='EEXIST')throw e;
      const targetStat=await fs.lstat(target);
      if(targetStat.dev===fromStat.dev&&targetStat.ino===fromStat.ino)await fs.rename(from,target);
      else throw Object.assign(Error('同分类下已存在同名文件，请换一个名称。'),{status:409});
    }
    const nextStat=await fs.stat(target);
    await this._mutate(course,s=>{
      const record=(s.sourceIndex||[]).find(x=>x.id===sourceId);
      if(record){record.relativePath=relativePath;record.identity=`${nextStat.dev}:${nextStat.ino}`;}
      const attachment=record?.attachmentId&&s.attachments.find(x=>x.id===record.attachmentId);
      if(attachment){
        attachment.relativePath=relativePath;attachment.name=trimmed;
        if(s.importConfirmations?.[attachment.id]){
          s.importConfirmations[attachment.id]={...s.importConfirmations[attachment.id],relativePath,fileVersion:{size:nextStat.size,mtimeMs:nextStat.mtimeMs,ino:nextStat.ino}};
        }
      }
    });
    return this.sourceById(course,sourceId);
  }
  async deleteSource(course,sourceId) {
    const source=await this.sourceById(course,sourceId);if(!source)throw Object.assign(Error('资料不存在。'),{status:404});
    if(internalFiles.has(source.relativePath))throw Object.assign(Error('系统文件不可删除。'),{status:400});
    const target=await this.safePath(course,source.relativePath);
    const stat=await fs.lstat(target);
    if(stat.isSymbolicLink()||!stat.isFile())throw Object.assign(Error('无效的资料文件。'),{status:400});
    await fs.unlink(target);
    await this._clearEmptyStagingParents(course,source.relativePath);
    let attachmentId=source.attachmentId||null,closedReader=false;
    await this._mutate(course,s=>{
      const record=(s.sourceIndex||[]).find(x=>x.id===sourceId);
      if(record?.attachmentId)attachmentId=record.attachmentId;
      s.sourceIndex=(s.sourceIndex||[]).filter(x=>x.id!==sourceId);
      if(s.agentFiles)delete s.agentFiles[sourceId];
      if(s.sourceSelection)delete s.sourceSelection[sourceId];
      if(s.reader?.sourceId===sourceId){s.reader=null;closedReader=true;}
      if(s.readingPositions)delete s.readingPositions[sourceId];
      if(attachmentId){
        s.attachments=(s.attachments||[]).filter(a=>a.id!==attachmentId);
        if(s.importConfirmations)delete s.importConfirmations[attachmentId];
      }
    });
    return {deleted:true,sourceId,attachmentId,closedReader,relativePath:source.relativePath};
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
    return {items:state.items.map(item=>decorated(state,item)),attempts:state.attempts,canvases:state.canvases||[],categories:this._collectPracticeCategories(state),progress:progress.text,importantInfo:importantInfo.text,workspacePath:this.coursePath(course)};
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
