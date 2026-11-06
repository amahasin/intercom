import { strToU8, zipSync } from 'fflate';

/**
 * Richer Office files than `fixtures.ts` makes: styled, as the files Office writes are, so the
 * built-in drawing has fonts, fills, borders, a layout and a theme to read. Made in code.
 */

const HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const NS_W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const NS_S = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const NS_P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const REL = 'http://schemas.openxmlformats.org/package/2006/relationships';

const rels = (items: Array<[string, string, string]>) =>
  `${HEAD}<Relationships xmlns="${REL}">${items
    .map(
      ([id, type, target]) =>
        `<Relationship Id="${id}" Type="${NS_R}/${type}" Target="${target}"/>`,
    )
    .join('')}</Relationships>`;

/** A one pixel red picture. */
export const PIXEL = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  ),
  (c) => c.charCodeAt(0),
);

/** Excel: a header row with a fill, bold white text and a bottom border, wide and hidden columns, a merged title, a held first row. */
export function styledXlsxBytes(): Uint8Array {
  const workbook = `${HEAD}<workbook xmlns="${NS_S}" xmlns:r="${NS_R}"><sheets><sheet name="Sales" sheetId="1" r:id="rId1"/></sheets></workbook>`;
  const strings = `${HEAD}<sst xmlns="${NS_S}"><si><t>Region</t></si><si><t>Total</t></si><si><t>North</t></si><si><t>Quarter one</t></si><si><t>Secret</t></si></sst>`;
  const styles = `${HEAD}<styleSheet xmlns="${NS_S}">
    <fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="14"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font></fonts>
    <fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF1F4E79"/></patternFill></fill></fills>
    <borders count="2"><border><left/><right/><top/><bottom/></border><border><left/><right/><top/><bottom style="medium"><color rgb="FFFFC000"/></bottom></border></borders>
    <cellXfs count="3"><xf numFmtId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="1"><alignment horizontal="center"/></xf><xf numFmtId="4"/></cellXfs>
  </styleSheet>`;
  const sheet = `${HEAD}<worksheet xmlns="${NS_S}">
    <sheetViews><sheetView workbookViewId="0" showGridLines="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
    <cols><col min="1" max="1" width="30" customWidth="1"/><col min="3" max="3" width="12" hidden="1" customWidth="1"/></cols>
    <sheetData>
      <row r="1" ht="30" customHeight="1"><c r="A1" s="1" t="s"><v>0</v></c><c r="B1" s="1" t="s"><v>1</v></c><c r="C1" s="1" t="s"><v>4</v></c></row>
      <row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2" s="2"><v>1234.5</v></c><c r="C2" t="s"><v>4</v></c></row>
      <row r="3"><c r="A3" s="1" t="s"><v>3</v></c><c r="B3" s="1"/></row>
    </sheetData>
    <mergeCells count="1"><mergeCell ref="A3:B3"/></mergeCells>
  </worksheet>`;
  return zipSync({
    'xl/workbook.xml': strToU8(workbook),
    'xl/_rels/workbook.xml.rels': strToU8(rels([['rId1', 'worksheet', 'worksheets/sheet1.xml']])),
    'xl/sharedStrings.xml': strToU8(strings),
    'xl/styles.xml': strToU8(styles),
    'xl/worksheets/sheet1.xml': strToU8(sheet),
  });
}

/** Word: a heading style with its size and colour, a page size and margins, a header, and a table with borders and shading. */
export function styledDocxBytes(): Uint8Array {
  const styles = `${HEAD}<w:styles xmlns:w="${NS_W}">
    <w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri"/><w:sz w:val="22"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="259" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
    <w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
    <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:before="480" w:after="0"/></w:pPr><w:rPr><w:b/><w:color w:val="1F4E79"/><w:sz w:val="40"/></w:rPr></w:style>
    <w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="12" w:color="FF0000"/><w:left w:val="single" w:sz="12" w:color="FF0000"/><w:bottom w:val="single" w:sz="12" w:color="FF0000"/><w:right w:val="single" w:sz="12" w:color="FF0000"/><w:insideH w:val="single" w:sz="12" w:color="FF0000"/><w:insideV w:val="single" w:sz="12" w:color="FF0000"/></w:tblBorders></w:tblPr></w:style>
  </w:styles>`;
  const document = `${HEAD}<w:document xmlns:w="${NS_W}" xmlns:r="${NS_R}"><w:body>
    <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Annual review</w:t></w:r></w:p>
    <w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:i/><w:color w:val="C00000"/><w:sz w:val="28"/></w:rPr><w:t>Centred and red</w:t></w:r></w:p>
    <w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/></w:tblPr><w:tblGrid><w:gridCol w:w="3000"/><w:gridCol w:w="3000"/></w:tblGrid>
      <w:tr><w:tc><w:tcPr><w:shd w:val="clear" w:fill="D9E2F3"/></w:tcPr><w:p><w:r><w:t>Shaded</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Plain</w:t></w:r></w:p></w:tc></w:tr>
    </w:tbl>
    <w:sectPr><w:headerReference w:type="default" r:id="rId9"/><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="720" w:bottom="1440" w:left="2160"/></w:sectPr>
  </w:body></w:document>`;
  const header = `${HEAD}<w:hdr xmlns:w="${NS_W}"><w:p><w:r><w:t>Confidential header</w:t></w:r></w:p></w:hdr>`;
  return zipSync({
    'word/document.xml': strToU8(document),
    'word/styles.xml': strToU8(styles),
    'word/header1.xml': strToU8(header),
    'word/_rels/document.xml.rels': strToU8(rels([['rId9', 'header', 'header1.xml']])),
  });
}

