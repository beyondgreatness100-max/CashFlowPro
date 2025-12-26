// =====================================================
// BALANCES ROUTES
// =====================================================

import { Hono } from 'hono';

interface Env { DB: D1Database; }

export const balanceRoutes = new Hono<{ Bindings: Env }>();

// Get all balances for current user
balanceRoutes.get('/', async (c) => {
  const userId = c.get('userId');
  
  try {
    const balances = await c.env.DB.prepare(`
      SELECT 
        b.friend_id,
        b.group_id,
        SUM(b.amount) as amount,
        b.currency,
        u.name as friend_name,
        u.avatar_url as friend_avatar,
        g.name as group_name,
        g.icon as group_icon
      FROM balances b
      JOIN users u ON b.friend_id = u.id
      LEFT JOIN groups g ON b.group_id = g.id
      WHERE b.user_id = ?
      GROUP BY b.friend_id, b.group_id
      HAVING ABS(SUM(b.amount)) > 0.01
      ORDER BY ABS(SUM(b.amount)) DESC
    `).bind(userId).all();
    
    // Calculate totals
    let totalOwed = 0;  // Others owe me
    let totalOwe = 0;   // I owe others
    
    for (const b of balances.results as any[]) {
      if (b.amount > 0) totalOwed += b.amount;
      else totalOwe += Math.abs(b.amount);
    }
    
    return c.json({
      success: true,
      data: {
        balances: balances.results,
        summary: {
          totalOwed: Math.round(totalOwed * 100) / 100,
          totalOwe: Math.round(totalOwe * 100) / 100,
          netBalance: Math.round((totalOwed - totalOwe) * 100) / 100
        }
      }
    });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// Get balance with specific friend
balanceRoutes.get('/friend/:friendId', async (c) => {
  const userId = c.get('userId');
  const friendId = c.req.param('friendId');
  
  try {
    const balances = await c.env.DB.prepare(`
      SELECT 
        b.amount,
        b.group_id,
        g.name as group_name,
        g.icon as group_icon
      FROM balances b
      LEFT JOIN groups g ON b.group_id = g.id
      WHERE b.user_id = ? AND b.friend_id = ?
    `).bind(userId, friendId).all();
    
    const totalBalance = (balances.results as any[]).reduce((sum, b) => sum + b.amount, 0);
    
    return c.json({
      success: true,
      data: {
        totalBalance: Math.round(totalBalance * 100) / 100,
        byGroup: balances.results
      }
    });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// Get balances in a group
balanceRoutes.get('/group/:groupId', async (c) => {
  const userId = c.get('userId');
  const groupId = c.req.param('groupId');
  
  try {
    const balances = await c.env.DB.prepare(`
      SELECT 
        b.friend_id,
        b.amount,
        u.name as friend_name,
        u.avatar_url as friend_avatar
      FROM balances b
      JOIN users u ON b.friend_id = u.id
      WHERE b.user_id = ? AND b.group_id = ?
      ORDER BY b.amount DESC
    `).bind(userId, groupId).all();
    
    return c.json({ success: true, data: balances.results });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// =====================================================
// NOTIFICATIONS ROUTES
// =====================================================

export const notificationRoutes = new Hono<{ Bindings: Env }>();

// Get notifications
notificationRoutes.get('/', async (c) => {
  const userId = c.get('userId');
  const unreadOnly = c.req.query('unread') === 'true';
  const limit = parseInt(c.req.query('limit') || '50');
  
  try {
    let query = 'SELECT * FROM notifications WHERE user_id = ?';
    const params: any[] = [userId];
    
    if (unreadOnly) {
      query += ' AND is_read = 0';
    }
    
    query += ' ORDER BY created_at DESC LIMIT ?';
    params.push(limit);
    
    const notifications = await c.env.DB.prepare(query).bind(...params).all();
    
    // Get unread count
    const unreadCount = await c.env.DB.prepare(
      'SELECT COUNT(*) as count FROM notifications WHERE user_id = ? AND is_read = 0'
    ).bind(userId).first();
    
    return c.json({
      success: true,
      data: {
        notifications: notifications.results,
        unreadCount: unreadCount?.count || 0
      }
    });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// Mark as read
notificationRoutes.post('/:notificationId/read', async (c) => {
  const userId = c.get('userId');
  const notificationId = c.req.param('notificationId');
  
  try {
    await c.env.DB.prepare(`
      UPDATE notifications SET is_read = 1, read_at = datetime('now')
      WHERE id = ? AND user_id = ?
    `).bind(notificationId, userId).run();
    
    return c.json({ success: true });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// Mark all as read
notificationRoutes.post('/read-all', async (c) => {
  const userId = c.get('userId');
  
  try {
    await c.env.DB.prepare(`
      UPDATE notifications SET is_read = 1, read_at = datetime('now')
      WHERE user_id = ? AND is_read = 0
    `).bind(userId).run();
    
    return c.json({ success: true });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// Delete notification
notificationRoutes.delete('/:notificationId', async (c) => {
  const userId = c.get('userId');
  const notificationId = c.req.param('notificationId');
  
  try {
    await c.env.DB.prepare('DELETE FROM notifications WHERE id = ? AND user_id = ?').bind(notificationId, userId).run();
    return c.json({ success: true });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});
