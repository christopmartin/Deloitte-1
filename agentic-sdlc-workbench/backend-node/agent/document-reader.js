// agent/document-reader.js
// Extracts raw text from uploaded files.
//
//  Supported:
//    DOCX              — mammoth  (local, no API)
//    TXT / CSV / JSON  — fs.readFileSync  (local)
//    MP3 / WAV / M4A / MP4 / WEBM  — OpenAI Whisper API
//
// Returns a plain UTF-8 string suitable for passing to the extraction agent.
'use strict';

const fs      = require('fs');
const path    = require('path');
const mammoth = require('mammoth');
const OpenAI  = require('openai');

// ── OpenAI client (lazy — only constructed when audio is processed) ──────────
let _openai;
function getOpenAI() {
  if (!_openai) {
    if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is not set in .env');
    _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return _openai;
}

const AUDIO_EXTS = new Set(['.mp3', '.wav', '.m4a', '.mp4', '.webm', '.ogg']);
const TEXT_EXTS  = new Set(['.txt', '.csv', '.json', '.md']);
const DOCX_EXTS  = new Set(['.docx', '.doc']);

/**
 * Extract text from a file.
 * @param {string} filePath  — absolute path to the saved file
 * @param {string} [fileType] — optional extension hint (without dot)
 * @returns {Promise<string>} plain text content
 */
async function extractText(filePath, fileType) {
  const ext = fileType
    ? `.${fileType.toLowerCase().replace(/^\./, '')}`
    : path.extname(filePath).toLowerCase();

  if (AUDIO_EXTS.has(ext)) return transcribeAudio(filePath, ext);
  if (DOCX_EXTS.has(ext))  return extractDocx(filePath);
  if (TEXT_EXTS.has(ext))  return fs.readFileSync(filePath, 'utf8');

  // Unknown type — try reading as UTF-8 text; if it throws, return empty
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

// ── DOCX ─────────────────────────────────────────────────────────────────────
async function extractDocx(filePath) {
  const result = await mammoth.extractRawText({ path: filePath });
  if (result.messages?.length) {
    console.warn('[document-reader] mammoth warnings:', result.messages.map(m => m.message).join('; '));
  }
  return result.value || '';
}

// ── Audio → Whisper ──────────────────────────────────────────────────────────
async function transcribeAudio(filePath, ext) {
  const MAX_BYTES = 25 * 1024 * 1024; // 25 MB Whisper limit
  const stat = fs.statSync(filePath);

  if (stat.size > MAX_BYTES) {
    throw new Error(
      `Audio file is ${(stat.size / 1024 / 1024).toFixed(1)} MB — ` +
      `Whisper API limit is 25 MB. Please trim or compress the file before re-submitting.`
    );
  }

  const openai = getOpenAI();

  console.log(`[document-reader] Transcribing audio (${(stat.size / 1024).toFixed(0)} KB) via Whisper…`);

  const transcription = await openai.audio.transcriptions.create({
    file:  fs.createReadStream(filePath),
    model: 'whisper-1',
    response_format: 'verbose_json',   // gives us segments + language detection
    timestamp_granularities: ['segment'],
  });

  const text = transcription.text || '';
  const lang = transcription.language || 'unknown';
  const dur  = transcription.duration ? `${Math.round(transcription.duration)}s` : '?';

  console.log(`[document-reader] Transcription complete — language: ${lang}, duration: ${dur}, chars: ${text.length}`);

  // Prepend a metadata header so the extraction agent has context
  const header = `[Transcribed audio — language: ${lang}, duration: ${dur}]\n\n`;
  return header + text;
}

module.exports = { extractText };
