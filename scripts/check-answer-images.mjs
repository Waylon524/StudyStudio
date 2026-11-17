import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {deflateSync} from 'node:zlib';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile);
import {LearningStore} from '../server/learning.mjs';
import {prepareAnswerImage} from '../server/answer-images.mjs';
const table=Array.from({length:256},(_,n)=>{for(let k=0;k<8;k++)n=n&1?0xedb88320^(n>>>1):n>>>1;return n>>>0;});
const crc=bytes=>{let c=0xffffffff;for(const b of bytes)c=table[(c^b)&255]^(c>>>8);return (c^0xffffffff)>>>0;};
const chunk=(type,body)=>{const tag=Buffer.from(type),length=Buffer.alloc(4),checksum=Buffer.alloc(4);length.writeUInt32BE(body.length);checksum.writeUInt32BE(crc(Buffer.concat([tag,body])));return Buffer.concat([length,tag,body,checksum]);};
function png(width=24,height=20){const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(width,0);ihdr.writeUInt32BE(height,4);ihdr[8]=8;ihdr[9]=2;const row=Buffer.alloc(width*3+1,255);row[0]=0;const data=Buffer.concat(Array.from({length:height},()=>row));return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('IDAT',deflateSync(data)),chunk('IEND',Buffer.alloc(0))]);}
const root=await fs.mkdtemp(path.join(os.tmpdir(),'study-answer-check-'));
const course={id:'photo-course',name:'图片作答测试'},other={id:'other-course',name:'另一课程'};
const store=new LearningStore({root});
const bytes=png(),upload=(questionId,name='answer.png',data=bytes)=>store.uploadAnswerImage(course,{questionId,name,mime:'image/png',data:data.toString('base64')});
try{
 const registered=await store.registerSet(course,{threadId:'t',itemId:'m',spec:{id:'set',items:[{id:'short',type:'short_answer',prompt:'画出甲烷的空间结构。'},{id:'second',type:'short_answer',prompt:'画出乙烯的空间结构。'},{id:'objective',type:'true_false',prompt:'甲烷含碳。',answer:true}]}});
 const [q,q2,objective]=registered.items;
 let state=await store._load(course);assert.equal(state.attempts.length,0);
 const {image}=await upload(q.id);
 assert.equal(image.mime,'image/png');assert.equal(image.width,24);assert.equal(image.height,20);assert.match(image.url,/answer-images\//);
 state=await store._load(course);assert.equal(state.attempts.length,0);assert.equal(state.turns.length,0);assert.equal(state.attachments.length,0);
 assert(!(await store.listSources(course)).some(s=>s.relativePath.includes('answers')));
 const fixture=path.join(root,'fixture.png');await fs.writeFile(fixture,bytes);
 for(const [format,extension,mime] of [['jpeg','.jpg','image/jpeg'],['heic','.heic','image/heic']]){
  const output=path.join(root,'fixture'+extension);await exec('/usr/bin/sips',['-s','format',format,fixture,'--out',output]);
  const prepared=await prepareAnswerImage({name:'phone'+extension,mime,data:await fs.readFile(output)});assert.equal(prepared.originalMime,mime);assert.equal(prepared.mime,'image/png');assert.equal(prepared.width,24);
 }
 const loaded=await store.getAnswerImage(course,image.id);assert(loaded.data.length>0);assert.equal(loaded.mime,'image/png');
 const saved=await store.submitAttempt(course,{questionId:q.id,answer:'',imageIds:[image.id],clientId:'same-request'});
 assert.equal(saved.attempt.answer,'');assert.equal(saved.attempt.images.length,1);assert.deepEqual(saved.attempt.grade,{status:'pending_feedback',correct:null});
 const retry=await store.submitAttempt(course,{questionId:q.id,answer:'',imageIds:[image.id],clientId:'same-request'});assert.equal(retry.attempt.id,saved.attempt.id);
 await assert.rejects(store.submitAttempt(course,{questionId:q.id,answer:'',imageIds:[],clientId:'same-request'}),/不同答案/);
 const reopened=new LearningStore({root});const read=await reopened.readAttemptImages(course,saved.attempt.id);assert.equal(read.images[0].id,image.id);assert.equal(read.question.prompt,q.prompt);assert(read.images[0].data.equals(loaded.data));
 const context=await reopened.context(course);assert.match(context,/answer_images/);assert.match(context,/尚未查看图片/);assert(!context.includes('base64'));
 await assert.rejects(store.submitAttempt(course,{questionId:q2.id,answer:'another',imageIds:[image.id]}),/不属于/);
 await assert.rejects(store.submitAttempt(course,{questionId:objective.id,answer:true,imageIds:[image.id]}),/仅简答题/);
 await assert.rejects(store.submitAttempt(course,{questionId:q.id,answer:'',imageIds:[image.id,image.id]}),/最多附/);
 await assert.rejects(store.submitAttempt(course,{questionId:q.id,answer:'',imageIds:Array.from({length:5},()=>image.id)}),/最多附/);
 await assert.rejects(store.submitAttempt(course,{questionId:q.id,answer:''}),/格式无效/);
 await assert.rejects(store.removeAnswerImage(course,image.id),/已提交/);
 await store.initCourse(other);await assert.rejects(store.getAnswerImage(other,image.id),/不存在/);
 const draft=(await upload(q.id,'draft.png')).image;await store.removeAnswerImage(course,draft.id);await assert.rejects(store.getAnswerImage(course,draft.id),/不存在/);
 await assert.rejects(upload(objective.id),/仅简答题/);
 await assert.rejects(upload(q.id,'../../escape.png'),/名称无效/);
 await assert.rejects(upload(q.id,'fake.jpg'),/格式不符/);
 await assert.rejects(prepareAnswerImage({name:'bad.png',mime:'image/png',data:'YWJj=='}),/无效/);
 await assert.rejects(prepareAnswerImage({name:'bad.png',mime:'image/png',data:bytes.subarray(0,30)}));
 await assert.rejects(prepareAnswerImage({name:'too-large.png',mime:'image/png',data:Buffer.alloc(10*1024*1024+1)}),/超过/);
 const versioned=(await store._load(course)).answerImages.find(x=>x.id===image.id);const originalPath=await store.safePath(course,store._answerImagePaths(versioned).original);await fs.writeFile(originalPath,Buffer.alloc(bytes.length));
 await assert.rejects(store.getAnswerImage(course,image.id),/已变化/);
 console.log('Photo answers passed: real image decode, image-only persisted attempt, context metadata and exact image read, idempotency, hidden storage, bounds, bad formats, cross-course/question rejection, immutable submitted images, draft cleanup and tamper detection.');
}finally{await fs.rm(root,{recursive:true,force:true});}
