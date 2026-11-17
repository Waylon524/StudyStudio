import { createElement, useId, useMemo, type CSSProperties, type ReactNode } from 'react'

type ChemistryKind = 'molecule' | 'reaction' | 'mechanism'
const SVG_NS = 'http://www.w3.org/2000/svg'
const elements = new Set(['svg', 'g', 'path', 'line', 'polyline', 'polygon', 'circle', 'ellipse', 'rect', 'text', 'tspan', 'title', 'desc', 'defs', 'marker', 'clipPath'])
const semanticClasses = new Set(['mech-arrow', 'electron-head', 'arrow-pair', 'arrow-single', 'reaction-head', 'reaction-arrow', 'scheme-operator', 'rxnArrow', 'arrowHead', 'compactArrowHead', 'equilibriumShaft', 'equilibriumHead', 'conditionLabel'])
const number = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?(?:px|%)?$/i
const numbers = /^[\d\s.,+eE-]+$/
const path = /^[MmZzLlHhVvCcSsQqTtAa\d\s.,+eE-]+$/
const identifier = /^[A-Za-z_][\w:.-]{0,180}$/
const styleAttributes: Record<string, string> = {
  fill: 'fill', stroke: 'stroke', 'fill-rule': 'fillRule', 'clip-rule': 'clipRule',
  'fill-opacity': 'fillOpacity', 'stroke-opacity': 'strokeOpacity', opacity: 'opacity',
  'stroke-width': 'strokeWidth', 'stroke-linecap': 'strokeLinecap',
  'stroke-linejoin': 'strokeLinejoin', 'stroke-miterlimit': 'strokeMiterlimit',
  'stroke-dasharray': 'strokeDasharray', 'stroke-dashoffset': 'strokeDashoffset',
  'font-size': 'fontSize', 'font-style': 'fontStyle', 'font-weight': 'fontWeight',
  'font-family': 'fontFamily', 'text-anchor': 'textAnchor', 'dominant-baseline': 'dominantBaseline',
}
const geometry = new Set(['x', 'y', 'x1', 'x2', 'y1', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'width', 'height', 'dx', 'dy'])
const anchorAttributes = new Set(['data-source-object', 'data-target-object', 'data-electrons', 'data-length-bonds', 'data-overlap-score', 'data-routed-curvature', 'data-painter'])

