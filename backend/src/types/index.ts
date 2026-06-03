export interface User {
  id: string;
  email: string;
  password_hash: string;
  api_key: string | null;
  subscription_status: 'active' | 'cancelled' | 'past_due' | 'unpaid' | 'trialing' | null;
  subscription_id: string | null;
  subscription_period: 'monthly' | 'yearly' | null;
  subscription_expires_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Channel {
  id: string;
  user_id: string;
  name: string;
  url: string;
  logo: string | null;
  group: string | null;
  country: string | null;
  language: string | null;
  category: string | null;
  content_type: 'live' | 'movie' | 'series';
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface ApiKey {
  id: string;
  user_id: string;
  key: string;
  name: string | null;
  is_active: boolean;
  last_used_at: string | null;
  created_at: string;
  expires_at: string | null;
}

export interface Payment {
  id: string;
  user_id: string;
  stripe_payment_intent_id: string;
  stripe_customer_id: string;
  amount: number;
  currency: string;
  status: 'succeeded' | 'pending' | 'failed';
  period: 'monthly' | 'yearly';
  created_at: string;
}

export interface JWTPayload {
  userId: string;
  email: string;
  iat: number;
  exp: number;
}

export interface CreateChannelRequest {
  name: string;
  url: string;
  logo?: string;
  group?: string;
  country?: string;
  language?: string;
  category?: string;
  content_type?: 'live' | 'movie' | 'series';
}

export interface UpdateChannelRequest {
  name?: string;
  url?: string;
  logo?: string;
  group?: string;
  country?: string;
  language?: string;
  category?: string;
  content_type?: 'live' | 'movie' | 'series';
  is_active?: boolean;
}

export interface RegisterRequest {
  email: string;
  password: string;
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface CreatePaymentIntentRequest {
  period: 'monthly' | 'yearly';
}
