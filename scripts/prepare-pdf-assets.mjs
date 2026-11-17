#!/usr/bin/env node
import {cp, mkdir, stat} from 'node:fs/promises';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const require=createRequire(import.meta.url);
const projectRoot=fileURLToPath(new URL('../',import.meta.url));
const assetDirectories=['cmaps','standard_fonts','wasm','iccs'];

// Keep these generated assets out of Git. Each installed PDF.js package remains
// the source of truth, including licenses shipped within its asset directories.
export async function preparePdfAssets(outputDirectory=path.join(projectRoot,'public/pdfjs')){
  let packageRoot;
  try{packageRoot=path.dirname(require.resolve('pdfjs-dist/package.json'));}
  catch{throw new Error('PDF.js is not installed. Run npm ci before preparing assets.');}
  for(const name of [...assetDirectories,'LICENSE']){
    const source=path.join(packageRoot,name);
    const entry=await stat(source).catch(()=>null);
    if(!entry||(name==='LICENSE'?!entry.isFile():!entry.isDirectory()))
      throw new Error(`The installed pdfjs-dist package is missing ${name}. Run npm ci to restore it.`);
  }
  await mkdir(outputDirectory,{recursive:true});
  for(const name of [...assetDirectories,'LICENSE'])
    await cp(path.join(packageRoot,name),path.join(outputDirectory,name),{recursive:true,force:true});
  return outputDirectory;
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  await preparePdfAssets();
  console.log('Prepared local PDF.js assets and their licenses.');
}
