'use client';

import React, { useState } from 'react';
import html2canvas from 'html2canvas';
import jsPDF from 'jspdf';
import { Button } from '@/components/ui/button';

const UNSUPPORTED_COLOR_FN_RE = /(?:oklch|oklab|lab|lch|color-mix|color)\s*\(/i;

function createColorResolver() {
  const cache = new Map<string, string>();
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const probeStyle = document.createElement('span').style;

  const resolve = (expr: string): string => {
    const trimmed = expr.trim();
    if (!trimmed) return 'transparent';
    const cached = cache.get(trimmed);
    if (cached !== undefined) return cached;
    if (!ctx) return 'transparent';

    probeStyle.color = '';
    probeStyle.color = trimmed;
    if (!probeStyle.color) {
      cache.set(trimmed, 'transparent');
      return 'transparent';
    }

    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = '#000000';
    ctx.fillStyle = probeStyle.color;
    ctx.fillRect(0, 0, 1, 1);
    const data = ctx.getImageData(0, 0, 1, 1).data;
    const alpha = Math.round((data[3] / 255) * 1000) / 1000;
    const rgba =
      alpha >= 1
        ? `rgb(${data[0]}, ${data[1]}, ${data[2]})`
        : `rgba(${data[0]}, ${data[1]}, ${data[2]}, ${alpha})`;

    cache.set(trimmed, rgba);
    return rgba;
  };

  const replaceUnsupportedFunctions = (cssText: string): string => {
    if (!cssText || !UNSUPPORTED_COLOR_FN_RE.test(cssText)) return cssText;

    let out = '';
    let i = 0;
    const len = cssText.length;

    while (i < len) {
      const slice = cssText.slice(i);
      const match = slice.match(/^(oklch|oklab|lab|lch|color-mix|color)\s*\(/i);
      if (match) {
        const start = i;
        let depth = 0;
        let j = i + match[0].length - 1;
        for (; j < len; j++) {
          const ch = cssText[j];
          if (ch === '(') depth++;
          else if (ch === ')') {
            depth--;
            if (depth === 0) {
              j++;
              break;
            }
          }
        }
        const expr = cssText.slice(start, j);
        out += resolve(expr);
        i = j;
      } else {
        out += cssText[i];
        i++;
      }
    }

    return out.replace(/(?:oklch|oklab|lab|lch|color-mix|color)\s*\([^)]*\)/gi, 'transparent');
  };

  return { replaceUnsupportedFunctions };
}

function sanitizeNodeComputedStyles(
  orig: Element,
  clone: Element,
  replaceUnsupportedFunctions: (v: string) => string
) {
  if (!(clone instanceof HTMLElement || clone instanceof SVGElement)) return;
  const cs = window.getComputedStyle(orig);

  const explicitProps = [
    'color',
    'backgroundColor',
    'borderTopColor',
    'borderRightColor',
    'borderBottomColor',
    'borderLeftColor',
    'outlineColor',
    'textDecorationColor',
    'caretColor',
    'accentColor',
    'columnRuleColor',
    'scrollbarColor',
    'fill',
    'stroke',
    'backgroundImage',
    'boxShadow',
    'textShadow',
  ];

  for (const prop of explicitProps) {
    const val = (cs as any)[prop];
    if (val && typeof val === 'string' && val !== 'none') {
      if (UNSUPPORTED_COLOR_FN_RE.test(val) || prop === 'color' || prop === 'backgroundColor') {
        (clone.style as any)[prop] = replaceUnsupportedFunctions(val);
      }
    }
  }

  for (let k = 0; k < cs.length; k++) {
    const propName = cs[k];
    const propVal = cs.getPropertyValue(propName);
    if (propVal && UNSUPPORTED_COLOR_FN_RE.test(propVal)) {
      clone.style.setProperty(
        propName,
        replaceUnsupportedFunctions(propVal),
        cs.getPropertyPriority(propName)
      );
    }
  }

  if (
    clone instanceof HTMLElement &&
    (clone.classList.contains('tbl-scroll') ||
      cs.overflowX === 'auto' ||
      cs.overflowX === 'scroll')
  ) {
    clone.style.overflowX = 'visible';
    clone.style.overflow = 'visible';
    clone.style.maxWidth = 'none';
  }
}

function sanitizeClonedDocument(
  clonedDoc: Document,
  liveRoot: HTMLElement,
  clonedRoot: HTMLElement
) {
  const { replaceUnsupportedFunctions } = createColorResolver();

  const collectedCss: string[] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      const rules = sheet.cssRules;
      if (!rules) continue;
      for (const rule of Array.from(rules)) {
        const text = rule.cssText || '';
        if (text.trim().startsWith('@property')) continue;
        collectedCss.push(replaceUnsupportedFunctions(text));
      }
    } catch {
      // Cross-origin stylesheet; ignore safely
    }
  }

  clonedDoc.querySelectorAll('link[rel="stylesheet"], style').forEach((node) => {
    if (node instanceof HTMLStyleElement && node.textContent) {
      collectedCss.push(replaceUnsupportedFunctions(node.textContent));
    }
    node.remove();
  });

  if (collectedCss.length > 0) {
    const safeStyle = clonedDoc.createElement('style');
    safeStyle.textContent = collectedCss.join('\n');
    clonedDoc.head.appendChild(safeStyle);
  }

  if (document.documentElement && clonedDoc.documentElement) {
    sanitizeNodeComputedStyles(document.documentElement, clonedDoc.documentElement, replaceUnsupportedFunctions);
  }
  if (document.body && clonedDoc.body) {
    sanitizeNodeComputedStyles(document.body, clonedDoc.body, replaceUnsupportedFunctions);
  }

  const syncElement = (orig: Element, clone: Element) => {
    if (orig instanceof HTMLCanvasElement && clone instanceof HTMLCanvasElement) {
      try {
        clone.width = orig.width;
        clone.height = orig.height;
        const cctx = clone.getContext('2d');
        if (cctx) cctx.drawImage(orig, 0, 0);
      } catch {
        // Ignore tainted canvas
      }
    }

    sanitizeNodeComputedStyles(orig, clone, replaceUnsupportedFunctions);

    const origChildren = Array.from(orig.children).filter(
      (c) => c.getAttribute('data-pdf-ignore') !== 'true'
    );
    const cloneChildren = Array.from(clone.children);

    let cloneIdx = 0;
    for (const origChild of origChildren) {
      while (
        cloneIdx < cloneChildren.length &&
        cloneChildren[cloneIdx].tagName !== origChild.tagName
      ) {
        cloneIdx++;
      }
      if (cloneIdx < cloneChildren.length) {
        syncElement(origChild, cloneChildren[cloneIdx]);
        cloneIdx++;
      }
    }
  };

  syncElement(liveRoot, clonedRoot);
}

