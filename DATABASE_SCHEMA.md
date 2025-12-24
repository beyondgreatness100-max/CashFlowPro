# SplitCost Database Schema

## Overview
This document describes the Firestore database schema for the SplitCost real-time expense splitting application.

---

## Collections Structure

### 1. `users` Collection
Stores user profile information.

```javascript
users/{userId}
{
    id: string,              // Firebase Auth UID
    email: string,           // User's email
    displayName: string,     // Display name
    photoURL: string,        // Profile photo URL (optional)
    createdAt: timestamp,    // Account creation date
    updatedAt: timestamp,    // Last update date
    settings: {
        currency: string,    // Preferred currency (USD, EUR, etc.)
        theme: string        // UI theme preference
    }
}
```

### 2. `friends` Collection
Stores friendship relationships between users.

```javascript
friends/{friendshipId}
{
    id: string,              // Auto-generated ID
    users: [userId1, userId2], // Array of two user IDs
    status: string,          // "pending" | "accepted" | "blocked"
    requestedBy: string,     // User ID who sent the request
    createdAt: timestamp,
    updatedAt: timestamp
}
```

### 3. `groups` Collection
Stores expense sharing groups.

```javascript
groups/{groupId}
{
    id: string,              // Auto-generated ID
    name: string,            // Group name
    icon: string,            // Emoji icon
    description: string,     // Group description (optional)
    createdBy: string,       // User ID of creator
    members: [{
        id: string,          // User ID
        displayName: string, // Cached display name
        email: string,       // Cached email
        role: string,        // "admin" | "member"
        joinedAt: timestamp
    }],
    memberIds: [string],     // Array of member IDs (for queries)
    totalExpenses: number,   // Running total of all expenses
    currency: string,        // Group's currency
    createdAt: timestamp,
    updatedAt: timestamp,
    isActive: boolean        // Soft delete flag
}
```

### 4. `expenses` Collection
Stores individual expenses within groups.

```javascript
expenses/{expenseId}
{
    id: string,              // Auto-generated ID
    groupId: string,         // Reference to group
    description: string,     // What was the expense for
    amount: number,          // Total amount
    currency: string,        // Currency code
    paidBy: {
        userId: string,      // Who paid
        displayName: string  // Cached name
    },
    splitMethod: string,     // "equal" | "exact" | "percentage" | "shares"
    splits: [{
        userId: string,      // User ID
        displayName: string, // Cached name
        amount: number,      // Amount owed
        percentage: number,  // If percentage split
        shares: number,      // If shares split
        isPaid: boolean      // Settlement status
    }],
    category: string,        // Expense category
    receipt: string,         // Receipt image URL (optional)
    notes: string,           // Additional notes
    date: timestamp,         // Expense date
    createdBy: string,       // User who added the expense
    createdAt: timestamp,
    updatedAt: timestamp,
    isDeleted: boolean       // Soft delete flag
}
```

### 5. `settlements` Collection
Tracks payments between users to settle debts.

```javascript
settlements/{settlementId}
{
    id: string,              // Auto-generated ID
    groupId: string,         // Reference to group (optional, can be direct)
    fromUser: {
        userId: string,
        displayName: string
    },
    toUser: {
        userId: string,
        displayName: string
    },
    amount: number,          // Settlement amount
    currency: string,
    method: string,          // "cash" | "bank" | "venmo" | "paypal" | "other"
    note: string,            // Optional note
    confirmedByReceiver: boolean, // Receiver confirmation
    createdAt: timestamp,
    confirmedAt: timestamp   // When receiver confirmed
}
```

### 6. `activities` Collection
Stores activity feed for real-time updates.

```javascript
activities/{activityId}
{
    id: string,              // Auto-generated ID
    groupId: string,         // Reference to group
    type: string,            // "expense_added" | "expense_updated" | "settlement" | "member_joined" | "member_left"
    actor: {
        userId: string,
        displayName: string
    },
    data: object,            // Type-specific data
    message: string,         // Human-readable message
    createdAt: timestamp,
    readBy: [string]         // Array of user IDs who have read this
}
```

### 7. `balances` Collection (Denormalized for Performance)
Pre-calculated balances for quick access.

