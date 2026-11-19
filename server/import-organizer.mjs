import { randomUUID } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs/promises';

export const IMPORT_CATEGORIES = Object.freeze(['课件','教材','作业','笔记','课程说明','图片','其他资料']);
const terminal = new Set(['completed','needs_review','failed']);
const timestamp = () => new Date().toISOString();
const errorText = error => String(error?.message || error || '资料整理未完成。').slice(0,1000);
const snapshot = value => JSON.parse(JSON.stringify(value));
const maxPreview = 10000, maxBatchPreview = 48000;
const reservedFolders = new Set(['附件','待整理','上传']);

function targetFolder(attachment, category) {
  const segments = path.posix.dirname(attachment.relativePath).split('/').filter(x => x && x !== '.');
  if (reservedFolders.has(segments[0])) segments.shift();
  if (IMPORT_CATEGORIES.includes(segments[0])) segments.shift();
  return [category,...segments].join('/');
}
async function clearEmptyStagingParents(store,course,relativePath) {
  let folder=path.posix.dirname(relativePath);
  if(folder!=='待整理' && !folder.startsWith('待整理/'))return;
  while(folder==='待整理' || folder.startsWith('待整理/')){
    try{await fs.rmdir(await store.safePath(course,folder));}
    catch(error){if(['ENOTEMPTY','ENOENT','EEXIST'].includes(error.code))return;throw error;}
    folder=path.posix.dirname(folder);
  }
}

function parseResult(value, allowedIds) {
  if (typeof value === 'string') {
    const content=value.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/,'$1');
    try { value=JSON.parse(content); } catch { throw Error('资料分类结果无法读取，文件已保留。'); }
  }
  if (!value || !Array.isArray(value.items) || value.items.length > allowedIds.size) throw Error('资料分类结果无效，文件已保留。');
  const seen=new Set();
  for (const item of value.items) {
    if (!item || !allowedIds.has(item.attachmentId) || seen.has(item.attachmentId) || !IMPORT_CATEGORIES.includes(item.category) || typeof item.reason !== 'string' || !item.reason.trim() || item.reason.length>1000) throw Error('资料分类结果包含无效的文件或分类，文件已保留。');
    seen.add(item.attachmentId);
  }
  const inspected=value.inspectedAttachmentIds || [];
  if(!Array.isArray(inspected)||inspected.some(id=>!allowedIds.has(id)))throw Error('资料查看依据无效，文件已保留。');
  return {items:value.items,inspectedAttachmentIds:inspected};
}

