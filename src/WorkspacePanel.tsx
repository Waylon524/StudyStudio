import {useEffect,useRef,useState} from 'react'
import {FileText,FolderOpen,RefreshCw,Save,Upload,ChevronRight} from 'lucide-react'
import {Markdown} from './Markdown'

type Workspace={workspacePath:string;files:any[];instructions:string;instructionsVersion?:string;progress:string;importantInfo:string}
export function WorkspacePanel({courseId,revision,onUpload}:{courseId:string;revision:number;onUpload:()=>void}){
 const [workspace,setWorkspace]=useState<Workspace|null>(null),[selected,setSelected]=useState('overview'),[draft,setDraft]=useState(''),[fileText,setFileText]=useState(''),[error,setError]=useState(''),[saving,setSaving]=useState(false),[saved,setSaved]=useState(false)
 const activeCourse=useRef(courseId),requestId=useRef(0),draftRef=useRef(''),baseline=useRef<{content:string;version?:string}|null>(null)
 useEffect(()=>{
  if(activeCourse.current!==courseId){activeCourse.current=courseId;baseline.current=null;draftRef.current='';setWorkspace(null);setSelected('overview');setDraft('');setFileText('');setSaved(false);setSaving(false)}
  const id=++requestId.current;setError('')
  ;(async()=>{try{const r=await fetch('/api/courses/'+encodeURIComponent(courseId)+'/workspace');const v=await r.json();if(!r.ok)throw new Error(v.error||'课程工作区读取失败');if(id!==requestId.current||activeCourse.current!==courseId)return;setWorkspace(v);if(!baseline.current||draftRef.current===baseline.current.content){baseline.current={content:v.instructions||'',version:v.instructionsVersion};draftRef.current=baseline.current.content;setDraft(baseline.current.content)}}catch(e:any){if(id===requestId.current&&activeCourse.current===courseId)setError(e.message)}})()
  return()=>{if(requestId.current===id)requestId.current++}
 },[courseId,revision])
 async function read(path:string){setSelected(path);setFileText('');setError('');try{const r=await fetch('/api/courses/'+encodeURIComponent(courseId)+'/files/read?path='+encodeURIComponent(path));const v=await r.json();if(!r.ok)throw new Error(v.error||'文件读取失败');setFileText(v.text||v.content||v.warning||'此文件需要下载后查看。')}catch(e:any){setError(e.message)}}
 async function save(){const content=draft,version=baseline.current?.version,course=courseId;++requestId.current;setSaving(true);setError('');try{const r=await fetch('/api/courses/'+encodeURIComponent(course)+'/instructions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({content,version})});const v=await r.json();if(!r.ok)throw new Error(v.error||'保存失败');if(activeCourse.current!==course)return;++requestId.current;baseline.current={content,version:v.instructionsVersion||v.version};setWorkspace(w=>w?{...w,instructions:content,instructionsVersion:baseline.current?.version}:w);setSaved(draftRef.current===content)}catch(e:any){if(activeCourse.current===course)setError(e.message)}finally{if(activeCourse.current===course)setSaving(false)}}
 return <div className="workspace-panel">
  <header className="section-heading"><div><h2>课程工作区</h2>{workspace&&<p className="workspace-path"><FolderOpen size={14}/>{workspace.workspacePath}</p>}</div><button className="quiet-button" onClick={onUpload}><Upload size={15}/>添加文件</button></header>
  {error&&<div className="app-error" role="alert">{error}</div>}
  {!workspace?<div className="figure-loading">正在读取工作区…</div>:<>
   <div className="workspace-tabs"><button className={selected==='overview'?'active':''} onClick={()=>setSelected('overview')}>课程文件</button><button className={selected==='instructions'?'active':''} onClick={()=>{setSelected('instructions');setSaved(false)}}>AGENTS.md</button><button className={selected==='progress'?'active':''} onClick={()=>setSelected('progress')}>学习进度</button><button className={selected==='info'?'active':''} onClick={()=>setSelected('info')}>重要信息</button></div>
   {selected==='overview'?<div className="workspace-file-list">{workspace.files.length?workspace.files.map((file:any)=><button key={file.path||file.relativePath} onClick={()=>read(file.path||file.relativePath)}><FileText size={17}/><span>{file.path||file.relativePath||file.name}</span><small>{file.size!=null?formatSize(file.size):''}</small><ChevronRight size={14}/></button>):<div className="empty-learning">添加课件、笔记或图片，Agent 就能在课程工作区中读取。</div>}</div>:
    selected==='instructions'?<div className="instructions-editor"><p>这里的课程约定会在每次对话前重新读取。</p><textarea aria-label="课程 AGENTS.md" spellCheck={false} value={draft} onChange={e=>{draftRef.current=e.target.value;setDraft(e.target.value);setSaved(false)}}/><div className="source-actions"><button className="quiet-button" onClick={save} disabled={saving||draft===baseline.current?.content}><Save size={14}/>{saving?'正在保存…':'保存课程约定'}</button>{saved&&<span className="saved-note">已保存，下次提问时生效</span>}</div></div>:
    selected==='progress'?<Markdown text={workspace.progress||'尚无学习记录。'}/>:selected==='info'?<Markdown text={workspace.importantInfo||'尚无课程重要信息。'}/>:<div className="file-preview"><div className="file-preview-header"><span>{selected}</span><button className="quiet-button" onClick={()=>read(selected)} aria-label="重新读取文件"><RefreshCw size={14}/></button></div><pre>{fileText}</pre></div>}
  </>}
 </div>
}
function formatSize(n:number){return n<1024?n+' B':n<1024*1024?(n/1024).toFixed(1)+' KB':(n/1024/1024).toFixed(1)+' MB'}
