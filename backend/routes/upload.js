import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import os from 'os';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const pdf = require('pdf-parse');
import mammoth from 'mammoth';
import EPub from 'epub';
import XLSX from 'xlsx';
import { requireAuth } from '../auth.js';
import { chat as openaiChat } from '../services/openai.js';

const uploadDir = os.tmpdir();

const upload = multer({
  dest: uploadDir,
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
  fileFilter: (req, file, cb) => {
    const allowed = ['.pdf', '.txt', '.html', '.htm', '.docx', '.epub', '.mobi', '.md', '.csv', '.json', '.xml', '.rtf', '.log', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.properties', '.tsx', '.ts', '.js', '.jsx', '.py', '.java', '.rb', '.go', '.rs', '.c', '.cpp', '.h', '.css', '.scss', '.less', '.sql', '.sh', '.bat', '.ps1', '.r', '.swift', '.kt', '.xls', '.xlsx'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error(`File type ${ext} not supported.`));
    }
  }
});

const router = Router();
router.use(requireAuth);

// Upload a file and extract text content
router.post('/extract-text', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  try {
    const ext = path.extname(req.file.originalname).toLowerCase();
    let text = '';

    if (ext === '.pdf') {
      const buffer = fs.readFileSync(req.file.path);
      const data = await pdf(buffer);
      text = data.text;
    } else if (ext === '.docx') {
      const buffer = fs.readFileSync(req.file.path);
      const result = await mammoth.extractRawText({ buffer });
      text = result.value;
    } else if (ext === '.epub') {
      // Parse EPUB and extract text from all chapters
      text = await new Promise((resolve, reject) => {
        const epub = new EPub(req.file.path);
        epub.on('end', () => {
          const chapterIds = epub.flow.map(ch => ch.id);
          const chapters = [];
          let processed = 0;
          if (chapterIds.length === 0) return resolve('');
          chapterIds.forEach((id, idx) => {
            epub.getChapter(id, (err, chapterText) => {
              if (!err && chapterText) {
                // Strip HTML tags from chapter content
                chapters[idx] = chapterText.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
              }
              processed++;
              if (processed === chapterIds.length) {
                resolve(chapters.filter(Boolean).join('\n\n'));
              }
            });
          });
        });
        epub.on('error', reject);
        epub.parse();
      });
    } else if (ext === '.mobi') {
      // MOBI files: read as binary and try to extract readable text
      const buffer = fs.readFileSync(req.file.path);
      // Extract printable ASCII/UTF-8 text runs from the binary
      const raw = buffer.toString('utf-8');
      // Strip non-printable characters, keep readable text
      text = raw.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, ' ').replace(/\s+/g, ' ').trim();
    } else if (ext === '.xlsx' || ext === '.xls') {
      // Excel files: convert each sheet to CSV-like text
      const workbook = XLSX.readFile(req.file.path);
      const sheets = [];
      for (const sheetName of workbook.SheetNames) {
        const sheet = workbook.Sheets[sheetName];
        const csv = XLSX.utils.sheet_to_csv(sheet);
        sheets.push(`--- Sheet: ${sheetName} ---\n${csv}`);
      }
      text = sheets.join('\n\n');
    } else if (ext === '.xml') {
      // Strip XML tags for plain text
      text = fs.readFileSync(req.file.path, 'utf-8');
      text = text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    } else {
      // TXT, HTML, Markdown, CSV, JSON, code files, config files — read as text
      text = fs.readFileSync(req.file.path, 'utf-8');
      if (ext === '.html' || ext === '.htm') {
        // Strip HTML tags for plain text
        text = text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
      }
      // All other text formats kept as-is (CSV, JSON, Markdown, code, config, etc.)
    }

    // Clean up uploaded file
    fs.unlinkSync(req.file.path);

    res.json({
      text: text.trim(),
      filename: req.file.originalname,
      charCount: text.trim().length
    });
  } catch (err) {
    // Clean up on error
    if (req.file?.path && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    res.status(500).json({ error: `Text extraction failed: ${err.message}` });
  }
});

// Auto-generate product description from sales page content
router.post('/auto-describe', async (req, res) => {
  const { sales_page_content } = req.body;
  if (!sales_page_content) return res.status(400).json({ error: 'Sales page content is required' });

  try {
    const description = await openaiChat(
      [
        {
          role: 'system',
          content: 'You are a concise product analyst. Given sales page content, write a clear 2-3 sentence product description covering: what the product is, who it\'s for, and what problem it solves. Be factual and direct. Do not use marketing language.'
        },
        {
          role: 'user',
          content: `Based on this sales page content, write a concise product description:\n\n${sales_page_content.slice(0, 8000)}`
        }
      ],
      'gpt-4.1-mini',
      { max_tokens: 300, operation: 'auto_describe' }
    );

    res.json({ description: description.trim() });
  } catch (err) {
    res.status(500).json({ error: `Auto-describe failed: ${err.message}` });
  }
});

export default router;
