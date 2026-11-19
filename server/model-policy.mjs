import {MODEL_ID,DEEP_MODEL_ID,THINKING_PRESETS,isValidModelId,isValidEffort} from '../shared/model-presets.mjs';
export {MODEL_ID,DEEP_MODEL_ID};

export const REASONING_LEVELS=Object.freeze(['none','minimal','low','medium','high','xhigh','max']);

export function checkedModel(value){
  if(value==null)return MODEL_ID;
  if(!isValidModelId(value))throw Error('模型名称无效。');
  return value.trim();
}

export function checkedEffort(value){
  if(value===undefined)return 'medium';
  if(value===null||value==='')return null;
  if(!isValidEffort(value))throw Error('思考强度参数无效。');
  return value.trim();
}

export function checkedTurn(model,effort){
  return {model:checkedModel(model),effort:checkedEffort(effort)};
}

export function normalizeCatalogModel(found){
  const rawId=typeof found?.model==='string'?found.model.trim():typeof found?.id==='string'?found.id.trim():'';
  if(!isValidModelId(rawId))return null;
  const rawOptions=Array.isArray(found?.supportedReasoningEfforts)?found.supportedReasoningEfforts:[];
  const seenEfforts=new Set(),supportedReasoningEfforts=[];
  for(const item of rawOptions){
    const effort=typeof item==='string'?item.trim():typeof item?.reasoningEffort==='string'?item.reasoningEffort.trim():'';
    if(!effort||!isValidEffort(effort)||seenEfforts.has(effort))continue;
    seenEfforts.add(effort);
    const description=typeof item?.description==='string'&&item.description.trim()?item.description.trim():undefined;
    supportedReasoningEfforts.push({reasoningEffort:effort,...(description?{description}:{})});
  }
  const declaredDefault=typeof found?.defaultReasoningEffort==='string'?found.defaultReasoningEffort.trim():null;
  const defaultReasoningEffort=declaredDefault&&seenEfforts.has(declaredDefault)
    ?declaredDefault
    :(supportedReasoningEfforts[0]?.reasoningEffort??null);
  const displayName=typeof found?.displayName==='string'&&found.displayName.trim()?found.displayName.trim():rawId;
  const description=typeof found?.description==='string'&&found.description.trim()?found.description.trim():'';
  return {
    id:rawId,
    model:rawId,
    displayName,
    ...(description?{description}:{}),
    isDefault:Boolean(found?.isDefault||rawId===MODEL_ID),
    supportedReasoningEfforts,
    defaultReasoningEffort,
  };
}

export function selectModels(models){
  if(!Array.isArray(models))return [];
  const seen=new Set(),available=[];
  for(const item of models){
    const normalized=normalizeCatalogModel(item);
    if(!normalized||seen.has(normalized.model))continue;
    seen.add(normalized.model);
    available.push(normalized);
  }
  return available;
}

export function selectModel(models,model=MODEL_ID,effort=undefined){
  const id=checkedModel(model);
  const found=Array.isArray(models)?models.find(value=>value?.model===id||value?.id===id):null;
  const normalized=found?normalizeCatalogModel(found):null;
  if(!normalized)throw Error(`当前账号的模型目录中没有 ${id}。`);
  if(effort!==undefined){
    const levels=normalized.supportedReasoningEfforts.map(item=>item.reasoningEffort);
    if(levels.length>0){
      if(!effort||!levels.includes(effort)){
        throw Error(`模型 ${normalized.displayName} 不支持思考强度「${effort??'无'}」（可选：${levels.join(' / ')}）。`);
      }
    }else if(effort!==null&&effort!==''){
      throw Error(`模型 ${normalized.displayName} 不支持自定义思考强度。`);
    }
  }
  return normalized;
}

export function validatePresetConfigs(models,raw){
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('思考强度配置无效。');
  const next={};
  for(const key of THINKING_PRESETS){
    const slot=raw[key];
    if(!slot||typeof slot!=='object'||Array.isArray(slot))throw Error(`缺少 ${key} 档位的模型配置。`);
    const model=checkedModel(slot.model);
    const effort=Object.prototype.hasOwnProperty.call(slot,'effort')?checkedEffort(slot.effort):null;
    const verified=selectModel(models,model,effort);
    next[key]={model:verified.model,effort:verified.supportedReasoningEfforts.length?effort:null};
  }
  return next;
}
