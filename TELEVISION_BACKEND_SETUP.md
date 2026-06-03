# Television Backend Setup Guide

This guide explains how to set up and integrate the Television backend API that allows users to purchase API keys and add their own streaming channels.

## Overview

The Television feature consists of:
1. **Backend API** (`/backend`) - Node.js/Express server with Stripe payments
2. **Frontend Component** (`TelevisionTab.tsx`) - UI for managing channels and API keys
3. **Player Integration** - Load channels from provider API keys

## Quick Setup

### 1. Start the Backend

```bash
cd backend
npm install

# Copy environment file and configure
cp .env.example .env
# Edit .env with your Stripe keys

# Initialize database
npm run db:init

# Start development server
npm run dev
```

The backend will run on `http://localhost:3001`

### 2. Configure Environment Variables

Edit `backend/.env`:

```env
# Required
STRIPE_SECRET_KEY=sk_test_your_key_here
STRIPE_PUBLISHABLE_KEY=pk_test_your_key_here
STRIPE_WEBHOOK_SECRET=whsec_your_webhook_secret
JWT_SECRET=your-super-secret-jwt-key-min-32-chars

# Optional (defaults shown)
PORT=3001
DATABASE_PATH=./data/iptv.db
PRICE_MONTHLY=999        # $9.99 in cents
PRICE_YEARLY=9999         # $99.99 in cents
CORS_ORIGINS=http://localhost:5173
```

### 3. Set Up Stripe

1. Create a Stripe account at https://stripe.com
2. Get your API keys from the Dashboard
3. Set up webhook endpoint: `https://your-domain.com/api/payments/webhook`
4. Configure webhook secret in `.env`

### 4. Integrate in Player

Add the Television tab to your player. Here's how to use the `TelevisionTab` component:

```tsx
import TelevisionTab from './components/TelevisionTab';

// In your main component:
const handleTelevisionChannels = (channels) => {
  // Add channels to your channel list
  setChannels(prev => [...prev, ...channels]);
};

<TelevisionTab
  apiBaseUrl="http://localhost:3001/api"
  onChannelsLoaded={handleTelevisionChannels}
/>
```

## Features

### For Channel Providers (Backend Users)

1. **Registration/Login**: Create account with email/password
2. **Channel Management**: Add/edit/delete streaming channels
3. **API Keys**: Generate API keys to share with viewers
4. **Subscriptions**: Monthly/yearly payments via Stripe

### For Viewers (Player Users)

1. **Enter API Key**: Input provider's API key in Television tab
2. **Load Channels**: Fetch and play provider's channels
3. **No Account Required**: Just need the API key

## API Endpoints

### Authentication
- `POST /api/auth/register` - Create account
- `POST /api/auth/login` - Sign in
- `GET /api/auth/me` - Get current user

### Channels (Requires Auth)
- `GET /api/channels` - List my channels
- `POST /api/channels` - Add channel
- `PUT /api/channels/:id` - Update channel
- `DELETE /api/channels/:id` - Delete channel

### Public Channels (Requires API Key)
- `GET /api/channels/public` - List channels by API key
  - Header: `X-API-Key: iptv_...`

### API Keys (Requires Auth)
- `GET /api/keys` - List API keys
- `POST /api/keys` - Create API key
- `DELETE /api/keys/:id` - Revoke API key

### Payments (Requires Auth)
- `POST /api/payments/create-intent` - Create payment
- `GET /api/payments/subscription` - Check status
- `GET /api/payments/history` - Payment history

## Database Schema

### Users Table
- `id` - UUID
- `email` - Unique email
- `password_hash` - Bcrypt hash
- `subscription_status` - active/cancelled/etc
- `subscription_expires_at` - ISO date
- Timestamps

### Channels Table
- `id` - UUID
- `user_id` - Owner reference
- `name`, `url`, `logo` - Channel info
- `group`, `country`, `language` - Metadata
- `content_type` - live/movie/series
- `is_active` - Boolean

### API Keys Table
- `id` - UUID
- `user_id` - Owner reference
- `key` - The API key string
- `is_active` - Boolean
- `expires_at` - Optional expiration

## Security Considerations

1. **HTTPS**: Use HTTPS in production
2. **JWT Secret**: Use strong random secret (32+ chars)
3. **Rate Limiting**: Configured (100 req/15min default)
4. **CORS**: Restrict to your frontend domain
5. **Stripe Webhooks**: Verify signatures
6. **API Keys**: Keys are hashed in logs, shown once on creation

## Production Deployment

### Backend
```bash
cd backend
npm run build
npm start
```

### Environment
- Set `NODE_ENV=production`
- Use strong `JWT_SECRET`
- Configure Stripe live keys
- Set up database backups
- Use process manager (PM2)

### Example PM2 Config
```json
{
  "name": "iptv-backend",
  "script": "./dist/server.js",
  "instances": 1,
  "env": {
    "NODE_ENV": "production",
    "PORT": 3001
  }
}
```

## Testing

### Create Test User
```bash
curl -X POST http://localhost:3001/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"password123"}'
```

### Add Channel
```bash
curl -X POST http://localhost:3001/api/channels \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Test Channel","url":"https://example.com/stream.m3u8"}'
```

### Get Channels with API Key
```bash
curl http://localhost:3001/api/channels/public \
  -H "X-API-Key: iptv_..."
```

## Troubleshooting

### CORS Errors
- Check `CORS_ORIGINS` in backend `.env`
- Ensure frontend URL is listed

### Stripe Webhook Failures
- Verify webhook secret matches
- Check webhook endpoint URL
- Review Stripe Dashboard logs

### Database Locked
- SQLite WAL mode is enabled by default
- For high traffic, migrate to PostgreSQL

## Next Steps

1. Customize pricing in Stripe Dashboard
2. Add more channel metadata fields
3. Implement analytics/usage tracking
4. Add admin panel for user management
5. Set up monitoring and logging
