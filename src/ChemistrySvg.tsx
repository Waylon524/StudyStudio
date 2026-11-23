import { createElement, useId, useMemo, type CSSProperties, type ReactNode } from 'react'
import { useI18n } from './i18n'

type ChemistryKind = 'molecule' | 'reaction' | 'mechanism'
const SVG_NS = 'http://www.w3.org/2000/svg'
const elements = new Set(['svg', 'g', 'path', 'line', 'polyline', 'polygon', 'circle', 'ellipse', 'rect', 'text', 'tspan', 'title', 'desc', 'defs', 'marker', 'clipPath'])
const semanticClasses = new Set(['mech-arrow', 'electron-head', 'arrow-pair', 'arrow-single', 'reaction-head', 'reaction-arrow', 'scheme-operator', 'rxnArrow', 'arrowHead', 'compactArrowHead', 'equilibriumShaft', 'equilibriumHead', 'conditionLabel', 'chem-annotation', 'chem-annotation-arrow', 'chem-annotation-head', 'chem-annotation-label', 'chem-annotation-highlight', 'chem-annotation-connector', 'chem-caption'])
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
const reactPropNames: Record<string, string> = {
  ...styleAttributes,
  class: 'className',
  'clip-path': 'clipPath',
  'marker-start': 'markerStart',
  'marker-mid': 'markerMid',
  'marker-end': 'markerEnd',
}
const geometry = new Set(['x', 'y', 'x1', 'x2', 'y1', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'width', 'height', 'dx', 'dy'])
const anchorAttributes = new Set(['data-source-object', 'data-target-object', 'data-electrons', 'data-length-bonds', 'data-overlap-score', 'data-routed-curvature', 'data-painter'])

type SanitizedNode = { tag: string; attrs: Record<string, string>; children: (SanitizedNode | string)[] }

