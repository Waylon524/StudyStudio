import { createHash } from 'node:crypto';

const normalize=value=>String(value).normalize('NFKC').replace(/\s+/g,' ').trim();
const compact=value=>normalize(value).replace(/\s+/g,'');
const isDate=value=>/^\d{4}-\d{2}-\d{2}$/.test(value);
const dateParts=value=>/^(\d{4})-(\d{2})-(\d{2})/.exec(value)?.slice(1).map(Number);
function validDay(value){
  const parts=dateParts(value);if(!parts)return false;
  const [year,month,day]=parts;if(year<1||month<1||month>12||day<1||day>31)return false;
  const date=new Date(0);date.setUTCHours(0,0,0,0);date.setUTCFullYear(year,month-1,day);
  return date.getUTCFullYear()===year&&date.getUTCMonth()===month-1&&date.getUTCDate()===day;
}
function validInstant(value){
  if(typeof value!=='string'||!validDay(value))return false;
  if(isDate(value))return true;
  const match=/^\d{4}-\d{2}-\d{2}T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if(!match||Number(match[1])>23||Number(match[2])>59||Number(match[3]||0)>59)return false;
  if(match[4]!=='Z'&&(Number(match[4].slice(1,3))>23||Number(match[4].slice(4))>59))return false;
  return Number.isFinite(Date.parse(value));
}
function number(value){
  if(/^\d+$/.test(value))return Number(value);
  const digits={'零':0,'〇':0,'一':1,'二':2,'两':2,'三':3,'四':4,'五':5,'六':6,'七':7,'八':8,'九':9};
  if(value==='十')return 10;
  if(value.includes('十')){const [a,b]=value.split('十');return (a?digits[a]:1)*10+(b?digits[b]:0);}
  return value.length===1?digits[value]:NaN;
}
function quotedDates(quote){
  const value=compact(quote),result=new Set(),years=[...new Set([...value.matchAll(/(\d{4})年/g)].map(m=>m[1]))];
  for(const match of value.matchAll(/(\d{4})(?:年|[-/.])(\d{1,2})(?:月|[-/.])(\d{1,2})(?:日|号)?/g))result.add(`${match[1]}-${match[2].padStart(2,'0')}-${match[3].padStart(2,'0')}`);
  if(years.length===1)for(const match of value.matchAll(/(\d{1,2})月(\d{1,2})(?:日|号)/g))result.add(`${years[0]}-${match[1].padStart(2,'0')}-${match[2].padStart(2,'0')}`);
  return result;
}
function localParts(instant,timezone){
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(new Date(instant));
  return Object.fromEntries(parts.filter(part=>part.type!=='literal').map(part=>[part.type,part.value]));
}
function relativeDates(quote,context){
  const result=new Set();if(typeof context.now!=='string'||!Number.isFinite(Date.parse(context.now))||typeof context.timezone!=='string')return result;
  let parts;try{parts=localParts(context.now,context.timezone)}catch{return result;}
  const base=new Date(Date.UTC(Number(parts.year),Number(parts.month)-1,Number(parts.day))),weekday=(base.getUTCDay()+6)%7,value=compact(quote);
  const add=days=>{const date=new Date(base);date.setUTCDate(date.getUTCDate()+days);result.add(date.toISOString().slice(0,10));};
  for(const match of value.matchAll(/今天|明天|后天|昨天/g))add({'今天':0,'明天':1,'后天':2,'昨天':-1}[match[0]]);
  for(const match of value.matchAll(/(本|这|下下|下)(?:周|星期|礼拜)(?:的)?(?:星期|礼拜|周)?([一二三四五六日天])/g))add(({'本':0,'这':0,'下':1,'下下':2}[match[1]])*7+({'一':0,'二':1,'三':2,'四':3,'五':4,'六':5,'日':6,'天':6}[match[2]])-weekday);
  return result;
}
function quotedTimes(quote){
  const value=compact(quote),result=new Set();
  for(const match of value.matchAll(/(?:^|[^\d+-])(\d{1,2}):(\d{2})(?::(\d{2}))?/g))result.add(`${Number(match[1])}:${Number(match[2])}:${Number(match[3]||0)}`);
  for(const match of value.matchAll(/(凌晨|早上|上午|中午|下午|晚上)?([零〇一二两三四五六七八九十\d]+)[点时](?:([零〇一二两三四五六七八九十\d]+)分?)?/g)){
    let hour=number(match[2]),minute=match[3]?number(match[3]):0;
    if(['下午','晚上'].includes(match[1])&&hour<12)hour+=12;
    if(match[1]==='中午'&&hour<11)hour+=12;
    if(match[1]==='凌晨'&&hour===12)hour=0;
    if(Number.isFinite(hour)&&Number.isFinite(minute))result.add(`${hour}:${minute}:0`);
  }
  return result;
}

