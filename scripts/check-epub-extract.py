"""Focused EPUB preview/bounds tests; synthetic local files only."""
import importlib.util
import pathlib
import tempfile
import zipfile

module_path = pathlib.Path(__file__).resolve().parents[1] / 'server/epub_extract.py'
spec = importlib.util.spec_from_file_location('epub_extract', module_path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
container = '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OPS/book.opf"/></rootfiles></container>'
opf = '''<package xmlns="http://www.idpf.org/2007/opf"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>有机化学</dc:title><dc:creator>教材作者</dc:creator></metadata><manifest><item id="second" href="Text/二.xhtml" media-type="application/xhtml+xml"/><item id="first" href="Text/一.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="first"/><itemref idref="second"/></spine></package>'''

def fixture(folder, name='book.epub', opf_text=opf, container_text=container, first=None):
    path = pathlib.Path(folder)/name
    with zipfile.ZipFile(path, 'w', compression=zipfile.ZIP_DEFLATED) as z:
        z.writestr('META-INF/container.xml', container_text)
        z.writestr('OPS/book.opf', opf_text)
        z.writestr('OPS/Text/一.xhtml', first or '<html><head><style>hidden-style</style><script>hidden-script</script></head><body><h1>第一章 绪论</h1><p>共价键 &amp; 轨道</p></body></html>')
        z.writestr('OPS/Text/二.xhtml', '<html><body><p>第二章 烷烃</p></body></html>')
    return path

with tempfile.TemporaryDirectory(prefix='study-epub-check-') as folder:
    result = module.read_epub(fixture(folder))
    assert '书名：有机化学' in result['text'] and '作者：教材作者' in result['text']
    assert result['text'].index('第一章 绪论') < result['text'].index('第二章 烷烃')
    assert '共价键 & 轨道' in result['text']
    assert 'hidden-style' not in result['text'] and 'hidden-script' not in result['text']
    assert not result['truncated']
    long_result = module.read_epub(fixture(folder,'long.epub',first='<html><body>'+('正文'*5000)+'</body></html>'), limit=500)
    assert len(long_result['text']) == 500 and long_result['truncated']
    giant = module.read_epub(fixture(folder,'giant.epub',first='<html>'+('x'*(module.MAX_DOCUMENT_BYTES+1))+'</html>'))
    assert giant['truncated'] and '安全展开上限' in giant['warning']
    for suffix, bad in [('network','https://example.invalid/book.opf'),('traversal','../../private/book.opf'),('encoded','%2e%2e/%2e%2e/private/book.opf')]:
        try:
            module.read_epub(fixture(folder,suffix+'.epub',container_text=container.replace('OPS/book.opf',bad)))
        except ValueError:
            pass
        else:
            raise AssertionError('unsafe path accepted: '+suffix)
    try:
        module.read_epub(fixture(folder,'entity.epub',opf_text='<!DOCTYPE package [<!ENTITY name "expanded">]>'+opf))
    except ValueError:
        pass
    else:
        raise AssertionError('metadata entity declaration accepted')
    image_only=module.read_epub(fixture(folder,'scan.epub',first='<html><body><img src="scan.png"/></body></html>',opf_text=opf.replace('<itemref idref="second"/>','')))
    assert '未进行 OCR' in image_only['warning']
    assert '书名：有机化学' in image_only['text']
    utf16=pathlib.Path(folder)/'utf16-entity.epub'
    with zipfile.ZipFile(utf16,'w') as z:
        z.writestr('META-INF/container.xml',container)
        z.writestr('OPS/book.opf', ('<!DOCTYPE package [<!ENTITY name "expanded">]>'+opf).encode('utf-16'))
    try:
        module.read_epub(utf16)
    except ValueError:
        pass
    else:
        raise AssertionError('UTF-16 metadata entity declaration accepted')
print('EPUB preview passed: metadata, reading order, script/style omission, character/member limits, external/traversal/entity rejection and image-only preservation.')
