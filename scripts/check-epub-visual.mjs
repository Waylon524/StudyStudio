import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {listEpub,readEpub,decodeEpubImagePath,decodeEpubSectionPath} from '../server/epub-visual.mjs';

const root=await fs.mkdtemp(path.join(os.tmpdir(),'study-epub-visual-check-'));
const file=path.join(root,'fixture.epub'),relativePath='教材/图片教材.epub';
try{
 execFileSync('/usr/bin/python3',['-B','-',file],{input:`import sys,zipfile,zlib,struct
def png(w,h):
 def chunk(t,d):return struct.pack('>I',len(d))+t+d+struct.pack('>I',zlib.crc32(t+d)&0xffffffff)
 return b'\\x89PNG\\r\\n\\x1a\\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',w,h,8,2,0,0,0))+chunk(b'IDAT',zlib.compress((b'\\0'+b'\\xff\\0\\0'*w)*h))+chunk(b'IEND',b'')
container='<container><rootfiles><rootfile full-path="OPS/content.opf"/></rootfiles></container>'
items='<item id="a" href="a.xhtml" media-type="application/xhtml+xml"/><item id="b" href="b.xhtml" media-type="application/xhtml+xml"/><item id="css" href="style.css" media-type="text/css"/>'
items+=''.join('<item id="i%d" href="images/%d.png" media-type="image/png"/>'%(i,i) for i in range(7))
items+='<item id="huge" href="images/huge.png" media-type="image/png"/><item id="wrapper" href="images/wrapper.svg" media-type="image/svg+xml"/><item id="vector" href="images/vector.svg" media-type="image/svg+xml"/>'
with zipfile.ZipFile(sys.argv[1],'w',zipfile.ZIP_DEFLATED) as z:
 z.writestr('META-INF/container.xml',container)
 z.writestr('OPS/content.opf','<package><metadata><title>图片测试教材</title></metadata><manifest>'+items+'</manifest><spine><itemref idref="a"/><itemref idref="b"/></spine></package>')
 z.writestr('OPS/a.xhtml','<html><head><link rel="stylesheet" href="style.css"/></head><body><h1>反应机理</h1><figure><p>碳氧键的电子对移动。</p><img src="images/0.png" alt="电子流箭头"/><figcaption>图1 碳氧键断裂</figcaption></figure>'+''.join('<img src="images/%d.png"/>'%i for i in range(1,6))+'<span class="equation">式一</span><img src="https://untrusted.invalid/a.png"/><img src="../../outside.png"/></body></html>')
 z.writestr('OPS/b.xhtml','<html><body><img src="images/wrapper.svg"/><img src="images/vector.svg"/><img src="images/huge.png"/></body></html>')
 z.writestr('OPS/style.css','.equation {background-image:url(images/6.png)}')
 for i in range(7):z.writestr('OPS/images/%d.png'%i,png(4,3))
 z.writestr('OPS/images/wrapper.svg','<svg xmlns="http://www.w3.org/2000/svg"><image href="0.png"/></svg>')
 z.writestr('OPS/images/vector.svg','<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0 L20 20"/></svg>')
 z.writestr('OPS/images/huge.png',b'\\x89PNG\\r\\n\\x1a\\n'+struct.pack('>I',13)+b'IHDR'+struct.pack('>II',50000,50000)+b'\\0'*20)
`});
 const listing=await listEpub(file,{relativePath,limit:1});
 assert.equal(listing.sectionCount,2);assert.equal(listing.nextOffset,1);assert.equal(listing.sections[0].page,1);
 assert.deepEqual(decodeEpubSectionPath(listing.sections[0].imageListPath),{path:relativePath,section:1});
 assert.equal((await listEpub(file,{relativePath,offset:1,limit:1})).sections[0].section,2);
 const view=await readEpub(file,{relativePath,section:1});
 assert.equal(view.imageCount,7);assert.equal(view.images.length,4);assert.equal(view.images[0].mime,'image/png');
 assert.equal(view.images[0].width,4);assert.equal(view.images[0].height,3);assert.equal(view.images[0].caption,'图1 碳氧键断裂');assert.match(view.images[0].context,/电子对移动/);
 assert(view.images.every(image=>Buffer.isBuffer(image.data)&&image.data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))));
 assert(view.warnings.some(warning=>warning.includes('外部图片')));
 const refs=await listEpub(file,{relativePath,section:1,offset:4,limit:2});assert.equal(refs.imageRefs.length,2);assert.equal(refs.nextOffset,6);
 const pointer=decodeEpubImagePath(refs.imageRefs[0].path);assert.equal(pointer.section,1);
 const single=await readEpub(file,{relativePath,section:pointer.section,imageRef:pointer.member});assert.equal(single.images.length,1);assert.equal(single.images[0].member,pointer.member);
 const second=await readEpub(file,{relativePath,section:2});assert.equal(second.images.length,1);assert(second.warnings.some(warning=>warning.includes('矢量')));assert(second.warnings.some(warning=>warning.includes('尺寸过大')));
 await assert.rejects(readEpub(file,{relativePath,imageRef:'OPS/not-in-manifest.png'}),/资源清单/);
 await assert.rejects(readEpub(file,{relativePath,section:2,imageRef:'OPS/images/1.png'}),/不属于指定/);
 assert.equal((await readEpub(file,{relativePath,imageRef:'OPS/images/1.png'})).section,null);
 await assert.rejects(readEpub(file,{relativePath,section:3}),/分节序号/);
 await assert.rejects(listEpub(file,{relativePath,offset:-1}),/范围无效/);
 assert.equal(decodeEpubImagePath('教材/book.epub'),null);
 assert.throws(()=>decodeEpubImagePath('epub-image:!'),/无效/);
 assert.throws(()=>decodeEpubImagePath('epub-image:'+Buffer.from(JSON.stringify({path:'../private.epub',member:'img.png'})).toString('base64url')),/无效/);
 assert.throws(()=>decodeEpubImagePath('epub-image:'+Buffer.from(JSON.stringify({path:relativePath,member:'../private.png'})).toString('base64url')),/无效/);
 console.log('EPUB visual access: section/image pagination, actual bounded pixels, context/caption, SVG raster wrapper, unsupported-vector honesty, pixel bounds, archive allowlist and opaque-pointer validation passed.');
}finally{await fs.rm(root,{recursive:true,force:true});}