/** Normalized dates must be supported by the actual quoted temporal wording. */
export function validateCourseTiming(value,sourceQuote,context={}){
  if(value===undefined)return undefined;
  const allowed=['start','end','allDay','timeText','timezone'];
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!allowed.includes(key)))throw Error('日程时间无效。');
  if(typeof value.timeText!=='string'||!value.timeText.trim()||value.timeText.length>1000||value.timeText.includes('\0'))throw Error('日程需要保留来源中的时间原文。');
  const timeText=normalize(value.timeText);
  if(!normalize(sourceQuote).includes(timeText))throw Error('日程时间原文必须来自本条来源。');
  if(value.allDay!==undefined&&typeof value.allDay!=='boolean')throw Error('全天日程标记无效。');
  const result={timeText};
  if(value.timezone!==undefined){
    if(typeof value.timezone!=='string'||value.timezone.length>100)throw Error('日程时区无效。');
    try{new Intl.DateTimeFormat('en',{timeZone:value.timezone}).format(new Date());}catch{throw Error('日程时区无效。');}
    result.timezone=value.timezone;
  }
  const relatives=relativeDates(sourceQuote,context),dates=new Set([...quotedDates(sourceQuote),...relatives]),times=quotedTimes(sourceQuote);
  for(const field of ['start','end'])if(value[field]!==undefined){
    const date=value[field];if(!validInstant(date))throw Error('日程日期或时间无效；请保留原文并待确认。');
    let calendarDate=date.slice(0,10),clock;
    if(!isDate(date)){
      const zone=value.timezone||(typeof context.timezone==='string'?context.timezone:undefined);
      if(zone){
        let parts;try{parts=localParts(date,zone)}catch{throw Error('日程时区无效。');}
        calendarDate=`${parts.year}-${parts.month}-${parts.day}`;
        clock=`${Number(parts.hour)}:${Number(parts.minute)}:${Number(parts.second)}`;
        if(!result.timezone)result.timezone=zone;
      }else{
        const [,hour,minute,second]=/T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(date);
        clock=`${Number(hour)}:${Number(minute)}:${Number(second||0)}`;
      }
    }
    if(!dates.has(calendarDate))throw Error('日程日期缺少完整的来源依据；未明确年份的时间请先保留原文。');
    if(clock&&!times.has(clock))throw Error('日程时刻缺少来源依据；请勿补入未明确的钟点。');
    result[field]=date;
  }
  if(result.end&&!result.start)throw Error('日程结束时间需要开始时间。');
  if(result.start){
    const allDay=isDate(result.start);
    if(value.allDay!==undefined&&value.allDay!==allDay)throw Error('日程日期精度与全天标记不一致。');
    result.allDay=allDay;
    if(result.end){if(isDate(result.end)!==allDay)throw Error('日程开始与结束时间的精度不一致。');if(result.end<result.start&&allDay||!allDay&&Date.parse(result.end)<Date.parse(result.start))throw Error('日程结束时间不能早于开始时间。');}
  }else result.allDay=value.allDay??false;
  return result;
}

