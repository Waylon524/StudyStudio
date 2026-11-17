import type {LearningData,StudyAttempt,StudyQuestion,StudySpec,SavedCanvas} from './study-types'

const empty:LearningData={items:[],attempts:[]}
type Snapshot={data:LearningData;loading:boolean;error:string;loaded:boolean}

/** One course owns one request, snapshot and trailing refresh, across all cards. */
export function createLearningEntry(load:()=>Promise<LearningData>){
  let snapshot:Snapshot={data:empty,loading:false,error:'',loaded:false}
  let epoch=0,completed=-1,revision:number|undefined,pending:Promise<void>|null=null,scheduled=false
  const listeners=new Set<()=>void>()
  const publish=(next:Partial<Snapshot>)=>{snapshot={...snapshot,...next};for(const listener of listeners)listener()}
  function schedule(){if(scheduled)return;scheduled=true;queueMicrotask(()=>{scheduled=false;if(listeners.size&&completed!==epoch)void start()})}
  function start():Promise<void>{
    if(pending)return pending
    const version=epoch
    const task=Promise.resolve().then(load).then(value=>{
      if(version!==epoch)return
      completed=version
      publish({data:{...value,items:value.items||[],attempts:value.attempts||[]},loading:false,error:'',loaded:true})
    },error=>{
      if(version!==epoch)return
      completed=version
      publish({loading:false,error:error instanceof Error?error.message:'学习记录暂时无法读取'})
    }).finally(()=>{if(pending===task)pending=null;if(version!==epoch)schedule()})
    pending=task
    publish({loading:true,error:''})
    return task
  }
  function invalidate(){++epoch;schedule()}
  function ensure(nextRevision?:number){
    // Root revisions increase through this app session. A cached hidden panel
    // with an older revision must not invalidate a newer course snapshot.
    if(nextRevision!==undefined&&(revision===undefined||nextRevision>revision)){
      revision=nextRevision
      if(snapshot.loaded||pending)++epoch
    }
    if(completed!==epoch||!snapshot.loaded||snapshot.error)void start()
  }
  async function read():Promise<LearningData>{
    for(;;){
      if(completed===epoch&&snapshot.loaded&&!snapshot.loading&&!snapshot.error)return snapshot.data
      await start()
      if(completed===epoch&&snapshot.error)throw Error(snapshot.error)
    }
  }
  return {getSnapshot:()=>snapshot,subscribe:(listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener)}},ensure,invalidate,read}
}

type LearningIndex={questions:Map<string,StudyQuestion>;sets:Map<string,StudyQuestion[]>;canvases:Map<string,SavedCanvas>}
const indexes=new WeakMap<LearningData,LearningIndex>(),attemptIndexes=new WeakMap<StudyAttempt[],Map<string,StudyAttempt>>()
export const canvasKey=(sourceId:string,threadId?:string|null,itemId?:string)=>JSON.stringify([sourceId,threadId,itemId])
export function learningIndex(data:LearningData):LearningIndex{
  let index=indexes.get(data)
  if(index)return index
  index={questions:new Map(),sets:new Map(),canvases:new Map()}
  for(const question of data.items){
    if(question.id)index.questions.set(question.id,question)
    if(question.setId){let set=index.sets.get(question.setId);if(!set){set=[];index.sets.set(question.setId,set)}set.push(question)}
  }
  for(const canvas of data.canvases||[])index.canvases.set(canvasKey(canvas.sourceId,canvas.threadId,canvas.itemId),canvas)
  indexes.set(data,index)
  return index
}
export function indexedLatestAttempt(attempts:StudyAttempt[],questionId?:string){
  if(!questionId)return null
  let index=attemptIndexes.get(attempts)
  if(!index){index=new Map();for(const attempt of attempts)index.set(attempt.questionId,attempt);attemptIndexes.set(attempts,index)}
  return index.get(questionId)||null
}

const ids=new Map<string,Promise<string|null>>()
function setId(parts:unknown[]):Promise<string|null>{
  const key=JSON.stringify(parts)
  let result=ids.get(key)
  if(!result){result=globalThis.crypto?.subtle?globalThis.crypto.subtle.digest('SHA-256',new TextEncoder().encode(key)).then(buffer=>Array.from(new Uint8Array(buffer),byte=>byte.toString(16).padStart(2,'0')).join('').slice(0,24)).catch(()=>null):Promise.resolve(null);ids.set(key,result)}
  return result
}
const generated=new Set(['id','sourceId','setId','threadId','itemId','attempts','latestAttempt','reveals'])
function stable(value:unknown):unknown{
  if(Array.isArray(value))return value.map(stable)
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,stable(item)]))
  return value
}
const content=(question:StudyQuestion)=>JSON.stringify(stable(Object.fromEntries(Object.entries(question).filter(([key])=>!generated.has(key)))))

/** Match the server's stable identity AND complete question content before reuse. */
export async function registeredStudySet(data:LearningData,courseId:string,threadId:string,itemId:string,spec:StudySpec):Promise<StudyQuestion[]|null>{
  const id=await setId([courseId,threadId,itemId,spec.id||'set'])
  const existing=id?learningIndex(data).sets.get(id):undefined
  if(!existing||existing.length!==spec.items.length)return null
  return existing.every((question,index)=>question.sourceId===(spec.items[index].id??String(index+1))&&content(question)===content(spec.items[index]))?existing:null
}
