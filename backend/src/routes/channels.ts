import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db';
import { authMiddleware, apiKeyMiddleware, AuthRequest } from '../middleware/auth';
import { createChannelSchema, updateChannelSchema, validateRequest } from '../validation/schemas';

const router = Router();

// Get all channels for authenticated user
router.get('/', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const db = getDb();
    const channels = await db('channels')
      .join('users', 'channels.user_id', 'users.id')
      .select(
        'channels.id', 'channels.name', 'channels.url', 'channels.logo',
        'channels.group_name as group', 'channels.country', 'channels.language',
        'channels.category', 'channels.content_type', 'channels.is_active',
        'channels.created_at', 'channels.updated_at',
        'users.email as username'
      )
      .where({ 'channels.user_id': req.user!.id })
      .orderBy('channels.created_at', 'desc');

    res.json({ channels });
  } catch (error) {
    console.error('Get channels error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get channels by API key (for player integration)
router.get('/public', apiKeyMiddleware, async (req: AuthRequest, res) => {
  try {
    const db = getDb();
    const channels = await db('channels')
      .select('id', 'name', 'url', 'logo', 'group_name as group', 'country', 'language', 'category', 'content_type')
      .where({ user_id: req.user!.id, is_active: 1 })
      .orderBy('name', 'asc');

    res.json({ channels });
  } catch (error) {
    console.error('Get public channels error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get single channel
router.get('/:id', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const db = getDb();
    const channel = await db('channels')
      .select('id', 'name', 'url', 'logo', 'group_name as group', 'country', 'language', 'category', 'content_type', 'is_active', 'created_at', 'updated_at')
      .where({ id: req.params.id, user_id: req.user!.id })
      .first();

    if (!channel) {
      return res.status(404).json({ error: 'Channel not found' });
    }

    res.json({ channel });
  } catch (error) {
    console.error('Get channel error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Create channel
router.post('/', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const validation = validateRequest(createChannelSchema, req.body);
    if (!validation.success) {
      return res.status(400).json({ error: 'Validation failed', details: validation.errors });
    }

    const db = getDb();
    const channelId = uuidv4();

    await db('channels').insert({
      id: channelId,
      user_id: req.user!.id,
      name: validation.data.name,
      url: validation.data.url,
      logo: validation.data.logo || null,
      group_name: validation.data.group || null,
      country: validation.data.country || null,
      language: validation.data.language || null,
      category: validation.data.category || null,
      content_type: validation.data.content_type,
    });

    const channel = await db('channels')
      .select('id', 'name', 'url', 'logo', 'group_name as group', 'country', 'language', 'category', 'content_type', 'is_active', 'created_at', 'updated_at')
      .where({ id: channelId })
      .first();

    res.status(201).json({
      message: 'Channel created successfully',
      channel,
    });
  } catch (error) {
    console.error('Create channel error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update channel
router.put('/:id', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const validation = validateRequest(updateChannelSchema, req.body);
    if (!validation.success) {
      return res.status(400).json({ error: 'Validation failed', details: validation.errors });
    }

    const db = getDb();

    const existing = await db('channels').where({ id: req.params.id }).first();
    if (!existing) {
      return res.status(404).json({ error: 'Channel not found' });
    }
    if (existing.user_id !== req.user!.id) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const data = validation.data;
    const updateFields: Record<string, unknown> = { updated_at: db.raw('CURRENT_TIMESTAMP') };
    if (data.name !== undefined) updateFields.name = data.name;
    if (data.url !== undefined) updateFields.url = data.url;
    if (data.logo !== undefined) updateFields.logo = data.logo || null;
    if (data.group !== undefined) updateFields.group_name = data.group || null;
    if (data.country !== undefined) updateFields.country = data.country || null;
    if (data.language !== undefined) updateFields.language = data.language || null;
    if (data.category !== undefined) updateFields.category = data.category || null;
    if (data.content_type !== undefined) updateFields.content_type = data.content_type;
    if (data.is_active !== undefined) updateFields.is_active = data.is_active ? 1 : 0;

    if (Object.keys(updateFields).length <= 1) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    await db('channels').where({ id: req.params.id }).update(updateFields);

    const channel = await db('channels')
      .select('id', 'name', 'url', 'logo', 'group_name as group', 'country', 'language', 'category', 'content_type', 'is_active', 'created_at', 'updated_at')
      .where({ id: req.params.id })
      .first();

    res.json({ message: 'Channel updated successfully', channel });
  } catch (error) {
    console.error('Update channel error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete channel
router.delete('/:id', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const db = getDb();

    const existing = await db('channels').where({ id: req.params.id }).first();
    if (!existing) {
      return res.status(404).json({ error: 'Channel not found' });
    }
    if (existing.user_id !== req.user!.id) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    await db('channels').where({ id: req.params.id }).delete();

    res.json({ message: 'Channel deleted successfully' });
  } catch (error) {
    console.error('Delete channel error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
