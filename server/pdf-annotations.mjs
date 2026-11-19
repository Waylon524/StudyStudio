import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {checkedPdfAnnotation,checkedPdfAnnotationId} from '../shared/pdf-markup.mjs';

const MAX_ITEM_BYTES=64*1024,MAX_PAGE_ITEMS=1000;
const MAX_EXPORT_ITEMS=10000,MAX_EXPORT_PAGES=10000,MAX_EXPORT_BYTES=16*1024*1024;
const exportLimitError=()=>Object.assign(Error('整份课件的批注超过导出容量上限，未生成不完整结果。'),{status:413});
const storageError=()=>Error('已保存的 PDF 批注无法读取，请保留原文件后重试。');

/** Separate annotation files never rewrite the PDF or course learning ledger. */
export class PdfAnnotations {
  constructor({store}){this.store=store;this.locks=new Map()}
  _request(request){
    if(!request||typeof request!=='object'||Array.isArray(request)||typeof request.sourceId!=='string'||! /^[0-9a-f]{24}$/.test(request.sourceId)||!Number.isSafeInteger(request.page)||request.page<1)throw new TypeError('PDF 资料或页码无效。');
    return {sourceId:request.sourceId,page:request.page};
  }
  async _resolved(course,request,{includePages=false}={}){
    let snapshot;
    try{snapshot=await this.store.resolveReader(course,request)}catch(error){
      if(['EACCES','EPERM','EIO','EMFILE','ENFILE'].includes(error.code))throw error;
      throw new TypeError(error.message||'PDF 资料或页码无效。');
    }
    if(!snapshot||snapshot.sourceId!==request.sourceId||snapshot.page!==request.page||snapshot.source?.id!==request.sourceId||snapshot.source?.mime!=='application/pdf')throw new TypeError('PDF 资料或页码无效。');
    return {...request,courseId:course.id,...(includePages?{pages:snapshot.pages}:{})};
  }
  async _serialized(course,request,operation){
    // A PDF-wide lock gives all-pages exports one snapshot across page writes.
    const key=JSON.stringify([this.store.coursePath(course),request.sourceId]),previous=this.locks.get(key)||Promise.resolve();
    const task=previous.catch(()=>{}).then(operation);this.locks.set(key,task);
    try{return await task}finally{if(this.locks.get(key)===task)this.locks.delete(key)}
  }
  _relative(scope,id){return `.study-studio/pdf-annotations/${scope.sourceId}/${scope.page}`+(id?`/${id}.json`:'')}
  async _directory(course,scope,create=false){
    const relative=this._relative(scope);
    if(create){
      const parts=relative.split('/');
      for(let i=1;i<=parts.length;i++){
        const target=await this.store.safePath(course,parts.slice(0,i).join('/'));
        try{await fs.mkdir(target,{mode:0o700})}catch(error){if(error.code!=='EEXIST')throw error}
        const stat=await fs.lstat(target);if(stat.isSymbolicLink()||!stat.isDirectory())throw Error('PDF 批注目录无效。');
      }
    }
    return this.store.safePath(course,relative);
  }
  async _entries(course,scope){
    let entries;
    try{entries=await fs.readdir(await this._directory(course,scope),{withFileTypes:true})}catch(error){if(error.code==='ENOENT')return [];throw error}
    const result=[];
    for(const entry of entries){
      if(!entry.name.endsWith('.json'))continue;
      if(entry.isSymbolicLink()||!entry.isFile())throw storageError();
      let id;try{id=checkedPdfAnnotationId(entry.name.slice(0,-5))}catch{throw storageError()}
      result.push(id);
    }
    if(result.length>MAX_PAGE_ITEMS)throw storageError();
    return result;
  }
  async _read(course,scope,id){
    let handle;
    try{handle=await fs.open(await this.store.safePath(course,this._relative(scope,id)),constants.O_RDONLY|constants.O_NOFOLLOW)}catch(error){if(error.code==='ENOENT')return null;throw error}
    try{
      const stat=await handle.stat();if(!stat.isFile()||stat.size>MAX_ITEM_BYTES)throw storageError();
      let value,annotation;
      try{value=JSON.parse(await handle.readFile('utf8'));annotation=checkedPdfAnnotation(value.annotation)}catch{throw storageError()}
      if(value.version!==1||value.courseId!==scope.courseId||value.sourceId!==scope.sourceId||value.page!==scope.page||annotation.id!==id||typeof value.createdAt!=='string'||!Number.isFinite(Date.parse(value.createdAt)))throw storageError();
      return {...value,annotation};
    }finally{await handle.close()}
  }
  async list(course,request){
    const checked=this._request(request);
    return this._serialized(course,checked,async()=>{
      const scope=await this._resolved(course,checked),ids=await this._entries(course,scope);
      const records=[];
      for(let offset=0;offset<ids.length;offset+=16)records.push(...(await Promise.all(ids.slice(offset,offset+16).map(id=>this._read(course,scope,id)))).filter(Boolean));
      records.sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.annotation.id.localeCompare(b.annotation.id));
      return {annotations:records.map(record=>record.annotation)};
    });
  }
  async listAll(course,request){
    const checked=this._request({sourceId:request?.sourceId,page:1});
    return this._serialized(course,checked,async()=>{
      // Verify the real course PDF even if it has no annotation directory yet.
      const {pages:pageCount,...scope}=await this._resolved(course,checked,{includePages:true});
      if(!Number.isSafeInteger(pageCount)||pageCount<1)throw new TypeError('PDF 页数无效，无法导出批注。');
      let directory;
      try{directory=await fs.opendir(await this.store.safePath(course,`.study-studio/pdf-annotations/${checked.sourceId}`))}catch(error){if(error.code==='ENOENT')return {pages:[]};throw error}
      const pageNumbers=[];
      for await(const entry of directory){
        if(entry.name.startsWith('.'))continue;
        const page=Number(entry.name);
        if(entry.isSymbolicLink()||!entry.isDirectory()||!/^[1-9][0-9]*$/.test(entry.name)||!Number.isSafeInteger(page)||page>pageCount)throw storageError();
        pageNumbers.push(page);
        if(pageNumbers.length>MAX_EXPORT_PAGES)throw exportLimitError();
      }
      pageNumbers.sort((a,b)=>a-b);
      const pages=[];let count=0,bytes=Buffer.byteLength('{"pages":[]}');
      for(const page of pageNumbers){
        const pageScope={...scope,page},ids=await this._entries(course,pageScope),records=[];
        count+=ids.length;if(count>MAX_EXPORT_ITEMS)throw exportLimitError();
        for(let offset=0;offset<ids.length;offset+=16){
          const batch=await Promise.all(ids.slice(offset,offset+16).map(id=>this._read(course,pageScope,id)));
          for(const record of batch){
            // Internal writes cannot race this snapshot; never omit a missing saved item.
            if(!record)throw storageError();
            bytes+=Buffer.byteLength(JSON.stringify(record.annotation))+1;
            if(bytes>MAX_EXPORT_BYTES)throw exportLimitError();
            records.push(record);
          }
        }
        if(!records.length)continue;
        records.sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.annotation.id.localeCompare(b.annotation.id));
        bytes+=Buffer.byteLength(JSON.stringify({page,annotations:[]}))+1;
        if(bytes>MAX_EXPORT_BYTES)throw exportLimitError();
        pages.push({page,annotations:records.map(record=>record.annotation)});
      }
      return {pages};
    });
  }
  async create(course,request,provenance){
    return this.change(course,{...request,op:'upsert',annotation:{...request.annotation,id:randomUUID(),author:'agent'}},{createOnly:true,provenance});
  }
  async change(course,request,{createOnly=false,provenance}={}){
    const checked=this._request(request),op=request.op;
    let annotation,id;
    if(op==='upsert'){annotation=checkedPdfAnnotation(request.annotation);id=annotation.id}
    else if(op==='delete')id=checkedPdfAnnotationId(request.id);
    else throw new TypeError('批注操作无效。');
    return this._serialized(course,checked,async()=>{
      const scope=await this._resolved(course,checked);
      if(op==='delete'){
        try{await fs.unlink(await this.store.safePath(course,this._relative(scope,id)))}catch(error){if(error.code!=='ENOENT')throw error}
        return {ok:true};
      }
      const old=await this._read(course,scope,id);
      if(createOnly&&old)throw Error('新批注编号已存在，未覆盖已有批注。');
      if(old?.annotation.author==='agent')annotation={...annotation,author:'agent'};
      if(!old&&(await this._entries(course,scope)).length>=MAX_PAGE_ITEMS)throw new TypeError('这一页的批注已达到上限。');
      await this._directory(course,scope,true);
      const timestamp=new Date().toISOString(),value={version:1,...scope,annotation,createdAt:old?.createdAt||timestamp,updatedAt:timestamp,...((old?.provenance||provenance)?{provenance:old?.provenance||provenance}:{})};
      const text=JSON.stringify(value);if(Buffer.byteLength(text)>MAX_ITEM_BYTES)throw new TypeError('批注内容过长。');
      const folder=this._relative(scope),temporary=`${folder}/.${randomUUID()}.tmp`;
      let handle;
      try{
        handle=await fs.open(await this.store.safePath(course,temporary),constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
        await handle.writeFile(text);await handle.sync();await handle.close();handle=null;
        await fs.rename(await this.store.safePath(course,temporary),await this.store.safePath(course,this._relative(scope,id)));
      }finally{
        await handle?.close().catch(()=>{});
        await fs.rm(await this.store.safePath(course,temporary),{force:true});
      }
      return {ok:true,...(createOnly?{annotation}:{})};
    });
  }
  async removeSource(course,sourceId){
    if(typeof sourceId!=='string'||!/^[0-9a-f]{24}$/.test(sourceId))return {removed:false};
    return this._serialized(course,{sourceId},async()=>{
      const target=await this.store.safePath(course,`.study-studio/pdf-annotations/${sourceId}`);
      await fs.rm(target,{recursive:true,force:true});
      return {removed:true};
    });
  }
}
