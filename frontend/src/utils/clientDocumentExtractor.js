import JSZip from 'jszip';
import pdfWorkerSrc from 'pdfjs-dist/build/pdf.worker.mjs?url';

const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.csv', '.json', '.rtf']);
const HTML_EXTENSIONS = new Set(['.html', '.htm', '.xml']);

function extensionFor(file) {
  return file?.name?.includes('.') ? `.${file.name.split('.').pop().toLowerCase()}` : '';
}

function manualRecoverySteps() {
  return [
    'Open the original sales page in your browser.',
    'Press Cmd+P on Mac or Ctrl+P on Windows.',
    'Choose Save as PDF, then upload the new text-based PDF.',
    'If that still fails, copy the page text and use Paste instead.',
  ];
}

function extractionError(message, code, details = '') {
  const err = new Error(message);
  err.code = code;
  err.reason_code = code;
  err.details = details;
  err.technical_details = details ? `Code: ${code} · ${details}` : `Code: ${code}`;
  err.manual_recovery_steps = manualRecoverySteps();
  return err;
}

function sanitizeText(text = '') {
  return String(text)
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}

function stripMarkup(text = '') {
  if (typeof DOMParser !== 'undefined') {
    const doc = new DOMParser().parseFromString(text, 'text/html');
    return sanitizeText(doc.body?.innerText || doc.documentElement?.textContent || text);
  }
  return sanitizeText(text.replace(/<[^>]*>/g, ' '));
}

async function extractPdf(file) {
  const pdfjs = await import('pdfjs-dist');
  pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerSrc;

  let pdf;
  try {
    const data = new Uint8Array(await file.arrayBuffer());
    pdf = await pdfjs.getDocument({ data, isEvalSupported: false }).promise;
  } catch (err) {
    throw extractionError(
      'This PDF could not be read in the browser. Re-save or re-export it, run OCR if it is scanned, or paste the sales page text manually.',
      'MALFORMED_PDF',
      err.message
    );
  }

  const pages = [];
  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum += 1) {
    const page = await pdf.getPage(pageNum);
    const content = await page.getTextContent();
    const pageText = content.items
      .map(item => ('str' in item ? item.str : ''))
      .filter(Boolean)
      .join(' ');
    if (pageText.trim()) pages.push(pageText);
  }

  const text = sanitizeText(pages.join('\n\n'));
  if (!text) {
    throw extractionError(
      'This PDF did not contain readable text. It may be scanned or image-only. Run OCR, save a text-based PDF, or paste the sales page text manually.',
      'EMPTY_OR_SCANNED_PDF'
    );
  }
  return text;
}

async function extractDocx(file) {
  try {
    const zip = await JSZip.loadAsync(await file.arrayBuffer());
    const documentXml = await zip.file('word/document.xml')?.async('string');
    if (!documentXml) {
      throw new Error('word/document.xml was missing');
    }
    const doc = new DOMParser().parseFromString(documentXml, 'application/xml');
    const textNodes = Array.from(doc.getElementsByTagName('w:t'));
    const text = sanitizeText(textNodes.map(node => node.textContent || '').join(' '));
    if (!text) throw new Error('No readable text nodes found');
    return text;
  } catch (err) {
    throw extractionError(
      'This DOCX file could not be read in the browser. Re-save it as a PDF or paste the text manually.',
      'DOCX_PARSE_FAILED',
      err.message
    );
  }
}

export function canExtractDocumentInBrowser(file) {
  const ext = extensionFor(file);
  return ext === '.pdf' || ext === '.docx' || TEXT_EXTENSIONS.has(ext) || HTML_EXTENSIONS.has(ext);
}

export async function extractDocumentTextInBrowser(file) {
  const ext = extensionFor(file);
  let text = '';

  if (ext === '.pdf') {
    text = await extractPdf(file);
  } else if (ext === '.docx') {
    text = await extractDocx(file);
  } else if (HTML_EXTENSIONS.has(ext)) {
    text = stripMarkup(await file.text());
  } else if (TEXT_EXTENSIONS.has(ext)) {
    text = sanitizeText(await file.text());
  } else {
    throw extractionError(
      'This file type still needs backend extraction. Try PDF, DOCX, TXT, HTML, Markdown, CSV, JSON, XML, or Paste.',
      'BROWSER_EXTRACTION_UNSUPPORTED'
    );
  }

  if (!text) {
    throw extractionError(
      'No readable text could be extracted from this file. Try a text-based PDF, DOCX, TXT/HTML file, or paste the text manually.',
      'NO_READABLE_TEXT'
    );
  }

  return {
    text,
    filename: file.name,
    charCount: text.length,
    extractionMethod: 'browser',
  };
}
