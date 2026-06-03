import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db';
import { generateToken, authMiddleware, AuthRequest } from '../middleware/auth';
import { registerSchema, loginSchema, validateRequest } from '../validation/schemas';

const router = Router();
const SALT_ROUNDS = 12;

// Register
router.post('/register', async (req, res) => {
  try {
    const validation = validateRequest(registerSchema, req.body);
    if (!validation.success) {
      return res.status(400).json({ error: 'Validation failed', details: validation.errors });
    }

    const { email, password } = validation.data;
    const db = getDb();

    // Check if user exists
    const existingUser = await db('users').where({ email }).first();
    if (existingUser) {
      return res.status(409).json({ error: 'Email already registered' });
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

    // Create user with 7-day trial
    const userId = uuidv4();
    const trialExpires = new Date();
    trialExpires.setDate(trialExpires.getDate() + 7);
    
    await db('users').insert({ 
      id: userId, 
      email, 
      password_hash: passwordHash,
      subscription_status: 'trial',
      trial_expires_at: trialExpires.toISOString()
    });

    // Generate token
    const token = generateToken(userId, email);

    res.status(201).json({
      message: 'User registered successfully',
      token,
      user: { id: userId, email },
    });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Login
router.post('/login', async (req, res) => {
  try {
    const validation = validateRequest(loginSchema, req.body);
    if (!validation.success) {
      return res.status(400).json({ error: 'Validation failed', details: validation.errors });
    }

    const { email, password } = validation.data;
    const db = getDb();

    // Get user
    const user = await db('users').where({ email }).first();
    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Verify password
    const isValid = await bcrypt.compare(password, user.password_hash);
    if (!isValid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Generate token
    const token = generateToken(user.id, user.email);

    res.json({
      message: 'Login successful',
      token,
      user: {
        id: user.id,
        email: user.email,
        subscription_status: user.subscription_status,
        subscription_period: user.subscription_period,
      },
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get current user
router.get('/me', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const db = getDb();
    const user = await db('users')
      .select('id', 'email', 'subscription_status', 'subscription_period', 'subscription_expires_at', 'created_at')
      .where({ id: req.user!.id })
      .first();

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({ user });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