function paint(value: string) {
  if (/^(?:black|#000(?:000)?|#111(?:111)?|rgb\(\s*0\s*,\s*0\s*,\s*0\s*\))$/i.test(value)) return 'currentColor'
  if (/^(?:none|currentColor|white|#[a-f\d]{3}|#[a-f\d]{6})$/i.test(value)) return value
  throw new Error('Unsupported SVG color')
}
function fontFamily(value: string) {
  const families=value.split(',').map(item=>item.trim().replace(/^['"]|['"]$/g, ''))
  if (!families.length || families.some(item=>!['sans-serif','serif','Arial','Helvetica','DejaVu Sans','Times New Roman','Songti SC','SimSun'].includes(item))) throw new Error('Unsupported SVG font')
  return families.map(item=>item.includes(' ')?`"${item}"`:item).join(', ')
}
function safeStyle(name: string, value: string): string {
  if (!styleAttributes[name] || value.length > 150) throw new Error('Unsupported SVG style')
  if (name === 'fill' || name === 'stroke') return paint(value)
  if (['fill-rule', 'clip-rule'].includes(name) && /^(?:nonzero|evenodd)$/.test(value)) return value
  if (name === 'stroke-linecap' && /^(?:butt|round|square)$/.test(value)) return value
  if (name === 'stroke-linejoin' && /^(?:miter|round|bevel)$/.test(value)) return value
  if (name === 'font-style' && /^(?:normal|italic|oblique)$/.test(value)) return value
  if (name === 'font-weight' && /^(?:normal|bold|[1-9]00)$/.test(value)) return value
  if (name === 'font-family') return fontFamily(value)
  if (name === 'text-anchor' && /^(?:start|middle|end)$/.test(value)) return value
  if (name === 'dominant-baseline' && /^(?:auto|alphabetic|middle|central|hanging|text-before-edge|text-after-edge)$/.test(value)) return value
  if (name === 'stroke-dasharray' && (value === 'none' || numbers.test(value))) return value
  if (['fill-opacity', 'stroke-opacity', 'opacity', 'stroke-width', 'stroke-miterlimit', 'stroke-dashoffset', 'font-size'].includes(name) && number.test(value)) return value
  throw new Error('Invalid SVG style')
}
function declarations(value: string) {
  const props: Record<string, unknown> = {}
  for (const declaration of value.split(';').filter(item=>item.trim())) {
    const colon=declaration.indexOf(':')
    if (colon<0) throw new Error('Invalid SVG style')
    const name=declaration.slice(0,colon).trim(), content=declaration.slice(colon+1).trim()
    if (name==='font') {
      const match=/^(?:(normal|bold|[1-9]00)\s+)?(\d+(?:\.\d+)?px)\s+(.+)$/.exec(content)
      if (!match) throw new Error('Invalid SVG font')
      props.fontWeight=match[1]||'normal';props.fontSize=match[2];props.fontFamily=fontFamily(match[3])
    } else props[styleAttributes[name]]=safeStyle(name,content)
  }
  return props
}
function safeTransform(value: string) {
  if (value.length > 1000 || !/^(?:(?:matrix|translate|scale|rotate|skewX|skewY)\(\s*[\d\s.,+eE-]+\)\s*)+$/.test(value)) throw new Error('Invalid SVG transform')
  return value
}
function bounds(value: string) {
  const parts=value.trim().split(/[\s,]+/).map(Number)
  if (parts.length!==4 || !parts.every(Number.isFinite) || parts[2]<=0 || parts[3]<=0 || parts[2]>100000 || parts[3]>100000) throw new Error('Invalid SVG bounds')
  return parts
}

function parseSvg(svg: string, scope: string) {
  if (svg.length>4_000_000 || /<!DOCTYPE|<!ENTITY/i.test(svg)) throw new Error('Invalid SVG document')
  const document=new DOMParser().parseFromString(svg,'image/svg+xml'),root=document.documentElement
  if (document.querySelector('parsererror') || root.localName!=='svg' || root.namespaceURI!==SVG_NS) throw new Error('Invalid SVG document')
  const viewBox=bounds(root.getAttribute('viewBox')||'')
  const ids=new Map<string,{id:string;tag:string}>()
  for (const element of Array.from(root.querySelectorAll('[id]'))) {
    const id=element.getAttribute('id')!
    if (!identifier.test(id) || ids.has(id)) throw new Error('Invalid SVG identifier')
    ids.set(id,{id:`${scope}-${ids.size}`,tag:element.localName})
  }
  function localReference(value: string, tag: string) {
    const match=/^url\(#([A-Za-z_][\w:.-]{0,180})\)$/.exec(value),target=match&&ids.get(match[1])
    if (!target || target.tag!==tag) throw new Error('Invalid SVG reference')
    return `url(#${target.id})`
  }
  // Renderer class rules become local presentation props. No stylesheet is ever
  // mounted, so a repeated mechanism cannot style another figure or the app.
  const rules: {classes:string[];props:Record<string,unknown>}[]=[]
  for (const style of Array.from(root.querySelectorAll('style'))) {
    const sheet=(style.textContent||'').replace(/\/\*[\s\S]*?\*\//g,'')
    let end=0
    for (const match of sheet.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (sheet.slice(end,match.index).trim()) throw new Error('Invalid SVG stylesheet')
      const selectors=match[1].trim().split(',').map(selector=>selector.trim())
      if (selectors.some(selector=>!/^\.[A-Za-z_][\w-]*$/.test(selector))) throw new Error('Unsupported SVG selector')
      rules.push({classes:selectors.map(selector=>selector.slice(1)),props:declarations(match[2])})
      end=match.index!+match[0].length
    }
    if (sheet.slice(end).trim()) throw new Error('Invalid SVG stylesheet')
  }
  let nodeCount=0
  function rebuild(element: Element,key: number,depth=0):ReactNode {
    if (++nodeCount>10000 || depth>128 || element.namespaceURI!==SVG_NS) throw new Error('Unsupported SVG content')
    if (element.localName==='style' || element.localName==='metadata') return null
    if (!elements.has(element.localName)) throw new Error('Unsupported SVG element')
    const isRoot=element===root,props:Record<string,unknown>={key},inline=element.getAttribute('style')
    for (const attribute of Array.from(element.attributes)) {
      const name=attribute.name,value=attribute.value.trim()
      if (['class','style','version','baseProfile','xml:space'].includes(name) || name.startsWith('xmlns')) continue
      if (isRoot && ['viewBox','width','height'].includes(name)) continue
      if (name==='id') {const id=ids.get(value);if(id)props.id=id.id}
      else if (styleAttributes[name]) props[styleAttributes[name]]=safeStyle(name,value)
      else if (geometry.has(name) && number.test(value)) props[name]=value
      else if (name==='d' && value.length<1_000_000 && path.test(value)) props.d=value
      else if (name==='points' && value.length<1_000_000 && numbers.test(value)) props.points=value
      else if (name==='transform') props.transform=safeTransform(value)
      else if (name==='viewBox') props.viewBox=bounds(value).join(' ')
      else if (name==='preserveAspectRatio' && /^(?:none|x(?:Min|Mid|Max)Y(?:Min|Mid|Max)(?:\s+(?:meet|slice))?)$/.test(value)) props.preserveAspectRatio=value
      else if (['marker-start','marker-mid','marker-end'].includes(name)) props[name.replace(/-([a-z])/g,(_,letter)=>letter.toUpperCase())]=value==='none'?'none':localReference(value,'marker')
      else if (name==='clip-path') props.clipPath=value==='none'?'none':localReference(value,'clipPath')
      else if (['markerWidth','markerHeight','refX','refY'].includes(name) && number.test(value)) props[name]=value
      else if (name==='markerUnits' && ['strokeWidth','userSpaceOnUse'].includes(value)) props.markerUnits=value
      else if (name==='orient' && (['auto','auto-start-reverse'].includes(value)||number.test(value))) props.orient=value
      else if (name==='clipPathUnits' && ['objectBoundingBox','userSpaceOnUse'].includes(value)) props.clipPathUnits=value
      else if (anchorAttributes.has(name) && value.length<=200 && /^[A-Za-z0-9_:.,+\s-]+$/.test(value)) props[name]=value
      else throw new Error('Unsupported SVG attribute')
    }
    const classes=(element.getAttribute('class')||'').split(/\s+/)
    for (const rule of rules) if (rule.classes.some(name=>classes.includes(name))) Object.assign(props,rule.props)
    if (inline) Object.assign(props,declarations(inline))
    const retainedClasses=classes.filter(name=>semanticClasses.has(name))
    if (retainedClasses.length) props.className=retainedClasses.join(' ')
    if (element.parentElement===root && element.localName==='rect' && /^(?:white|#fff(?:fff)?)$/i.test(String(props.fill))) {
      const full=(value:unknown,size:number)=>value==='100%'||Math.abs(Number(String(value).replace(/px$/,''))-size)<.01
      if (full(props.width,viewBox[2]) && full(props.height,viewBox[3]) && Number(props.x||0)===viewBox[0] && Number(props.y||0)===viewBox[1]) return null
    }
    const children=Array.from(element.childNodes).map((node,index)=>{
      if(node.nodeType===Node.ELEMENT_NODE)return rebuild(node as Element,index,depth+1)
      if(node.nodeType===Node.TEXT_NODE)return node.textContent
      if(node.nodeType===Node.COMMENT_NODE)return null
      throw new Error('Unsupported SVG content')
    })
    return isRoot?children:createElement(element.localName,props,...children)
  }
  return {viewBox,content:rebuild(root,0)}
}

export function ChemistrySvg({svg,source,inline=false,kind='molecule'}:{svg:string;source:string;inline?:boolean;kind?:ChemistryKind}) {
  const scope=`chem-${useId().replace(/[^A-Za-z0-9_-]/g,'')}`
  const drawing=useMemo(()=>{try{return parseSvg(svg,scope)}catch{return null}},[svg,scope])
  if(!drawing)return <span className="chem-svg-error" role="alert">化学公式无法安全显示，请重新生成。</span>
  const [,,width,height]=drawing.viewBox,cap=kind==='molecule'?11:kind==='reaction'?24:32
  const style:CSSProperties=kind==='molecule'
    ? {width:`min(${width/16}em, ${cap*width/height}em, 100%)`,aspectRatio:`${width} / ${height}`}
    : {width:`min(${width/16}em, 100%)`,minWidth:`${width/22}em`,aspectRatio:`${width} / ${height}`}
  const label=kind==='molecule'?`化学结构式，SMILES：${source}`:kind==='reaction'?'有机化学反应式，包含反应物、反应条件和产物':'有机反应机理，电子流弯箭头锚定到指定原子或化学键'
  return <span className="chem-structure" data-kind={kind} data-inline={inline?'true':undefined} role="math" aria-label={label} style={inline?{width:style.width}:undefined}>
    <svg xmlns={SVG_NS} viewBox={drawing.viewBox.join(' ')} preserveAspectRatio="xMidYMid meet" style={inline?{width:'100%',minWidth:style.minWidth,aspectRatio:style.aspectRatio}:style} aria-hidden="true" focusable="false">{drawing.content}</svg>
  </span>
}
