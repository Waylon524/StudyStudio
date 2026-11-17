import {finalAssistantItems} from './final-messages.mjs';

export function createFinalStream(){return {turnId:null,items:new Map(),finished:false,success:false};}

// Deltas never carry phase in the app-server protocol. Hold them until item
// metadata explicitly identifies final_answer; commentary stays private.
export function applyFinalStream(state,method,params={}){
  if(state.finished)return false;
  if(state.turnId&&params.turnId&&state.turnId!==params.turnId)return false;
  if(params.turnId)state.turnId=params.turnId;
  const item=params.item;
  const id=method==='item/agentMessage/delta'?params.itemId:item?.id;
  if(typeof id!=='string'||(method!=='item/agentMessage/delta'&&item?.type!=='agentMessage'))return false;
  const previous=state.items.get(id)||{id,type:'agentMessage',text:'',phase:null,completed:false};
  const next={...previous};
  if(method==='item/agentMessage/delta'){
    if(next.completed||typeof params.delta!=='string')return false;
    next.text+=params.delta;
  }else if(method==='item/started'||method==='item/completed'){
    if(item.phase!=null)next.phase=item.phase;
    if(typeof item.text==='string'&&(method==='item/completed'||!next.text))next.text=item.text;
    if(method==='item/completed')next.completed=true;
  }else return false;
  state.items.set(id,next);
  return next.phase==='final_answer'||previous.phase==='final_answer';
}

export function finishFinalStream(state,{success=false,items=[]}={}){
  for(const item of items)if(item?.type==='agentMessage')applyFinalStream(state,'item/completed',{item});
  state.finished=true;state.success=success;
}

export function finalStreamMessages(state){
  const items=[...state.items.values()];
  const selected=state.finished&&state.success?finalAssistantItems(items.filter(item=>item.completed||item.phase==='final_answer')):items.filter(item=>item.phase==='final_answer').slice(-1);
  return selected.filter(item=>item.text.length>0).map(item=>({id:item.id,role:'assistant',text:item.text,streaming:!state.finished&&!item.completed,incomplete:state.finished&&(!state.success||!item.completed)}));
}
