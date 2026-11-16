/* Minimal Excel (.xlsx) writer — no library. An .xlsx file is a zip of small XML files; we write them "stored" (no compression).
   Used by reports.html so exports keep colours, widths, frozen header, filters and print settings (a CSV cannot hold any of that).
   Text is always written as plain text cells, so a value such as =1+1 can never run as a formula. */
(function () {
  const enc = new TextEncoder();
  const esc = s => String(s === undefined || s === null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
  const col = n => { let s = ''; n++; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };

  /* ---------- zip (stored) ---------- */
  const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  const crc32 = b => { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  function zip(files) {
    const parts = [], central = []; let offset = 0;
    const u16 = v => [v & 255, (v >> 8) & 255], u32 = v => [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255];
    files.forEach(f => {
      const name = enc.encode(f.name), data = typeof f.data === 'string' ? enc.encode(f.data) : f.data, crc = crc32(data);
      const local = new Uint8Array([0x50, 0x4B, 3, 4, 20, 0, 0, 8, 0, 0, 0, 0, 0x21, 0, ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(name.length), 0, 0]);
      parts.push(local, name, data);
      central.push(new Uint8Array([0x50, 0x4B, 1, 2, 20, 0, 20, 0, 0, 8, 0, 0, 0, 0, 0x21, 0, ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(name.length), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, ...u32(offset)]), name);
      offset += local.length + name.length + data.length;
    });
    const cdSize = central.reduce((a, p) => a + p.length, 0);
    const end = new Uint8Array([0x50, 0x4B, 5, 6, 0, 0, 0, 0, ...u16(files.length), ...u16(files.length), ...u32(cdSize), ...u32(offset), 0, 0]);
    const all = parts.concat(central, [end]); const out = new Uint8Array(all.reduce((a, p) => a + p.length, 0)); let o = 0; all.forEach(p => { out.set(p, o); o += p.length; }); return out;
  }

  /* ---------- styles ---------- */
  // cellXfs indexes used below
  const S = { def: 0, camp: 1, title: 2, meta: 3, head: 4, txt: 5, txtB: 6, num: 7, numB: 8, totT: 9, totN: 10, ok: 11, warn: 12, bad: 13, mute: 14, kl: 15, kv: 16, sec: 17, conf: 18 };
  const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="11"><font><sz val="11"/><name val="Arial"/></font>
<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Arial"/></font>
<font><b/><sz val="20"/><color rgb="FF1F5E3B"/><name val="Arial"/></font>
<font><b/><sz val="14"/><color rgb="FF13261A"/><name val="Arial"/></font>
<font><sz val="10"/><color rgb="FF5B6A60"/><name val="Arial"/></font>
<font><b/><sz val="11"/><color rgb="FF13261A"/><name val="Arial"/></font>
<font><b/><sz val="10"/><color rgb="FF1D6B3B"/><name val="Arial"/></font>
<font><b/><sz val="10"/><color rgb="FF8A5A00"/><name val="Arial"/></font>
<font><b/><sz val="10"/><color rgb="FF9C1F1F"/><name val="Arial"/></font>
<font><b/><sz val="10"/><color rgb="FF5A6670"/><name val="Arial"/></font>
<font><b/><sz val="16"/><color rgb="FF1F5E3B"/><name val="Arial"/></font></fonts>
<fills count="10"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FF1F5E3B"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFF1F6F2"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFE3EEE6"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFDCF2E3"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFFDF0D5"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFFBE2E2"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFECEFF1"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFE8B04B"/></patternFill></fill></fills>
<borders count="4"><border><left/><right/><top/><bottom/><diagonal/></border>
<border><left/><right/><top/><bottom style="thin"><color rgb="FFDCE3DE"/></bottom><diagonal/></border>
<border><left/><right/><top style="medium"><color rgb="FF1F5E3B"/></top><bottom style="thin"><color rgb="FF1F5E3B"/></bottom><diagonal/></border>
<border><left style="thin"><color rgb="FF164A2E"/></left><right style="thin"><color rgb="FF164A2E"/></right><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="19">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"><alignment vertical="center"/></xf>
<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1"><alignment vertical="center"/></xf>
<xf numFmtId="0" fontId="4" fillId="0" borderId="0" xfId="0" applyFont="1"><alignment vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="1" fillId="2" borderId="3" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="0" fillId="3" borderId="1" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
<xf numFmtId="0" fontId="0" fillId="3" borderId="1" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
<xf numFmtId="0" fontId="5" fillId="4" borderId="2" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf>
<xf numFmtId="0" fontId="5" fillId="4" borderId="2" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
<xf numFmtId="0" fontId="6" fillId="5" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
<xf numFmtId="0" fontId="7" fillId="6" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
<xf numFmtId="0" fontId="8" fillId="7" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
<xf numFmtId="0" fontId="9" fillId="8" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
<xf numFmtId="0" fontId="4" fillId="3" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="10" fillId="3" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
<xf numFmtId="0" fontId="3" fillId="9" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="center"/></xf>
<xf numFmtId="0" fontId="8" fillId="7" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;

  /* ---------- sheet builder ----------
     sheet = { name, rtl, landscape, campName, title, meta, confidential, blocks:[ {kind:'heading',text} | {kind:'kpis',items:[{label,value}]} | {kind:'table',columns:[{label,type,key,tone}],rows:[[v..]],total:[v..]} ] } */
  function sheetXml(sh) {
    const rows = []; let r = 0, maxCol = 1; const merges = []; const widths = []; let headRow = 0, filterRef = '';
    const note = (c, text) => { const w = Math.min(46, Math.max(8, Math.round(String(text).length * 1.25 + 2))); widths[c] = Math.max(widths[c] || 8, w); };
    const cell = (c, rr, v, style, isNum) => {
      const ref = col(c) + rr;
      if (v === '' || v === null || v === undefined) return `<c r="${ref}" s="${style}"/>`;
      if (isNum && typeof v === 'number' && isFinite(v)) return `<c r="${ref}" s="${style}"><v>${v}</v></c>`;
      return `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
    };
    const rowXml = (rr, cells, ht) => `<row r="${rr}"${ht ? ` ht="${ht}" customHeight="1"` : ''}>${cells.join('')}</row>`;
    const tables = sh.blocks.filter(b => b.kind === 'table'); const width = Math.max(4, ...tables.map(t => t.columns.length), ...sh.blocks.filter(b => b.kind === 'kpis').map(b => b.items.length));
    // banner rows
    r++; rows.push(rowXml(r, [cell(0, r, sh.campName, S.camp)], 34)); merges.push(`A${r}:${col(width - 1)}${r}`);
    r++; rows.push(rowXml(r, [cell(0, r, sh.title + (sh.confidential ? '   🔒 ' + sh.confLabel : ''), S.title)], 26)); merges.push(`A${r}:${col(width - 1)}${r}`);
    r++; rows.push(rowXml(r, [cell(0, r, sh.meta, S.meta)], 30)); merges.push(`A${r}:${col(width - 1)}${r}`);
    r++; rows.push(`<row r="${r}" ht="8" customHeight="1"/>`);
    sh.blocks.forEach(b => {
      if (b.kind === 'heading') { r++; const cs = []; for (let c = 0; c < width; c++) cs.push(cell(c, r, c === 0 ? b.text : '', S.sec)); rows.push(rowXml(r, cs, 24)); merges.push(`A${r}:${col(width - 1)}${r}`); r++; rows.push(`<row r="${r}" ht="6" customHeight="1"/>`); }
      else if (b.kind === 'kpis') { r++; const l = [], v = []; b.items.forEach((k, i) => { l.push(cell(i, r, k.label, S.kl)); v.push(cell(i, r + 1, typeof k.value === 'number' ? k.value : String(k.value), S.kv, true)); note(i, k.label); }); rows.push(rowXml(r, l, 22)); r++; rows.push(rowXml(r, v, 30)); r++; rows.push(`<row r="${r}" ht="8" customHeight="1"/>`); }
      else if (b.kind === 'table') {
        r++; if (!headRow) headRow = r; const first = r;
        rows.push(rowXml(r, b.columns.map((c, i) => { note(i, c.label); return cell(i, r, c.label, S.head); }), 28));
        b.rows.forEach((row, ri) => { r++; const band = ri % 2 === 1; rows.push(rowXml(r, b.columns.map((c, i) => { const v = row[i]; note(i, v === null || v === undefined ? '' : v);
          let st = c.type === 'num' ? (band ? S.numB : S.num) : (band ? S.txtB : S.txt); const tone = c.tone && c.tone[v]; if (tone) st = S[tone];
          return cell(i, r, v, st, c.type === 'num'); }), 21)); });
        if (b.total) { r++; rows.push(rowXml(r, b.columns.map((c, i) => cell(i, r, b.total[i], c.type === 'num' ? S.totN : S.totT, c.type === 'num')), 24)); }
        if (!filterRef && b.filter !== false && b.rows.length) filterRef = `A${first}:${col(b.columns.length - 1)}${first + b.rows.length}`;
        r++; rows.push(`<row r="${r}" ht="10" customHeight="1"/>`);
      }
    });
    const cols = Array.from({ length: width }, (_, i) => `<col min="${i + 1}" max="${i + 1}" width="${Math.min(46, widths[i] || 12)}" customWidth="1"/>`).join('');
    const pane = headRow ? `<pane ySplit="${headRow}" topLeftCell="A${headRow + 1}" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A${headRow + 1}" sqref="A${headRow + 1}"/>` : '';
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetPr><tabColor rgb="FF1F5E3B"/><pageSetUpPr fitToPage="1"/></sheetPr>
<dimension ref="A1:${col(width - 1)}${r}"/><sheetViews><sheetView ${sh.rtl ? 'rightToLeft="1" ' : ''}showGridLines="0" workbookViewId="0" zoomScale="110">${pane}</sheetView></sheetViews><sheetFormatPr defaultRowHeight="18"/>
<cols>${cols}</cols><sheetData>${rows.join('')}</sheetData>${filterRef ? `<autoFilter ref="${filterRef}"/>` : ''}<mergeCells count="${merges.length}">${merges.map(m => `<mergeCell ref="${m}"/>`).join('')}</mergeCells>
<pageMargins left="0.4" right="0.4" top="0.6" bottom="0.7" header="0.3" footer="0.3"/><pageSetup paperSize="9" orientation="${sh.landscape ? 'landscape' : 'portrait'}" fitToWidth="1" fitToHeight="0"/>
<headerFooter><oddFooter>&amp;C${esc(sh.footer || '')}  &amp;P / &amp;N</oddFooter></headerFooter></worksheet>`;
  }

  function build(sheets) {
    const names = sheets.map((s, i) => { let n = String(s.name || 'Sheet' + (i + 1)).replace(/[\[\]:*?\/\\]/g, ' ').trim().slice(0, 28) || 'Sheet' + (i + 1); return n; });
    const uniq = []; names.forEach(n => { let m = n, k = 2; while (uniq.indexOf(m) !== -1) m = n.slice(0, 25) + ' ' + k++; uniq.push(m); });
    const files = [
      { name: '[Content_Types].xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>` },
      { name: '_rels/.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
      { name: 'xl/workbook.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView xWindow="0" yWindow="0" windowWidth="24000" windowHeight="12000"/></bookViews><sheets>${uniq.map((n, i) => `<sheet name="${esc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>` },
      { name: 'xl/_rels/workbook.xml.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
      { name: 'xl/styles.xml', data: STYLES }
    ].concat(sheets.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(s) })));
    return zip(files);
  }
  window.MKXlsx = { build: build };
})();