function extractCleanText(el: Element): string {
  const clone = el.cloneNode(true) as Element;
  clone.querySelectorAll('[data-pdf-ignore="true"], script, style, svg').forEach((n) => n.remove());
  return (clone.textContent || '')
    .replace(/\s*\n\s*/g, ' | ')
    .replace(/\s{2,}/g, ' ')
    .replace(/^(\s*\|\s*)+|(\s*\|\s*)+$/g, '')
    .trim();
}

function extractTablesFromElement(root: HTMLElement) {
  const tables = Array.from(root.querySelectorAll('table')).filter(
    (tbl) => !tbl.closest('[data-pdf-ignore="true"]')
  );

  return tables.map((tbl) => {
    const headerRow = tbl.querySelector('thead tr');
    const headers = headerRow
      ? Array.from(headerRow.querySelectorAll('th, td')).map((cell) => extractCleanText(cell))
      : [];

    const bodyRows = Array.from(tbl.querySelectorAll('tbody tr'))
      .map((tr) => Array.from(tr.querySelectorAll('td, th')).map((cell) => extractCleanText(cell)))
      .filter((cells) => cells.length > 0 && !(cells.length === 1 && cells[0] === ''));

    return { headers, rows: bodyRows };
  });
}

function generateStructuredPdf(input: HTMLElement, filename: string) {
  const tables = extractTablesFromElement(input);
  const maxCols = tables.reduce(
    (max, t) => Math.max(max, t.headers.length, ...(t.rows.map((r) => r.length))),
    0
  );
  const orientation = maxCols >= 6 ? 'l' : 'p';
  const pdf = new jsPDF(orientation, 'mm', 'a4');
  const pageWidth = pdf.internal.pageSize.getWidth();
  const pageHeight = pdf.internal.pageSize.getHeight();
  const margin = 12;
  const usableWidth = pageWidth - margin * 2;
  let y = 16;

  const headingEl = input.querySelector('h1, h2, h3');
  const docTitle =
    (headingEl ? extractCleanText(headingEl) : '') ||
    filename.replace(/[-_]+/g, ' ').toUpperCase();

  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(14);
  pdf.setTextColor(15, 23, 42);
  pdf.text(docTitle, margin, y);
  y += 6;

  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(9);
  pdf.setTextColor(100, 116, 139);
  pdf.text(
    `CalioFish Dashboard • Dicetak: ${new Date().toLocaleString('id-ID')}`,
    margin,
    y
  );
  y += 4;

  pdf.setDrawColor(203, 213, 225);
  pdf.line(margin, y, pageWidth - margin, y);
  y += 6;

  const ensureSpace = (needed: number) => {
    if (y + needed > pageHeight - 14) {
      pdf.addPage();
      y = 16;
      return true;
    }
    return false;
  };

  if (tables.length > 0) {
    for (const tbl of tables) {
      const colCount = Math.max(
        tbl.headers.length,
        ...(tbl.rows.map((r) => r.length)),
        1
      );
      const colWidth = usableWidth / colCount;

      const drawRow = (cells: string[], isHeader: boolean, rowIdx: number) => {
        const fontSize = isHeader ? 8 : 8;
        pdf.setFont('helvetica', isHeader ? 'bold' : 'normal');
        pdf.setFontSize(fontSize);

        const wrappedCells = Array.from({ length: colCount }, (_, idx) => {
          const text = cells[idx] ?? '';
          return pdf.splitTextToSize(text || '-', Math.max(12, colWidth - 4)) as string[];
        });
        const maxLines = Math.max(1, ...wrappedCells.map((lines) => lines.length));
        const rowHeight = maxLines * 4.2 + 4;

        const addedPage = ensureSpace(rowHeight);
        if (addedPage && !isHeader && tbl.headers.length > 0) {
          drawRow(tbl.headers, true, -1);
        }

        if (isHeader) {
          pdf.setFillColor(239, 246, 255);
          pdf.setTextColor(30, 58, 138);
        } else {
          if (rowIdx % 2 === 1) {
            pdf.setFillColor(248, 250, 252);
          } else {
            pdf.setFillColor(255, 255, 255);
          }
          pdf.setTextColor(30, 41, 59);
        }

        pdf.setDrawColor(226, 232, 240);
        pdf.rect(margin, y, usableWidth, rowHeight, 'FD');

        for (let c = 0; c < colCount; c++) {
          const cellX = margin + c * colWidth;
          if (c > 0) {
            pdf.line(cellX, y, cellX, y + rowHeight);
          }
          pdf.text(wrappedCells[c], cellX + 2, y + 4.5);
        }

        y += rowHeight;
      };

      if (tbl.headers.length > 0) {
        drawRow(tbl.headers, true, -1);
      }
      tbl.rows.forEach((row, idx) => drawRow(row, false, idx));
      y += 6;
    }
  } else {
    const blocks = extractCleanText(input).split(' | ').filter(Boolean);
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(10);
    pdf.setTextColor(30, 41, 59);
    for (const block of blocks) {
      const lines = pdf.splitTextToSize(block, usableWidth) as string[];
      ensureSpace(lines.length * 5 + 2);
      pdf.text(lines, margin, y);
      y += lines.length * 5 + 2;
    }
  }

  const totalPages = pdf.getNumberOfPages();
  for (let p = 1; p <= totalPages; p++) {
    pdf.setPage(p);
    pdf.setFontSize(8);
    pdf.setTextColor(148, 163, 184);
    pdf.text(`Halaman ${p} dari ${totalPages}`, pageWidth - margin, pageHeight - 6, {
      align: 'right',
    });
  }

  pdf.save(`${filename}.pdf`);
}

