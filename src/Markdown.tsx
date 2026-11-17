import { useEffect, useState, memo, createContext, useContext } from 'react'
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown'
import remarkMath from 'remark-math'
import remarkGfm from 'remark-gfm'
import remarkCjkStrong from '../shared/remark-cjk-strong.mjs'
import remarkSourceCompletion from '../shared/remark-source-completion.mjs'
import rehypeKatex from 'rehype-katex'
import 'katex/contrib/mhchem'
import 'katex/dist/katex.min.css'
import {LiveStudyBlock} from './StudyComponents'
import './chemistry-layout.css'
import {ChemistrySvg} from './ChemistrySvg'
import {chemicalEquationFromMath} from '../shared/chemical-equation.mjs'
import {createChemistryRenderQueue} from '../shared/chemistry-render-queue.mjs'
import {useNearViewport} from './useNearViewport'

const StreamContext = createContext(false)
const StudyAllowedContext = createContext(true)
const ExecutionAllowedContext = createContext(true)
const SourceContext = createContext<((id:string,page?:number)=>void)|undefined>(undefined)

export function parseStudySource(value:string): {id:string;page?:number}|null {
  const match = /^study-source:([A-Za-z0-9_-]{1,128})(?:#page=([1-9][0-9]{0,5}))?$/.exec(value)
  if (!match) return null
  return {id:match[1],...(match[2] ? {page:Number(match[2])} : {})}
}
export function studyUrlTransform(value:string):string {
  return parseStudySource(value) ? value : defaultUrlTransform(value)
}
type FigureResult = {status:string;svg?:string;warnings?:string[];validation?:unknown;trace?:unknown;error?:string}
const figures=createChemistryRenderQueue<FigureResult>(async(kind,source)=>{
  const input=['reaction','mechanism'].includes(kind)&&source.trim().startsWith('{')?JSON.parse(source):source
  const res=await fetch('/api/chem/render',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({kind,source:input})})
  const result=await res.json()
  if(!res.ok)throw new Error(result.error||result.warnings?.[0]||'绘图请求失败')
  return result
})
export function ChemistryFigure({kind,source,inline=false,ready=true}:{kind:string;source:string;inline?:boolean;ready?:boolean}) {
  const key=kind+':'+source,{ref,near}=useNearViewport(ready)
  const [state,setState]=useState<{key:string;result?:FigureResult;error?:string}>(()=>({key,result:figures.peek(kind,source)}))
  const result=state.key===key?state.result:figures.peek(kind,source),error=state.key===key?state.error:''
  const active=near||Boolean(result)
  useEffect(()=>{
    if(!ready||!active||result)return
    let disposed=false
    setState({key,result:figures.peek(kind,source)})
    figures.render(kind,source).then(result=>{if(!disposed)setState({key,result})}).catch(err=>{if(!disposed)setState({key,error:err.message})})
    return()=>{disposed=true}
  },[kind,source,key,ready,active,result])
  const blocked=result?.status==='blocked_for_publication'||result?.status==='error'||result?.status==='blocked'
  const Status=inline?'span':'div'
  const drawingKind=kind==='equation'?'reaction':kind
  const content=!ready?<Status className="figure-loading">等待结构输入完成…</Status>:!active?<Status className="figure-loading"/>:error?<Status role="alert" className="figure-error">{error}</Status>:!result?<Status className="figure-loading"><span className="spinner"/>正在绘制…</Status>:blocked?<Status className="figure-error" role="alert">当前结构或电子流尚未通过校验。{result.warnings?.length?<span>{result.warnings.join('；')}</span>:null}</Status>:result.svg?<ChemistrySvg svg={result.svg} source={source} kind={drawingKind as 'molecule'|'reaction'|'mechanism'} inline={inline}/>:<Status className="figure-error">绘图没有返回可显示的结构。</Status>
  if(inline)return <span ref={ref} className="chem-formula-inline">{content}</span>
  return <figure ref={ref} className="chem-figure" data-kind={kind}>{content}</figure>
}

