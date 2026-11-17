import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LearningStore } from '../server/learning.mjs';
import { CourseRequirements } from '../server/requirements.mjs';
import { CourseSchedule, validateCourseTiming } from '../server/course-schedule.mjs';

const root=await fs.mkdtemp(path.join(os.tmpdir(),'studio-schedule-check-')),store=new LearningStore({root}),requirements=new CourseRequirements(store),schedule=new CourseSchedule({store,requirements}),course={id:'calendar',name:'日程验收'},other={id:'other',name:'其他课程'};
const source=quote=>({type:'user',quote});
const make=(text,timeText,start,extra={})=>({kind:'exam',text,status:'confirmed',conditions:'若本班仍采用该安排',source:source(timeText),timing:{timeText,...(start?{start}:{}),...extra}});
const record=async args=>requirements.record(course,args,{text:args.source.quote});
try{
 await store.initCourse(course);
 const lateArgs=make('期末考试','2026年12月21日','2026-12-21'),late=await record(lateArgs);
 const leap=await record(make('闰年复测','2028年2月29日','2028-02-29',{timezone:'Asia/Shanghai'}));
 const early=await record(make('阶段报告','2026年11月20日15:00','2026-11-20T15:00:00+08:00',{timezone:'Asia/Shanghai'}));
 const unknown=await record(make('提交待确认时间','12月23日',undefined));
 assert.equal((await record(lateArgs)).unchanged,true);
 let events=(await schedule.list(course)).events;assert.equal(events[0].id,early.requirement.id);assert.equal(events[1].id,late.requirement.id);assert.equal(events.at(-1).id,unknown.requirement.id);assert.equal(events.find(e=>e.id===leap.requirement.id).start,'2028-02-29');assert.equal(events.find(e=>e.id===leap.requirement.id).allDay,true);assert.equal(events[1].source.quote,'2026年12月21日');assert.equal(events[1].conditions,lateArgs.conditions);
 for(const [timing,quote] of [
  [{start:'2026-02-29',timeText:'2026年2月29日'},'2026年2月29日'],
  [{start:'2026-04-31',timeText:'2026年4月31日'},'2026年4月31日'],
  [{start:'2026-12-21T24:00:00+08:00',timeText:'2026年12月21日24:00'},'2026年12月21日24:00'],
  [{start:'2026-12-21T15:00',timeText:'2026年12月21日15:00'},'2026年12月21日15:00'],
  [{start:'2026-12-21',timeText:'12月21日'},'12月21日'],
  [{start:'2026-12-21',allDay:false,timeText:'2026年12月21日'},'2026年12月21日'],
  [{start:'2026-12-21',end:'2026-12-20',timeText:'2026年12月20日到2026年12月21日'},'2026年12月20日到2026年12月21日'],
  [{start:'2026-12-21T15:00:00Z',timezone:'Asia/Shanghai',timeText:'2026年12月21日15:00'},'2026年12月21日15:00'],
  [{start:'2026-12-21',timezone:'not-a-zone',timeText:'2026年12月21日'},'2026年12月21日'],
  [{start:'2026-12-21',timeText:'2026年12月21日'},'2026年12月22日']
 ])assert.throws(()=>validateCourseTiming(timing,quote));
 assert.equal(validateCourseTiming({start:'2026-12-21T06:00:00Z',timezone:'Asia/Shanghai',timeText:'2026年12月21日下午两点'},'2026年12月21日下午两点').start,'2026-12-21T06:00:00Z');
 assert.equal(validateCourseTiming({start:'2026-12-21T06:00:00Z',timeText:'2026年12月21日下午两点'},'2026年12月21日下午两点',{timezone:'Asia/Shanghai'}).timezone,'Asia/Shanghai');
 assert.equal(validateCourseTiming({start:'2026-12-31T18:00:00Z',timezone:'Asia/Shanghai',timeText:'2027年1月1日凌晨两点'},'2027年1月1日凌晨两点').start,'2026-12-31T18:00:00Z');
 assert.throws(()=>validateCourseTiming({start:'2026-12-21T14:00:00Z',timezone:'Asia/Shanghai',timeText:'2026年12月21日下午两点'},'2026年12月21日下午两点'));
 const now={now:'2026-12-31T23:30:00+08:00',timezone:'Asia/Shanghai'};
 assert.equal(validateCourseTiming({start:'2027-01-01',timeText:'明天'},'明天',now).start,'2027-01-01');
 assert.equal(validateCourseTiming({start:'2027-01-02T14:00:00+08:00',timeText:'后天下午两点'},'后天下午两点',now).timezone,'Asia/Shanghai');
 assert.equal(validateCourseTiming({start:'2026-12-30',timeText:'昨天'},'昨天',now).start,'2026-12-30');
 assert.equal(validateCourseTiming({start:'2027-01-06',timeText:'下周三'},'下周三',now).start,'2027-01-06');
 assert.equal(validateCourseTiming({start:'2027-01-17',timeText:'下下周星期日'},'下下周星期日',now).start,'2027-01-17');
 assert.equal(validateCourseTiming({start:'2026-12-28',timeText:'本周一'},'本周一',now).start,'2026-12-28');
 assert.throws(()=>validateCourseTiming({start:'2027-01-01',timeText:'今天'},'今天',now));
 assert.throws(()=>validateCourseTiming({start:'2027-01-01',timeText:'明天'},'明天'));
 assert.throws(()=>validateCourseTiming({start:'2027-01-02T14:00:00Z',timeText:'后天下午两点'},'后天下午两点',now));
 const relativeArgs={kind:'assignment',text:'报告截止',status:'confirmed',source:source('明天下午两点交报告'),timing:{start:'2027-01-01T14:00:00+08:00',timeText:'明天下午两点'}};
 const relative=await requirements.record(course,relativeArgs,{text:relativeArgs.source.quote,...now});assert.equal(relative.requirement.timing.start,'2027-01-01T14:00:00+08:00');
 const corrected={...lateArgs,id:late.requirement.id,expectedRevision:1,reason:'老师更正日期',source:source('2026年12月28日'),timing:{start:'2026-12-28',timeText:'2026年12月28日'}};
 const update=await record(corrected);assert.equal(update.requirement.revisions.length,2);assert.equal(update.requirement.revisions[0].timing.start,'2026-12-21');
 await schedule.remove(course,late.requirement.id);assert(!((await schedule.list(course)).events.some(e=>e.id===late.requirement.id)));assert.equal((await requirements.list(course)).find(r=>r.id===late.requirement.id).scheduleDismissed,true);
 assert.equal((await record(corrected)).requirement.scheduleDismissed,true);
 const revisedAgain=await record({...corrected,expectedRevision:2,source:source('2026年12月29日'),timing:{start:'2026-12-29',timeText:'2026年12月29日'}});assert.equal(revisedAgain.requirement.scheduleDismissed,true);
 const rediscovered=await record({...lateArgs,source:source('课程通知确定于2026年12月29日考试'),timing:{start:'2026-12-29',timeText:'2026年12月29日'}});assert.equal(rediscovered.requirement.scheduleDismissed,true);assert(!((await new CourseSchedule({store:new LearningStore({root}),requirements:new CourseRequirements(new LearningStore({root}))}).list(course)).events.some(e=>e.title==='期末考试')));
 const state=await store._load(course);assert(state.requirements.find(r=>r.id===late.requirement.id).revisions.length===3);assert((await fs.readFile(await store.safePath(course,'课程重要信息.md'),'utf8')).includes('2026年12月21日'));
 assert.equal((await schedule.remove(course,late.requirement.id)).removed,true);assert.equal((await schedule.list(other)).events.length,0);await assert.rejects(schedule.remove(other,late.requirement.id));await assert.rejects(schedule.remove(course,'../AGENTS.md'));
 console.log('Course schedule: source timing, valid dates/timezones, exact local relative dates, ordering, history, deletion persistence, deduplication and course isolation passed.');
}finally{await fs.rm(root,{recursive:true,force:true});}
