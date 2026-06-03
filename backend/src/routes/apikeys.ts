import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import { getDb } from '../db';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { createApiKeySchema, validateRequest } from '../validation/schemas';

const router = Router();

// Generate a secure API key
function generateApiKey(): string {
  return `iptv_${crypto.randomBytes(32).toString('hex')}`;
}

// Get all API keys for user
router.get('/', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const db = getDb();
    const keys = await db('api_keys')
      .select('id', 'name', 'key', 'is_active', 'last_used_at', 'created_at', 'expires_at')
      .where({ user_id: req.user!.id })
      .orderBy('created_at', 'desc');

    const maskedKeys = keys.map((k: Record<string, unknown>) => ({
      ...k,
      key: `${String(k.key).substring(0, 8)}...${String(k.key).substring(String(k.key).length - 4)}`,
    }));

    res.json({ apiKeys: maskedKeys });
  } catch (error) {
    console.error('Get API keys error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Create new API key
router.post('/', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const validation = validateRequest(createApiKeySchema, req.body);
    if (!validation.success) {
      return res.status(400).json({ error: 'Validation failed', details: validation.errors });
    }

    const db = getDb();
    const keyId = uuidv4();
    const apiKey = generateApiKey();

    await db('api_keys').insert({
      id: keyId,
      user_id: req.user!.id,
      key: apiKey,
      name: validation.data.name || null,
      expires_at: validation.data.expires_at || null,
    });

    res.status(201).json({
      message: 'API key created successfully',
      apiKey,
      id: keyId,
    });
  } catch (error) {
    console.error('Create API key error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Revoke/deactivate API key
router.delete('/:id', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const db = getDb();

    const key = await db('api_keys').where({ id: req.params.id }).first();
    if (!key) {
      return res.status(404).json({ error: 'API key not found' });
    }
    if (key.user_id !== req.user!.id) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    await db('api_keys').where({ id: req.params.id }).delete();

    res.json({ message: 'API key revoked successfully' });
  } catch (error) {
    console.error('Delete API key error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Toggle API key active status
router.patch('/:id/toggle', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const db = getDb();

    const key = await db('api_keys').where({ id: req.params.id }).first();
    if (!key) {
      return res.status(404).json({ error: 'API key not found' });
    }
    if (key.user_id !== req.user!.id) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const newStatus = key.is_active ? 0 : 1;
    await db('api_keys').where({ id: req.params.id }).update({ is_active: newStatus });

    res.json({
      message: `API key ${newStatus ? 'activated' : 'deactivated'}`,
      is_active: !!newStatus,
    });
  } catch (error) {
    console.error('Toggle API key error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
