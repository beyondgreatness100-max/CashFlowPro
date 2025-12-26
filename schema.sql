-- =====================================================
-- SPLITCOST REAL-TIME DATABASE SCHEMA
-- Cloudflare D1 (SQLite-compatible)
-- =====================================================

-- Users table
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    avatar_url TEXT,
    phone TEXT,
    currency TEXT DEFAULT 'USD',
    currency_symbol TEXT DEFAULT '$',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
    push_token TEXT,
    is_active BOOLEAN DEFAULT 1
);

-- Friends/Connections table
CREATE TABLE IF NOT EXISTS friendships (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    friend_id TEXT NOT NULL,
    status TEXT DEFAULT 'pending', -- pending, accepted, blocked
    nickname TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    accepted_at DATETIME,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (friend_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE(user_id, friend_id)
);

-- Groups table
CREATE TABLE IF NOT EXISTS groups (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    icon TEXT DEFAULT '👥',
    cover_image_url TEXT,
    created_by TEXT NOT NULL,
    group_type TEXT DEFAULT 'general', -- general, trip, home, couple, event
    currency TEXT DEFAULT 'USD',
    currency_symbol TEXT DEFAULT '$',
    is_active BOOLEAN DEFAULT 1,
    simplify_debts BOOLEAN DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE
);

-- Group members table
CREATE TABLE IF NOT EXISTS group_members (
    id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    role TEXT DEFAULT 'member', -- admin, member
    joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    left_at DATETIME,
    is_active BOOLEAN DEFAULT 1,
    FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE(group_id, user_id)
);

-- Expenses table
CREATE TABLE IF NOT EXISTS expenses (
    id TEXT PRIMARY KEY,
    group_id TEXT,
    description TEXT NOT NULL,
    amount REAL NOT NULL,
    currency TEXT DEFAULT 'USD',
    currency_symbol TEXT DEFAULT '$',
    category TEXT DEFAULT 'general',
    paid_by TEXT NOT NULL,
    split_type TEXT DEFAULT 'equal', -- equal, exact, percentage, shares
    receipt_url TEXT,
    notes TEXT,
    expense_date DATE DEFAULT CURRENT_DATE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    deleted_at DATETIME,
    is_deleted BOOLEAN DEFAULT 0,
    FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE SET NULL,
    FOREIGN KEY (paid_by) REFERENCES users(id) ON DELETE CASCADE
);

-- Expense splits (who owes what)
CREATE TABLE IF NOT EXISTS expense_splits (
    id TEXT PRIMARY KEY,
    expense_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    amount REAL NOT NULL,
    percentage REAL,
    shares INTEGER,
    is_paid BOOLEAN DEFAULT 0,
    paid_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (expense_id) REFERENCES expenses(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE(expense_id, user_id)
);

-- Settlements/Payments table
CREATE TABLE IF NOT EXISTS settlements (
    id TEXT PRIMARY KEY,
    from_user_id TEXT NOT NULL,
    to_user_id TEXT NOT NULL,
    group_id TEXT,
    amount REAL NOT NULL,
    currency TEXT DEFAULT 'USD',
    currency_symbol TEXT DEFAULT '$',
    payment_method TEXT, -- cash, bank, venmo, paypal, etc.
    notes TEXT,
    status TEXT DEFAULT 'pending', -- pending, confirmed, rejected
    settled_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    confirmed_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (from_user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (to_user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE SET NULL
);

-- Balances cache (for quick lookups)
CREATE TABLE IF NOT EXISTS balances (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    friend_id TEXT NOT NULL,
    group_id TEXT,
    amount REAL NOT NULL DEFAULT 0, -- positive = friend owes user, negative = user owes friend
    currency TEXT DEFAULT 'USD',
    last_updated DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (friend_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE,
    UNIQUE(user_id, friend_id, group_id)
);

-- Activity/Chat messages table
CREATE TABLE IF NOT EXISTS activities (
    id TEXT PRIMARY KEY,
    group_id TEXT,
    user_id TEXT NOT NULL,
    activity_type TEXT NOT NULL, -- expense_added, expense_updated, expense_deleted, settlement, member_joined, member_left, comment
    reference_id TEXT, -- expense_id or settlement_id
    message TEXT,
    metadata TEXT, -- JSON for additional data
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Comments on expenses
CREATE TABLE IF NOT EXISTS comments (
    id TEXT PRIMARY KEY,
    expense_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    is_deleted BOOLEAN DEFAULT 0,
    FOREIGN KEY (expense_id) REFERENCES expenses(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Notifications table
CREATE TABLE IF NOT EXISTS notifications (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    type TEXT NOT NULL, -- expense_added, settlement_request, settlement_confirmed, reminder, group_invite
    title TEXT NOT NULL,
    message TEXT,
    reference_type TEXT, -- expense, settlement, group
    reference_id TEXT,
    is_read BOOLEAN DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    read_at DATETIME,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Invites table (for inviting non-users)
CREATE TABLE IF NOT EXISTS invites (
    id TEXT PRIMARY KEY,
    inviter_id TEXT NOT NULL,
    group_id TEXT,
    email TEXT,
    phone TEXT,
    invite_code TEXT UNIQUE NOT NULL,
    status TEXT DEFAULT 'pending', -- pending, accepted, expired
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME,
    accepted_at DATETIME,
    accepted_by TEXT,
    FOREIGN KEY (inviter_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE SET NULL,
    FOREIGN KEY (accepted_by) REFERENCES users(id) ON DELETE SET NULL
);

-- =====================================================
-- INDEXES FOR PERFORMANCE
-- =====================================================

CREATE INDEX IF NOT EXISTS idx_friendships_user ON friendships(user_id);
CREATE INDEX IF NOT EXISTS idx_friendships_friend ON friendships(friend_id);
CREATE INDEX IF NOT EXISTS idx_friendships_status ON friendships(status);

CREATE INDEX IF NOT EXISTS idx_group_members_group ON group_members(group_id);
CREATE INDEX IF NOT EXISTS idx_group_members_user ON group_members(user_id);

CREATE INDEX IF NOT EXISTS idx_expenses_group ON expenses(group_id);
CREATE INDEX IF NOT EXISTS idx_expenses_paid_by ON expenses(paid_by);
CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(expense_date);
CREATE INDEX IF NOT EXISTS idx_expenses_deleted ON expenses(is_deleted);

CREATE INDEX IF NOT EXISTS idx_expense_splits_expense ON expense_splits(expense_id);
CREATE INDEX IF NOT EXISTS idx_expense_splits_user ON expense_splits(user_id);

CREATE INDEX IF NOT EXISTS idx_settlements_from ON settlements(from_user_id);
CREATE INDEX IF NOT EXISTS idx_settlements_to ON settlements(to_user_id);
CREATE INDEX IF NOT EXISTS idx_settlements_group ON settlements(group_id);

CREATE INDEX IF NOT EXISTS idx_balances_user ON balances(user_id);
CREATE INDEX IF NOT EXISTS idx_balances_friend ON balances(friend_id);
CREATE INDEX IF NOT EXISTS idx_balances_group ON balances(group_id);

CREATE INDEX IF NOT EXISTS idx_activities_group ON activities(group_id);
CREATE INDEX IF NOT EXISTS idx_activities_user ON activities(user_id);
CREATE INDEX IF NOT EXISTS idx_activities_created ON activities(created_at);

CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_read ON notifications(is_read);

-- =====================================================
-- VIEWS FOR COMMON QUERIES
-- =====================================================

-- View: Total balance between users (across all groups)
CREATE VIEW IF NOT EXISTS v_total_balances AS
SELECT 
    user_id,
    friend_id,
    SUM(amount) as total_balance,
    currency
FROM balances
GROUP BY user_id, friend_id, currency;

-- View: Group summaries
CREATE VIEW IF NOT EXISTS v_group_summaries AS
SELECT 
    g.id,
    g.name,
    g.icon,
    g.currency_symbol,
    COUNT(DISTINCT gm.user_id) as member_count,
    COALESCE(SUM(e.amount), 0) as total_expenses,
    g.created_at
FROM groups g
LEFT JOIN group_members gm ON g.id = gm.group_id AND gm.is_active = 1
LEFT JOIN expenses e ON g.id = e.group_id AND e.is_deleted = 0
WHERE g.is_active = 1
GROUP BY g.id;

-- View: User's pending settlements
CREATE VIEW IF NOT EXISTS v_pending_settlements AS
SELECT 
    s.*,
    u_from.name as from_name,
    u_to.name as to_name,
    g.name as group_name
FROM settlements s
JOIN users u_from ON s.from_user_id = u_from.id
JOIN users u_to ON s.to_user_id = u_to.id
LEFT JOIN groups g ON s.group_id = g.id
WHERE s.status = 'pending';
