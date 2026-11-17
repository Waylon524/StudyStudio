"""Read bounded EPUB sections and actual embedded image pixels, without extraction."""
import base64
import json
import os
import posixpath
import re
import struct
import subprocess
import sys
import tempfile
import zipfile
from html.parser import HTMLParser
from pathlib import Path

from epub_extract import _member, _xml, _local

MAX_ENTRIES = 10000
MAX_META = 1024 * 1024
MAX_DOCUMENT = 2 * 1024 * 1024
MAX_EXPANDED = 32 * 1024 * 1024
MAX_IMAGE = 6 * 1024 * 1024
MAX_PIXELS = 24_000_000
MAX_EDGE = 24000
MAX_TEXT = 30000
MAX_IMAGES = 4
MAX_IMAGE_OUTPUT = 12 * 1024 * 1024
HTML_TYPES = {'application/xhtml+xml', 'text/html'}
RASTER_TYPES = {'image/png', 'image/jpeg', 'image/gif', 'image/webp'}


def clean(value, bound=400):
    return ' '.join(value.split())[:bound]


class Book:
    def __init__(self, file):
        if os.path.getsize(file) > 100 * 1024 * 1024:
            raise ValueError('EPUB 超过 100 MB。')
        self.archive = zipfile.ZipFile(file)
        self.expanded = 0
        self.warnings = []
        infos = self.archive.infolist()
        if len(infos) > MAX_ENTRIES or len({i.filename for i in infos}) != len(infos):
            raise ValueError('EPUB 内部文件过多或存在重复文件名。')
        container = _xml(self.read('META-INF/container.xml', MAX_META))
        roots = [n.attrib.get('full-path') for n in container.iter() if _local(n.tag) == 'rootfile']
        if not roots or not roots[0]:
            raise ValueError('EPUB 缺少书目信息入口。')
        self.opf = _member('', roots[0])
        package = _xml(self.read(self.opf, MAX_META))
        self.metadata = {}
        metadata = next((n for n in package if _local(n.tag) == 'metadata'), None)
        if metadata is not None:
            for n in metadata:
                if _local(n.tag) in ('title', 'creator', 'publisher', 'language', 'description'):
                    self.metadata.setdefault(_local(n.tag), []).append(clean(''.join(n.itertext()), 4000))
        manifest = next((n for n in package if _local(n.tag) == 'manifest'), None)
        self.manifest, by_id = {}, {}
        for node in manifest if manifest is not None else []:
            if _local(node.tag) != 'item':
                continue
            try:
                member = _member(posixpath.dirname(self.opf), node.attrib.get('href'))
            except ValueError:
                self.warnings.append('已忽略指向外部或无效位置的 EPUB 资源。')
                continue
            item = {**node.attrib, 'member': member}
            if member in self.manifest or item.get('id') in by_id:
                raise ValueError('EPUB 资源清单存在重复定位。')
            self.manifest[member] = item
            by_id[item.get('id')] = item
        spine = next((n for n in package if _local(n.tag) == 'spine'), None)
        self.sections = []
        for node in spine if spine is not None else []:
            item = by_id.get(node.attrib.get('idref'))
            if _local(node.tag) == 'itemref' and item and item.get('media-type') in HTML_TYPES:
                self.sections.append({'section': len(self.sections) + 1, 'member': item['member'], 'title': posixpath.basename(item['member'])})
        self._titles()

    def close(self):
        self.archive.close()

    def read(self, member, bound):
        info = self.archive.getinfo(member)
        if info.flag_bits & 1 or info.file_size > bound or self.expanded + info.file_size > MAX_EXPANDED:
            raise ValueError('EPUB 资源已加密或超过读取上限。')
        with self.archive.open(info) as stream:
            data = stream.read(min(bound, MAX_EXPANDED - self.expanded) + 1)
        self.expanded += len(data)
        if len(data) > bound or self.expanded > MAX_EXPANDED:
            raise ValueError('EPUB 资源超过读取上限。')
        return data

    def _titles(self):
        titles = {}
        for member, item in self.manifest.items():
            if item.get('media-type') != 'application/x-dtbncx+xml':
                continue
            try:
                ncx = _xml(self.read(member, MAX_META))
                for point in ncx.iter():
                    if _local(point.tag) != 'navPoint':
                        continue
                    content = next((n for n in point if _local(n.tag) == 'content'), None)
                    label = next((n for n in point if _local(n.tag) == 'navLabel'), None)
                    if content is not None and label is not None:
                        target = _member(posixpath.dirname(member), content.attrib.get('src'))
                        titles.setdefault(target, clean(''.join(label.itertext())))
            except (ValueError, KeyError):
                self.warnings.append('部分 EPUB 导航标题不可用，保留文件名定位。')
        for section in self.sections:
            section['title'] = titles.get(section['member']) or section['title']

    def section(self, number):
        if not isinstance(number, int) or isinstance(number, bool) or number < 1 or number > len(self.sections):
            raise ValueError('EPUB 分节序号超出范围；分节序号不是纸书页码。')
        info = self.sections[number - 1]
        raw = self.read(info['member'], MAX_DOCUMENT)
        encoding = 'utf-16' if raw.startswith((b'\xff\xfe', b'\xfe\xff')) else 'utf-8-sig'
        try:
            html = raw.decode(encoding)
        except UnicodeError:
            raise ValueError('这一 EPUB 分节的文字编码暂不支持。')
        parser = SectionParser(self, info['member'])
        parser.feed(html)
        parser.close()
        parser.finish()
        return {**info, 'text': parser.text, 'textTruncated': parser.truncated, 'imageRefs': parser.refs, 'warnings': parser.warnings}

    def image(self, member, seen=None):
        seen = set() if seen is None else seen
        if member in seen or len(seen) > 2:
            raise ValueError('EPUB 图片引用循环或嵌套过深。')
        seen.add(member)
        item = self.manifest.get(member)
        if not item or not item.get('media-type', '').startswith('image/'):
            raise ValueError('图片不在该 EPUB 的资源清单中。')
        data = self.read(member, MAX_IMAGE)
        if item.get('media-type') == 'image/svg+xml':
            svg = _xml(data)
            refs = []
            for node in svg.iter():
                if _local(node.tag) == 'image':
                    href = node.attrib.get('href') or node.attrib.get('{http://www.w3.org/1999/xlink}href')
                    if href:
                        refs.append(_member(posixpath.dirname(member), href))
            if len(set(refs)) == 1:
                result = self.image(refs[0], seen)
                result['warning'] = '已查看 SVG 包装中引用的栅格图片；SVG 叠加的矢量线条和文字未渲染。'
                return result
            raise ValueError('此 SVG 矢量图暂不能安全渲染；未将说明文字当作已查看图像。')
        mime, width, height = raster_info(data)
        if not width or not height or width * height > MAX_PIXELS or max(width, height) > MAX_EDGE:
            raise ValueError('EPUB 图片尺寸过大，未解码。')
        original_mime = mime
        # ImageIO resizes only an already bounded local raster. No archive
        # document, CSS, script, external URL or SVG enters this renderer.
        with tempfile.TemporaryDirectory(prefix='study-epub-raster-') as scratch:
            source = Path(scratch) / ('input' + {'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp'}[mime])
            dest = Path(scratch) / 'preview.png'
            source.write_bytes(data)
            command = ['/usr/bin/sips'] + (['-Z', '2000'] if max(width, height) > 2000 else [])
            result = subprocess.run(command + ['-s', 'format', 'png', str(source), '--out', str(dest)], capture_output=True, timeout=8)
            if result.returncode or not dest.is_file() or dest.stat().st_size > 8 * 1024 * 1024:
                raise ValueError('此 EPUB 栅格图片转换失败，未查看图像。')
            data = dest.read_bytes()
        mime, width, height = raster_info(data)
        if mime != 'image/png' or max(width, height) > 2000:
            raise ValueError('EPUB 图片预览无效。')
        return {'mime': mime, 'originalMime': original_mime, 'width': width, 'height': height, 'base64': base64.b64encode(data).decode('ascii')}


