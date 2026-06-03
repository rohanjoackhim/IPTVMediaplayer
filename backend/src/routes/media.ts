import { Router, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db';
import { authMiddleware, apiKeyMiddleware, AuthRequest } from '../middleware/auth';

const router = Router();

const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(process.cwd(), 'data', 'uploads');
const MAX_FILE_SIZE = parseInt(process.env.MAX_UPLOAD_MB || '200') * 1024 * 1024;

const ALLOWED_MIME = new Set([
  'audio/mpeg', 'audio/mp3', 'audio/flac', 'audio/x-flac',
  'audio/mp4', 'audio/m4a', 'audio/x-m4a', 'audio/m4b',
  'audio/aac', 'audio/ogg', 'audio/opus', 'audio/wav',
  'audio/x-wav', 'audio/webm', 'audio/x-aiff', 'audio/aiff',
]);

function ensureUploadsDir(userId: string): string {
  const dir = path.join(UPLOADS_DIR, userId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const storage = multer.diskStorage({
  destination: (req: AuthRequest, _file, cb) => {
    const dir = ensureUploadsDir(req.user!.id);
    cb(null, dir);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.mp3';
    cb(null, `${uuidv4()}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (_req, file, cb) => {
    const mime = file.mimetype.toLowerCase();
    if (ALLOWED_MIME.has(mime) || mime.startsWith('audio/')) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported file type: ${file.mimetype}. Only audio files (MP3, FLAC, AAC, M4A, OGG, WAV) are allowed.`));
    }
  },
});

// POST /api/media/upload — upload one or more audio files (JWT auth)
router.post('/upload', authMiddleware, (req: AuthRequest, res: Response) => {
  upload.array('files', 20)(req as any, res as any, async (err) => {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: `File too large. Maximum size is ${MAX_FILE_SIZE / 1024 / 1024}MB.` });
      }
      return res.status(400).json({ error: err.message });
    }
    if (err) return res.status(400).json({ error: err.message });

    const files = (req as any).files as Express.Multer.File[];
    if (!files || files.length === 0) {
      return res.status(400).json({ error: 'No files uploaded.' });
    }

    const db = getDb();
    const saved: object[] = [];

    for (const file of files) {
      const id = uuidv4();
      const mediaType = file.originalname.toLowerCase().match(/\.(m4b|mp3)$/i) ? 'music' : 'music';
      const record = {
        id,
        user_id: req.user!.id,
        original_name: file.originalname,
        file_name: file.filename,
        mime_type: file.mimetype,
        size_bytes: file.size,
        media_type: mediaType,
        title: file.originalname.replace(/\.[^/.]+$/, ''),
      };
      await db('media_files').insert(record);
      saved.push({
        id,
        original_name: file.originalname,
        title: record.title,
        mime_type: file.mimetype,
        size_bytes: file.size,
        media_type: mediaType,
        stream_url: `/api/media/stream/${id}`,
        created_at: new Date().toISOString(),
      });
    }

    res.status(201).json({ uploaded: saved.length, files: saved });
  });
});

