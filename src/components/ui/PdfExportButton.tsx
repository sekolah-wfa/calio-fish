'use client';

import React, { useState } from 'react';
import html2canvas from 'html2canvas';
import jsPDF from 'jspdf';
import { Button } from '@/components/ui/button';

const UNSUPPORTED_COLOR_FN_RE = /(?:oklch|oklab|lab|lch|color-mix|color)\s*\(/i;

/**
 * Resolves any CSS color expression (including oklch, oklab, lab, lch, color-mix)
 * into standard rgba(r, g, b, a) via an offscreen 1x1 canvas so html2canvas 1.4.x
 * never throws "Attempting to parse an unsupported color function".
 */
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

    if (!ctx) {
      return 'transparent';
    }

    // Validate syntax via browser CSS parser (unresolved var() yields empty string)
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
    const rgba = alpha >= 1
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

    return out;
  };

  return { replaceUnsupportedFunctions };
}

function sanitizeClonedDocument(
  clonedDoc: Document,
  liveRoot: HTMLElement,
  clonedRoot: HTMLElement
) {
  const { replaceUnsupportedFunctions } = createColorResolver();

  // 1. Extract live CSS stylesheets into a single sanitized <style> tag
  //    so html2canvas never parses raw Tailwind v4 oklch/oklab/color-mix rules.
  const collectedCss: string[] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      const rules = sheet.cssRules;
      if (!rules) continue;
      for (const rule of Array.from(rules)) {
        collectedCss.push(replaceUnsupportedFunctions(rule.cssText));
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

  // 2. Bake computed RGB colors & sanitize remaining color expressions via safe DOM tree walk
  const colorProps = [
    'color',
    'backgroundColor',
    'borderTopColor',
    'borderRightColor',
    'borderBottomColor',
    'borderLeftColor',
    'outlineColor',
    'textDecorationColor',
    'fill',
    'stroke',
  ] as const;

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

    if (clone instanceof HTMLElement || clone instanceof SVGElement) {
      const cs = window.getComputedStyle(orig);
      for (const prop of colorProps) {
        const rawVal = cs[prop];
        if (rawVal) {
          (clone.style as any)[prop] = replaceUnsupportedFunctions(rawVal);
        }
      }

      if (cs.backgroundImage && cs.backgroundImage !== 'none') {
        clone.style.backgroundImage = replaceUnsupportedFunctions(cs.backgroundImage);
      }
      if (cs.boxShadow && cs.boxShadow !== 'none') {
        clone.style.boxShadow = replaceUnsupportedFunctions(cs.boxShadow);
      }
      if (cs.textShadow && cs.textShadow !== 'none') {
        clone.style.textShadow = replaceUnsupportedFunctions(cs.textShadow);
      }

      // Prevent horizontal scroll containers from clipping wide tables in the exported PDF
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

export function PdfExportButton({
  targetId,
  filename = 'report',
  className = '',
}: {
  targetId: string;
  filename?: string;
  className?: string;
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
    } catch (error: any) {
      console.error('Error generating PDF', error);
      alert(`Gagal membuat PDF: ${error?.message || 'Terjadi kesalahan saat merender laporan.'}`);
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <Button
      type="button"
      data-pdf-ignore="true"
      onClick={exportPDF}
      disabled={isExporting}
      variant="outline"
      className={`h-9 px-4 rounded-lg text-sm font-semibold border border-gray-300 text-gray-700 bg-white hover:bg-gray-50 transition-colors shadow-sm disabled:opacity-60 cursor-pointer ${className}`}
    >
      {isExporting ? 'Mengexport PDF...' : 'Export PDF'}
    </Button>
  );
}