class SectionParser(HTMLParser):
    def __init__(self, book, member):
        super().__init__(convert_charrefs=True)
        self.book, self.member = book, member
        self.parts, self.refs, self.warnings = [], [], []
        self.length, self.skip = 0, 0
        self.truncated = False
        self.seen = set()
        self.figure = None
        self.in_caption = False
        self.caption = []
        self.css_files = []
        self.classes = set()
        self.tail, self.pending_context = '', []

    def append(self, text):
        for ref in self.pending_context:
            ref['_following'] += text[:max(0, 500 - len(ref['_following']))]
        self.pending_context = [ref for ref in self.pending_context if len(ref['_following']) < 500]
        self.tail = (self.tail + text)[-220:]
        remaining = MAX_TEXT + 1 - self.length
        if remaining <= 0:
            self.truncated = True
            return
        self.parts.append(text[:remaining])
        self.length += min(remaining, len(text))
        self.truncated |= len(text) > remaining

    def image_ref(self, href, alt='', base=None, contextual=True):
        if len(self.refs) >= 2000:
            self.warnings.append('此分节包含过多图片引用，已停止继续列出。')
            return
        try:
            member = _member(base if base is not None else posixpath.dirname(self.member), href)
            item = self.book.manifest.get(member)
            if not item or not item.get('media-type', '').startswith('image/'):
                raise ValueError()
        except (ValueError, TypeError):
            self.warnings.append('已忽略不在 EPUB 资源清单中的图片或外部图片。')
            return
        if member in self.seen:
            return
        self.seen.add(member)
        ref = {'member': member, 'name': posixpath.basename(member), 'alt': clean(alt), 'order': len(self.refs) + 1, 'caption': '', '_before': self.tail if contextual else '', '_following': '', '_contextual': contextual}
        self.refs.append(ref)
        if contextual:
            self.pending_context.append(ref)
        if self.figure is not None:
            self.figure.append(ref)
        self.append('\n[图像 ' + str(ref['order']) + '：' + ref['name'] + ']\n')

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag in ('script', 'style'):
            self.skip += 1
            return
        if self.skip:
            return
        self.classes.update(attrs.get('class', '').split())
        if tag == 'figure':
            self.figure, self.caption = [], []
        if tag == 'figcaption':
            self.in_caption = True
        if tag in ('p', 'div', 'br', 'li', 'tr', 'h1', 'h2', 'h3', 'h4', 'section', 'figure'):
            self.append('\n')
        if tag == 'img':
            self.image_ref(attrs.get('src'), attrs.get('alt', ''))
        elif tag in ('image', 'svg:image'):
            self.image_ref(attrs.get('href') or attrs.get('xlink:href'), attrs.get('aria-label', ''))
        elif tag == 'object' and attrs.get('type', '').startswith('image/'):
            self.image_ref(attrs.get('data'), attrs.get('aria-label', ''))
        elif tag == 'link' and 'stylesheet' in attrs.get('rel', '').split() and len(self.css_files) < 10:
            try:
                member = _member(posixpath.dirname(self.member), attrs.get('href'))
                if self.book.manifest.get(member, {}).get('media-type') == 'text/css':
                    self.css_files.append(member)
            except ValueError:
                self.warnings.append('已忽略外部样式表。')
        elif tag in ('svg', 'math'):
            self.warnings.append('此分节含内联 SVG 或 MathML；已读取文字及可用栅格图片，未渲染其矢量排版。')
        for href in re.findall(r'url\(\s*[\"\']?([^\)\"\']+)', attrs.get('style', ''), re.I):
            self.image_ref(href)

    def handle_endtag(self, tag):
        if tag in ('script', 'style'):
            self.skip = max(0, self.skip - 1)
        elif not self.skip:
            if tag == 'figcaption':
                self.in_caption = False
            if tag == 'figure' and self.figure is not None:
                for ref in self.figure:
                    ref['caption'] = clean(''.join(self.caption))
                self.figure = None
            if tag in ('p', 'div', 'li', 'tr', 'h1', 'h2', 'h3', 'h4', 'section', 'figure'):
                self.append('\n')

    def handle_data(self, data):
        if not self.skip:
            self.append(data)
            if self.in_caption:
                self.caption.append(data[:1000])

    def finish(self):
        # Resolve only image-bearing stylesheet rules that match a class used
        # by this section, avoiding unrelated whole-book decorative assets.
        for member in self.css_files:
            try:
                css = self.book.read(member, 256 * 1024).decode('utf-8-sig')
                for selectors, declarations in re.findall(r'([^{}]+)\{([^{}]*)\}', css):
                    if not self.classes.intersection(re.findall(r'\.([\w-]+)', selectors)):
                        continue
                    for href in re.findall(r'url\(\s*[\"\']?([^\)\"\']+)', declarations, re.I):
                        self.image_ref(href, base=posixpath.dirname(member), contextual=False)
            except (ValueError, KeyError, UnicodeError):
                self.warnings.append('部分样式表图片引用无法读取。')
        self.text = re.sub(r'\n\s*\n+', '\n\n', ''.join(self.parts))[:MAX_TEXT].strip()
        for ref in self.refs:
            before, following, contextual = ref.pop('_before'), ref.pop('_following'), ref.pop('_contextual')
            ref['context'] = clean(before + following, 700) if contextual else '此图像来自匹配本分节类名的样式表；未渲染其具体排版位置。'