/**
 * PowerPoint: a theme (dark text 112233, first accent 00AA55), a master with a title position and a
 * title style, a layout, and a slide with a title that inherits both, a red box with white text, a
 * picture and a table.
 */
export function styledPptxBytes(): Uint8Array {
  const presentation = `${HEAD}<p:presentation xmlns:p="${NS_P}" xmlns:r="${NS_R}"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst><p:sldSz cx="9144000" cy="5143500"/></p:presentation>`;
  const theme = `${HEAD}<a:theme xmlns:a="${NS_A}"><a:themeElements><a:clrScheme name="t"><a:dk1><a:srgbClr val="112233"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2><a:accent1><a:srgbClr val="00AA55"/></a:accent1><a:accent2><a:srgbClr val="ED7D31"/></a:accent2></a:clrScheme><a:fontScheme name="f"><a:majorFont><a:latin typeface="Georgia"/></a:majorFont><a:minorFont><a:latin typeface="Arial"/></a:minorFont></a:fontScheme></a:themeElements></a:theme>`;
  const master = `${HEAD}<p:sldMaster xmlns:p="${NS_P}" xmlns:a="${NS_A}"><p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="F5F5DC"/></a:solidFill></p:bgPr></p:bg><p:spTree>
    <p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="457200" y="228600"/><a:ext cx="8229600" cy="857250"/></a:xfrm></p:spPr><p:txBody><a:bodyPr anchor="ctr"/><a:p><a:r><a:t>Click to edit</a:t></a:r></a:p></p:txBody></p:sp>
  </p:spTree></p:cSld>
  <p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2"/>
  <p:txStyles><p:titleStyle><a:lvl1pPr algn="l"><a:defRPr sz="4000" b="1"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mj-lt"/></a:defRPr></a:lvl1pPr></p:titleStyle></p:txStyles></p:sldMaster>`;
  const layout = `${HEAD}<p:sldLayout xmlns:p="${NS_P}" xmlns:a="${NS_A}"><p:cSld><p:spTree><p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr/></p:sp></p:spTree></p:cSld></p:sldLayout>`;
  const slide = `${HEAD}<p:sld xmlns:p="${NS_P}" xmlns:a="${NS_A}" xmlns:r="${NS_R}"><p:cSld><p:spTree>
    <p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:p><a:r><a:t>Quarterly plan</a:t></a:r></a:p></p:txBody></p:sp>
    <p:sp><p:nvSpPr><p:cNvPr id="3" name="Box"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="914400" y="1714500"/><a:ext cx="3657600" cy="1143000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="C00000"/></a:solidFill></p:spPr><p:txBody><a:bodyPr anchor="ctr"/><a:p><a:pPr algn="ctr"/><a:r><a:rPr lang="en-US" sz="2400" b="1"><a:solidFill><a:schemeClr val="bg1"/></a:solidFill></a:rPr><a:t>Red box</a:t></a:r></a:p></p:txBody></p:sp>
    <p:pic><p:nvPicPr><p:cNvPr id="4" name="Picture"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId2"/></p:blipFill><p:spPr><a:xfrm><a:off x="5486400" y="1714500"/><a:ext cx="1143000" cy="1143000"/></a:xfrm></p:spPr></p:pic>
    <p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="5" name="Table"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="914400" y="3200400"/><a:ext cx="5486400" cy="914400"/></p:xfrm><a:graphic><a:graphicData><a:tbl><a:tblPr firstRow="1"/><a:tblGrid><a:gridCol w="2743200"/><a:gridCol w="2743200"/></a:tblGrid><a:tr h="457200"><a:tc><a:txBody><a:p><a:r><a:t>Owner</a:t></a:r></a:p></a:txBody></a:tc><a:tc><a:txBody><a:p><a:r><a:t>Due</a:t></a:r></a:p></a:txBody></a:tc></a:tr><a:tr h="457200"><a:tc><a:txBody><a:p><a:r><a:t>Bob</a:t></a:r></a:p></a:txBody></a:tc><a:tc><a:txBody><a:p><a:r><a:t>Friday</a:t></a:r></a:p></a:txBody></a:tc></a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>
  </p:spTree></p:cSld></p:sld>`;
  return zipSync({
    'ppt/presentation.xml': strToU8(presentation),
    'ppt/_rels/presentation.xml.rels': strToU8(rels([['rId1', 'slide', 'slides/slide1.xml']])),
    'ppt/theme/theme1.xml': strToU8(theme),
    'ppt/slideMasters/slideMaster1.xml': strToU8(master),
    'ppt/slideLayouts/slideLayout1.xml': strToU8(layout),
    'ppt/slideLayouts/_rels/slideLayout1.xml.rels': strToU8(
      rels([['rId1', 'slideMaster', '../slideMasters/slideMaster1.xml']]),
    ),
    'ppt/slides/slide1.xml': strToU8(slide),
    'ppt/slides/_rels/slide1.xml.rels': strToU8(
      rels([
        ['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml'],
        ['rId2', 'image', '../media/image1.png'],
      ]),
    ),
    'ppt/media/image1.png': PIXEL,
  });
}
