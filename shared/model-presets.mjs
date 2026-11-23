export const MODEL_ID='gpt-6.1-terra';
export const DEEP_MODEL_ID='gpt-6.2-astra';
export const PRESET_STORAGE_KEY='study-studio:thinking-preset';
export const PRESET_CONFIGS_STORAGE_KEY='study-studio:thinking-preset-configs';
export const LEGACY_EFFORT_STORAGE_KEY='study-studio:reasoning-effort';
export const THINKING_PRESETS=Object.freeze(['fast','default','deep']);

export const DEFAULT_PRESET_CONFIGS=Object.freeze({
  fast:Object.freeze({label:'Fast',model:MODEL_ID,effort:'medium'}),
  default:Object.freeze({label:'Default',model:MODEL_ID,effort:'high'}),
  deep:Object.freeze({label:'Deep',model:DEEP_MODEL_ID,effort:'high'}),
});

const MODEL_PATTERN=/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/;
const EFFORT_PATTERN=/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,31}$/;

export function isValidModelId(value){
  return typeof value==='string'&&MODEL_PATTERN.test(value.trim());
}

export function isValidEffort(value){
  return value===null||value===''||(typeof value==='string'&&EFFORT_PATTERN.test(value.trim()));
}

export function normalizePresetConfigs(raw){
  const result={};
  for(const key of THINKING_PRESETS){
    const fallback=DEFAULT_PRESET_CONFIGS[key];
    const entry=raw&&typeof raw==='object'&&!Array.isArray(raw)?raw[key]:null;
    const model=entry&&isValidModelId(entry.model)?entry.model.trim():fallback.model;
    let effort=fallback.effort;
    if(entry&&Object.prototype.hasOwnProperty.call(entry,'effort')){
      if(entry.effort===null||entry.effort==='')effort=null;
      else if(isValidEffort(entry.effort))effort=entry.effort.trim();
    }
    result[key]={label:fallback.label,model,effort};
  }
  return result;
}

export function thinkingPreset(value,configs){
  if(!Object.hasOwn(DEFAULT_PRESET_CONFIGS,value))throw Error('思考预设只能选择 Fast、Default 或 Deep。');
  const fallback=DEFAULT_PRESET_CONFIGS[value];
  const entry=configs&&typeof configs==='object'&&Object.prototype.hasOwnProperty.call(configs,value)?configs[value]:null;
  if(!entry)return fallback;
  const model=isValidModelId(entry.model)?entry.model.trim():fallback.model;
  const effort=Object.prototype.hasOwnProperty.call(entry,'effort')
    ?(entry.effort===null||entry.effort===''?null:isValidEffort(entry.effort)?entry.effort.trim():fallback.effort)
    :fallback.effort;
  return {label:fallback.label,model,effort};
}

const EFFORT_LABELS_ZH=Object.freeze({
  none:'关闭 (none)',
  minimal:'极简 (minimal)',
  low:'低 (low)',
  medium:'中 (medium)',
  high:'高 (high)',
  xhigh:'极高 (xhigh)',
  max:'最高 (max)',
});

const EFFORT_LABELS_EN=Object.freeze({
  none:'None',
  minimal:'Minimal',
  low:'Low',
  medium:'Medium',
  high:'High',
  xhigh:'Extra High',
  max:'Max',
});

export function effortLabel(effort,locale='zh-CN'){
  const isEn=typeof locale==='string'&&locale.toLowerCase().startsWith('en');
  if(!effort)return isEn?'Default':'默认';
  const table=isEn?EFFORT_LABELS_EN:EFFORT_LABELS_ZH;
  return Object.hasOwn(table,effort)?table[effort]:effort;
}

// The old preference overloaded xhigh as a UI sentinel. It never becomes the
// new request's effort, and the old high preference remains Default/Terra.
export function restoreThinkingPreset(value,legacyEffort){
  if(THINKING_PRESETS.includes(value))return value;
  return legacyEffort==='xhigh'?'deep':legacyEffort==='high'?'default':'fast';
}
