import { promises as fs } from 'node:fs';
import { pdfPage } from './pdf-reader.mjs';

// Capture only the pointer; no PDF page is extracted until read() is called.
export function createPageAccess(store,course,snapshot,{render=pdfPage}={}) {
  let pending=null, result=null, closed=false;
  return {
    async read(){
      if(closed)throw Error('本轮课件页面已关闭。');
      if(!pending)pending=(async()=>{
        const cache=await store.safePath(course,'.study-studio/page-cache');await fs.mkdir(cache,{recursive:true});await store.safePath(course,'.study-studio/page-cache');
        const file=await store.safePath(course,snapshot.source.relativePath);
        const page=await render(file,snapshot.page,cache);
        if(closed){await fs.rm(page.tempDir,{recursive:true,force:true});throw Error('本轮课件页面已关闭。');}
        result={...page,sourceId:snapshot.sourceId,name:snapshot.name};return result;
      })();
      return pending;
    },
    async close(){closed=true;if(result?.tempDir)await fs.rm(result.tempDir,{recursive:true,force:true});}
  };
}
