import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { strToU8, zipSync } from 'fflate';

/** Small real files of the kinds the viewer shows, made in code so the tests need no assets. */

const NS_W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const NS_S = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const NS_P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

const relationships = (items: Array<[string, string]>) =>
  `${HEAD}<Relationships xmlns="${REL}">${items
    .map(([id, target]) => `<Relationship Id="${id}" Type="x" Target="${target}"/>`)
    .join('')}</Relationships>`;

/** A PDF with one line of text per page (Helvetica, so nothing needs embedding). */
export function pdfBytes(pages: string[]): Uint8Array {
  const objects: string[] = [];
  const kids = pages.map((_, i) => `${3 + i * 2} 0 R`).join(' ');
  objects.push('<< /Type /Catalog /Pages 2 0 R >>');
  objects.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
  const font = 3 + pages.length * 2;
  pages.forEach((text, i) => {
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${4 + i * 2} 0 R /Resources << /Font << /F1 ${font} 0 R >> >> >>`,
    );
    const stream = `BT /F1 28 Tf 72 700 Td (${text}) Tj ET`;
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return strToU8(out);
}

/** Word: a heading, a paragraph with bold, two bullets and a 2 x 2 table. */
export function docxBytes(): Uint8Array {
  const document = `${HEAD}<w:document xmlns:w="${NS_W}"><w:body>
    <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Meeting notes</w:t></w:r></w:p>
    <w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Budget</w:t></w:r><w:r><w:t xml:space="preserve"> was approved by everyone.</w:t></w:r></w:p>
    <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>First action</w:t></w:r></w:p>
    <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>Second action</w:t></w:r></w:p>
    <w:tbl>
      <w:tr><w:tc><w:p><w:r><w:t>Owner</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Due</w:t></w:r></w:p></w:tc></w:tr>
      <w:tr><w:tc><w:p><w:r><w:t>Bob</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Friday</w:t></w:r></w:p></w:tc></w:tr>
    </w:tbl>
  </w:body></w:document>`;
  const numbering = `${HEAD}<w:numbering xmlns:w="${NS_W}">
    <w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum>
    <w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`;
  return zipSync({
    '[Content_Types].xml': strToU8(`${HEAD}<Types xmlns="x"/>`),
    'word/document.xml': strToU8(document),
    'word/numbering.xml': strToU8(numbering),
    'word/_rels/document.xml.rels': strToU8(relationships([])),
  });
}

/** Excel: two sheets; the first has text, a number and a date (45000 is 15 March 2023). */
export function xlsxBytes(): Uint8Array {
  const workbook = `${HEAD}<workbook xmlns="${NS_S}" xmlns:r="${NS_R}"><sheets>
    <sheet name="Budget" sheetId="1" r:id="rId1"/><sheet name="Notes" sheetId="2" r:id="rId2"/></sheets></workbook>`;
  const strings = `${HEAD}<sst xmlns="${NS_S}"><si><t>Name</t></si><si><t>Amount</t></si><si><t>Date</t></si><si><t>Alice</t></si><si><t>Bob</t></si><si><t>Second sheet text</t></si></sst>`;
  const styles = `${HEAD}<styleSheet xmlns="${NS_S}"><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>`;
  const sheet1 = `${HEAD}<worksheet xmlns="${NS_S}"><sheetData>
    <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row>
    <row r="2"><c r="A2" t="s"><v>3</v></c><c r="B2"><v>1234.5</v></c><c r="C2" s="1"><v>45000</v></c></row>
    <row r="3"><c r="A3" t="s"><v>4</v></c><c r="B3"><v>99</v></c></row>
  </sheetData></worksheet>`;
  const sheet2 = `${HEAD}<worksheet xmlns="${NS_S}"><sheetData><row r="1"><c r="A1" t="s"><v>5</v></c></row></sheetData></worksheet>`;
  return zipSync({
    'xl/workbook.xml': strToU8(workbook),
    'xl/_rels/workbook.xml.rels': strToU8(
      relationships([
        ['rId1', 'worksheets/sheet1.xml'],
        ['rId2', 'worksheets/sheet2.xml'],
      ]),
    ),
    'xl/sharedStrings.xml': strToU8(strings),
    'xl/styles.xml': strToU8(styles),
    'xl/worksheets/sheet1.xml': strToU8(sheet1),
    'xl/worksheets/sheet2.xml': strToU8(sheet2),
  });
}

/** PowerPoint: one slide with a title and two bullets. */
export function pptxBytes(): Uint8Array {
  const presentation = `${HEAD}<p:presentation xmlns:p="${NS_P}" xmlns:r="${NS_R}"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst><p:sldSz cx="9144000" cy="5143500"/></p:presentation>`;
  const slide = `${HEAD}<p:sld xmlns:p="${NS_P}" xmlns:a="${NS_A}"><p:cSld><p:spTree>
    <p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>Roadmap</a:t></a:r></a:p></p:txBody></p:sp>
    <p:sp><p:nvSpPr><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr><p:txBody>
      <a:p><a:r><a:t>Ship the viewer</a:t></a:r></a:p><a:p><a:pPr lvl="1"/><a:r><a:t>Then the release</a:t></a:r></a:p></p:txBody></p:sp>
  </p:spTree></p:cSld></p:sld>`;
  return zipSync({
    'ppt/presentation.xml': strToU8(presentation),
    'ppt/_rels/presentation.xml.rels': strToU8(relationships([['rId1', 'slides/slide1.xml']])),
    'ppt/slides/slide1.xml': strToU8(slide),
  });
}

/** Write every kind of sample file into `dir`; returns their paths by name. */
export function writeSamples(dir: string): Record<string, string> {
  const files: Record<string, Uint8Array | string> = {
    'report.pdf': pdfBytes(['Quarterly report', 'Needle in page two']),
    'notes.docx': docxBytes(),
    'budget.xlsx': xlsxBytes(),
    'roadmap.pptx': pptxBytes(),
    'people.csv': 'Name,City\nAlice,Dhaka\n"Bob, Jr.",Khulna\n',
    'minutes.txt': 'Minutes of the quarterly meeting\nSecond line of the minutes\n',
  };
  const paths: Record<string, string> = {};
  for (const [name, data] of Object.entries(files)) {
    paths[name] = join(dir, name);
    writeFileSync(paths[name]!, data);
  }
  return paths;
}

/** One second of silence as a WAV file (8 kHz, mono, 8 bit). */
export function wavBytes(): Uint8Array {
  const samples = 8000;
  const out = new Uint8Array(44 + samples).fill(128);
  const view = new DataView(out.buffer);
  const text = (at: number, value: string) =>
    [...value].forEach((ch, i) => view.setUint8(at + i, ch.charCodeAt(0)));
  text(0, 'RIFF');
  view.setUint32(4, 36 + samples, true);
  text(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 8000, true);
  view.setUint32(28, 8000, true);
  view.setUint16(32, 1, true);
  view.setUint16(34, 8, true);
  text(36, 'data');
  view.setUint32(40, samples, true);
  return out;
}