// Whole structural reactions and ordinary ce equations share the native vector
// renderer. Formula-only ce, resonance and mixed mathematics remain in KaTeX.
function remarkStructureMath() {
  return (tree:any) => {
    const formulaOf=(node:any) => {
      if(!node || !['math','inlineMath'].includes(node.type)) return
      const match=/^\\(smiles|reaction)\s*\{([^{}]+)\}$/.exec(String(node.value).trim())
      if(match)return {kind:match[1]==='smiles'?'molecule':'reaction',source:match[2].trim()}
      try{return chemicalEquationFromMath(String(node.value))||undefined}catch{return undefined}
    }
    function convert(node:any,formula:{kind:string;source:string},inline:boolean,sourceNode=node) {
      const ready=sourceNode.data?.hProperties?.['data-source-ready']==='true'
      node.type='chemFormula'
      node.data={hName:'chem-formula',hProperties:{'data-kind':formula.kind,'data-source':formula.source,'data-inline':inline?'true':'false','data-source-ready':ready?'true':'false'}}
      node.children=[]
    }
    function visit(node:any) {
      const standalone=node.type==='paragraph' && node.children?.length===1 ? formulaOf(node.children[0]) : undefined
      if(standalone) {convert(node,standalone,false,node.children[0]);return}
      const formula=formulaOf(node)
      if(formula) {convert(node,formula,node.type==='inlineMath');return}
      node.children?.forEach(visit)
    }
    visit(tree)
  }
}
function ChemistryMath(props:any) {
  const allowExecution=useContext(ExecutionAllowedContext)
  if(!allowExecution) return <span className="study-footnote">组件内容未完成</span>
  const kind=props['data-kind']==='equation'?'equation':props['data-kind']==='reaction'?'reaction':'molecule'
  return <ChemistryFigure kind={kind} source={String(props['data-source']||'')} inline={props['data-inline']==='true'} ready={props['data-source-ready']==='true'}/>
}

function Code({className,children,node: _node,...props}:any) {
  const streaming=useContext(StreamContext)
  const allowStudy=useContext(StudyAllowedContext)
  const allowExecution=useContext(ExecutionAllowedContext)
  const language=/language-([^\s]+)/.exec(className||'')?.[1]
  const source=String(children).replace(/\n$/,'')
  const kind = language==='smiles'||language==='molecule'?'molecule':language
  const ready=props['data-source-ready']==='true'
  if(!allowExecution&&(language==='study'||language==='ui'||kind&&['molecule','reaction','mechanism','equation'].includes(kind)))return <div className="study-footnote">组件内容未完成</div>
  if(allowStudy && (language==='study'||language==='ui')) return <LiveStudyBlock source={source} streaming={streaming||!ready} blockId={'block-'+String(_node?.position?.start?.offset??0)}/>
  if(kind && ['molecule','reaction','mechanism','equation'].includes(kind)) return <ChemistryFigure kind={kind} source={source} ready={ready}/>
  return <code className={className} {...props}>{children}</code>
}
function Link({children,href}:any) {
  const openSource=useContext(SourceContext)
  const source=typeof href==='string'?parseStudySource(href):null
  if(source) return <button type="button" onClick={()=>openSource?.(source.id,source.page)} disabled={!openSource} title={source.page?`打开课程资料，第 ${source.page} 页`:'打开课程资料'} style={{display:'inline',verticalAlign:'baseline',border:0,borderRadius:5,padding:'1px 5px',margin:'0 2px',background:'#eaf4ef',color:'#38745c',fontSize:'0.82em',lineHeight:1.5}}>{children}</button>
  return href ? <a href={href} target="_blank" rel="noreferrer">{children}</a> : <span>{children}</span>
}
const components={'chem-formula':ChemistryMath,code:Code,pre:({children}:any)=><div className="code-container">{children}</div>,a:Link}
function normalizeMath(source:string) {
  return source.split(/(```[\s\S]*?```|~~~[\s\S]*?~~~)/g).map(part=>/^(?:```|~~~)/.test(part)?part:part
    .replace(/\\\[([\s\S]*?)\\\]/g,(_,inner)=>'$$'+inner+'$$')
    .replace(/\\\((.*?)\\\)/g,(_,inner)=>'$ '+inner+' $')).join('')
}
export const Markdown=memo(function Markdown({text,streaming=false,incomplete=false,allowStudy=true,onOpenSource}:{text:string;streaming?:boolean;incomplete?:boolean;allowStudy?:boolean;onOpenSource?:(id:string,page?:number)=>void}) {
  const inheritedSource=useContext(SourceContext)
  return <SourceContext.Provider value={onOpenSource??inheritedSource}><StreamContext.Provider value={streaming}><StudyAllowedContext.Provider value={allowStudy}><ExecutionAllowedContext.Provider value={!incomplete}><div className="markdown"><ReactMarkdown skipHtml remarkPlugins={[remarkGfm,remarkMath,remarkCjkStrong,[remarkSourceCompletion,{streaming}],remarkStructureMath]} rehypePlugins={[[rehypeKatex,{strict:'ignore',throwOnError:false}]]} components={components} urlTransform={studyUrlTransform}>{normalizeMath(text)}</ReactMarkdown></div></ExecutionAllowedContext.Provider></StudyAllowedContext.Provider></StreamContext.Provider></SourceContext.Provider>
})
