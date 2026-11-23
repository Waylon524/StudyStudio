/**
 * Explicit, deliberately limited mhchem-equation -> native route adapter.
 * This is a notation parser, not a chemical balance/validity checker.
 * Keep resonance (<->) in KaTeX; never reinterpret it as equilibrium.
 */
const OPEN = new Map([['{', '}'], ['[', ']'], ['(', ')']]);
const CLOSE = new Set(OPEN.values());
const ARROWS = ['<-->', '<<=>', '<=>>', '<=>', '<->', '->', '<-', '⇌', '→', '←', '↔'];
const KIND = new Map([['->', 'forward'], ['→', 'forward'], ['<-', 'reverse'], ['←', 'reverse'], ['<=>', 'equilibrium'], ['⇌', 'equilibrium']]);
const RESONANCE = new Set(['<->', '↔']);
const SUB = Object.fromEntries([... '0123456789+-()'].map((c, i) => [c, [... '₀₁₂₃₄₅₆₇₈₉₊₋₍₎'][i]]));
const SUP = {
  ...Object.fromEntries([... '0123456789+-()'].map((c, i) => [c, [... '⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁽⁾'][i]])),
  '•': '•',
  '·': '•',
  '.': '•',
};

export class ChemicalEquationError extends Error {
  constructor(code, message, offset) {
    super(message); this.name = 'ChemicalEquationError'; this.code = code;
    if (offset !== undefined) this.offset = offset;
  }
}
function fail(code, message, offset) { throw new ChemicalEquationError(code, message, offset); }

/** Read one balanced group. Braces escaped as \{ / \} are unsupported. */
function groupAt(text, start) {
  if (!OPEN.has(text[start])) fail('EXPECTED_GROUP', '这里需要成对括号。', start);
  const stack = [OPEN.get(text[start])];
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === '\\') { i++; continue; }
    if (OPEN.has(text[i])) stack.push(OPEN.get(text[i]));
    else if (CLOSE.has(text[i])) {
      if (stack.pop() !== text[i]) fail('UNBALANCED_GROUP', '化学式或条件的括号不匹配。', i);
      if (!stack.length) return {value: text.slice(start + 1, i), end: i + 1};
    }
  }
  fail('UNBALANCED_GROUP', '化学式或条件的括号未闭合。', start);
}

/** Return only a whole \ce{...} command; leave mixed mathematics untouched. */
export function extractCeExpression(mathSource) {
  const text = String(mathSource).trim();
  const match = /^\\ce\s*\{/.exec(text);
  if (!match) return null;
  const group = groupAt(text, match[0].length - 1);
  return text.slice(group.end).trim() ? null : group.value;
}

function arrowTokens(text) {
  const tokens = [], stack = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '\\') {
      // No TeX expansion is attempted. Arrow commands cannot silently disappear.
      const command = /^\\([A-Za-z]+)/.exec(text.slice(i));
      if (command && /(?:arrow|harpoon|equilibrium)/i.test(command[1]) && !stack.length)
        fail('UNSUPPORTED_ARROW', '反应箭头请写 ->、<- 或 <=>；复杂箭头语法暂不支持。', i);
      i += command ? command[0].length - 1 : 1;
      continue;
    }
    if (OPEN.has(c)) { stack.push(OPEN.get(c)); continue; }
    if (CLOSE.has(c)) {
      if (stack.pop() !== c) fail('UNBALANCED_GROUP', '化学式或条件的括号不匹配。', i);
      continue;
    }
    if (!stack.length) {
      const token = ARROWS.find(value => text.startsWith(value, i));
      if (token) { tokens.push({token, start: i, end: i + token.length}); i += token.length - 1; }
    }
  }
  if (stack.length) fail('UNBALANCED_GROUP', '化学式或条件的括号未闭合。');
  return tokens;
}

/** Classify whole ce math. Formula-only and resonance-only ce stay in KaTeX. */
export function chemicalEquationFromMath(mathSource) {
  const source = extractCeExpression(mathSource);
  if (source === null) return null;
  let arrows;
  try { arrows = arrowTokens(source); }
  catch (error) {
    // Forward unsupported arrow commands to the backend for an explicit error;
    // never throw from the Markdown tree transformer and break the whole answer.
    if (error instanceof ChemicalEquationError && error.code === 'UNSUPPORTED_ARROW')
      return {kind: 'equation', source};
    throw error;
  }
  if (!arrows.length || arrows.every(arrow => RESONANCE.has(arrow.token))) return null;
  return {kind: 'equation', source};
}

function scriptText(value, table, kind) {
  if (!value || [...value].some(c => !Object.hasOwn(table, c)))
    fail('UNSUPPORTED_SCRIPT', `${kind}仅支持数字、电荷正负号、自由基点与括号；请明确展开复杂表达式。`);
  return [...value].map(c => table[c]).join('');
}
function scriptAt(text, start) {
  if (text[start] === '{') return groupAt(text, start);
  const value = /^(?:[0-9]*[+−\-•·.]+|[0-9]+)/u.exec(text.slice(start))?.[0];
  if (!value) fail('UNSUPPORTED_SCRIPT', '上下标需用数字、电荷或自由基点；多字符请放在花括号中。', start);
  return {value, end: start + value.length};
}

