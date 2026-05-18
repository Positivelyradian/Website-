/**
 * File4Life — Backend Server
 * ===========================
 * Handles real file conversions for:
 *   - Images  (JPEG, PNG, WEBP, GIF, AVIF, BMP, TIFF) via Sharp
 *   - Documents (PDF ↔ DOCX, TXT, HTML) via LibreOffice + pdf-lib
 *   - Audio  (MP3, WAV, FLAC, OGG, AAC, M4A) via FFmpeg
 *   - Video  (MP4, MOV, AVI, WEBM, MKV, GIF) via FFmpeg
 *   - Archives (ZIP ↔ any) via archiver/unzipper
 *
 * Revenue: Google AdSense is on the frontend. Optionally add a Stripe
 * "Pro" tier later — stub is included at the bottom.
 *
 * Quick start:
 *   npm install
 *   node server.js
 *
 * Requires on the host machine:
 *   - ffmpeg  (brew install ffmpeg / apt install ffmpeg)
 *   - LibreOffice  (for doc conversions — optional but recommended)
 */

const express      = require('express');
const multer       = require('multer');
const cors         = require('cors');
const path         = require('path');
const fs           = require('fs');
const fsp          = require('fs/promises');
const { v4: uuid } = require('uuid');
const sharp        = require('sharp');
const ffmpeg       = require('fluent-ffmpeg');
const archiver     = require('archiver');
const unzipper     = require('unzipper');
const { exec }     = require('child_process');
const rateLimit    = require('express-rate-limit');

/* ─── CONFIG ────────────────────────────────────────────────── */
const PORT        = process.env.PORT || 3001;
const UPLOAD_DIR  = path.join(__dirname, 'uploads');
const OUTPUT_DIR  = path.join(__dirname, 'outputs');
const MAX_SIZE_MB = 500;               // free plan cap
const TTL_MS      = 60 * 60 * 1000;   // 1 hour — then auto-delete

[UPLOAD_DIR, OUTPUT_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));

/* ─── APP SETUP ─────────────────────────────────────────────── */
const app = express();
app.use(cors({ origin: '*' }));        // tighten to your domain in prod
app.use(express.json());

/* Serve finished files for download */
app.use('/download', express.static(OUTPUT_DIR));

/* Rate limiting — prevents abuse, keeps free tier fair */
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,                             // 30 conversions per 15 min per IP
  message: { error: 'Too many requests — please wait a few minutes.' }
});
app.use('/api/convert', limiter);

/* ─── MULTER (file upload) ───────────────────────────────────── */
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(UPLOAD_DIR, uuid());
    fs.mkdirSync(dir, { recursive: true });
    req.uploadDir = dir;               // stash so converter can find it
    cb(null, dir);
  },
  filename: (req, file, cb) => cb(null, file.originalname)
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_SIZE_MB * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /\.(jpe?g|png|webp|gif|avif|bmp|tiff?|pdf|docx?|txt|html|htm|mp3|wav|flac|ogg|aac|m4a|mp4|mov|avi|webm|mkv|zip)$/i;
    if (allowed.test(path.extname(file.originalname))) return cb(null, true);
    cb(new Error(`File type not supported: ${path.extname(file.originalname)}`));
  }
});

/* ─── HELPERS ───────────────────────────────────────────────── */

/** Schedule a directory for deletion after TTL */
function scheduleCleanup(dir) {
  setTimeout(async () => {
    try { await fsp.rm(dir, { recursive: true, force: true }); }
    catch { /* already gone */ }
  }, TTL_MS);
}

/** Detect category from extension */
function category(ext) {
  ext = ext.toLowerCase().replace('.', '');
  if (/jpe?g|png|webp|gif|avif|bmp|tiff?/.test(ext)) return 'image';
  if (/pdf|docx?|txt|html?/.test(ext))                return 'document';
  if (/mp3|wav|flac|ogg|aac|m4a/.test(ext))           return 'audio';
  if (/mp4|mov|avi|webm|mkv/.test(ext))               return 'video';
  if (/zip/.test(ext))                                  return 'archive';
  return 'unknown';
}

/** Run a shell command and return stdout */
function run(cmd) {
  return new Promise((resolve, reject) =>
    exec(cmd, (err, stdout, stderr) =>
      err ? reject(new Error(stderr || err.message)) : resolve(stdout)
    )
  );
}

/* ─── CONVERTERS ─────────────────────────────────────────────── */

async function convertImage(inputPath, outputPath, toExt) {
  const ext = toExt.replace('.', '').toLowerCase();
  let s = sharp(inputPath);
  if (ext === 'jpg' || ext === 'jpeg') s = s.jpeg({ quality: 92 });
  else if (ext === 'png')              s = s.png({ compressionLevel: 8 });
  else if (ext === 'webp')             s = s.webp({ quality: 90 });
  else if (ext === 'avif')             s = s.avif({ quality: 80 });
  else if (ext === 'gif')              s = s.gif();
  else if (ext === 'bmp')              s = s.bmp();
  else if (ext === 'tiff')             s = s.tiff({ quality: 90 });
  else throw new Error(`Unsupported image output: ${ext}`);
  await s.toFile(outputPath);
}

