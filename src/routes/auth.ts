// =====================================================
// AUTH ROUTES
// =====================================================

import { Hono } from 'hono';
import { nanoid } from 'nanoid';

interface Env {
  DB: D1Database;
  JWT_SECRET: string;
}

export const authRoutes = new Hono<{ Bindings: Env }>();

// Register
authRoutes.post('/register', async (c) => {
  const { email, password, name, phone } = await c.req.json();
  
  if (!email || !password || !name) {
    return c.json({ error: 'Email, password, and name required' }, 400);
  }
  
  try {
    // Check if user exists
    const existing = await c.env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email.toLowerCase()).first();
    if (existing) {
      return c.json({ error: 'Email already registered' }, 400);
    }
    
    // Hash password
    const passwordHash = await hashPassword(password);
    
    const userId = nanoid();
    await c.env.DB.prepare(`
      INSERT INTO users (id, email, name, phone, created_at, updated_at)
      VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))
    `).bind(userId, email.toLowerCase(), name, phone || null).run();
    
    // Store password hash (in a real app, use a separate table)
    await c.env.DB.prepare(`
      INSERT INTO user_auth (user_id, password_hash) VALUES (?, ?)
    `).bind(userId, passwordHash).run();
    
    // Generate JWT
    const token = await generateJWT({ sub: userId, email, name }, c.env.JWT_SECRET);
    
    return c.json({
      success: true,
      data: {
        token,
        user: { id: odId, email, name }
      }
    });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// Login
authRoutes.post('/login', async (c) => {
  const { email, password } = await c.req.json();
  
  if (!email || !password) {
    return c.json({ error: 'Email and password required' }, 400);
  }
  
  try {
    const user = await c.env.DB.prepare(`
      SELECT u.*, ua.password_hash 
      FROM users u 
      JOIN user_auth ua ON u.id = ua.user_id 
      WHERE u.email = ?
    `).bind(email.toLowerCase()).first();
    
    if (!user) {
      return c.json({ error: 'Invalid credentials' }, 401);
    }
    
    const valid = await verifyPassword(password, user.password_hash as string);
    if (!valid) {
      return c.json({ error: 'Invalid credentials' }, 401);
    }
    
    // Update last seen
    await c.env.DB.prepare('UPDATE users SET last_seen = datetime("now") WHERE id = ?').bind(user.id).run();
    
    const token = await generateJWT({ sub: user.id, email: user.email, name: user.name }, c.env.JWT_SECRET);
    
    return c.json({
      success: true,
      data: {
        token,
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          avatar_url: user.avatar_url
        }
      }
    });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// Password hashing helpers
async function hashPassword(password: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(password);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return btoa(String.fromCharCode(...new Uint8Array(hash)));
}

async function verifyPassword(password: string, hash: string): Promise<boolean> {
  const newHash = await hashPassword(password);
  return newHash === hash;
}

// JWT generation
async function generateJWT(payload: any, secret: string): Promise<string> {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const fullPayload = { ...payload, iat: now, exp: now + 86400 * 30 }; // 30 days
  
  const encoder = new TextEncoder();
  const headerB64 = btoa(JSON.stringify(header)).replace(/=/g, '');
  const payloadB64 = btoa(JSON.stringify(fullPayload)).replace(/=/g, '');
  
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(`${headerB64}.${payloadB64}`));
  const signatureB64 = btoa(String.fromCharCode(...new Uint8Array(signature))).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  
  return `${headerB64}.${payloadB64}.${signatureB64}`;
}