function expandPlainCommands(text) {
  let out = '';
  for (let i = 0; i < text.length;) {
    if (text[i] !== '\\') { out += text[i++]; continue; }
    const command = /^\\([A-Za-z]+|[,;! ])/u.exec(text.slice(i));
    if (!command) fail('UNSUPPORTED_COMMAND', '此化学方程式含未支持的 TeX 转义。', i);
    const name = command[1]; i += command[0].length;
    if (['text', 'mathrm', 'ce'].includes(name)) {
      while (/\s/u.test(text[i] || '') && i < text.length) i++;
      if (text[i] !== '{') fail('UNSUPPORTED_COMMAND', `\\${name} 需要花括号。`, i);
      const group = groupAt(text, i); out += expandPlainCommands(group.value); i = group.end;
    } else {
      const replacements = {
        Delta: 'Δ', delta: 'δ', alpha: 'α', beta: 'β', gamma: 'γ', lambda: 'λ', mu: 'μ', nu: 'ν', pi: 'π', sigma: 'σ',
        circ: '°', degree: '°', cdot: '·', bullet: '•', times: '×', pm: '±', mp: '∓', approx: '≈',
        uparrow: '↑', downarrow: '↓', ',': ' ', ';': ' ', '!': '', ' ': ' ',
      };
      if (!Object.hasOwn(replacements, name)) fail('UNSUPPORTED_COMMAND', `暂不支持 \\${name}；请改用明确的化学式或条件文字。`, i - command[0].length);
      out += replacements[name];
    }
  }
  return out;
}

