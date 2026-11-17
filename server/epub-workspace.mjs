import path from 'node:path';
import {listEpub,readEpub,decodeEpubImagePath,decodeEpubSectionPath} from './epub-visual.mjs';

function locate(value){
  if(typeof value!=='string')return null;
  const image=decodeEpubImagePath(value);if(image)return {...image,imageRef:image.member};
  const section=decodeEpubSectionPath(value);if(section)return section;
  return path.extname(value).toLowerCase()==='.epub'?{path:value}:null;
}

export async function listWorkspaceEpub(store,course,args){
  const pointer=locate(args.path);if(!pointer)return null;
  if(pointer.imageRef)throw Error('请用 study_workspace_read 打开返回的 EPUB 图片指针。');
  const source=await store.sourceForPath(course,pointer.path),file=await store.safePath(course,source.relativePath);
  if(path.extname(source.relativePath).toLowerCase()!=='.epub')throw Error('指针没有指向课程内的 EPUB。');
  const result=await listEpub(file,{offset:args.offset,limit:args.limit,relativePath:source.relativePath,section:pointer.section});
  return {sourceId:source.id,sourceName:source.name,relativePath:source.relativePath,...result};
}

export async function readWorkspaceEpub(store,course,args){
  const pointer=locate(args.path);if(!pointer)return null;
  if(args.page!==undefined&&(!Number.isInteger(args.page)||args.page<1))throw Error('请指定有效的 EPUB 章节序号。');
  if(pointer.imageRef&&args.page!==undefined)throw Error('图片指针无需章节序号。');
  if(pointer.section!==undefined&&args.page!==undefined&&pointer.section!==args.page)throw Error('章节指针与指定章节不一致。');
  const source=await store.sourceForPath(course,pointer.path),file=await store.safePath(course,source.relativePath);
  if(path.extname(source.relativePath).toLowerCase()!=='.epub')throw Error('指针没有指向课程内的 EPUB。');
  const result=await readEpub(file,{section:pointer.section??args.page,relativePath:source.relativePath,imageRef:pointer.imageRef});
  const {images=[],...metadata}=result;
  const items=[{type:'inputText',text:JSON.stringify({sourceId:source.id,sourceName:source.name,relativePath:source.relativePath,...metadata,imageAvailable:images.length>0,returnedImageCount:images.length})}];
  for(const image of images){
    if(!Buffer.isBuffer(image.data)||!['image/png','image/jpeg','image/webp','image/gif'].includes(image.mime))throw Error('EPUB 图片返回格式无效。');
    items.push({type:'inputText',text:JSON.stringify({member:image.member,name:image.name,caption:image.caption,context:image.context})},{type:'inputImage',imageUrl:`data:${image.mime};base64,${image.data.toString('base64')}`});
  }
  return {source,metadata:{...metadata,imageAvailable:images.length>0},toolResult:{toolContentItems:items}};
}