// GET /api/media — list all media files for authenticated user (JWT)
router.get('/', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const db = getDb();
    const files = await db('media_files')
      .select('id', 'original_name', 'title', 'artist', 'album', 'mime_type', 'size_bytes', 'media_type', 'duration_sec', 'created_at')
      .where({ user_id: req.user!.id })
      .orderBy('created_at', 'desc');

    const withUrls = files.map((f: Record<string, unknown>) => ({
      ...f,
      stream_url: `/api/media/stream/${f.id}`,
    }));

    res.json({ files: withUrls, storage_path: `${req.protocol}://${req.get('host')}/api/media` });
  } catch (error) {
    console.error('List media error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/media/library — list media files via API key (for the player)
router.get('/library', apiKeyMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const db = getDb();
    const files = await db('media_files')
      .select('id', 'original_name', 'title', 'artist', 'album', 'mime_type', 'size_bytes', 'media_type', 'duration_sec', 'created_at')
      .where({ user_id: req.user!.id })
      .orderBy('created_at', 'desc');

    const host = `${req.protocol}://${req.get('host')}`;
    const withUrls = files.map((f: Record<string, unknown>) => ({
      ...f,
      stream_url: `${host}/api/media/stream/${f.id}`,
    }));

    res.json({ files: withUrls });
  } catch (error) {
    console.error('Library media error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/media/stream/:id — stream the audio file (JWT or API key)
router.get('/stream/:id', async (req: Request, res: Response) => {
  try {
    // Accept either Bearer token or x-api-key
    const db = getDb();
    let userId: string | null = null;

    const authHeader = req.headers.authorization || '';
    const apiKey = req.headers['x-api-key'] as string || (req.query.apikey as string) || '';

    if (authHeader.startsWith('Bearer ')) {
      const jwt = require('jsonwebtoken');
      try {
        const decoded = jwt.verify(authHeader.slice(7), process.env.JWT_SECRET || 'secret') as { userId: string };
        userId = decoded.userId;
      } catch { /* invalid token */ }
    }

    if (!userId && apiKey) {
      const key = await db('api_keys').where({ key: apiKey, is_active: 1 }).first();
      if (key) userId = key.user_id;
    }

    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const file = await db('media_files').where({ id: req.params.id, user_id: userId }).first();
    if (!file) return res.status(404).json({ error: 'File not found' });

    const filePath = path.join(UPLOADS_DIR, userId, file.file_name);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File missing from storage' });

    const stat = fs.statSync(filePath);
    const fileSize = stat.size;
    const range = req.headers.range;

    res.setHeader('Content-Type', file.mime_type || 'audio/mpeg');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(file.original_name)}"`);

    if (range) {
      const [startStr, endStr] = range.replace(/bytes=/, '').split('-');
      const start = parseInt(startStr, 10);
      const end = endStr ? parseInt(endStr, 10) : fileSize - 1;
      const chunkSize = end - start + 1;

      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
      res.setHeader('Content-Length', chunkSize);

      const stream = fs.createReadStream(filePath, { start, end });
      stream.pipe(res);
    } else {
      res.setHeader('Content-Length', fileSize);
      fs.createReadStream(filePath).pipe(res);
    }
  } catch (error) {
    console.error('Stream media error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PATCH /api/media/:id — update title/artist/album metadata
router.patch('/:id', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const db = getDb();
    const file = await db('media_files').where({ id: req.params.id, user_id: req.user!.id }).first();
    if (!file) return res.status(404).json({ error: 'File not found' });

    const { title, artist, album, media_type } = req.body;
    const update: Record<string, unknown> = {};
    if (title !== undefined) update.title = String(title).trim() || file.title;
    if (artist !== undefined) update.artist = String(artist).trim() || null;
    if (album !== undefined) update.album = String(album).trim() || null;
    if (media_type !== undefined && ['music', 'audiobook'].includes(media_type)) update.media_type = media_type;

    if (Object.keys(update).length > 0) {
      await db('media_files').where({ id: req.params.id }).update(update);
    }

    const updated = await db('media_files')
      .select('id', 'original_name', 'title', 'artist', 'album', 'mime_type', 'size_bytes', 'media_type', 'duration_sec', 'created_at')
      .where({ id: req.params.id })
      .first();

    res.json({ file: { ...updated, stream_url: `/api/media/stream/${req.params.id}` } });
  } catch (error) {
    console.error('Update media error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/media/:id — delete a file
router.delete('/:id', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const db = getDb();
    const file = await db('media_files').where({ id: req.params.id, user_id: req.user!.id }).first();
    if (!file) return res.status(404).json({ error: 'File not found' });

    const filePath = path.join(UPLOADS_DIR, req.user!.id, file.file_name);
    if (fs.existsSync(filePath)) {
      try { fs.unlinkSync(filePath); } catch { /* ignore */ }
    }

    await db('media_files').where({ id: req.params.id }).delete();
    res.json({ message: 'File deleted successfully' });
  } catch (error) {
    console.error('Delete media error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