function convertAudio(inputPath, outputPath, toExt) {
  return new Promise((resolve, reject) => {
    const ext = toExt.replace('.', '').toLowerCase();
    let cmd = ffmpeg(inputPath);
    if (ext === 'mp3')  cmd = cmd.audioCodec('libmp3lame').audioBitrate(320);
    else if (ext === 'aac' || ext === 'm4a') cmd = cmd.audioCodec('aac').audioBitrate(256);
    else if (ext === 'flac') cmd = cmd.audioCodec('flac');
    else if (ext === 'ogg')  cmd = cmd.audioCodec('libvorbis').audioBitrate(320);
    else if (ext === 'wav')  cmd = cmd.audioCodec('pcm_s16le');
    cmd.save(outputPath)
       .on('end',   resolve)
       .on('error', reject);
  });
}

function convertVideo(inputPath, outputPath, toExt) {
  return new Promise((resolve, reject) => {
    const ext = toExt.replace('.', '').toLowerCase();
    let cmd = ffmpeg(inputPath);
    if (ext === 'mp4')  cmd = cmd.videoCodec('libx264').audioCodec('aac');
    else if (ext === 'webm') cmd = cmd.videoCodec('libvpx-vp9').audioCodec('libopus');
    else if (ext === 'avi')  cmd = cmd.videoCodec('mpeg4').audioCodec('mp3');
    else if (ext === 'mov')  cmd = cmd.videoCodec('libx264').audioCodec('aac');
    else if (ext === 'mkv')  cmd = cmd.videoCodec('libx264').audioCodec('aac');
    else if (ext === 'gif') {
      // Video → animated GIF (resized to max 480px wide to keep size sane)
      cmd = cmd.complexFilter('fps=12,scale=480:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse');
    }
    cmd.save(outputPath)
       .on('end',   resolve)
       .on('error', reject);
  });
}

async function convertDocument(inputPath, outputPath, toExt) {
  const fromExt = path.extname(inputPath).toLowerCase().replace('.', '');
  const ext     = toExt.replace('.', '').toLowerCase();
  const outDir  = path.dirname(outputPath);

  /* txt → pdf or docx: use LibreOffice */
  if (['doc', 'docx', 'txt', 'html', 'htm', 'odt'].includes(fromExt)) {
    const fmt = ext === 'pdf' ? 'pdf' : ext === 'txt' ? 'txt' : 'docx';
    await run(`libreoffice --headless --convert-to ${fmt} --outdir "${outDir}" "${inputPath}"`);
    /* LibreOffice names the output after the source file */
    const libOut = path.join(outDir, path.basename(inputPath, path.extname(inputPath)) + '.' + fmt);
    if (libOut !== outputPath) await fsp.rename(libOut, outputPath);
    return;
  }

  if (fromExt === 'pdf') {
    if (ext === 'txt') {
      /* pdf → txt using pdftotext (poppler-utils) */
      await run(`pdftotext "${inputPath}" "${outputPath}"`);
      return;
    }
    if (ext === 'docx') {
      /* pdf → docx via LibreOffice (best free option) */
      await run(`libreoffice --headless --convert-to docx --outdir "${outDir}" "${inputPath}"`);
      const libOut = path.join(outDir, path.basename(inputPath, '.pdf') + '.docx');
      if (libOut !== outputPath) await fsp.rename(libOut, outputPath);
      return;
    }
  }

  throw new Error(`Cannot convert ${fromExt} → ${ext}`);
}

async function convertArchive(inputPath, outputPath, toExt) {
  /* For now: any file → zip. More formats (tar.gz etc) easy to add. */
  if (toExt === '.zip') {
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(outputPath);
      const archive = archiver('zip', { zlib: { level: 9 } });
      out.on('close', resolve);
      archive.on('error', reject);
      archive.pipe(out);
      archive.file(inputPath, { name: path.basename(inputPath) });
      archive.finalize();
    });
  } else {
    throw new Error('Only ZIP output is supported for archives right now.');
  }
}

/* ─── MAIN ROUTE: POST /api/convert ─────────────────────────── */
app.post('/api/convert', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });

  const { targetFormat } = req.body;
  if (!targetFormat) return res.status(400).json({ error: 'targetFormat is required.' });

  const inputPath = req.file.path;
  const fromExt   = path.extname(req.file.originalname).toLowerCase();
  const toExt     = '.' + targetFormat.toLowerCase().replace(/^\./, '');
  const baseName  = path.basename(req.file.originalname, fromExt);
  const jobId     = uuid();
  const outDir    = path.join(OUTPUT_DIR, jobId);
  fs.mkdirSync(outDir, { recursive: true });
  const outputPath = path.join(outDir, baseName + toExt);

  try {
    const cat = category(fromExt);

    if (cat === 'image')    await convertImage(inputPath, outputPath, toExt);
    else if (cat === 'audio')    await convertAudio(inputPath, outputPath, toExt);
    else if (cat === 'video')    await convertVideo(inputPath, outputPath, toExt);
    else if (cat === 'document') await convertDocument(inputPath, outputPath, toExt);
    else if (cat === 'archive')  await convertArchive(inputPath, outputPath, toExt);
    else throw new Error(`Unsupported file type: ${fromExt}`);

    /* Schedule both upload and output dirs for cleanup */
    scheduleCleanup(req.uploadDir || path.dirname(inputPath));
    scheduleCleanup(outDir);

    const fileSize = (await fsp.stat(outputPath)).size;

    return res.json({
      success:   true,
      jobId,
      fileName:  baseName + toExt,
      fileSize,
      downloadUrl: `/download/${jobId}/${encodeURIComponent(baseName + toExt)}`,
      expiresIn: '1 hour'
    });

  } catch (err) {
    console.error('[convert error]', err.message);
    scheduleCleanup(req.uploadDir || path.dirname(inputPath));
    scheduleCleanup(outDir);
    return res.status(500).json({ error: err.message });
  }
});

