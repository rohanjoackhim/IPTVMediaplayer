import { z } from 'zod';

export const registerSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
});

export const loginSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z.string().min(1, 'Password is required'),
});

export const createChannelSchema = z.object({
  name: z.string().min(1, 'Channel name is required'),
  url: z.string().url('Invalid URL').min(1, 'Stream URL is required'),
  logo: z.string().url('Invalid logo URL').optional().or(z.literal('')),
  group: z.string().optional(),
  country: z.string().optional(),
  language: z.string().optional(),
  category: z.string().optional(),
  content_type: z.enum(['live', 'movie', 'series']).default('live'),
});

export const updateChannelSchema = z.object({
  name: z.string().min(1).optional(),
  url: z.string().url().optional(),
  logo: z.string().url().optional().or(z.literal('')),
  group: z.string().optional(),
  country: z.string().optional(),
  language: z.string().optional(),
  category: z.string().optional(),
  content_type: z.enum(['live', 'movie', 'series']).optional(),
  is_active: z.boolean().optional(),
});

export const createPaymentIntentSchema = z.object({
  period: z.enum(['monthly', 'yearly']),
});

export const createApiKeySchema = z.object({
  name: z.string().optional(),
  expires_at: z.string().datetime().optional(),
});

export const validateRequest = <T>(schema: z.ZodSchema<T>, data: unknown): { success: true; data: T } | { success: false; errors: string[] } => {
  const result = schema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data };
  }
  const errors = result.error.errors.map(e => e.message);
  return { success: false, errors };
};
