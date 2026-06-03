import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db';
import { authMiddleware, AuthRequest } from '../middleware/auth';

const router = Router();

// Create a new coupon (admin only for now)
router.post('/create', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const { code, description, discountType, discountValue, maxUses, expiresAt } = req.body;
    
    if (!code || !discountType || !discountValue) {
      return res.status(400).json({ error: 'Code, discount type, and discount value are required' });
    }
    
    if (!['percentage', 'fixed', 'unlimited'].includes(discountType)) {
      return res.status(400).json({ error: 'Discount type must be percentage, fixed, or unlimited' });
    }
    
    const db = getDb();
    
    // Check if coupon code already exists
    const existing = await db('coupons').where({ code: code.trim().toUpperCase() }).first();
    if (existing) {
      return res.status(409).json({ error: 'Coupon code already exists' });
    }
    
    const coupon = {
      id: uuidv4(),
      code: code.trim().toUpperCase(),
      description: description || null,
      discount_type: discountType,
      discount_value: discountValue,
      max_uses: maxUses || null,
      used_count: 0,
      is_active: 1,
      created_by: req.user!.id,
      expires_at: expiresAt || null,
    };
    
    await db('coupons').insert(coupon);
    
    res.status(201).json({
      message: 'Coupon created successfully',
      coupon: {
        id: coupon.id,
        code: coupon.code,
        description: coupon.description,
        discount_type: coupon.discount_type,
        discount_value: coupon.discount_value,
        max_uses: coupon.max_uses,
        used_count: coupon.used_count,
        is_active: !!coupon.is_active,
        expires_at: coupon.expires_at,
        created_at: new Date().toISOString(),
      }
    });
  } catch (error) {
    console.error('Create coupon error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Validate and apply a coupon
router.post('/validate', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const { code } = req.body;
    
    if (!code) {
      return res.status(400).json({ error: 'Coupon code is required' });
    }
    
    const db = getDb();
    const coupon = await db('coupons').where({ 
      code: code.trim().toUpperCase(),
      is_active: 1 
    }).first();
    
    if (!coupon) {
      return res.status(404).json({ error: 'Invalid coupon code' });
    }
    
    // Check if expired
    if (coupon.expires_at && new Date(coupon.expires_at) < new Date()) {
      return res.status(400).json({ error: 'Coupon has expired' });
    }
    
    // Check usage limit
    if (coupon.max_uses && coupon.used_count >= coupon.max_uses) {
      return res.status(400).json({ error: 'Coupon usage limit reached' });
    }
    
    // Check if user already used this coupon
    const userUsage = await db('users').where({ 
      id: req.user!.id,
      coupon_id: coupon.id 
    }).first();
    
    if (userUsage) {
      return res.status(400).json({ error: 'You have already used this coupon' });
    }
    
    res.json({
      valid: true,
      coupon: {
        id: coupon.id,
        code: coupon.code,
        description: coupon.description,
        discount_type: coupon.discount_type,
        discount_value: coupon.discount_value,
      }
    });
  } catch (error) {
    console.error('Validate coupon error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Apply coupon to user account
router.post('/apply', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const { code } = req.body;
    
    if (!code) {
      return res.status(400).json({ error: 'Coupon code is required' });
    }
    
    const db = getDb();
    const coupon = await db('coupons').where({ 
      code: code.trim().toUpperCase(),
      is_active: 1 
    }).first();
    
    if (!coupon) {
      return res.status(404).json({ error: 'Invalid coupon code' });
    }
    
    // Check if expired
    if (coupon.expires_at && new Date(coupon.expires_at) < new Date()) {
      return res.status(400).json({ error: 'Coupon has expired' });
    }
    
    // Check usage limit
    if (coupon.max_uses && coupon.used_count >= coupon.max_uses) {
      return res.status(400).json({ error: 'Coupon usage limit reached' });
    }
    
    // Check if user already used this coupon
    const userUsage = await db('users').where({ 
      id: req.user!.id,
      coupon_id: coupon.id 
    }).first();
    
    if (userUsage) {
      return res.status(400).json({ error: 'You have already used this coupon' });
    }
    
    // Apply coupon based on type
    let updates: any = { coupon_id: coupon.id };
    
    if (coupon.discount_type === 'unlimited') {
      // Unlimited access - set subscription to never expire
      updates.subscription_status = 'active';
      updates.subscription_expires_at = null;
    } else if (coupon.discount_type === 'fixed' && coupon.discount_value === 0) {
      // Free access for a specific duration (e.g., 1 year)
      const expiryDate = new Date();
      expiryDate.setFullYear(expiryDate.getFullYear() + 1);
      updates.subscription_status = 'active';
      updates.subscription_expires_at = expiryDate.toISOString();
    }
    
    // Update user
    await db('users').where({ id: req.user!.id }).update(updates);
    
    // Increment coupon usage
    await db('coupons').where({ id: coupon.id }).update({
      used_count: coupon.used_count + 1
    });
    
    res.json({
      message: 'Coupon applied successfully',
      subscription_status: updates.subscription_status,
      expires_at: updates.subscription_expires_at,
    });
  } catch (error) {
    console.error('Apply coupon error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// List all coupons (admin)
router.get('/list', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const db = getDb();
    const coupons = await db('coupons')
      .select('id', 'code', 'description', 'discount_type', 'discount_value', 'max_uses', 'used_count', 'is_active', 'created_at', 'expires_at')
      .orderBy('created_at', 'desc');
    
    res.json({ coupons });
  } catch (error) {
    console.error('List coupons error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
