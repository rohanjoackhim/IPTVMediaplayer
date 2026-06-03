# IPTV Backend API

Backend API for the Television tab with payment integration. Allows users to purchase API keys and add streaming channels that can be played in the IPTV player.

## Features

- **User Authentication**: JWT-based auth with email/password
- **API Key Management**: Generate and manage API keys for channel access
- **Channel Management**: CRUD operations for streaming channels
- **Payment Integration**: Stripe integration for subscription payments
- **Security**: Rate limiting, Helmet headers, CORS protection

## Quick Start

1. **Install dependencies**:
```bash
cd backend
npm install
```

2. **Set up environment variables**:
```bash
cp .env.example .env
# Edit .env with your Stripe keys and JWT secret
```

3. **Initialize database**:
```bash
npm run db:init
```

4. **Start development server**:
```bash
npm run dev
```

5. **Build for production**:
```bash
npm run build
npm start
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Server port | 3001 |
| `DATABASE_PATH` | SQLite database file path | ./data/iptv.db |
| `JWT_SECRET` | Secret for JWT signing | (required) |
| `STRIPE_SECRET_KEY` | Stripe secret key | (required) |
| `STRIPE_PUBLISHABLE_KEY` | Stripe publishable key | (required) |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook secret | (required) |
| `PRICE_MONTHLY` | Monthly subscription price in cents | 999 |
| `PRICE_YEARLY` | Yearly subscription price in cents | 9999 |
| `CORS_ORIGINS` | Comma-separated allowed origins | http://localhost:5173 |

## API Endpoints

### Authentication
- `POST /api/auth/register` - Register new user
- `POST /api/auth/login` - Login
- `GET /api/auth/me` - Get current user (requires auth)

### Channels
- `GET /api/channels` - List user's channels (requires auth)
- `GET /api/channels/public` - List channels by API key (requires API key)
- `GET /api/channels/:id` - Get channel details (requires auth)
- `POST /api/channels` - Create channel (requires auth)
- `PUT /api/channels/:id` - Update channel (requires auth)
- `DELETE /api/channels/:id` - Delete channel (requires auth)

### Payments
- `POST /api/payments/create-intent` - Create Stripe payment intent (requires auth)
- `GET /api/payments/subscription` - Get subscription status (requires auth)
- `GET /api/payments/history` - Get payment history (requires auth)
- `POST /api/payments/webhook` - Stripe webhook

### API Keys
- `GET /api/keys` - List API keys (requires auth)
- `POST /api/keys` - Create new API key (requires auth)
- `DELETE /api/keys/:id` - Revoke API key (requires auth)
- `PATCH /api/keys/:id/toggle` - Toggle API key status (requires auth)

## Channel Data Structure

```json
{
  "id": "uuid",
  "name": "Channel Name",
  "url": "https://stream-url.com/live.m3u8",
  "logo": "https://logo-url.com/logo.png",
  "group": "Sports",
  "country": "US",
  "language": "English",
  "category": "Live TV",
  "content_type": "live",
  "is_active": true
}
```

## Player Integration

To use channels from a user's account in the player:

1. User provides their API key in the Television tab
2. Player makes request to `GET /api/channels/public` with header `X-API-Key: <api-key>`
3. Channels are returned and can be played

## Payment Flow

1. Frontend calls `POST /api/payments/create-intent` with period (monthly/yearly)
2. Backend creates Stripe PaymentIntent and returns `clientSecret`
3. Frontend uses Stripe.js to confirm payment
4. Stripe webhook updates user's subscription status
5. User can now create and manage channels
