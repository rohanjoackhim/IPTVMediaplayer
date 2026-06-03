import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db';
import { authMiddleware, AuthRequest } from '../middleware/auth';

const router = Router();

const PRICE_MONTHLY = parseInt(process.env.PRICE_MONTHLY || '999');
const PRICE_YEARLY = parseInt(process.env.PRICE_YEARLY || '9999');

// Create payment intent (Stripe stub — returns mock client secret when no Stripe key set)
router.post('/create-intent', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const { period } = req.body;
    if (!period || !['monthly', 'yearly'].includes(period)) {
      return res.status(400).json({ error: 'period must be "monthly" or "yearly"' });
    }

    const amount = period === 'monthly' ? PRICE_MONTHLY : PRICE_YEARLY;
    const db = getDb();

    await db('payments').insert({
      id: uuidv4(),
      user_id: req.user!.id,
      stripe_payment_intent_id: null,
      stripe_customer_id: null,
      amount,
      currency: 'usd',
      status: 'pending',
      period,
    });

    res.json({ clientSecret: null, amount, period, message: 'Stripe not configured' });
  } catch (error) {
    console.error('Create payment intent error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Stripe webhook (stub)
router.post('/webhook', async (req, res) => {
  res.json({ received: true });
});

// Get subscription status — accessible as /subscription or /status
async function getSubscriptionStatus(req: AuthRequest, res: any) {
  try {
    const db = getDb();
    const user = await db('users')
      .select('subscription_status', 'subscription_period', 'subscription_expires_at', 'trial_expires_at', 'coupon_id')
      .where({ id: req.user!.id })
      .first();

    let isActive = false;
    let status = user?.subscription_status || 'inactive';
    let expiresAt = user?.subscription_expires_at || null;
    let period = user?.subscription_period || null;

    // Check trial status
    if (user?.trial_expires_at && new Date(user.trial_expires_at) > new Date()) {
      isActive = true;
      status = 'trial';
      expiresAt = user.trial_expires_at;
    }
    // Check regular subscription
    else if (user?.subscription_expires_at === null) {
      // Unlimited access (from coupon)
      isActive = true;
      status = 'active';
    }
    else if (user?.subscription_expires_at && new Date(user.subscription_expires_at) > new Date()) {
      isActive = true;
      status = 'active';
    }

    res.json({
      status,
      period,
      expires_at: expiresAt,
      trial_expires_at: user?.trial_expires_at || null,
      coupon_id: user?.coupon_id || null,
      is_active: !!isActive,
    });
  } catch (error) {
    console.error('Get subscription error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

router.get('/subscription', authMiddleware, getSubscriptionStatus);
router.get('/status', authMiddleware, getSubscriptionStatus);

// Get payment history
router.get('/history', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const db = getDb();
    const payments = await db('payments')
      .select('id', 'amount', 'currency', 'status', 'period', 'created_at')
      .where({ user_id: req.user!.id })
      .orderBy('created_at', 'desc');

    res.json({ payments });
  } catch (error) {
    console.error('Get payment history error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
