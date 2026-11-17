import { randomUUID } from 'node:crypto';

const number=(value,min=0,max=48)=>typeof value==='number'&&Number.isFinite(value)&&value>=min&&value<=max;
const object=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(key=>keys.includes(key))&&keys.every(key=>Object.hasOwn(value,key));
const arity={M:2,L:2,H:1,V:1,C:6,S:4,Q:4,T:2,Z:0};
function safePath(d){
  if(typeof d!=='string'||d.length<5||d.length>900||!/^\s*M/.test(d))return false;
  const tokens=d.match(/[MLHVCSQTZ]|(?:\d+(?:\.\d+)?|\.\d+)/g);
  if(!tokens||d.replace(/[MLHVCSQTZ]|(?:\d+(?:\.\d+)?|\.\d+)/g,'').replace(/[\s,]/g,''))return false;
  let command=null,count=0;
  for(const token of tokens){
    if(Object.hasOwn(arity,token)){
      if(command!==null&&(arity[command]===0?count!==0:count<arity[command]||count%arity[command]!==0))return false;
      command=token;count=0;
    }else{if(command===null||arity[command]===0||!number(Number(token)))return false;count++;}
  }
  return command!==null&&(arity[command]===0?count===0:count>=arity[command]&&count%arity[command]===0);
}

/** Returns a fresh canonical object, never a raw SVG or model-provided attributes. */
export function validateCourseAvatar(value){
  if(!object(value,['elements'])||!Array.isArray(value.elements)||value.elements.length<1||value.elements.length>18)throw Error('课程头像结构无效。');
  const elements=value.elements.map(element=>{
    if(!element||typeof element!=='object'||Array.isArray(element))throw Error('课程头像元素无效。');
    if(element.type==='path'&&object(element,['type','d'])&&safePath(element.d))return {type:'path',d:element.d};
    const fields={circle:['cx','cy','r'],ellipse:['cx','cy','rx','ry'],line:['x1','y1','x2','y2']}[element.type];
    if(fields&&object(element,['type',...fields])&&fields.every(key=>number(element[key],['r','rx','ry'].includes(key)?.2:0,['r','rx','ry'].includes(key)?24:48))){
      if(element.type!=='line'){const rx=element.r??element.rx,ry=element.r??element.ry;if(element.cx-rx<0||element.cx+rx>48||element.cy-ry<0||element.cy+ry>48)throw Error('课程头像超出画布。');}
      return Object.fromEntries(['type',...fields].map(key=>[key,element[key]]));
    }
    if(element.type==='polyline'&&object(element,['type','points'])&&Array.isArray(element.points)&&element.points.length>=2&&element.points.length<=24&&element.points.every(point=>Array.isArray(point)&&point.length===2&&point.every(n=>number(n))))return {type:'polyline',points:element.points.map(point=>[...point])};
    throw Error('课程头像包含不支持的绘图内容。');
  });
  if(JSON.stringify(elements).length>6500)throw Error('课程头像过于复杂。');
  return {elements};
}

export class CourseAvatars {
  constructor({store,generate,onUpdate=()=>{}}){if(!store||typeof generate!=='function')throw Error('缺少头像生成服务。');this.store=store;this.generate=generate;this.onUpdate=onUpdate;this.jobs=new Map();this.initializing=new Map();}
  async _publish(course,avatar){try{await this.onUpdate(course,avatar)}catch{}}
  async _request(course,regenerate){
    const current=this.initializing.get(course.id);
    if(current){if(regenerate&&!current.regenerate){await current.task;return this._request(course,true)}return current.task;}
    const task=this._ensure(course,regenerate);this.initializing.set(course.id,{task,regenerate});
    try{return await task}finally{if(this.initializing.get(course.id)?.task===task)this.initializing.delete(course.id)}
  }
  ensure(course){return this._request(course,false);}
  regenerate(course){return this._request(course,true);}
  async _ensure(course,regenerate){
    const state=await this.store._load(course),saved=state.avatar;let previousIcon;
    if(saved?.icon){try{previousIcon=validateCourseAvatar(saved.icon)}catch{}}
    const {icon:ignoredIcon,...savedFields}=saved||{};
    if(this.jobs.has(course.id))return {...savedFields,...(previousIcon?{icon:previousIcon}:{})};
    if(!regenerate&&saved?.status==='ready')return previousIcon?{...saved,icon:previousIcon}:{status:'failed',error:'已保存的课程头像无法显示，请更换头像。',updatedAt:saved.updatedAt};
    if(!regenerate&&saved?.status==='failed')return {...savedFields,...(previousIcon?{icon:previousIcon}:{})};
    const requestId=randomUUID(),createdAt=saved?.createdAt||new Date().toISOString();
    const pending={status:'pending',requestId,createdAt,model:'gpt-6-astra',effort:'high',updatedAt:new Date().toISOString(),...(previousIcon?{icon:previousIcon}:{})};
    await this.store._mutate(course,s=>{s.avatar=pending});
    const job=Promise.resolve().then(async()=>{
      let result;
      try{const icon=validateCourseAvatar(await this.generate({courseName:course.name,cwd:this.store.coursePath(course)}));result={status:'ready',requestId,createdAt,model:'gpt-6-astra',effort:'high',updatedAt:new Date().toISOString(),icon};}
      catch(error){result={status:'failed',requestId,createdAt,updatedAt:new Date().toISOString(),...(previousIcon?{icon:previousIcon}:{}),error:error?.code==='AVATAR_MODEL_UNAVAILABLE'?'当前账号暂时无法使用头像生成模型，请稍后重试。':previousIcon?'头像暂未更换，请重试。':'课程头像暂未生成，请重试。'};}
      const applied=await this.store._mutate(course,s=>{if(s.avatar?.requestId!==requestId)return false;s.avatar=result;return true;});if(applied)await this._publish(course,result);
    }).finally(()=>{if(this.jobs.get(course.id)===job)this.jobs.delete(course.id)});
    this.jobs.set(course.id,job);job.catch(()=>{});return pending;
  }
  async wait(course){await this.initializing.get(course.id)?.task;await this.jobs.get(course.id);return (await this.store._load(course)).avatar;}
}
