// =====================================================
// SETTLEMENTS API ROUTES
// =====================================================

import { Hono } from 'hono';
import { nanoid } from 'nanoid';

interface Env {
  DB: D1Database;
  SPLITCOST_DO: DurableObjectNamespace;
}

export const settlementRoutes = new Hono<{ Bindings: Env }>();

// Get all settlements for user
settlementRoutes.get('/', async (c) => {
  const userId = c.get('userId');
  const status = c.req.query('status');
  const groupId = c.req.query('groupId');
  
  try {
    let query = `
      SELECT 
        s.*,
        u_from.name as from_name,
        u_from.avatar_url as from_avatar,
        u_to.name as to_name,
        u_to.avatar_url as to_avatar,
        g.name as group_name,
        g.icon as group_icon
      FROM settlements s
      JOIN users u_from ON s.from_user_id = u_from.id
      JOIN users u_to ON s.to_user_id = u_to.id
      LEFT JOIN groups g ON s.group_id = g.id
      WHERE (s.from_user_id = ? OR s.to_user_id = ?)
    `;
    
    const params: any[] = [userId, userId];
    
    if (status && status !== 'all') {
      query += ' AND s.status = ?';
      params.push(status);
    }
    
    if (groupId) {
      query += ' AND s.group_id = ?';
      params.push(groupId);
    }
    
    query += ' ORDER BY s.created_at DESC';
    
    const settlements = await c.env.DB.prepare(query).bind(...params).all();
    
    return c.json({ success: true, data: settlements.results });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// Create settlement
settlementRoutes.post('/', async (c) => {
  const userId = c.get('userId');
  const { toUserId, amount, groupId, currency = 'USD', currencySymbol = '$', paymentMethod, notes } = await c.req.json();
  
  if (!toUserId || !amount) {
    return c.json({ error: 'Missing required fields' }, 400);
  }
  
  try {
    const settlementId = nanoid();
    const now = new Date().toISOString();
    
    await c.env.DB.prepare(`
      INSERT INTO settlements (id, from_user_id, to_user_id, group_id, amount, currency, currency_symbol, payment_method, notes, status, settled_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    `).bind(settlementId, userId, toUserId, groupId || null, amount, currency, currencySymbol, paymentMethod || null, notes || null, now, now).run();
    
    const fromUser = await c.env.DB.prepare('SELECT name FROM users WHERE id = ?').bind(userId).first();
    
    // Notification
    const notifId = nanoid();
    await c.env.DB.prepare(`
      INSERT INTO notifications (id, user_id, type, title, message, reference_type, reference_id, created_at)
      VALUES (?, ?, 'settlement_request', ?, ?, 'settlement', ?, ?)
    `).bind(notifId, toUserId, 'Payment Received', `${fromUser?.name} paid you ${currencySymbol}${amount.toFixed(2)}`, settlementId, now).run();
    
    // Broadcast
    try {
      const doId = c.env.SPLITCOST_DO.idFromName(`user:${toUserId}`);
      const stub = c.env.SPLITCOST_DO.get(doId);
      await stub.fetch(new Request('http://internal/broadcast', {
        method: 'POST',
        body: JSON.stringify({ type: 'settlement_received', data: { settlementId, from: { id: userId, name: fromUser?.name }, amount, currencySymbol } })
      }));
    } catch (e) { console.error('Broadcast failed:', e); }
    
    return c.json({ success: true, data: { settlementId } });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// Confirm settlement
settlementRoutes.post('/:settlementId/confirm', async (c) => {
  const userId = c.get('userId');
  const settlementId = c.req.param('settlementId');
  
  try {
    const settlement = await c.env.DB.prepare(`SELECT * FROM settlements WHERE id = ? AND status = 'pending'`).bind(settlementId).first();
    
    if (!settlement) return c.json({ error: 'Settlement not found' }, 404);
    if (settlement.to_user_id !== userId) return c.json({ error: 'Not authorized' }, 403);
    
    const now = new Date().toISOString();
    await c.env.DB.prepare(`UPDATE settlements SET status = 'confirmed', confirmed_at = ? WHERE id = ?`).bind(now, settlementId).run();
    
    // Update balances
    const amount = settlement.amount as number;
    const fromUserId = settlement.from_user_id as string;
    const groupId = settlement.group_id as string | null;
    
    await c.env.DB.prepare(`
      UPDATE balances SET amount = amount - ?, last_updated = ?
      WHERE user_id = ? AND friend_id = ? AND (group_id = ? OR (? IS NULL AND group_id IS NULL))
    `).bind(amount, now, fromUserId, userId, groupId, groupId).run();
    
    await c.env.DB.prepare(`
      UPDATE balances SET amount = amount + ?, last_updated = ?
      WHERE user_id = ? AND friend_id = ? AND (group_id = ? OR (? IS NULL AND group_id IS NULL))
    `).bind(amount, now, userId, fromUserId, groupId, groupId).run();
    
    // Notify payer
    const receiver = await c.env.DB.prepare('SELECT name FROM users WHERE id = ?').bind(userId).first();
    const notifId = nanoid();
    await c.env.DB.prepare(`
      INSERT INTO notifications (id, user_id, type, title, message, reference_type, reference_id, created_at)
      VALUES (?, ?, 'settlement_confirmed', 'Payment Confirmed', ?, 'settlement', ?, ?)
    `).bind(notifId, fromUserId, `${receiver?.name} confirmed your payment`, settlementId, now).run();
    
    // Broadcast
    try {
      const doId = c.env.SPLITCOST_DO.idFromName(`user:${fromUserId}`);
      const stub = c.env.SPLITCOST_DO.get(doId);
      await stub.fetch(new Request('http://internal/broadcast', {
        method: 'POST',
        body: JSON.stringify({ type: 'settlement_confirmed', data: { settlementId } })
      }));
    } catch (e) { console.error('Broadcast failed:', e); }
    
    return c.json({ success: true, message: 'Settlement confirmed' });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// Reject settlement
settlementRoutes.post('/:settlementId/reject', async (c) => {
  const userId = c.get('userId');
  const settlementId = c.req.param('settlementId');
  
  try {
    const settlement = await c.env.DB.prepare(`SELECT * FROM settlements WHERE id = ? AND status = 'pending'`).bind(settlementId).first();
    if (!settlement) return c.json({ error: 'Settlement not found' }, 404);
    if (settlement.to_user_id !== userId) return c.json({ error: 'Not authorized' }, 403);
    
    await c.env.DB.prepare(`UPDATE settlements SET status = 'rejected' WHERE id = ?`).bind(settlementId).run();
    
    return c.json({ success: true, message: 'Settlement rejected' });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// Delete settlement
settlementRoutes.delete('/:settlementId', async (c) => {
  const userId = c.get('userId');
  const settlementId = c.req.param('settlementId');
  
  try {
    const settlement = await c.env.DB.prepare(`SELECT * FROM settlements WHERE id = ? AND status = 'pending'`).bind(settlementId).first();
    if (!settlement) return c.json({ error: 'Settlement not found' }, 404);
    if (settlement.from_user_id !== userId) return c.json({ error: 'Not authorized' }, 403);
    
    await c.env.DB.prepare('DELETE FROM settlements WHERE id = ?').bind(settlementId).run();
    
    return c.json({ success: true, message: 'Settlement cancelled' });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});
