# SplitCost Real-Time API

A complete real-time split cost/expense sharing system built with Cloudflare Workers, D1 (SQLite), and Durable Objects for WebSocket connections.

## Features

- 🔐 **Authentication** - JWT-based auth with registration/login
- 👥 **Friends** - Add friends, manage friend requests, track balances
- 👨‍👩‍👧‍👦 **Groups** - Create groups for trips, roommates, events
- 💰 **Expenses** - Split bills equally, by percentage, or custom amounts
- 💸 **Settlements** - Record and confirm payments
- ⚡ **Real-time** - WebSocket updates via Durable Objects
- 📊 **Smart Debt Simplification** - Minimize transactions needed

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Cloudflare Edge                          │
├─────────────────────────────────────────────────────────────┤
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐  │
│  │   Worker    │  │     D1      │  │  Durable Objects    │  │
│  │  (Hono)     │◄─┤  Database   │  │   (WebSockets)      │  │
│  │  REST API   │  │  (SQLite)   │  │   Real-time sync    │  │
│  └─────────────┘  └─────────────┘  └─────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

## Setup

### 1. Prerequisites

```bash
npm install -g wrangler
wrangler login
```

### 2. Install Dependencies

```bash
npm install
```

### 3. Create D1 Database

```bash
wrangler d1 create splitcost-db
```

Copy the database_id from the output and update `wrangler.toml`.

### 4. Run Migrations

```bash
# Local development
wrangler d1 execute splitcost-db --local --file=./schema.sql

# Production
wrangler d1 execute splitcost-db --file=./schema.sql --remote
```

### 5. Set JWT Secret

```bash
wrangler secret put JWT_SECRET
# Enter a secure random string
```

### 6. Development

```bash
npm run dev
# API available at http://localhost:8787
```

### 7. Deploy

```bash
npm run deploy
```

## API Endpoints

### Authentication
- `POST /api/auth/register` - Register new user
- `POST /api/auth/login` - Login

### Users
- `GET /api/users/me` - Get profile
- `PUT /api/users/me` - Update profile
- `GET /api/users/search?q=` - Search users

### Friends
- `GET /api/friends` - List friends
- `GET /api/friends/pending` - Pending requests
- `POST /api/friends/request` - Send request
- `POST /api/friends/accept/:id` - Accept request
- `DELETE /api/friends/:id` - Remove friend
- `GET /api/friends/:id/balance` - Balance with friend

### Groups
- `GET /api/groups` - List groups
- `GET /api/groups/:id` - Group details
- `POST /api/groups` - Create group
- `PUT /api/groups/:id` - Update group
- `POST /api/groups/:id/members` - Add member
- `DELETE /api/groups/:id/members/:memberId` - Remove member
- `GET /api/groups/:id/balances` - Group balances
- `GET /api/groups/:id/activities` - Activity feed

### Expenses
- `GET /api/expenses` - List expenses
- `GET /api/expenses/:id` - Expense details
- `POST /api/expenses` - Create expense
- `PUT /api/expenses/:id` - Update expense
- `DELETE /api/expenses/:id` - Delete expense
- `POST /api/expenses/:id/comments` - Add comment

### Settlements
- `GET /api/settlements` - List settlements
- `POST /api/settlements` - Record payment
- `POST /api/settlements/:id/confirm` - Confirm receipt
- `POST /api/settlements/:id/reject` - Reject payment

### Balances
- `GET /api/balances` - All balances
- `GET /api/balances/friend/:id` - Balance with friend
- `GET /api/balances/group/:id` - Group balances

### Notifications
- `GET /api/notifications` - List notifications
- `POST /api/notifications/:id/read` - Mark as read
- `POST /api/notifications/read-all` - Mark all read

## WebSocket Events

### Connect
```javascript
const client = new SplitCostClient({ token: 'your-jwt' });
client.connect('group-id'); // Connect to group
// or
client.connect(); // Connect to user notifications
```

### Events
- `connected` - Successfully connected
- `disconnected` - Disconnected
- `expense_added` - New expense created
- `expense_updated` - Expense modified
- `expense_deleted` - Expense removed
- `settlement_added` - New settlement
- `settlement_confirmed` - Payment confirmed
- `comment_added` - New comment
- `member_joined` - User joined group
- `member_left` - User left group
- `friend_request` - New friend request
- `friend_accepted` - Friend request accepted

### Example
```javascript
client.on('expense_added', ({ data }) => {
  console.log('New expense:', data);
  // Update UI
});
```

## Client Usage

```javascript
// Initialize
const client = new SplitCostClient({
  baseUrl: 'https://api.splitcost.app',
  wsUrl: 'wss://api.splitcost.app'
});

// Login
await client.login('email@example.com', 'password');

// Create expense
await client.createExpense({
  description: 'Dinner',
  amount: 60.00,
  groupId: 'group-123',
  splits: [
    { userId: 'user-1', amount: 20 },
    { userId: 'user-2', amount: 20 },
    { userId: 'user-3', amount: 20 }
  ]
});

// Connect to real-time updates
client.connect('group-123');

client.on('expense_added', ({ data }) => {
  console.log('New expense!', data);
});

// Record settlement
await client.createSettlement({
  toUserId: 'user-1',
  amount: 20.00,
  groupId: 'group-123'
});
```

## Database Schema

See `schema.sql` for complete database schema including:
- `users` - User accounts
- `friendships` - Friend connections
- `groups` - Expense groups
- `group_members` - Group membership
- `expenses` - Expense records
- `expense_splits` - Who owes what
- `settlements` - Payment records
- `balances` - Cached balance calculations
- `activities` - Activity feed
- `notifications` - User notifications

## Currencies Supported

The system supports any currency. Defaults include all Gulf and Middle East currencies:
- AED, SAR, OMR, KWD, QAR, BHD (Gulf)
- EGP, IQD, JOD, LBP, SYP, ILS, YER (Middle East)
- TND, MAD, DZD, LYD, SDG (North Africa)
- USD, EUR, GBP, TRY, INR, PKR (International)

## License

MIT