/* ─── BATCH ROUTE: POST /api/convert/batch ───────────────────── */
/**
 * Accepts up to 10 files. Each must have a matching targetFormats[] entry.
 * Returns an array of results in the same order.
 */
app.post('/api/convert/batch', upload.array('files', 10), async (req, res) => {
  if (!req.files || req.files.length === 0)
    return res.status(400).json({ error: 'No files uploaded.' });

  let formats = req.body.targetFormats;
  if (typeof formats === 'string') formats = [formats]; // single file case

  if (!formats || formats.length !== req.files.length)
    return res.status(400).json({ error: 'Provide a targetFormats[] entry for each file.' });

  const results = await Promise.allSettled(
    req.files.map(async (file, i) => {
      const toExt  = '.' + formats[i].toLowerCase().replace(/^\./, '');
      const fromExt = path.extname(file.originalname).toLowerCase();
      const baseName = path.basename(file.originalname, fromExt);
      const jobId  = uuid();
      const outDir = path.join(OUTPUT_DIR, jobId);
      fs.mkdirSync(outDir, { recursive: true });
      const outputPath = path.join(outDir, baseName + toExt);
      const cat = category(fromExt);

      if      (cat === 'image')    await convertImage(file.path, outputPath, toExt);
      else if (cat === 'audio')    await convertAudio(file.path, outputPath, toExt);
      else if (cat === 'video')    await convertVideo(file.path, outputPath, toExt);
      else if (cat === 'document') await convertDocument(file.path, outputPath, toExt);
      else if (cat === 'archive')  await convertArchive(file.path, outputPath, toExt);
      else throw new Error(`Unsupported type: ${fromExt}`);

      scheduleCleanup(path.dirname(file.path));
      scheduleCleanup(outDir);

      const fileSize = (await fsp.stat(outputPath)).size;
      return {
        success: true, jobId, fileName: baseName + toExt, fileSize,
        downloadUrl: `/download/${jobId}/${encodeURIComponent(baseName + toExt)}`,
        expiresIn: '1 hour'
      };
    })
  );

  return res.json(
    results.map(r => r.status === 'fulfilled' ? r.value : { success: false, error: r.reason.message })
  );
});

/* ─── HEALTH CHECK ───────────────────────────────────────────── */
app.get('/api/health', (req, res) => res.json({ status: 'ok', version: '1.0.0' }));

/* ─── SUPPORTED FORMATS ─────────────────────────────────────── */
app.get('/api/formats', (req, res) => res.json({
  image:    { from: ['jpg','jpeg','png','webp','gif','avif','bmp','tiff'], to: ['jpg','png','webp','avif','gif','bmp','tiff'] },
  audio:    { from: ['mp3','wav','flac','ogg','aac','m4a'],               to: ['mp3','wav','flac','ogg','aac','m4a'] },
  video:    { from: ['mp4','mov','avi','webm','mkv'],                     to: ['mp4','webm','avi','mov','mkv','gif'] },
  document: { from: ['pdf','docx','doc','txt','html'],                    to: ['pdf','docx','txt'] },
  archive:  { from: ['zip','any'],                                        to: ['zip'] }
}));

/* ─── ERROR HANDLER ─────────────────────────────────────────── */
app.use((err, req, res, next) => {
  if (err.code === 'LIMIT_FILE_SIZE')
    return res.status(413).json({ error: `File too large. Max size is ${MAX_SIZE_MB}MB.` });
  console.error('[unhandled error]', err);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

/* ─── START ─────────────────────────────────────────────────── */
app.listen(PORT, () =>
  console.log(`✅ File4Life backend running → http://localhost:${PORT}`)
);

/* ─── STRIPE PRO TIER STUB (add later) ──────────────────────── */
/*
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
app.post('/api/checkout', async (req, res) => {
  const session = await stripe.checkout.sessions.create({
    payment_method_types: ['card'],
    line_items: [{ price: 'price_XXXX', quantity: 1 }],
    mode: 'subscription',
    success_url: 'https://file4life.com/pro?success=true',
    cancel_url:  'https://file4life.com/pricing',
  });
  res.json({ url: session.url });
});
*/