function paint(value: string) {
  if (/^(?:black|#000(?:000)?|#111(?:111)?|rgb\(\s*0\s*,\s*0\s*,\s*0\s*\))$/i.test(value)) return 'currentColor'
  if (/^(?:none|currentColor|white|#[a-f\d]{3}|#[a-f\d]{6})$/i.test(value)) return value
  throw new Error('Unsupported SVG color')
}
function fontFamily(value: string) {
  const families = value.split(',').map(item => item.trim().replace(/^['"]|['"]$/g, ''))
  if (!families.length || families.some(item => !['sans-serif', 'serif', 'Arial', 'Helvetica', 'DejaVu Sans', 'Times New Roman', 'Songti SC', 'SimSun'].includes(item))) throw new Error('Unsupported SVG font')
  return families.map(item => item.includes(' ') ? `"${item}"` : item).join(', ')
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
function declarations(value: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  for (const declaration of value.split(';').filter(item => item.trim())) {
    const colon = declaration.indexOf(':')
    if (colon < 0) throw new Error('Invalid SVG style')
    const name = declaration.slice(0, colon).trim(), content = declaration.slice(colon + 1).trim()
    if (name === 'font') {
      const match = /^(?:(normal|bold|[1-9]00)\s+)?(\d+(?:\.\d+)?px)\s+(.+)$/.exec(content)
      if (!match) throw new Error('Invalid SVG font')
      attrs['font-weight'] = match[1] || 'normal'
      attrs['font-size'] = match[2]
      attrs['font-family'] = fontFamily(match[3])
    } else attrs[name] = safeStyle(name, content)
  }
  return attrs
}
function safeTransform(value: string) {
  if (value.length > 1000 || !/^(?:(?:matrix|translate|scale|rotate|skewX|skewY)\(\s*[\d\s.,+eE-]+\)\s*)+$/.test(value)) throw new Error('Invalid SVG transform')
  return value
}
function bounds(value: string): [number, number, number, number] {
  const parts = value.trim().split(/[\s,]+/).map(Number)
  if (parts.length !== 4 || !parts.every(Number.isFinite) || parts[2] <= 0 || parts[3] <= 0 || parts[2] > 100000 || parts[3] > 100000) throw new Error('Invalid SVG bounds')
  return [parts[0], parts[1], parts[2], parts[3]]
}

function parseSvgTree(svg: string, scope: string): { viewBox: [number, number, number, number]; children: (SanitizedNode | string)[] } {
  if (svg.length > 4_000_000 || /<!DOCTYPE|<!ENTITY/i.test(svg)) throw new Error('Invalid SVG document')
  const document = new DOMParser().parseFromString(svg, 'image/svg+xml'), root = document.documentElement
  if (document.querySelector('parsererror') || root.localName !== 'svg' || root.namespaceURI !== SVG_NS) throw new Error('Invalid SVG document')
  const viewBox = bounds(root.getAttribute('viewBox') || '')
  const ids = new Map<string, { id: string; tag: string }>()
  for (const element of Array.from(root.querySelectorAll('[id]'))) {
    const id = element.getAttribute('id')!
    if (!identifier.test(id) || ids.has(id)) throw new Error('Invalid SVG identifier')
    ids.set(id, { id: `${scope}-${ids.size}`, tag: element.localName })
  }
  function localReference(value: string, tag: string) {
    const match = /^url\(#([A-Za-z_][\w:.-]{0,180})\)$/.exec(value), target = match && ids.get(match[1])
    if (!target || target.tag !== tag) throw new Error('Invalid SVG reference')
    return `url(#${target.id})`
  }
  // Renderer class rules become local presentation attributes. No stylesheet is ever
  // mounted, so a repeated mechanism cannot style another figure or the app.
  const rules: { classes: string[]; attrs: Record<string, string> }[] = []
  for (const style of Array.from(root.querySelectorAll('style'))) {
    const sheet = (style.textContent || '').replace(/\/\*[\s\S]*?\*\//g, '')
    let end = 0
    for (const match of sheet.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (sheet.slice(end, match.index).trim()) throw new Error('Invalid SVG stylesheet')
      const selectors = match[1].trim().split(',').map(selector => selector.trim())
      if (selectors.some(selector => !/^\.[A-Za-z_][\w-]*$/.test(selector))) throw new Error('Unsupported SVG selector')
      rules.push({ classes: selectors.map(selector => selector.slice(1)), attrs: declarations(match[2]) })
      end = match.index! + match[0].length
    }
    if (sheet.slice(end).trim()) throw new Error('Invalid SVG stylesheet')
  }
  let nodeCount = 0
  function rebuild(element: Element, depth = 0): SanitizedNode | null {
    if (++nodeCount > 10000 || depth > 128 || element.namespaceURI !== SVG_NS) throw new Error('Unsupported SVG content')
    if (element.localName === 'style' || element.localName === 'metadata') return null
    if (!elements.has(element.localName)) throw new Error('Unsupported SVG element')
    const isRoot = element === root, attrs: Record<string, string> = {}, inline = element.getAttribute('style')
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name, value = attribute.value.trim()
      if (['class', 'style', 'version', 'baseProfile', 'xml:space'].includes(name) || name.startsWith('xmlns')) continue
      if (isRoot && ['viewBox', 'width', 'height'].includes(name)) continue
      if (name === 'id') { const id = ids.get(value); if (id) attrs.id = id.id }
      else if (styleAttributes[name]) attrs[name] = safeStyle(name, value)
      else if (geometry.has(name) && number.test(value)) attrs[name] = value
      else if (name === 'd' && value.length < 1_000_000 && path.test(value)) attrs.d = value
      else if (name === 'points' && value.length < 1_000_000 && numbers.test(value)) attrs.points = value
      else if (name === 'transform') attrs.transform = safeTransform(value)
      else if (name === 'viewBox') attrs.viewBox = bounds(value).join(' ')
      else if (name === 'preserveAspectRatio' && /^(?:none|x(?:Min|Mid|Max)Y(?:Min|Mid|Max)(?:\s+(?:meet|slice))?)$/.test(value)) attrs.preserveAspectRatio = value
      else if (['marker-start', 'marker-mid', 'marker-end'].includes(name)) attrs[name] = value === 'none' ? 'none' : localReference(value, 'marker')
      else if (name === 'clip-path') attrs['clip-path'] = value === 'none' ? 'none' : localReference(value, 'clipPath')
      else if (['markerWidth', 'markerHeight', 'refX', 'refY'].includes(name) && number.test(value)) attrs[name] = value
      else if (name === 'markerUnits' && ['strokeWidth', 'userSpaceOnUse'].includes(value)) attrs.markerUnits = value
      else if (name === 'orient' && (['auto', 'auto-start-reverse'].includes(value) || number.test(value))) attrs.orient = value
      else if (name === 'clipPathUnits' && ['objectBoundingBox', 'userSpaceOnUse'].includes(value)) attrs.clipPathUnits = value
      else if (anchorAttributes.has(name) && value.length <= 200 && /^[A-Za-z0-9_:.,+\s-]+$/.test(value)) attrs[name] = value
      else throw new Error('Unsupported SVG attribute')
    }
    const classes = (element.getAttribute('class') || '').split(/\s+/)
    for (const rule of rules) if (rule.classes.some(name => classes.includes(name))) Object.assign(attrs, rule.attrs)
    if (inline) Object.assign(attrs, declarations(inline))
    const retainedClasses = classes.filter(name => semanticClasses.has(name))
    if (retainedClasses.length) attrs.class = retainedClasses.join(' ')
    if (element.parentElement === root && element.localName === 'rect' && /^(?:white|#fff(?:fff)?)$/i.test(String(attrs.fill || ''))) {
      const full = (value: unknown, size: number) => value === '100%' || Math.abs(Number(String(value).replace(/px$/, '')) - size) < .01
      if (full(attrs.width, viewBox[2]) && full(attrs.height, viewBox[3]) && Number(attrs.x || 0) === viewBox[0] && Number(attrs.y || 0) === viewBox[1]) return null
    }
    const children: (SanitizedNode | string)[] = []
    for (const node of Array.from(element.childNodes)) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        const child = rebuild(node as Element, depth + 1)
        if (child) children.push(child)
      } else if (node.nodeType === Node.TEXT_NODE) {
        if (node.textContent) children.push(node.textContent)
      } else if (node.nodeType !== Node.COMMENT_NODE) {
        throw new Error('Unsupported SVG content')
      }
    }
    return { tag: element.localName, attrs, children }
  }
  const rebuilt = rebuild(root, 0)
  if (!rebuilt) throw new Error('Empty SVG document')
  return { viewBox, children: rebuilt.children }
}

function toReactNodes(children: (SanitizedNode | string)[]): ReactNode[] {
  return children.map((child, index) => {
    if (typeof child === 'string') return child
    const props: Record<string, unknown> = { key: index }
    for (const [name, value] of Object.entries(child.attrs)) {
      props[reactPropNames[name] || name] = value
    }
    return createElement(child.tag, props, ...toReactNodes(child.children))
  })
}

const escapeXml = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function serializeNode(node: SanitizedNode | string): string {
  if (typeof node === 'string') return escapeXml(node)
  const attrText = Object.entries(node.attrs).map(([name, value]) => ` ${name}="${escapeXml(value)}"`).join('')
  if (!node.children.length) return `<${node.tag}${attrText}/>`
  return `<${node.tag}${attrText}>${node.children.map(serializeNode).join('')}</${node.tag}>`
}

/** Validate and serialize an SVG through the same strict allowlist used by ChemistrySvg. */
export function sanitizeChemistrySvg(svg: string, scope: string): { svg: string; viewBox: [number, number, number, number]; width: number; height: number } | null {
  try {
    const parsed = parseSvgTree(svg, scope)
    const [, , width, height] = parsed.viewBox
    const body = parsed.children.map(serializeNode).join('')
    return {
      svg: `<svg xmlns="${SVG_NS}" viewBox="${parsed.viewBox.join(' ')}" width="${width}" height="${height}" preserveAspectRatio="xMidYMid meet">${body}</svg>`,
      viewBox: parsed.viewBox,
      width,
      height,
    }
  } catch {
    return null
  }
}

export function ChemistrySvg({ svg, source, inline = false, kind = 'molecule' }: { svg: string; source: string; inline?: boolean; kind?: ChemistryKind }) {
  const { t } = useI18n()
  const scope = `chem-${useId().replace(/[^A-Za-z0-9_-]/g, '')}`
  const drawing = useMemo(() => {
    try {
      const parsed = parseSvgTree(svg, scope)
      return { viewBox: parsed.viewBox, content: toReactNodes(parsed.children) }
    } catch {
      return null
    }
  }, [svg, scope])
  if (!drawing) return <span className="chem-svg-error" role="alert">{t('chem.svgError')}</span>
  const [, , width, height] = drawing.viewBox, cap = kind === 'molecule' ? (inline ? 11 : 15) : kind === 'reaction' ? 24 : 32
  const style: CSSProperties = kind === 'molecule'
    ? { width: `min(${width / 16}em, ${cap * width / height}em, 100%)`, aspectRatio: `${width} / ${height}` }
    : { width: `min(${width / 16}em, 100%)`, minWidth: `${width / 22}em`, aspectRatio: `${width} / ${height}` }
  let moleculeSource = source
  if (kind === 'molecule' && source.trim().startsWith('{')) {
    try {
      const parsed = JSON.parse(source)
      if (typeof parsed?.smiles === 'string') moleculeSource = parsed.smiles
    } catch {}
  }
  const label = kind === 'molecule' ? t('chem.labelMolecule', { source: moleculeSource }) : kind === 'reaction' ? t('chem.labelReaction') : t('chem.labelMechanism')
  return <span className="chem-structure" data-kind={kind} data-inline={inline ? 'true' : undefined} role="math" aria-label={label} style={inline ? { width: style.width } : undefined}>
    <svg xmlns={SVG_NS} viewBox={drawing.viewBox.join(' ')} preserveAspectRatio="xMidYMid meet" style={inline ? { width: '100%', minWidth: style.minWidth, aspectRatio: style.aspectRatio } : style} aria-hidden="true" focusable="false">{drawing.content}</svg>
  </span>
}
