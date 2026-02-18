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
import { requireAuth } from '../auth.js';
import { getSetting } from '../convexClient.js';

const uploadDir = os.tmpdir();

const upload = multer({
  dest: uploadDir,
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
  fileFilter: (req, file, cb) => {
    const allowed = ['.pdf', '.txt', '.html', '.htm', '.docx', '.epub', '.mobi', '.md'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error(`File type ${ext} not supported. Supported: PDF, DOCX, EPUB, MOBI, TXT, HTML, Markdown.`));
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
    } else {
      // TXT, HTML, or Markdown — read as text
      text = fs.readFileSync(req.file.path, 'utf-8');
      if (ext === '.html' || ext === '.htm') {
        // Strip HTML tags for plain text
        text = text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
      }
      // Markdown (.md) is kept as-is — plain text with formatting markers
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

  const apiKey = await getSetting('openai_api_key');
  if (!apiKey) return res.status(400).json({ error: 'OpenAI API key not configured. Set it in Settings first.' });

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: 'You are a concise product analyst. Given sales page content, write a clear 2-3 sentence product description covering: what the product is, who it\'s for, and what problem it solves. Be factual and direct. Do not use marketing language.'
          },
          {
            role: 'user',
            content: `Based on this sales page content, write a concise product description:\n\n${sales_page_content.slice(0, 8000)}`
          }
        ],
        max_tokens: 300
      })
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      return res.status(500).json({ error: `OpenAI error: ${err.error?.message || response.status}` });
    }

    const data = await response.json();
    const description = data.choices[0].message.content.trim();

    res.json({ description });
  } catch (err) {
    res.status(500).json({ error: `Auto-describe failed: ${err.message}` });
  }
});

export default router;