/** Unicode atom indices/charges; stoichiometric coefficients remain baseline. */
export function formatChemicalSpecies(raw) {
  let text = expandPlainCommands(String(raw).trim());
  if (!text) fail('EMPTY_SPECIES', '反应式中有空物种。');
  text = text.replace(/\s+v$/u, ' ↓').replace(/\s+\^$/u, ' ↑');
  // Ordinary text nodes cannot safely represent bonds, fractions or TeX layout.
  if (/[<>=$%&#~|]/u.test(text)) fail('UNSUPPORTED_SPECIES', '此物种含复杂结构或排版；请使用有机结构式组件或展开写法。');
  let coefficient = '';
  const lead = /^(\d+(?:\/\d+|\.\d+)?)\s*(?=[A-Za-z\[(^])/u.exec(text);
  if (lead) { coefficient = lead[1] + ' '; text = text.slice(lead[0].length); }
  let out = '';
  for (let i = 0; i < text.length;) {
    const c = text[i];
    if (c === '^' || c === '_') {
      const script = scriptAt(text, i + 1);
      out += scriptText(script.value.replace(/−/g, '-'), c === '^' ? SUP : SUB, c === '^' ? '上标' : '下标');
      i = script.end; continue;
    }
    if (c === '{' || c === '}') fail('UNSUPPORTED_GROUP', '物种中的花括号仅用于上下标或受支持的文字命令。', i);
    if (/\d/u.test(c)) {
      const digits = /^\d+/.exec(text.slice(i))[0];
      const prev = text[i - 1] || '';
      out += /[A-Za-z)\]₀-₉]/u.test(prev) ? scriptText(digits, SUB, '下标') : digits;
      i += digits.length; continue;
    }
    if (c === '+' || c === '-' || c === '−') {
      // An inline hyphen between two chemical groups (e.g. C4H9-Br, R-H) is a single bond.
      const prev = text[i - 1] || '';
      const next = text[i + 1] || '';
      if ((c === '-' || c === '−') && /[A-Za-z0-9)\]₀-₉]/u.test(prev) && /[A-Za-z(\[]/u.test(next)) {
        out += '–'; i++; continue;
      }
      // A species charge is terminal, possibly with a radical dot and/or phase/gas/solid mark.
      if (!/^(?:[+−\-•]+)(?:\s*\((?:aq|s|l|g)\))?\s*[↑↓]?$/u.test(text.slice(i)))
        fail('AMBIGUOUS_CHARGE', '物种间的 + 两侧请留空格；电荷请写 H+、Fe^{3+} 等明确形式。', i);
      out += c === '+' ? '⁺' : '⁻'; i++; continue;
    }
    if (!/[A-Za-z\p{N}\s()[\]·•–—.,↑↓°±Δδαβγλμνπσ⁰-⁹₀-₉⁺⁻₊₋⁽⁾₍₎]/u.test(c))
      fail('UNSUPPORTED_SPECIES', `物种中暂不支持字符 ${c}。`, i);
    out += c; i++;
  }
  return coefficient + out.replace(/\s+/gu, ' ').trim();
}

/** Conditions remain prose; only chemical-formula tokens get numeric indices. */
export function formatChemicalCondition(raw) {
  let text = expandPlainCommands(String(raw).trim());
  // Common mhchem temperature notation, before generic superscript conversion.
  text = text.replace(/\^\{?°\}?/gu, '°').replace(/\^\{?\\?circ\}?/gu, '°');
  text = text.replace(/\^\{([0-9+−\-()•·.]+)\}|\^([0-9]*[+−\-•·.]+)/gu, (_, a, b) => scriptText((a || b).replace(/−/g, '-'), SUP, '上标'));
  if (/[\\{}^_$%&#~|]/u.test(text)) fail('UNSUPPORTED_CONDITION', '箭头条件含未支持的排版；请使用中文、化学式与普通数字。');
  return text.replace(/(?:[A-Z][a-z]?)(?:[A-Z][a-z]?|\d+|\([^()]*\)\d*)*(?:[+\-•])?/gu, value => formatChemicalSpecies(value)).replace(/\s+/gu, ' ');
}

function speciesItems(side) {
  const parts = [], stack = []; let start = 0;
  for (let i = 0; i < side.length; i++) {
    const c = side[i];
    if (c === '\\') { const cmd = /^\\[A-Za-z]+/.exec(side.slice(i)); i += cmd ? cmd[0].length - 1 : 1; continue; }
    if (OPEN.has(c)) stack.push(OPEN.get(c));
    else if (CLOSE.has(c)) { if (stack.pop() !== c) fail('UNBALANCED_GROUP', '物种中的括号不匹配。', i); }
    else if (c === '+' && !stack.length && /\s/u.test(side[i - 1] || '') && /\s/u.test(side[i + 1] || '')) {
      parts.push(side.slice(start, i)); start = i + 1;
    }
  }
  if (stack.length) fail('UNBALANCED_GROUP', '物种中的括号未闭合。');
  parts.push(side.slice(start));
  return parts.flatMap((part, index) => {
    if (!part.trim()) fail('EMPTY_SPECIES', '每个反应物和产物都必须写完整。');
    return [...(index ? [{type: 'plus'}] : []), {type: 'text', text: formatChemicalSpecies(part)}];
  });
}

/**
 * Return the same route rows/items used for structure reactions.
 * Raw left/right order is retained for a reverse arrow; never swap compounds.
 */
export function parseChemicalEquation(input) {
  if (typeof input !== 'string' || !input.trim()) fail('EMPTY_EQUATION', '请输入化学方程式。');
  const source = /^\s*\\ce\b/u.test(input) ? extractCeExpression(input) : input.trim();
  if (source === null) fail('MIXED_MATH', '仅支持完整的 \\ce{…} 方程式；混合数学请分开书写。');
  const arrows = arrowTokens(source);
  if (!arrows.length) fail('MISSING_ARROW', '方程式需要 ->、<- 或 <=> 反应箭头。');
  if (arrows.some(arrow => RESONANCE.has(arrow.token))) fail('RESONANCE_NOT_REACTION', '共振双向箭头 <-> 应保留为普通化学表达，不作为反应方程式转换。');
  if (arrows.some(arrow => !KIND.has(arrow.token))) fail('UNSUPPORTED_ARROW', '暂不支持不等长平衡箭头或双向全箭头；请明确使用 ->、<- 或 <=>。');
  const items = []; let start = 0;
  for (const arrow of arrows) {
    if (arrow.start < start) fail('ARROW_IN_CONDITION', '箭头条件中出现了嵌套反应；请把反应分开书写。');
    items.push(...speciesItems(source.slice(start, arrow.start)));
    let end = arrow.end; const labels = [];
    for (let count = 0; count < 2; count++) {
      // Conditions are adjacent: ->[above][below]. A separated [complex] is
      // a product species, not an arrow label. Never silently consume it.
      if (source[end] !== '[') break;
      const condition = groupAt(source, end); labels.push(formatChemicalCondition(condition.value)); end = condition.end;
    }
    if (source[end] === '[') fail('TOO_MANY_CONDITIONS', '每支箭头仅支持一个上方条件和一个下方条件。', end);
    items.push({type: 'arrow', arrow_kind: KIND.get(arrow.token), label: labels[0] || '', sublabel: labels[1] || ''});
    start = end;
  }
  items.push(...speciesItems(source.slice(start)));
  return {rows: [{items}]};
}

/**
 * Parse a standalone formula or species expression (without reaction arrows) into
 * the same route-text structure, for canvases and vector formula cards.
 */
export function parseChemicalFormula(input) {
  if (typeof input !== 'string' || !input.trim()) fail('EMPTY_EQUATION', '请输入化学式。');
  const source = /^\s*\\ce\b/u.test(input) ? extractCeExpression(input) : input.trim();
  if (source === null) fail('MIXED_MATH', '仅支持完整的 \\ce{…} 化学式。');
  const arrows = arrowTokens(source);
  if (arrows.length) return parseChemicalEquation(input);
  return {rows: [{items: speciesItems(source)}]};
}