/** Background semantic organization. Only the attachment IDs in a job may move. */
export class ImportOrganizer {
  constructor({store,classify,onUpdate=()=>{}}) {
    if (!store || typeof classify !== 'function') throw Error('缺少资料整理服务。');
    this.store=store; this.classify=classify; this.onUpdate=onUpdate; this.queues=new Map(); this.scheduled=new Set(); this.fileChanges=new Map();
  }
  async _withFileChange(course,change) {
    const previous=this.fileChanges.get(course.id)||Promise.resolve();
    const task=previous.catch(()=>{}).then(change);
    this.fileChanges.set(course.id,task);
    try{return await task;}finally{if(this.fileChanges.get(course.id)===task)this.fileChanges.delete(course.id);}
  }
  async moveAndConfirmSource(course,request) {
    return this._withFileChange(course,async()=>{
      const moved=await this.store.moveSource(course,request);
      const confirmation=await this._confirmSource(course,moved.id);
      if(!confirmation)await this._publish(course,{status:'moved',sourceId:moved.id});
      return moved;
    });
  }
  async moveAndConfirmSources(course,{sourceIds,folder,requirePdf=false}) {
    if(!Array.isArray(sourceIds)||!sourceIds.length||sourceIds.length>200||sourceIds.some(id=>typeof id!=='string'||!id)||new Set(sourceIds).size!==sourceIds.length)throw Object.assign(Error('请选择要移动的文件。'),{status:400});
    return this._withFileChange(course,async()=>{
      const moved=[];
      for(const sourceId of sourceIds){
        const result=await this.store.moveSource(course,{sourceId,folder,requirePdf});
        await this._confirmSource(course,result.id);
        moved.push(result);
      }
      await this._publish(course,{status:'moved',sourceIds:moved.map(item=>item.id)});
      return {sources:moved};
    });
  }
  async renameSource(course,request) {
    return this._withFileChange(course,async()=>{
      const renamed=await this.store.renameSource(course,request);
      await this._publish(course,{status:'renamed',sourceId:renamed.id});
      return renamed;
    });
  }
  async deleteSources(course,sourceIds,{onSourceDeleted}={}) {
    if(!Array.isArray(sourceIds)||!sourceIds.length||sourceIds.length>200||sourceIds.some(id=>typeof id!=='string'||!id)||new Set(sourceIds).size!==sourceIds.length)throw Object.assign(Error('请选择要删除的文件。'),{status:400});
    return this._withFileChange(course,async()=>{
      const deletedIds=[],attachmentIds=[],missingIds=[];
      let closedReader=false;
      for(const sourceId of sourceIds){
        let result;
        try{result=await this.store.deleteSource(course,sourceId);}
        catch(error){if(error.status===404&&sourceIds.length>1){missingIds.push(sourceId);continue;}throw error;}
        deletedIds.push(result.sourceId);
        if(result.attachmentId)attachmentIds.push(result.attachmentId);
        if(result.closedReader)closedReader=true;
        if(onSourceDeleted)await onSourceDeleted(result.sourceId);
      }
      if(deletedIds.length)await this._publish(course,{status:'deleted',sourceIds:deletedIds});
      return {deletedIds,attachmentIds,missingIds,closedReader};
    });
  }
  async renameFolder(course,request) {
    return this._withFileChange(course,async()=>{
      const result=await this.store.renameFolder(course,request);
      await this._publish(course,{status:'folder_renamed',path:result.path});
      return result;
    });
  }
  async deleteFolder(course,folderPath) {
    return this._withFileChange(course,async()=>{
      const result=await this.store.deleteFolder(course,folderPath);
      await this._publish(course,{status:'folder_deleted',path:result.path});
      return result;
    });
  }
  async _publish(course,job) { try { await this.onUpdate(course,snapshot(job)); } catch { /* A notification failure must not change a saved job. */ } }
  async _change(course,id,update) {
    const job=await this.store._mutate(course,s=>{
      const current=s.importJobs?.find(x=>x.id===id);if(!current)throw Error('资料整理记录不存在。');
      Object.assign(current,update,{updatedAt:timestamp()});return snapshot(current);
    });
    await this._publish(course,job);return job;
  }
  _latest(state) {
    const latest=new Map(),attachments=new Map(state.attachments.map(a=>[a.id,a]));
    for(const job of [...(state.importJobs || [])].reverse()){
      for(const id of job.attachmentIds || []){
        if(latest.has(id)||!attachments.has(id))continue;
        const item=(job.items || []).find(x=>x.attachmentId===id),attachment=attachments.get(id);
        latest.set(id,{job,attachment,item,status:item?.status==='completed'?'completed':!terminal.has(job.status)?job.status:item?.status||job.status});
      }
    }
    return latest;
  }
  async _confirmed(course,state,attachment) {
    const confirmation=state.importConfirmations?.[attachment.id];
    if(!confirmation || confirmation.relativePath!==attachment.relativePath)return false;
    try {
      const stat=await fs.stat(await this.store.safePath(course,attachment.relativePath)),v=confirmation.fileVersion;
      return !!v&&stat.isFile()&&stat.size===v.size&&stat.mtimeMs===v.mtimeMs&&stat.ino===v.ino;
    }catch{return false;}
  }
  async _summary(course,state) {
    const pending=[],activeAttachmentIds=[];
    for(const {job,attachment,item,status} of this._latest(state).values()){
      if(await this._confirmed(course,state,attachment))continue;
      if(!terminal.has(status)){activeAttachmentIds.push(attachment.id);continue;}
      if(status==='completed')continue;
      const source=(state.sourceIndex || []).find(x=>x.attachmentId===attachment.id);
      pending.push({jobId:job.id,attachmentId:attachment.id,...(source?{sourceId:source.id}:{}),name:attachment.name,relativePath:attachment.relativePath,status:status==='failed'?'failed':'needs_review',reason:item?.error||item?.reason||job.error||'资料分类尚未确认，原文件已保留。'});
    }
    return {pending,activeAttachmentIds,active:activeAttachmentIds.length>0};
  }
  async list(course) {
    const state=await this.store._load(course),jobs=state.importJobs || [];
    return {jobs:snapshot(jobs.slice(-80).reverse()),...await this._summary(course,state)};
  }
  _newJob(state,attachmentIds) {
    if(attachmentIds.some(id=>!state.attachments.some(a=>a.id===id)))throw Error('待整理的附件不存在。');
    const entry={id:randomUUID(),attachmentIds:[...attachmentIds],status:'queued',createdAt:timestamp(),updatedAt:timestamp(),items:[]};
    state.importJobs ||= [];state.importJobs.push(entry);return snapshot(entry);
  }
  async enqueue(course,attachmentIds) {
    if (!Array.isArray(attachmentIds) || !attachmentIds.length || attachmentIds.length>100 || attachmentIds.some(x=>typeof x!=='string'||!x) || new Set(attachmentIds).size!==attachmentIds.length) throw Error('待整理的资料无效。');
    const job=await this.store._mutate(course,s=>this._newJob(s,attachmentIds));
    await this._publish(course,job);this._schedule(course,job.id);return job;
  }
  async retry(course,jobId) {
    const job=await this.store._mutate(course,async state=>{
      const previous=state.importJobs?.find(x=>x.id===jobId);
      if(!previous)throw Error('这项资料整理无需重试。');
      const selected=new Set(previous.attachmentIds),summary=await this._summary(course,state);
      const ids=summary.pending.filter(item=>selected.has(item.attachmentId)).map(item=>item.attachmentId);
      if(ids.length)return this._newJob(state,ids);
      const active=[...this._latest(state).values()].find(item=>selected.has(item.attachment.id)&&!terminal.has(item.status));
      if(active)return snapshot(active.job);
      throw Error('这项资料整理无需重试。');
    });
    await this._publish(course,job);this._schedule(course,job.id);return job;
  }
  async confirmSource(course,sourceId) {
    return this._withFileChange(course,()=>this._confirmSource(course,sourceId));
  }
  async _confirmSource(course,sourceId) {
    const source=await this.store.sourceById(course,sourceId);if(!source)throw Error('资料不存在。');
    const confirmation=await this.store._mutate(course,async state=>{
      const record=(state.sourceIndex || []).find(x=>x.id===sourceId),attachment=record?.attachmentId&&state.attachments.find(a=>a.id===record.attachmentId);
      if(!attachment)return null;
      if(record.relativePath!==source.relativePath||attachment.relativePath!==source.relativePath)throw Error('资料位置已变化，请重新确认。');
      const stat=await fs.stat(await this.store.safePath(course,source.relativePath));
      if(!stat.isFile())throw Error('资料不存在。');
      const value={sourceId,attachmentId:attachment.id,relativePath:attachment.relativePath,confirmedAt:timestamp(),source:'user_category_confirmation',fileVersion:{size:stat.size,mtimeMs:stat.mtimeMs,ino:stat.ino}};
      state.importConfirmations ||= {};state.importConfirmations[attachment.id]=value;return snapshot(value);
    });
    if(confirmation)await this._publish(course,{status:'confirmed',...confirmation});
    return confirmation;
  }
  async recover(course) { return this.resume(course); }
  async resume(course) {
    const state=await this.store._load(course);
    for(const job of state.importJobs || [])if(!terminal.has(job.status)){
      // A prior process might have moved a subset. Retain its completed items.
      if(job.status==='running')await this._change(course,job.id,{status:'queued'});
      this._schedule(course,job.id);
    }
  }
  _schedule(course,id) {
    const key=`${course.id}:${id}`;if(this.scheduled.has(key))return;
    this.scheduled.add(key);
    const previous=this.queues.get(course.id)||Promise.resolve();
    const task=previous.catch(()=>{}).then(()=>this._run(course,id)).finally(()=>{this.scheduled.delete(key);if(this.queues.get(course.id)===task)this.queues.delete(course.id);});
    this.queues.set(course.id,task);task.catch(()=>{});
  }
  async wait(course) { while(this.queues.has(course.id))await this.queues.get(course.id); }
  async _run(course,id) {
    let job;
    try {
      const state=await this.store._load(course);job=state.importJobs?.find(x=>x.id===id);
      if(!job || terminal.has(job.status))return;
      job=await this._change(course,id,{status:'running',error:null});
      const done=new Map(job.items.filter(x=>x.status==='completed').map(x=>[x.attachmentId,x]));
      const attachments=[];
      for(const attachmentId of job.attachmentIds){
        if(done.has(attachmentId))continue;
        let info,stat;
        try{info=await this.store.attachment(course,attachmentId);stat=await fs.stat(info.absolutePath);}
        catch{done.set(attachmentId,{attachmentId,status:'completed',resolution:'removed',reason:'文件已被用户移除。'});continue;}
        const read=await this.store.readFile(course,info.relativePath);
        const text=typeof read.text==='string'?read.text.slice(0,maxPreview):'';
        attachments.push({attachmentId,name:info.name,mime:info.mime,size:info.size,relativePath:info.relativePath,absolutePath:info.absolutePath,kind:read.kind,text,truncated:!!read.truncated || (read.text?.length||0)>text.length,warning:read.warning||null,fileVersion:{size:stat.size,mtimeMs:stat.mtimeMs,ino:stat.ino},contentAvailable:!!text.trim()});
      }
      const chunks=[];let chunk=[],chars=0;
      for(const attachment of attachments){
        if(chunk.length && (chunk.length>=6 || chars+attachment.text.length>maxBatchPreview)){chunks.push(chunk);chunk=[];chars=0;}
        chunk.push(attachment);chars+=attachment.text.length;
      }
      if(chunk.length)chunks.push(chunk);
      const classified=new Map(),inspected=new Set();
      for(const batch of chunks){
        const result=parseResult(await this.classify({course,jobId:id,attachments:snapshot(batch)}),new Set(batch.map(a=>a.attachmentId)));
        for(const item of result.items)classified.set(item.attachmentId,item);
        for(const attachmentId of result.inspectedAttachmentIds)inspected.add(attachmentId);
      }
      let items=[...done.values()];
      for(const attachment of attachments){
        await this._withFileChange(course,async()=>{
        const currentState=await this.store._load(course),currentAttachment=currentState.attachments.find(a=>a.id===attachment.attachmentId);
        if(!currentAttachment){
          items.push({attachmentId:attachment.attachmentId,status:'completed',resolution:'removed',reason:'文件已被用户移除。'});
          job=await this._change(course,id,{items:[...items]});return;
        }
        if(await this._confirmed(course,currentState,currentAttachment)){
          const confirmation=currentState.importConfirmations[attachment.attachmentId];
          items.push({attachmentId:attachment.attachmentId,status:'completed',resolution:'user_category_confirmation',relativePath:currentAttachment.relativePath,sourceId:confirmation.sourceId,reason:'已保留用户明确确认的分类。'});
          job=await this._change(course,id,{items:[...items]});return;
        }
        const proposed=classified.get(attachment.attachmentId);
        const contentAvailable=attachment.contentAvailable||inspected.has(attachment.attachmentId);
        const unknown=!contentAvailable || !proposed || proposed.category==='其他资料';
        const category=unknown?'其他资料':proposed.category;
        const reason=!contentAvailable?'未能读取可供判断的内容，原文件已保留，待进一步确认。':!proposed?'未获得明确分类，待进一步确认。':proposed.reason.trim();
        let item={attachmentId:attachment.attachmentId,category,reason,status:unknown?'needs_review':'completed',relativePath:attachment.relativePath};
        try {
          const current=await this.store.attachment(course,attachment.attachmentId),stat=await fs.stat(current.absolutePath);
          if(current.relativePath!==attachment.relativePath || stat.size!==attachment.fileVersion.size || stat.mtimeMs!==attachment.fileVersion.mtimeMs || stat.ino!==attachment.fileVersion.ino){
            item={...item,status:'needs_review',relativePath:current.relativePath,reason:'资料在整理期间已被移动或修改，已保留当前位置。'};
          }else{
            const source=await this.store.sourceForPath(course,current.relativePath);
            const moved=await this.store.moveSource(course,{sourceId:source.id,folder:targetFolder(attachment,category)});
            item={...item,sourceId:moved.id,relativePath:moved.relativePath};
            if(moved.relativePath!==current.relativePath)await clearEmptyStagingParents(this.store,course,current.relativePath);
          }
        }catch(error){item={...item,status:'failed',error:errorText(error)};}
        items.push(item);
        // Save after every move so a stopped process can resume without repeating it.
        job=await this._change(course,id,{items:[...items]});
        });
      }
      const status=items.some(x=>x.status==='failed')?'failed':items.some(x=>x.status==='needs_review')?'needs_review':'completed';
      await this._change(course,id,{status,items,...(status==='failed'?{error:'部分资料尚未整理，原文件已保留。'}:{error:null})});
    }catch(error){
      if(job)await this._change(course,id,{status:'failed',error:errorText(error)}).catch(()=>{});
    }
  }
}
