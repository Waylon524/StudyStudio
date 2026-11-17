// Limit expensive native drawing requests and retain only a bounded warm cache.
export function createChemistryRenderQueue(request,{concurrency=2,maxEntries=64,maxBytes=16*1024*1024}={}){
  const cache=new Map(),queue=[];
  let active=0,bytes=0;
  const keyFor=(kind,source)=>kind+':'+source;
  function touch(key,entry){cache.delete(key);cache.set(key,entry);}
  function trim(){
    for(const [key,entry] of cache){
      if(cache.size<=maxEntries&&bytes<=maxBytes)break;
      if(entry.finished){cache.delete(key);bytes-=entry.bytes;}
    }
  }
  function drain(){
    while(active<concurrency&&queue.length){
      const {kind,source,key,entry,resolve,reject}=queue.shift();active++;
      Promise.resolve().then(()=>request(kind,source)).then(value=>{
        entry.finished=true;entry.value=value;
        entry.bytes=2*(source.length+(JSON.stringify(value)?.length||0));
        bytes+=entry.bytes;trim();resolve(value);
      },error=>{if(cache.get(key)===entry)cache.delete(key);reject(error);}).finally(()=>{active--;drain();});
    }
  }
  return {
    peek(kind,source){const key=keyFor(kind,source),entry=cache.get(key);if(entry?.finished){touch(key,entry);return entry.value;}},
    render(kind,source){
      const key=keyFor(kind,source),existing=cache.get(key);
      if(existing){touch(key,existing);return existing.promise;}
      const entry={finished:false,bytes:0,value:undefined,promise:null};
      entry.promise=new Promise((resolve,reject)=>queue.push({kind,source,key,entry,resolve,reject}));
      cache.set(key,entry);trim();drain();return entry.promise;
    }
  };
}
