import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const exec=promisify(execFile);
export const MAX_ANSWER_IMAGE_BYTES=10*1024*1024;
export const MAX_ANSWER_IMAGES=4;
export const ANSWER_IMAGE_ID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const allowedExtensions={
 'image/png':['.png'],'image/jpeg':['.jpg','.jpeg'], 'image/webp':['.webp'],
 'image/gif':['.gif'],'image/heic':['.heic','.heif'],'image/heif':['.heif','.heic'],
};
function imageMime(data){
 if(data.length>=24&&data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))&&data.toString('ascii',12,16)==='IHDR')return 'image/png';
 if(data.length>=4&&data[0]===255&&data[1]===216&&data[2]===255&&data[data.length-2]===255&&data[data.length-1]===217)return 'image/jpeg';
 if(data.length>=16&&data.toString('ascii',0,4)==='RIFF'&&data.toString('ascii',8,12)==='WEBP'&&data.readUInt32LE(4)+8===data.length)return 'image/webp';
 if(data.length>=14&&['GIF87a','GIF89a'].includes(data.toString('ascii',0,6))&&data[data.length-1]===59)return 'image/gif';
 if(data.length>=24&&data.toString('ascii',4,8)==='ftyp'){
  const boxSize=data.readUInt32BE(0);if(boxSize<24||boxSize>Math.min(data.length,4096))return null;
  const brands=[];for(let i=8;i+4<=boxSize;i+=4)if(i!==12)brands.push(data.toString('ascii',i,i+4));
  if(brands.some(brand=>['heic','heix','hevc','hevx'].includes(brand)))return 'image/heic';
  if(brands.some(brand=>['mif1','msf1'].includes(brand)))return 'image/heif';
 }
 return null;
}
function decodeBase64(data){
 if(Buffer.isBuffer(data))return data;
 if(typeof data!=='string'||!data.length||data.length>Math.ceil(MAX_ANSWER_IMAGE_BYTES/3)*4||data.length%4||!/^[A-Za-z0-9+/]*={0,2}$/.test(data))throw Error('图片内容无效或超过 10 MB。');
 const result=Buffer.from(data,'base64');if(result.toString('base64')!==data)throw Error('图片内容无效。');return result;
}
function pngDimensions(bytes){
 if(bytes.length<24||imageMime(bytes)!=='image/png')throw Error('图片预览生成失败。');
 return {width:bytes.readUInt32BE(16),height:bytes.readUInt32BE(20)};
}
export async function prepareAnswerImage({name,mime,data}){
 if(typeof name!=='string'||!name||name.length>240||name.startsWith('.')||/[\/\\\x00-\x1f]/.test(name))throw Error('图片名称无效。');
 const bytes=decodeBase64(data);if(!bytes.length||bytes.length>MAX_ANSWER_IMAGE_BYTES)throw Error('每张作答图片不能超过 10 MB。');
 const actualMime=imageMime(bytes),extension=path.extname(name).toLowerCase();
 if(!actualMime||!allowedExtensions[actualMime]?.includes(extension))throw Error('图片内容与格式不符；支持 PNG、JPEG、WebP、GIF、HEIC 和 HEIF。');
 const suppliedMime=typeof mime==='string'?mime.toLowerCase():'';
 if(suppliedMime&&suppliedMime!=='application/octet-stream'&&suppliedMime!==actualMime&&!(actualMime==='image/heic'&&suppliedMime==='image/heif')&&!(actualMime==='image/heif'&&suppliedMime==='image/heic')&&!(actualMime==='image/jpeg'&&suppliedMime==='image/jpg'))throw Error('图片类型与实际内容不一致。');
 const scratch=await fs.mkdtemp(path.join(os.tmpdir(),'study-answer-image-'));
 try{
  const original=path.join(scratch,'original'+extension),previewPath=path.join(scratch,'preview.png');
  await fs.writeFile(original,bytes,{flag:'wx',mode:0o600});
  let width,height;
  try{
   const {stdout}=await exec('/usr/bin/sips',['-g','pixelWidth','-g','pixelHeight',original],{timeout:8000,maxBuffer:100000});
   width=Number(/pixelWidth:\s*(\d+)/.exec(stdout)?.[1]);height=Number(/pixelHeight:\s*(\d+)/.exec(stdout)?.[1]);
   if(!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1||width>15000||height>15000||width*height>25000000)throw Error('dimensions');
   await exec('/usr/bin/sips',['-s','format','png',...(Math.max(width,height)>2400?['--resampleHeightWidthMax','2400']:[]),original,'--out',previewPath],{timeout:15000,maxBuffer:100000});
  }catch(error){throw Error(error.message==='dimensions'?'图片尺寸过大或无效，请裁剪后重试。':'图片无法完整解码，请重新导出或拍摄后上传。');}
  let preview=await fs.readFile(previewPath);
  if(preview.length>MAX_ANSWER_IMAGE_BYTES){
   await exec('/usr/bin/sips',['-s','format','png','--resampleHeightWidthMax','1600',original,'--out',previewPath],{timeout:15000,maxBuffer:100000});
   preview=await fs.readFile(previewPath);
  }
  if(preview.length>MAX_ANSWER_IMAGE_BYTES)throw Error('图片展开后过大，请裁剪后重试。');
  const view=pngDimensions(preview);
  return {name,bytes,originalMime:actualMime,originalWidth:width,originalHeight:height,preview,mime:'image/png',...view,...(actualMime==='image/gif'?{warning:'GIF 作答图片仅展示首帧；原图已保留。'}:{})};
 }finally{await fs.rm(scratch,{recursive:true,force:true});}
}