```javascript
balances/{balanceId}  // balanceId = `${groupId}_${userId}`
{
    groupId: string,
    userId: string,
    displayName: string,
    totalPaid: number,       // Total amount paid by user
    totalOwed: number,       // Total amount user owes
    netBalance: number,      // totalPaid - totalOwed (positive = owed to user)
    updatedAt: timestamp
}
```

---

## Firestore Security Rules

```javascript
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    
    // Users can read/write their own profile
    match /users/{userId} {
      allow read: if request.auth != null;
      allow write: if request.auth.uid == userId;
    }
    
    // Friends - users can manage their own friendships
    match /friends/{friendshipId} {
      allow read: if request.auth.uid in resource.data.users;
      allow create: if request.auth.uid in request.resource.data.users;
      allow update, delete: if request.auth.uid in resource.data.users;
    }
    
    // Groups - only members can access
    match /groups/{groupId} {
      allow read: if request.auth.uid in resource.data.memberIds;
      allow create: if request.auth.uid == request.resource.data.createdBy;
      allow update: if request.auth.uid in resource.data.memberIds;
      allow delete: if request.auth.uid == resource.data.createdBy;
    }
    
    // Expenses - only group members can access
    match /expenses/{expenseId} {
      allow read: if request.auth.uid in get(/databases/$(database)/documents/groups/$(resource.data.groupId)).data.memberIds;
      allow create: if request.auth.uid in get(/databases/$(database)/documents/groups/$(request.resource.data.groupId)).data.memberIds;
      allow update, delete: if request.auth.uid == resource.data.createdBy || 
                              request.auth.uid in get(/databases/$(database)/documents/groups/$(resource.data.groupId)).data.memberIds;
    }
    
    // Settlements - involved users can access
    match /settlements/{settlementId} {
      allow read: if request.auth.uid == resource.data.fromUser.userId || 
                    request.auth.uid == resource.data.toUser.userId;
      allow create: if request.auth.uid == request.resource.data.fromUser.userId;
      allow update: if request.auth.uid == resource.data.fromUser.userId || 
                      request.auth.uid == resource.data.toUser.userId;
    }
    
    // Activities - group members can read
    match /activities/{activityId} {
      allow read: if request.auth.uid in get(/databases/$(database)/documents/groups/$(resource.data.groupId)).data.memberIds;
      allow create: if request.auth != null;
    }
    
    // Balances - group members can read
    match /balances/{balanceId} {
      allow read: if request.auth.uid == resource.data.userId;
      allow write: if false; // Only updated by Cloud Functions
    }
  }
}
```

---

## Realtime Database Structure (for Presence & Typing)

```javascript
/presence/{groupId}/{oderId}
{
    oderId: string,
    displayName: string,
    online: boolean,
    lastSeen: timestamp
}

/typing/{groupId}/{oderId}
{
    isTyping: boolean,
    timestamp: number
}
```

---

## Indexes Required

Create these composite indexes in Firebase Console:

1. **expenses** - groupId (ASC), createdAt (DESC)
2. **expenses** - groupId (ASC), date (DESC)
3. **activities** - groupId (ASC), createdAt (DESC)
4. **friends** - users (ARRAY_CONTAINS), status (ASC)
5. **settlements** - groupId (ASC), createdAt (DESC)

---

## Cloud Functions (Optional - for advanced features)

### 1. `onExpenseCreated`
- Recalculates balances for all group members
- Creates activity entry
- Sends push notifications

### 2. `onSettlementCreated`
- Updates balances
- Creates activity entry
- Notifies receiver

### 3. `onUserDeleted`
- Cleans up user data
- Removes from groups
- Anonymizes historical data

---

## Data Flow Examples

### Adding an Expense
1. User creates expense in `expenses` collection
2. Cloud Function triggers on create
3. Function calculates new balances
4. Function updates `balances` collection
5. Function creates `activities` entry
6. Real-time listeners update all group members' UIs

### Settling Up
1. User creates settlement in `settlements` collection
2. Update related expense splits to `isPaid: true`
3. Cloud Function recalculates balances
4. Activity created and pushed to group members