function escapeCsvCell(value: string): string {
  const clean = value.replace(/\r?\n+/g, ' ').trim();
  return `"${clean.replace(/"/g, '""')}"`;
}

export function PdfExportButton({
  targetId,
  filename = 'report',
  className = '',
  showCsv = true,
}: {
  targetId: string;
  filename?: string;
  className?: string;
  showCsv?: boolean;
}) {
  const [isExporting, setIsExporting] = useState(false);

  const exportPDF = async () => {
    const input = document.getElementById(targetId);
    if (!input) {
      alert(`Area laporan (#${targetId}) belum siap untuk di-export.`);
      return;
    }

    setIsExporting(true);
    try {
      const captureWidth = Math.max(input.scrollWidth, input.offsetWidth, 1024);

      const canvas = await html2canvas(input, {
        scale: 2,
        useCORS: true,
        allowTaint: false,
        backgroundColor: '#ffffff',
        logging: false,
        windowWidth: captureWidth,
        ignoreElements: (el) => el.getAttribute('data-pdf-ignore') === 'true',
        onclone: (clonedDoc, clonedEl) => {
          sanitizeClonedDocument(clonedDoc, input, clonedEl);
        },
      });

      const imgData = canvas.toDataURL('image/png');
      const pdf = new jsPDF('p', 'mm', 'a4');
      const pageWidth = pdf.internal.pageSize.getWidth();
      const pageHeight = pdf.internal.pageSize.getHeight();
      const margin = 8;
      const usableWidth = pageWidth - margin * 2;
      const usableHeight = pageHeight - margin * 2;
      const imgWidth = usableWidth;
      const imgHeight = (canvas.height * imgWidth) / canvas.width;

      const drawWhiteMargins = () => {
        pdf.setFillColor(255, 255, 255);
        pdf.rect(0, 0, pageWidth, margin, 'F');
        pdf.rect(0, pageHeight - margin, pageWidth, margin, 'F');
      };

      let heightLeft = imgHeight;
      let position = margin;

      pdf.addImage(imgData, 'PNG', margin, position, imgWidth, imgHeight);
      drawWhiteMargins();
      heightLeft -= usableHeight;

      while (heightLeft > 1) {
        position = margin - (imgHeight - heightLeft);
        pdf.addPage();
        pdf.addImage(imgData, 'PNG', margin, position, imgWidth, imgHeight);
        drawWhiteMargins();
        heightLeft -= usableHeight;
      }

      pdf.save(`${filename}.pdf`);
    } catch (canvasErr) {
      console.warn('html2canvas fallback triggered for PDF export:', canvasErr);
      try {
        generateStructuredPdf(input, filename);
      } catch (fallbackErr: any) {
        console.error('Error generating PDF', fallbackErr);
        alert(`Gagal membuat PDF: ${fallbackErr?.message || 'Terjadi kesalahan saat merender laporan.'}`);
      }
    } finally {
      setIsExporting(false);
    }
  };

  const exportCSV = () => {
    const input = document.getElementById(targetId);
    if (!input) {
      alert(`Area laporan (#${targetId}) belum siap untuk di-export.`);
      return;
    }

    const tables = extractTablesFromElement(input);
    const csvLines: string[] = [];

    if (tables.length > 0) {
      tables.forEach((tbl, idx) => {
        if (idx > 0) csvLines.push('');
        if (tbl.headers.length > 0) {
          csvLines.push(tbl.headers.map(escapeCsvCell).join(','));
        }
        tbl.rows.forEach((row) => {
          csvLines.push(row.map(escapeCsvCell).join(','));
        });
      });
    } else {
      const lines = extractCleanText(input).split(' | ').filter(Boolean);
      csvLines.push('Data Laporan');
      lines.forEach((line) => csvLines.push(escapeCsvCell(line)));
    }

    const bom = '\uFEFF';
    const blob = new Blob([bom + csvLines.join('\r\n')], {
      type: 'text/csv;charset=utf-8;',
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', `${filename}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  return (
    <div data-pdf-ignore="true" className="inline-flex items-center gap-1.5">
      {showCsv && (
        <Button
          type="button"
          onClick={exportCSV}
          variant="outline"
          className="h-9 px-3 rounded-lg text-sm font-semibold border border-emerald-300 text-emerald-700 bg-emerald-50/70 hover:bg-emerald-100 transition-colors shadow-sm cursor-pointer"
        >
          Export Excel / CSV
        </Button>
      )}
      <Button
        type="button"
        onClick={exportPDF}
        disabled={isExporting}
        variant="outline"
        className={`h-9 px-4 rounded-lg text-sm font-semibold border border-gray-300 text-gray-700 bg-white hover:bg-gray-50 transition-colors shadow-sm disabled:opacity-60 cursor-pointer ${className}`}
      >
        {isExporting ? 'Mengexport PDF...' : 'Export PDF'}
      </Button>
    </div>
  );
}
