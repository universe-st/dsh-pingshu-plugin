/**
 * 生成自检用的最小 EPUB / PDF / TXT / MD fixture。
 * 运行：node scripts/make-fixtures.mjs
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync, strToU8 } from 'fflate';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures');
await mkdir(root, { recursive: true });

function epubFiles({ nav }) {
  const files = {
    mimetype: strToU8('application/epub+zip'),
    'META-INF/container.xml': strToU8('<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'),
    'OEBPS/content.opf': strToU8(`<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="id" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>评书测试书</dc:title>
    <dc:creator>测试作者</dc:creator>
    <dc:language>zh</dc:language>
  </metadata>
  <manifest>
    ${nav ? '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>' : ''}
    <item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="ch2.xhtml" media-type="application/xhtml+xml"/>
    <item id="c3" href="ch3.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="c1"/>
    <itemref idref="c2"/>
    <itemref idref="c3"/>
  </spine>
</package>`),
    'OEBPS/nav.xhtml': strToU8(`<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
  <head><title>目录</title></head>
  <body><nav epub:type="toc"><ol>
    <li><a href="ch1.xhtml">第一回 桃园</a></li>
    <li><a href="ch2.xhtml">第二回 风波</a></li>
    <li><a href="ch3.xhtml">第三回 夜雨</a></li>
  </ol></nav></body>
</html>`),
    'OEBPS/ch1.xhtml': strToU8(`<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>第一回</title></head><body>
<h1>第一回 桃园</h1>
<p>这是第一段，讲三个人在桃园里见面。</p>
<p>这是第二段，写他们各自的心思。</p>
<p>这是第三段，留一个扣子。</p>
</body></html>`),
    'OEBPS/ch2.xhtml': strToU8(`<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>第二回</title></head><body>
<h1>第二回 风波</h1>
<p>风波起来了。</p>
<p>有人拍案而起。</p>
</body></html>`),
    'OEBPS/ch3.xhtml': strToU8(`<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>第三回</title></head><body>
<h1>第三回 夜雨</h1>
<p>夜雨下了一整晚。</p>
<p>天亮时，事情有了转机。</p>
</body></html>`),
  };
  if (!nav) {
    files['OEBPS/content.opf'] = strToU8(`<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="id" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>无目录测试书</dc:title><dc:creator>测试作者</dc:creator><dc:language>zh</dc:language></metadata>
  <manifest>
    <item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="ch2.xhtml" media-type="application/xhtml+xml"/>
    <item id="c3" href="ch3.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine><itemref idref="c1"/><itemref idref="c2"/><itemref idref="c3"/></spine>
</package>`);
    delete files['OEBPS/nav.xhtml'];
  }
  return files;
}

await writeFile(join(root, 'sample.epub'), zipSync(epubFiles({ nav: true })));
await writeFile(join(root, 'sample-no-toc.epub'), zipSync(epubFiles({ nav: false })));

await writeFile(join(root, 'sample.txt'), `第一回 桃园
　　这是第一段，讲三个人在桃园里见面。
　　这是第二段，写他们各自的心思。

第二回 风波
　　风波起来了。
　　有人拍案而起。

第三回 夜雨
　　夜雨下了一整晚。
　　天亮时，事情有了转机。
`, 'utf8');

await writeFile(join(root, 'sample.md'), `# 第一回 桃园

这是第一段。

# 第二回 风波

风波起来了。

# 第三回 夜雨

夜雨下了一整晚。
`, 'utf8');

function makePdf() {
  const contents = [1, 2, 3].map((n) => [
    'BT',
    '/F1 20 Tf 72 720 Td (Chapter ' + n + ') Tj',
    '/F1 12 Tf 0 -36 Td (This is the body of chapter ' + n + '.) Tj',
    '0 -18 Td (It has several lines of text so that the extractor can) Tj',
    '0 -18 Td (group them into paragraphs and detect the heading size.) Tj',
    '0 -18 Td (The quick brown fox jumps over the lazy dog.) Tj',
    'ET',
  ].join('\n') + '\n');
  const objects = [];
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = '<< /Type /Pages /Kids [3 0 R 5 0 R 7 0 R] /Count 3 >>';
  for (let i = 0; i < 3; i += 1) {
    const pageObj = 3 + i * 2;
    const contentObj = pageObj + 1;
    objects[pageObj] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contentObj} 0 R /Resources << /Font << /F1 9 0 R >> >> >>`;
    objects[contentObj] = `<< /Length ${Buffer.byteLength(contents[i])} >>\nstream\n${contents[i]}endstream`;
  }
  objects[9] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (let i = 1; i < objects.length; i += 1) {
    offsets[i] = Buffer.byteLength(pdf);
    pdf += `${i} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objects.length; i += 1) pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return pdf;
}

await writeFile(join(root, 'sample.pdf'), makePdf());
console.log(`fixtures written to ${root}`);