def raster_info(data):
    if len(data) >= 24 and data[:8] == b'\x89PNG\r\n\x1a\n' and data[12:16] == b'IHDR':
        width, height = struct.unpack('>II', data[16:24])
        return 'image/png', width, height
    if len(data) >= 10 and data[:6] in (b'GIF87a', b'GIF89a'):
        return 'image/gif', *struct.unpack('<HH', data[6:10])
    if data[:2] == b'\xff\xd8':
        position = 2
        while position < len(data):
            if data[position] != 255:
                raise ValueError('JPEG 图片头无效。')
            while position < len(data) and data[position] == 255:
                position += 1
            if position >= len(data):
                break
            marker = data[position]
            position += 1
            if marker in (0xd8, 0xd9) or 0xd0 <= marker <= 0xd7:
                continue
            if position + 2 > len(data):
                break
            length = int.from_bytes(data[position:position + 2], 'big')
            if length < 2 or position + length > len(data):
                break
            if marker in (0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf) and length >= 8:
                height, width = struct.unpack('>HH', data[position + 3:position + 7])
                return 'image/jpeg', width, height
            if marker == 0xda:
                break
            position += length
    if len(data) >= 30 and data[:4] == b'RIFF' and data[8:12] == b'WEBP':
        kind = data[12:16]
        if kind == b'VP8X':
            return 'image/webp', 1 + int.from_bytes(data[24:27], 'little'), 1 + int.from_bytes(data[27:30], 'little')
        if kind == b'VP8 ' and data[23:26] == b'\x9d\x01\x2a':
            return 'image/webp', int.from_bytes(data[26:28], 'little') & 0x3fff, int.from_bytes(data[28:30], 'little') & 0x3fff
        if kind == b'VP8L' and data[20] == 0x2f:
            bits = int.from_bytes(data[21:25], 'little')
            return 'image/webp', (bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1
    raise ValueError('EPUB 图片格式无法识别；仅支持 PNG、JPEG、GIF、WebP 和单栅格 SVG 包装。')


def main(file, options):
    book = Book(file)
    try:
        section = options.get('section')
        if options.get('mode') == 'list' and section is None:
            offset, limit = options.get('offset', 0), options.get('limit', 40)
            entries = book.sections[offset:offset + limit]
            return {'kind': 'epub', 'metadata': book.metadata, 'sections': entries, 'sectionCount': len(book.sections), 'offset': offset, 'nextOffset': offset + len(entries) if offset + len(entries) < len(book.sections) else None, 'warnings': list(dict.fromkeys(book.warnings + ['section/page 是 EPUB 阅读顺序分节序号，不是纸书页码。']))}
        requested = options.get('imageRef')
        if requested is not None and section is None:
            item = book.manifest.get(requested)
            if not item or not item.get('media-type', '').startswith('image/'):
                raise ValueError('图片不在该 EPUB 的资源清单中。')
            info = {'section': None, 'title': 'EPUB 内嵌图片', 'member': requested, 'text': '', 'textTruncated': False, 'imageRefs': [{'member': requested, 'name': posixpath.basename(requested), 'caption': '', 'context': '', 'order': None}], 'warnings': ['未提供分节定位，不能据此断言图片所属分节或纸书页码。']}
        else:
            info = book.section(section if section is not None else 1)
        if options.get('mode') == 'list':
            offset, limit = options.get('offset', 0), options.get('limit', 40)
            refs = info['imageRefs']
            return {'kind': 'epub_images', **{k: info[k] for k in ('section', 'title', 'member')}, 'imageRefs': refs[offset:offset + limit], 'imageCount': len(refs), 'offset': offset, 'nextOffset': offset + limit if offset + limit < len(refs) else None, 'warnings': list(dict.fromkeys(book.warnings + info['warnings']))}
        if requested is not None:
            # The selected member must itself be OPF-listed. Never treat this
            # token as an arbitrary filesystem path or network URL.
            selected = next((r for r in info['imageRefs'] if r['member'] == requested), None)
            if selected is None:
                raise ValueError('图片不属于指定 EPUB 分节，请使用返回的图片定位。')
            refs = [selected]
        else:
            refs = info['imageRefs'][:MAX_IMAGES]
        images, warnings, total_bytes = [], book.warnings + info['warnings'], 0
        for ref in refs:
            try:
                image = book.image(ref['member'])
                size = len(image['base64']) * 3 // 4
                if total_bytes + size > MAX_IMAGE_OUTPUT:
                    warnings.append('本次图像合计达到读取上限；请按图片定位单独查看。')
                    break
                total_bytes += size
                image = {**ref, **image}
                if image.get('warning'):
                    warnings.append(image['warning'])
                images.append(image)
            except (ValueError, KeyError, subprocess.TimeoutExpired, OSError) as error:
                warnings.append(ref['name'] + '：' + str(error))
        image_refs = info['imageRefs'][:200]
        warnings.append('只查看本次返回的实际图像；图片列表、替代文字和邻近正文不代表已经查看其他图片。分节序号不是纸书页码。')
        return {'kind': 'epub', 'metadata': book.metadata, 'sectionCount': len(book.sections), **{k: info[k] for k in ('section', 'title', 'member', 'text', 'textTruncated')}, 'imageRefs': image_refs, 'imageCount': len(info['imageRefs']), 'imagesNextOffset': 200 if len(info['imageRefs']) > 200 else None, 'images': images, 'imageAvailable': bool(images), **({'sections': book.sections[:30], 'nextOffset': 30 if len(book.sections) > 30 else None} if section is None and requested is None else {}), 'warnings': list(dict.fromkeys(warnings))}
    finally:
        book.close()


if __name__ == '__main__':
    try:
        result = main(sys.argv[1], json.loads(sys.argv[2]))
    except Exception as error:
        result = {'error': str(error)[:1000]}
    print(json.dumps(result, ensure_ascii=False))