export function scheduleFingerprint(requirement){
  if(!requirement.timing)return null;
  const timing=requirement.timing,start=timing.start?(isDate(timing.start)?timing.start:new Date(timing.start).toISOString()):compact(timing.timeText);
  return createHash('sha256').update(JSON.stringify([compact(requirement.text),start])).digest('hex');
}
export function isScheduleDismissed(state,requirement){
  if((state.scheduleRestorations||[]).some(item=>item.id===requirement.id))return false;
  const fingerprint=scheduleFingerprint(requirement);
  return !!fingerprint&&(state.scheduleDismissals||[]).some(item=>item.id===requirement.id||item.fingerprint===fingerprint||item.fingerprints?.includes(fingerprint));
}
export function retainScheduleDismissal(state,previous,current){
  if(!current.timing||(state.scheduleRestorations||[]).some(item=>item.id===current.id))return;
  const previousFingerprint=previous&&scheduleFingerprint(previous),fingerprint=scheduleFingerprint(current);
  const source=(state.scheduleDismissals||[]).find(item=>item.id===current.id||item.fingerprint===fingerprint||item.fingerprints?.includes(fingerprint)||previousFingerprint&&(item.fingerprint===previousFingerprint||item.fingerprints?.includes(previousFingerprint)));
  if(!source)return;
  let row=state.scheduleDismissals.find(item=>item.id===current.id);
  if(!row){row={id:current.id,revision:current.revision,deletedAt:source.deletedAt,fingerprint};state.scheduleDismissals.push(row);}
  row.fingerprints=[...new Set([...(row.fingerprints||[]),row.fingerprint,fingerprint].filter(Boolean))];
}
function dayKey(timing){
  if(!timing.start)return '\uffff';
  if(isDate(timing.start)||!timing.timezone)return timing.start.slice(0,10);
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone:timing.timezone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(timing.start)),part=type=>parts.find(item=>item.type===type)?.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}
function compareEvents(a,b){
  const day=dayKey(a).localeCompare(dayKey(b));if(day)return day;
  if(a.start&&b.start){if(a.allDay!==b.allDay)return a.allDay?-1:1;const instant=Date.parse(a.start)-Date.parse(b.start);if(instant)return instant;}
  return a.title.localeCompare(b.title,'zh-CN',{numeric:true})||a.id.localeCompare(b.id);
}

export class CourseSchedule {
  constructor({store,requirements}){if(!store||!requirements)throw Error('缺少课程日程服务。');this.store=store;this.requirements=requirements;}
  async list(course,{state,records}={}){
    state ||= await this.store._load(course);if(state.courseId!==course.id)throw Error('课程记录不匹配。');records ||= await this.requirements.list(course,{includeHistory:false,state});
    const events=records.filter(item=>item.timing&&item.status!=='withdrawn'&&!item.scheduleDismissed&&!isScheduleDismissed(state,item)).map(item=>({id:item.id,title:item.text,...item.timing,kind:item.kind,status:item.status,source:item.source,conditions:item.conditions,revision:item.revision,updatedAt:item.updatedAt})).sort(compareEvents);
    return {events,dismissed:(state.scheduleDismissals||[]).filter(item=>!(state.scheduleRestorations||[]).some(restored=>restored.id===item.id)).map(({id,revision,deletedAt})=>({id,revision,deletedAt}))};
  }
  async remove(course,id){
    if(typeof id!=='string'||!/^req-[0-9a-f-]{36}$/.test(id))throw Error('日程 ID 无效。');
    return this.store._mutate(course,state=>{
      const entry=state.requirements?.find(item=>item.id===id),latest=entry?.revisions.at(-1);if(!entry||!latest?.timing)throw Error('日程不存在。');
      const wasRestored=(state.scheduleRestorations||[]).some(item=>item.id===id);state.scheduleRestorations=(state.scheduleRestorations||[]).filter(item=>item.id!==id);
      state.scheduleDismissals ||= [];
      if(wasRestored||!state.scheduleDismissals.some(item=>item.id===id))state.scheduleDismissals.push({id,revision:latest.revision,fingerprint:scheduleFingerprint({id,...latest}),deletedAt:new Date().toISOString()});
      return {removed:true,id};
    });
  }
}
