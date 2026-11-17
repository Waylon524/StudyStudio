"""Bounded, local EPUB bibliographic/text preview. Never extracts archive members."""
import posixpath
import re
import zipfile
import xml.etree.ElementTree as ET
from html.parser import HTMLParser
from urllib.parse import unquote, urlsplit

MAX_ENTRIES = 10000
MAX_METADATA_BYTES = 1024 * 1024
MAX_DOCUMENT_BYTES = 2 * 1024 * 1024
MAX_EXPANDED_BYTES = 8 * 1024 * 1024
MAX_DOCUMENTS = 100


def _member(base, href):
    if not isinstance(href, str) or '\\' in href or '\x00' in href:
        raise ValueError('EPUB 内部资料路径无效。')
    parsed = urlsplit(href)
    if parsed.scheme or parsed.netloc or parsed.query:
        raise ValueError('EPUB 内部资料不能指向网络或外部位置。')
    decoded = unquote(parsed.path)
    if not decoded or decoded.startswith('/') or '\\' in decoded or '\x00' in decoded:
        raise ValueError('EPUB 内部资料路径无效。')
    result = posixpath.normpath(posixpath.join(base, decoded))
    if result in ('.', '..') or result.startswith('../'):
        raise ValueError('EPUB 内部资料路径越界。')
    return result


def _xml(data):
    # XML entities are never needed for the container/OPF metadata.
    if re.search(br'<!\s*(?:DOCTYPE|ENTITY)\b', data.replace(b'\x00', b''), re.I):
        raise ValueError('EPUB 书目信息含不支持的 XML 声明。')
    return ET.fromstring(data)


def _local(tag):
    return tag.rsplit('}', 1)[-1]


class _Text(HTMLParser):
    def __init__(self, limit):
        super().__init__(convert_charrefs=True)
        self.limit = limit
        self.parts = []
        self.size = 0
        self.skip = 0
        self.truncated = False

    def _append(self, text):
        if self.skip or not text:
            return
        remaining = self.limit + 1 - self.size
        if remaining <= 0:
            self.truncated = True
            return
        self.parts.append(text[:remaining])
        self.size += min(len(text), remaining)
        self.truncated |= len(text) > remaining

    def handle_starttag(self, tag, attrs):
        if tag in ('script', 'style'):
            self.skip += 1
        elif tag in ('p', 'div', 'br', 'li', 'tr', 'h1', 'h2', 'h3', 'h4', 'section'):
            self._append('\n')

    def handle_endtag(self, tag):
        if tag in ('script', 'style'):
            self.skip = max(0, self.skip - 1)
        elif tag in ('p', 'div', 'li', 'tr', 'h1', 'h2', 'h3', 'h4', 'section'):
            self._append('\n')

    def handle_data(self, data):
        self._append(data)

    def text(self):
        return re.sub(r'\n\s*\n+', '\n\n', ''.join(self.parts)).strip()


def read_epub(path, limit=100000):
    parts, warnings = [], []
    expanded = 0
    truncated = False
    with zipfile.ZipFile(path) as archive:
        infos = archive.infolist()
        if len(infos) > MAX_ENTRIES:
            raise ValueError('EPUB 包含过多文件，未展开。')
        names = {info.filename for info in infos}
        if len(names) != len(infos):
            raise ValueError('EPUB 含重复的内部文件名，无法可靠读取。')

        def read(name, bound):
            nonlocal expanded
            info = archive.getinfo(name)
            if info.flag_bits & 1:
                raise ValueError('EPUB 内部资料已加密，无法提取。')
            if info.file_size > bound or expanded + info.file_size > MAX_EXPANDED_BYTES:
                raise ValueError('EPUB 待读取文字超过安全展开上限。')
            with archive.open(info) as entry:
                content = entry.read(min(bound, MAX_EXPANDED_BYTES - expanded) + 1)
            expanded += len(content)
            if len(content) > bound or expanded > MAX_EXPANDED_BYTES:
                raise ValueError('EPUB 待读取文字超过安全展开上限。')
            return content

        container = _xml(read('META-INF/container.xml', MAX_METADATA_BYTES))
        rootfiles = [e.attrib.get('full-path') for e in container.iter() if _local(e.tag) == 'rootfile']
        if not rootfiles or not rootfiles[0]:
            raise ValueError('EPUB 缺少书目信息入口。')
        opf_path = _member('', rootfiles[0])
        package = _xml(read(opf_path, MAX_METADATA_BYTES))
        metadata = next((e for e in package if _local(e.tag) == 'metadata'), None)
        labels = {'title': '书名', 'creator': '作者', 'publisher': '出版者', 'language': '语言', 'description': '简介', 'subject': '主题'}
        if metadata is not None:
            lines = []
            for node in metadata:
                key = _local(node.tag)
                if key in labels:
                    value = ' '.join(''.join(node.itertext()).split())
                    if value:
                        lines.append(labels[key] + '：' + value[:4000])
            if lines:
                parts.append('[EPUB 书目信息]\n' + '\n'.join(lines))
        manifest = next((e for e in package if _local(e.tag) == 'manifest'), None)
        spine = next((e for e in package if _local(e.tag) == 'spine'), None)
        entries = {e.attrib.get('id'): e.attrib for e in manifest or [] if _local(e.tag) == 'item'}
        refs = [e.attrib.get('idref') for e in spine or [] if _local(e.tag) == 'itemref']
        if len(refs) > MAX_DOCUMENTS:
            truncated = True
        docs_with_text = 0
        chars = sum(len(p) for p in parts)
        for ref in refs[:MAX_DOCUMENTS]:
            item = entries.get(ref)
            if not item:
                warnings.append('部分 EPUB 阅读顺序引用缺失，预览可能不完整。')
                continue
            if item.get('media-type') not in ('application/xhtml+xml', 'text/html'):
                continue
            if chars >= limit:
                truncated = True
                break
            member = _member(posixpath.dirname(opf_path), item.get('href'))
            try:
                content = read(member, MAX_DOCUMENT_BYTES)
            except (ValueError, KeyError) as error:
                warnings.append(str(error) if isinstance(error, ValueError) else '部分 EPUB 正文文件缺失。')
                truncated = True
                continue
            parser = _Text(max(0, limit - chars))
            # XML/HTML declares UTF-8 by default for ordinary EPUB text. UTF-16
            # is supported by its BOM; invalid bytes are not silently invented.
            encoding = 'utf-16' if content.startswith((b'\xff\xfe', b'\xfe\xff')) else 'utf-8-sig'
            try:
                parser.feed(content.decode(encoding))
                parser.close()
            except UnicodeError:
                warnings.append('部分 EPUB 正文编码暂不支持，原文件仍然保留。')
                truncated = True
                continue
            text = parser.text()
            if text:
                docs_with_text += 1
                part = '[EPUB 正文片段：' + member + ']\n' + text
                parts.append(part)
                chars += len(part)
            truncated |= parser.truncated
        if not docs_with_text:
            warnings.append('未提取到可读的 EPUB 正文；当前仅显示可用书目信息，未进行 OCR。')
        warnings.append('EPUB 按阅读顺序提取有限文字；结构图、公式图片和完整内容仍需查看原件。')
    text = '\n\n'.join(parts)
    if len(text) > limit:
        truncated = True
    return {'text': text[:limit], 'truncated': truncated, 'warning': ' '.join(dict.fromkeys(warnings))}
