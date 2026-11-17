import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { validateCourseTiming, isScheduleDismissed, retainScheduleDismissal } from './course-schedule.mjs';

const START='<!-- STUDY-STUDIO REQUIREMENTS START -->';
const END='<!-- STUDY-STUDIO REQUIREMENTS END -->';
const kinds=new Set(['exam','assignment','grading','schedule','general']);
const statuses=new Set(['confirmed','unverified','conflicted','withdrawn']);
const sourceTypes=new Set(['user','teacher_report','material']);
const names={exam:'考试',assignment:'作业',grading:'评分',schedule:'日程',general:'课程要求',confirmed:'已确认',unverified:'待核实',conflicted:'有冲突',withdrawn:'已撤回',user:'用户说明',teacher_report:'用户转述教师要求',material:'课程资料'};
const normalize=value=>value.replace(/\s+/g,' ').trim();
const hash=value=>createHash('sha256').update(value).digest('hex');
const line=value=>String(value).replace(/<!--/g,'&lt;!--').replace(/[\r\n]+/g,' ');
function object(value,allowed,label){if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!allowed.includes(key)))throw Error(`${label}无效。`);}
function text(value,label,max,{optional=false}={}){if(optional&&(value===undefined||value===''))return '';if(typeof value!=='string'||!value.trim()||value.length>max||value.includes('\0'))throw Error(`${label}无效。`);return value.trim();}
// Settings fields are explicit user input. Their requested time is validated
// independently of the original source quote, which remains unchanged below.
function manualTiming(value){
  if(value===null)return undefined;
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('日程时间无效。');
  const quote=[typeof value.timeText==='string'?value.timeText:''];
  for(const key of ['start','end'])if(typeof value[key]==='string'){
    const instant=value[key];quote.push(instant);
    if(instant.includes('T')&&value.timezone){
      try{const parts=new Intl.DateTimeFormat('en-CA',{timeZone:value.timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(new Date(instant)),get=type=>parts.find(part=>part.type===type)?.value||'';quote.push(`${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}`)}catch{throw Error('日程日期或时区无效。');}
    }
  }
  return validateCourseTiming(value,quote.join(' '));
}
function storedTimeEvidence(value,timezone){
  if(typeof value!=='string')return '';
  const parts=value.includes('T')?[]:[value];
  if(value.includes('T')){
    try{const zone=timezone||Intl.DateTimeFormat().resolvedOptions().timeZone,formatted=new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(new Date(value)),get=type=>formatted.find(part=>part.type===type)?.value||'';parts.push(`${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}`)}catch{throw Error('原记录的日期或时区无效。');}
  }
  return parts.join(' ');
}
function conversationTiming(patch,previous,evidence,context){
  if(patch===null)return undefined;
  object(patch,['start','end','allDay','timeText','timezone'],'日程更正时间');
  const timeText=text(patch.timeText,'本轮时间原话',1000);
  if(!evidence.includes(timeText))throw Error('更正时间的 timeText 必须是本轮用户依据中的原话。');
  const merged={...previous,...patch,timeText};
  // Explicit null removes a previously normalized endpoint while retaining an
  // unresolved temporal phrase; omission preserves the prior endpoint.
  for(const field of ['start','end'])if(merged[field]===null)delete merged[field];
  const zone=merged.timezone||context.timezone;
  for(const field of ['start','end'])if(merged[field]!==undefined){
    // Only the same OLD endpoint can justify an inherited component. Never
    // manufacture date/clock evidence from the model's requested new ISO value.
    const quoted=[evidence,storedTimeEvidence(previous?.[field],zone)].join('；');
    validateCourseTiming({timeText,start:merged[field],...(merged.allDay!==undefined?{allDay:merged.allDay}:{}),...(merged.timezone!==undefined?{timezone:merged.timezone}:{})},quoted,context);
  }
  const inherited=['start','end'].map(field=>storedTimeEvidence(previous?.[field],zone)).join('；');
  return validateCourseTiming(merged,evidence+'；'+inherited,context);
}
function userActionLabel(revision){
  const place=revision.origin==='conversation'?'对话':'设置';
  return `用户在${place}中${revision.action==='restore'?'恢复':revision.status==='withdrawn'?'移除':'更正'}`;
}
function revisionConflict(){return Object.assign(Error('记录已更新，请重新读取最新版本后再更正。'),{status:409})}
function current(entry,history=true){const latest=entry.revisions.at(-1);return {id:entry.id,...latest,createdAt:entry.createdAt,updatedAt:latest.createdAt,...(history?{revisions:entry.revisions}: {})};}
function decorate(state,entry,history=true){const value=current(entry,history);return {...value,...(value.timing?{scheduleDismissed:isScheduleDismissed(state,value)}:{})};}
function equivalent(a,b){return JSON.stringify(a.timing)===JSON.stringify(b.timing)&&a.kind===b.kind&&a.text===b.text&&a.conditions===b.conditions&&a.status===b.status&&a.source.type===b.source.type&&normalize(a.source.quote)===normalize(b.source.quote)&&a.source.sourceId===b.source.sourceId&&a.source.page===b.source.page&&a.source.verification===b.source.verification;}

function render(entries){return [START,'## 课程要求与更正','',...entries.flatMap(entry=>{const latest=entry.revisions.at(-1);return [`### ${names[latest.kind]} · ${line(latest.text)}`,'',`- ID：${entry.id}；当前状态：${names[latest.status]}；版本：${latest.revision}`,...entry.revisions.flatMap(revision=>[``, `#### 版本 ${revision.revision} · ${revision.createdAt} · ${names[revision.status]}`,revision.text.replace(/<!--/g,'&lt;!--'),...(revision.actor==='user'?[`操作来源：${userActionLabel(revision)}；原始来源未改写，新内容未重新核验。`]:[]),...(revision.actionEvidence?[`本轮操作依据（用户对话原话）：${line(revision.actionEvidence.quote)}`,`操作会话：${line(revision.actionEvidence.threadId)}${revision.actionEvidence.turnId?` · 本轮 ${line(revision.actionEvidence.turnId)}`:''}`]:[]),...(revision.timing?[`${revision.actor==='user'?'用户更正的时间说明':'时间原文'}：${line(revision.timing.timeText)}`,revision.timing.start?`日程时间：${line(revision.timing.start)}${revision.timing.end?` → ${line(revision.timing.end)}`:''}${revision.timing.timezone?`（${line(revision.timing.timezone)}）`:''}`:'日程时间：待确认']:[]),...(revision.conditions?[`适用条件：${line(revision.conditions)}`]:[]),...(revision.reason?[`更正原因：${line(revision.reason)}`]:[]),`来源：${names[revision.source.type]}${revision.source.relativePath?` · ${line(revision.source.relativePath)}`:''}${revision.source.page?` · 第 ${revision.source.page} 页`:''}${revision.source.threadId?` · 会话 ${line(revision.source.threadId)}`:''}`,`${revision.source.verification==='visual_unverified'?'图像转录（待核实）':'依据原文'}：${line(revision.source.quote)}`,...(revision.source.fileHash?[`文件 SHA-256：${revision.source.fileHash}`]:[]),...(revision.source.textHash?[`读取文本 SHA-256：${revision.source.textHash}`]:[])])];}), '',END].join('\n');}

export class CourseRequirements {
  constructor(store){this.store=store;}
  async list(course,{includeHistory=true,state}={}){const snapshot=state||await this.store._load(course);if(snapshot.courseId!==course.id)throw Error('课程记录不匹配。');return (snapshot.requirements||[]).map(entry=>decorate(snapshot,entry,includeHistory));}
  async _source(course,value,context,status){
    object(value,['type','quote','sourceId','page'],'课程要求来源');
    if(!sourceTypes.has(value.type))throw Error('课程要求来源类型无效。');
    const quote=text(value.quote,'来源原文',4000),base={type:value.type,quote,threadId:context.threadId||null,turnId:context.turnId||null};
    if(value.type!=='material'){
      if(value.sourceId!==undefined||value.page!==undefined)throw Error('用户说明不能附带资料定位。');
      if(typeof context.text!=='string'||!normalize(context.text).includes(normalize(quote)))throw Error('依据必须是本轮用户消息中的原文。');
      return base;
    }
    if(typeof value.sourceId!=='string'||!/^[0-9a-f]{24}$/.test(value.sourceId)||(value.page!==undefined&&(!Number.isInteger(value.page)||value.page<1)))throw Error('资料来源定位无效。');
    const observed=context.readEvidence?.get(`${value.sourceId}:${value.page||''}`) || (value.page===undefined?context.readEvidence?.get(value.sourceId):null);
    if(!observed||typeof observed.text!=='string')throw Error('先读取来源资料，并提供读取内容中的原文。');
    const source=await this.store.sourceById(course,value.sourceId);if(!source)throw Error('来源资料不存在。');
    const matched=normalize(observed.text).includes(normalize(quote));
    const visual=!matched&&observed.imageAvailable===true&&(value.page!==undefined||source.mime?.startsWith('image/'));
    if(!matched&&!visual)throw Error('先读取来源资料，并提供读取内容中的原文。');
    if(visual&&status!=='unverified')throw Error('图像中的转录尚未核实，只能记录为待核实。');
    const relativePath=text(observed.relativePath||source.relativePath,'来源资料路径',1000);
    await this.store.safePath(course,relativePath);
    return {...base,verification:matched?'text_matched':'visual_unverified',sourceId:source.id,relativePath,name:observed.name||source.name,...(value.page?{page:value.page}:{}),textHash:hash(observed.text),...(typeof observed.hash==='string'&&/^[0-9a-f]{64}$/.test(observed.hash)?{fileHash:observed.hash}:{}),readAt:observed.readAt||new Date().toISOString()};
  }
  async _render(course,entries){
    const target=await this.store.safePath(course,'课程重要信息.md');
    const handle=await fs.open(target,constants.O_RDONLY|constants.O_NOFOLLOW);let before,mode;
    try{before=await handle.readFile('utf8');mode=(await handle.stat()).mode&0o777;}finally{await handle.close();}
    const start=before.indexOf(START),end=before.indexOf(END);
    if((start===-1)!==(end===-1)||end<start||(start!==-1&&(before.indexOf(START,start+START.length)!==-1||before.indexOf(END,end+END.length)!==-1)))throw Error('课程要求记录区不完整，请先恢复文件中的记录标记。');
    const block=render(entries),after=start===-1?`${before.replace(/\s*$/,'')}\n\n${block}\n`:`${before.slice(0,start)}${block}${before.slice(end+END.length)}`;
    const temporary=await this.store.safePath(course,`.study-studio/requirements-${randomUUID()}.tmp`);
    try{await fs.writeFile(temporary,after,{flag:'wx',mode});await this.store.safePath(course,'课程重要信息.md');if(await fs.readFile(target,'utf8')!==before)throw Error('课程重要信息已被修改，请重新读取后再记录。');await fs.rename(temporary,target);}finally{await fs.rm(temporary,{force:true});}
  }
  async changeFromConversation(course,args,context={}){
    let evidence,reason;try{
      object(args,['operation','id','expectedRevision','evidence','reason','text','conditions','timing'],'对话中的日常更正');
      if(!['update','remove','restore'].includes(args.operation))throw Error('更正操作须为 update、remove 或 restore。');
      if(typeof args.id!=='string'||!/^req-[0-9a-f-]{36}$/.test(args.id)||!Number.isInteger(args.expectedRevision)||args.expectedRevision<1)throw Error('请先读取并指定现有记录 ID 和当前版本。');
      evidence=text(args.evidence,'本轮用户依据',4000);
      if(typeof context.text!=='string'||typeof context.threadId!=='string'||!context.threadId.trim()||(context.turnId!==undefined&&context.turnId!==null&&(typeof context.turnId!=='string'||!context.turnId.trim()))||!context.text.includes(evidence))throw Error('更正依据必须是当前用户消息中的原话，不能来自附件或旧对话。');
      reason=text(args.reason,'更正原因',2000,{optional:true})||evidence;
      const fields=['text','conditions','timing'].filter(field=>Object.prototype.hasOwnProperty.call(args,field));
      if(args.operation==='update'&&!fields.length)throw Error('请指定本轮要更正的内容、条件或时间。');
      if(args.operation==='remove'&&fields.length)throw Error('移除操作不接受内容或时间改写。');
      if('text' in args)text(args.text,'课程要求',4000);
      if('conditions' in args)text(args.conditions,'适用条件',2000,{optional:true});
    }catch(error){throw Object.assign(error,{status:400})}
    return this.store._mutate(course,async state=>{
      const entry=state.requirements?.find(item=>item.id===args.id);if(!entry)throw Object.assign(Error('课程要求不存在，请重新读取记录。'),{status:404});
      const latest=entry.revisions.at(-1);if(latest.revision!==args.expectedRevision)throw revisionConflict();
      if(args.operation==='update'&&latest.status==='withdrawn')throw Object.assign(Error('这条记录已移除；需要重新显示时请明确使用 restore。'),{status:409});
      if(args.operation==='remove'&&latest.status==='withdrawn')return {requirement:decorate(state,entry),unchanged:true};
      const hasText=Object.prototype.hasOwnProperty.call(args,'text'),hasConditions=Object.prototype.hasOwnProperty.call(args,'conditions'),hasTiming=Object.prototype.hasOwnProperty.call(args,'timing');
      const previous=current(entry,false);let timing;
      if(hasTiming)try{timing=conversationTiming(args.timing,latest.timing,evidence,context)}catch(error){throw Object.assign(error,{status:400})}
      if(args.operation==='restore'&&latest.status!=='withdrawn'&&!isScheduleDismissed(state,previous)&&!hasText&&!hasConditions&&!hasTiming)return {requirement:decorate(state,entry),unchanged:true};
      const now=new Date().toISOString(),revision={...latest,text:hasText?args.text.trim():latest.text,conditions:hasConditions?args.conditions?.trim()||'':latest.conditions,reason,status:args.operation==='remove'?'withdrawn':'unverified',actor:'user',origin:'conversation',action:args.operation,actionEvidence:{quote:evidence,threadId:context.threadId,turnId:context.turnId??null},revision:latest.revision+1,createdAt:now,updatedAt:now,source:structuredClone(latest.source)};
      if(hasTiming){if(timing)revision.timing=timing;else delete revision.timing;}
      entry.revisions.push(revision);
      if(args.operation==='restore'){
        state.scheduleRestorations=(state.scheduleRestorations||[]).filter(item=>item.id!==args.id);
        state.scheduleRestorations.push({id:args.id,revision:revision.revision,restoredAt:now});
      }else if(args.operation==='remove')state.scheduleRestorations=(state.scheduleRestorations||[]).filter(item=>item.id!==args.id);
      else retainScheduleDismissal(state,previous,{id:args.id,...revision});
      await this._render(course,state.requirements);return {requirement:decorate(state,entry),unchanged:false};
    });
  }
  async manualCorrection(course,id,args){
    let content,conditions,reason,hasTiming,timing;try{object(args,['expectedRevision','text','conditions','reason','timing'],'课程更正');
    if(typeof id!=='string'||!/^req-[0-9a-f-]{36}$/.test(id)||!Number.isInteger(args.expectedRevision)||args.expectedRevision<1)throw Error('课程要求或版本无效。');
    content=text(args.text,'课程要求',4000);conditions=text(args.conditions,'适用条件',2000,{optional:true});reason=text(args.reason,'更正原因',2000);
    hasTiming=Object.prototype.hasOwnProperty.call(args,'timing');timing=hasTiming?manualTiming(args.timing):undefined;}catch(error){throw Object.assign(error,{status:400})}
    return this.store._mutate(course,async state=>{
      const entry=state.requirements?.find(item=>item.id===id);if(!entry)throw Object.assign(Error('课程要求不存在。'),{status:404});
      const previous=current(entry,false),latest=entry.revisions.at(-1);if(latest.revision!==args.expectedRevision)throw revisionConflict();
      const now=new Date().toISOString(),revision={...latest,text:content,conditions:Object.prototype.hasOwnProperty.call(args,'conditions')?conditions:latest.conditions,reason,status:'unverified',actor:'user',origin:'settings',revision:latest.revision+1,createdAt:now,updatedAt:now,source:structuredClone(latest.source)};
      delete revision.actionEvidence;delete revision.action;
      if(hasTiming){if(timing)revision.timing=timing;else delete revision.timing;}
      entry.revisions.push(revision);
      if(latest.status==='withdrawn'){revision.action='restore';state.scheduleRestorations=(state.scheduleRestorations||[]).filter(item=>item.id!==id);state.scheduleRestorations.push({id,revision:revision.revision,restoredAt:now})}else retainScheduleDismissal(state,previous,{id,...revision});
      await this._render(course,state.requirements);return {requirement:decorate(state,entry),unchanged:false};
    });
  }
  async manualRemove(course,id,args){
    let reason;try{object(args,['expectedRevision','reason'],'移除课程记录');
    if(typeof id!=='string'||!/^req-[0-9a-f-]{36}$/.test(id)||!Number.isInteger(args.expectedRevision)||args.expectedRevision<1)throw Error('课程要求或版本无效。');
    reason=text(args.reason,'移除原因',2000,{optional:true})||'用户在设置中移除此项。';}catch(error){throw Object.assign(error,{status:400})}
    return this.store._mutate(course,async state=>{
      const entry=state.requirements?.find(item=>item.id===id);if(!entry)throw Object.assign(Error('课程要求不存在。'),{status:404});
      const latest=entry.revisions.at(-1);if(latest.revision!==args.expectedRevision)throw revisionConflict();
      if(latest.status==='withdrawn')return {requirement:decorate(state,entry),unchanged:true};
      const now=new Date().toISOString(),revision={...latest,status:'withdrawn',reason,actor:'user',origin:'settings',revision:latest.revision+1,createdAt:now,updatedAt:now,source:structuredClone(latest.source)};delete revision.actionEvidence;delete revision.action;entry.revisions.push(revision);state.scheduleRestorations=(state.scheduleRestorations||[]).filter(item=>item.id!==id);
      await this._render(course,state.requirements);return {requirement:decorate(state,entry),unchanged:false};
    });
  }
  async record(course,args,context={}){
    object(args,['id','expectedRevision','kind','text','conditions','status','reason','source','timing'],'课程要求');
    if(!kinds.has(args.kind)||!statuses.has(args.status))throw Error('课程要求类别或状态无效。');
    const incoming={kind:args.kind,text:text(args.text,'课程要求',4000),conditions:text(args.conditions,'适用条件',2000,{optional:true}),status:args.status,reason:text(args.reason,'更正原因',2000,{optional:true}),source:await this._source(course,args.source,context,args.status)};
    const timing=validateCourseTiming(args.timing,incoming.source.quote,context);if(timing)incoming.timing=timing;
    if(args.id!==undefined&&(typeof args.id!=='string'||!/^req-[0-9a-f-]{36}$/.test(args.id)))throw Error('课程要求 ID 无效。');
    if(args.expectedRevision!==undefined&&(!Number.isInteger(args.expectedRevision)||args.expectedRevision<1))throw Error('课程要求版本无效。');
    return this.store._mutate(course,async state=>{
      state.requirements ||= [];
      const entry=args.id?state.requirements.find(item=>item.id===args.id):null;
      if(args.id&&!entry)throw Error('要更正的课程要求不存在。');
      const duplicate=entry?(equivalent(entry.revisions.at(-1),incoming)?entry:null):state.requirements.find(item=>equivalent(item.revisions.at(-1),incoming));
      if(duplicate)return {requirement:decorate(state,duplicate),unchanged:true};
      if(entry){if(args.expectedRevision!==entry.revisions.at(-1).revision)throw Error('课程要求已更新，请读取最新版本再更正。');if(!incoming.reason)throw Error('更正课程要求时必须说明原因。');}
      else if(args.expectedRevision!==undefined||args.status==='withdrawn')throw Error('新课程要求不能指定旧版本或直接撤回。');
      const previous=entry?current(entry,false):null;
      const createdAt=new Date().toISOString(),revision={...incoming,revision:entry?entry.revisions.at(-1).revision+1:1,createdAt,updatedAt:createdAt};
      const updated=entry||{id:`req-${randomUUID()}`,createdAt,revisions:[]};updated.revisions.push(revision);if(!entry)state.requirements.push(updated);retainScheduleDismissal(state,previous,{id:updated.id,...revision});
      await this._render(course,state.requirements);
      return {requirement:decorate(state,updated),unchanged:false};
    });
  }
}
