// =====================================================
// FRIENDS API ROUTES
// =====================================================

import { Hono } from 'hono';
import { nanoid } from 'nanoid';

interface Env {
  DB: D1Database;
  SPLITCOST_DO: DurableObjectNamespace;
}

export const friendRoutes = new Hono<{ Bindings: Env }>();

// Get all friends for current user
friendRoutes.get('/', async (c) => {
  const userId = c.get('userId');
  
  try {
    const friends = await c.env.DB.prepare(`
      SELECT 
        u.id,
        u.name,
        u.email,
        u.avatar_url,
        u.phone,
        f.status,
        f.nickname,
        f.created_at,
        f.accepted_at,
        COALESCE(b.amount, 0) as balance
      FROM friendships f
      JOIN users u ON (
        CASE 
          WHEN f.user_id = ? THEN f.friend_id = u.id
          ELSE f.user_id = u.id
        END
      )
      LEFT JOIN balances b ON (
        (b.user_id = ? AND b.friend_id = u.id AND b.group_id IS NULL)
      )
      WHERE (f.user_id = ? OR f.friend_id = ?)
        AND f.status = 'accepted'
      ORDER BY u.name ASC
    `).bind(userId, userId, userId, userId).all();
    
    return c.json({
      success: true,
      data: friends.results
    });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// Get pending friend requests
friendRoutes.get('/pending', async (c) => {
  const userId = c.get('userId');
  
  try {
    // Incoming requests
    const incoming = await c.env.DB.prepare(`
      SELECT 
        f.id as request_id,
        u.id,
        u.name,
        u.email,
        u.avatar_url,
        f.created_at,
        'incoming' as direction
      FROM friendships f
      JOIN users u ON f.user_id = u.id
      WHERE f.friend_id = ? AND f.status = 'pending'
      ORDER BY f.created_at DESC
    `).bind(userId).all();
    
    // Outgoing requests
    const outgoing = await c.env.DB.prepare(`
      SELECT 
        f.id as request_id,
        u.id,
        u.name,
        u.email,
        u.avatar_url,
        f.created_at,
        'outgoing' as direction
      FROM friendships f
      JOIN users u ON f.friend_id = u.id
      WHERE f.user_id = ? AND f.status = 'pending'
      ORDER BY f.created_at DESC
    `).bind(userId).all();
    
    return c.json({
      success: true,
      data: {
        incoming: incoming.results,
        outgoing: outgoing.results
      }
    });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// Send friend request
friendRoutes.post('/request', async (c) => {
  const userId = c.get('userId');
  const { email, phone } = await c.req.json();
  
  if (!email && !phone) {
    return c.json({ error: 'Email or phone required' }, 400);
  }
  
  try {
    // Find user by email or phone
    let friend;
    if (email) {
      friend = await c.env.DB.prepare(
        'SELECT id, name, email FROM users WHERE email = ?'
      ).bind(email.toLowerCase()).first();
    } else {
      friend = await c.env.DB.prepare(
        'SELECT id, name, email FROM users WHERE phone = ?'
      ).bind(phone).first();
    }
    
    if (!friend) {
      return c.json({ error: 'User not found' }, 404);
    }
    
    if (friend.id === odId) {
      return c.json({ error: 'Cannot add yourself as a friend' }, 400);
    }
    
    // Check if friendship already exists
    const existing = await c.env.DB.prepare(`
      SELECT id, status FROM friendships 
      WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)
    `).bind(userId, friend.id, friend.id, userId).first();
    
    if (existing) {
      if (existing.status === 'accepted') {
        return c.json({ error: 'Already friends' }, 400);
      }
      if (existing.status === 'pending') {
        return c.json({ error: 'Friend request already pending' }, 400);
      }
      if (existing.status === 'blocked') {
        return c.json({ error: 'Cannot send request' }, 400);
      }
    }
    
    // Create friend request
    const requestId = nanoid();
    await c.env.DB.prepare(`
      INSERT INTO friendships (id, user_id, friend_id, status, created_at)
      VALUES (?, ?, ?, 'pending', datetime('now'))
    `).bind(requestId, userId, friend.id).run();
    
    // Create notification for the friend
    const notifId = nanoid();
    const currentUser = await c.env.DB.prepare(
      'SELECT name FROM users WHERE id = ?'
    ).bind(userId).first();
    
    await c.env.DB.prepare(`
      INSERT INTO notifications (id, user_id, type, title, message, reference_type, reference_id, created_at)
      VALUES (?, ?, 'friend_request', ?, ?, 'friendship', ?, datetime('now'))
    `).bind(
      notifId, 
      friend.id, 
      'New Friend Request',
      `${currentUser?.name || 'Someone'} wants to be your friend`,
      requestId
    ).run();
    
    // Broadcast to friend's WebSocket
    try {
      const doId = c.env.SPLITCOST_DO.idFromName(`user:${friend.id}`);
      const stub = c.env.SPLITCOST_DO.get(doId);
      await stub.fetch(new Request('http://internal/broadcast', {
        method: 'POST',
        body: JSON.stringify({
          type: 'friend_request',
          data: {
            requestId,
            from: {
              id: userId,
              name: currentUser?.name
            }
          }
        })
      }));
    } catch (e) {
      console.error('Failed to broadcast:', e);
    }
    
    return c.json({
      success: true,
      data: {
        requestId,
        friend: {
          id: friend.id,
          name: friend.name,
          email: friend.email
        }
      }
    });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// Accept friend request
friendRoutes.post('/accept/:requestId', async (c) => {
  const userId = c.get('userId');
  const requestId = c.req.param('requestId');
  
  try {
    // Get the request
    const request = await c.env.DB.prepare(`
      SELECT * FROM friendships WHERE id = ? AND friend_id = ? AND status = 'pending'
    `).bind(requestId, userId).first();
    
    if (!request) {
      return c.json({ error: 'Request not found' }, 404);
    }
    
    // Update status
    await c.env.DB.prepare(`
      UPDATE friendships 
      SET status = 'accepted', accepted_at = datetime('now')
      WHERE id = ?
    `).bind(requestId).run();
    
    // Initialize balance records
    const balanceId1 = nanoid();
    const balanceId2 = nanoid();
    
    await c.env.DB.batch([
      c.env.DB.prepare(`
        INSERT OR IGNORE INTO balances (id, user_id, friend_id, amount, last_updated)
        VALUES (?, ?, ?, 0, datetime('now'))
      `).bind(balanceId1, userId, request.user_id),
      c.env.DB.prepare(`
        INSERT OR IGNORE INTO balances (id, user_id, friend_id, amount, last_updated)
        VALUES (?, ?, ?, 0, datetime('now'))
      `).bind(balanceId2, request.user_id, userId)
    ]);
    
    // Notify the requester
    const notifId = nanoid();
    const currentUser = await c.env.DB.prepare(
      'SELECT name FROM users WHERE id = ?'
    ).bind(userId).first();
    
    await c.env.DB.prepare(`
      INSERT INTO notifications (id, user_id, type, title, message, reference_type, reference_id, created_at)
      VALUES (?, ?, 'friend_accepted', ?, ?, 'friendship', ?, datetime('now'))
    `).bind(
      notifId,
      request.user_id,
      'Friend Request Accepted',
      `${currentUser?.name || 'Someone'} accepted your friend request`,
      requestId
    ).run();
    
    // Broadcast to requester
    try {
      const doId = c.env.SPLITCOST_DO.idFromName(`user:${request.user_id}`);
      const stub = c.env.SPLITCOST_DO.get(doId);
      await stub.fetch(new Request('http://internal/broadcast', {
        method: 'POST',
        body: JSON.stringify({
          type: 'friend_accepted',
          data: {
            requestId,
            friend: {
              id: userId,
              name: currentUser?.name
            }
          }
        })
      }));
    } catch (e) {
      console.error('Failed to broadcast:', e);
    }
    
    return c.json({
      success: true,
      message: 'Friend request accepted'
    });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// Reject/Cancel friend request
friendRoutes.delete('/request/:requestId', async (c) => {
  const userId = c.get('userId');
  const requestId = c.req.param('requestId');
  
  try {
    // Check if user is part of this request
    const request = await c.env.DB.prepare(`
      SELECT * FROM friendships 
      WHERE id = ? AND (user_id = ? OR friend_id = ?) AND status = 'pending'
    `).bind(requestId, userId, userId).first();
    
    if (!request) {
      return c.json({ error: 'Request not found' }, 404);
    }
    
    // Delete the request
    await c.env.DB.prepare('DELETE FROM friendships WHERE id = ?').bind(requestId).run();
    
    return c.json({
      success: true,
      message: 'Friend request removed'
    });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// Remove friend
friendRoutes.delete('/:friendId', async (c) => {
  const userId = c.get('userId');
  const friendId = c.req.param('friendId');
  
  try {
    // Delete friendship
    await c.env.DB.prepare(`
      DELETE FROM friendships 
      WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)
    `).bind(userId, friendId, friendId, userId).run();
    
    // Delete balance records
    await c.env.DB.prepare(`
      DELETE FROM balances 
      WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)
    `).bind(userId, friendId, friendId, userId).run();
    
    return c.json({
      success: true,
      message: 'Friend removed'
    });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// Get balance with specific friend
friendRoutes.get('/:friendId/balance', async (c) => {
  const userId = c.get('userId');
  const friendId = c.req.param('friendId');
  
  try {
    // Get overall balance
    const balance = await c.env.DB.prepare(`
      SELECT amount, currency, last_updated
      FROM balances
      WHERE user_id = ? AND friend_id = ? AND group_id IS NULL
    `).bind(userId, friendId).first();
    
    // Get balance breakdown by group
    const groupBalances = await c.env.DB.prepare(`
      SELECT 
        b.amount,
        b.currency,
        g.id as group_id,
        g.name as group_name,
        g.icon as group_icon
      FROM balances b
      LEFT JOIN groups g ON b.group_id = g.id
      WHERE b.user_id = ? AND b.friend_id = ? AND b.group_id IS NOT NULL
    `).bind(userId, friendId).all();
    
    // Get recent activity
    const recentActivity = await c.env.DB.prepare(`
      SELECT 
        e.id,
        e.description,
        e.amount,
        e.currency_symbol,
        e.paid_by,
        e.created_at,
        es.amount as split_amount
      FROM expenses e
      JOIN expense_splits es ON e.id = es.expense_id
      WHERE (e.paid_by = ? AND es.user_id = ?) OR (e.paid_by = ? AND es.user_id = ?)
      ORDER BY e.created_at DESC
      LIMIT 10
    `).bind(userId, friendId, friendId, userId).all();
    
    return c.json({
      success: true,
      data: {
        totalBalance: balance?.amount || 0,
        currency: balance?.currency || 'USD',
        lastUpdated: balance?.last_updated,
        groupBalances: groupBalances.results,
        recentActivity: recentActivity.results
      }
    });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// Update friend nickname
friendRoutes.patch('/:friendId/nickname', async (c) => {
  const userId = c.get('userId');
  const friendId = c.req.param('friendId');
  const { nickname } = await c.req.json();
  
  try {
    await c.env.DB.prepare(`
      UPDATE friendships 
      SET nickname = ?
      WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)
    `).bind(nickname, userId, friendId, friendId, userId).run();
    
    return c.json({
      success: true,
      message: 'Nickname updated'
    });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});
