// =====================================================
// USERS ROUTES
// =====================================================

import { Hono } from 'hono';

interface Env { DB: D1Database; }

export const userRoutes = new Hono<{ Bindings: Env }>();

// Get current user profile
userRoutes.get('/me', async (c) => {
  const userId = c.get('userId');
  try {
    const user = await c.env.DB.prepare(`
      SELECT id, name, email, avatar_url, phone, currency, currency_symbol, created_at 
      FROM users WHERE id = ?
    `).bind(userId).first();
    return c.json({ success: true, data: user });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// Update profile
userRoutes.put('/me', async (c) => {
  const userId = c.get('userId');
  const updates = await c.req.json();
  
  try {
    const fields: string[] = [];
    const values: any[] = [];
    
    if (updates.name) { fields.push('name = ?'); values.push(updates.name); }
    if (updates.phone) { fields.push('phone = ?'); values.push(updates.phone); }
    if (updates.avatar_url) { fields.push('avatar_url = ?'); values.push(updates.avatar_url); }
    if (updates.currency) { fields.push('currency = ?'); values.push(updates.currency); }
    if (updates.currency_symbol) { fields.push('currency_symbol = ?'); values.push(updates.currency_symbol); }
    
    fields.push('updated_at = datetime("now")');
    values.push(userId);
    
    await c.env.DB.prepare(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`).bind(...values).run();
    return c.json({ success: true, message: 'Profile updated' });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// Search users
userRoutes.get('/search', async (c) => {
  const query = c.req.query('q');
  const userId = c.get('userId');
  
  if (!query || query.length < 2) {
    return c.json({ error: 'Query too short' }, 400);
  }
  
  try {
    const users = await c.env.DB.prepare(`
      SELECT id, name, email, avatar_url FROM users 
      WHERE id != ? AND (name LIKE ? OR email LIKE ?)
      LIMIT 20
    `).bind(userId, `%${query}%`, `%${query}%`).all();
    return c.json({ success: true, data: users.results });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});
