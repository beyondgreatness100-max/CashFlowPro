// =====================================================
// SPLITCOST REAL-TIME API - CLOUDFLARE WORKER
// Main entry point with routing
// =====================================================

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { jwt } from 'hono/jwt';
import { authRoutes } from './routes/auth';
import { userRoutes } from './routes/users';
import { friendRoutes } from './routes/friends';
import { groupRoutes } from './routes/groups';
import { expenseRoutes } from './routes/expenses';
import { settlementRoutes } from './routes/settlements';
import { balanceRoutes } from './routes/balances';
import { notificationRoutes } from './routes/notifications';

// Types
export interface Env {
  DB: D1Database;
  SPLITCOST_DO: DurableObjectNamespace;
  JWT_SECRET: string;
  ENVIRONMENT: string;
}

// Create Hono app
const app = new Hono<{ Bindings: Env }>();

// CORS middleware
app.use('/*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
  exposeHeaders: ['Content-Length'],
  maxAge: 86400,
}));

// Health check
app.get('/', (c) => {
  return c.json({
    status: 'ok',
    service: 'SplitCost Real-Time API',
    version: '1.0.0',
    timestamp: new Date().toISOString()
  });
});

// Public routes (no auth required)
app.route('/api/auth', authRoutes);

// Protected routes middleware
app.use('/api/*', async (c, next) => {
  // Skip auth for auth routes
  if (c.req.path.startsWith('/api/auth')) {
    return next();
  }
  
  const authHeader = c.req.header('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  
  const token = authHeader.replace('Bearer ', '');
  
  try {
    const payload = await verifyToken(token, c.env.JWT_SECRET);
    c.set('userId', payload.sub);
    c.set('user', payload);
    return next();
  } catch (e) {
    return c.json({ error: 'Invalid token' }, 401);
  }
});

// API routes
app.route('/api/users', userRoutes);
app.route('/api/friends', friendRoutes);
app.route('/api/groups', groupRoutes);
app.route('/api/expenses', expenseRoutes);
app.route('/api/settlements', settlementRoutes);
app.route('/api/balances', balanceRoutes);
app.route('/api/notifications', notificationRoutes);

// WebSocket upgrade for real-time
app.get('/ws/:groupId', async (c) => {
  const groupId = c.req.param('groupId');
  const userId = c.get('userId');
  
  // Get Durable Object for this group
  const id = c.env.SPLITCOST_DO.idFromName(groupId);
  const stub = c.env.SPLITCOST_DO.get(id);
  
  // Forward the request to the Durable Object
  return stub.fetch(c.req.raw);
});

// Global WebSocket (for user-level notifications)
app.get('/ws/user/:userId', async (c) => {
  const userId = c.req.param('userId');
  
  // Get Durable Object for this user's notifications
  const id = c.env.SPLITCOST_DO.idFromName(`user:${userId}`);
  const stub = c.env.SPLITCOST_DO.get(id);
  
  return stub.fetch(c.req.raw);
});

// JWT verification helper
async function verifyToken(token: string, secret: string): Promise<any> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify']
  );
  
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new Error('Invalid token format');
  }
  
  const [headerB64, payloadB64, signatureB64] = parts;
  const data = encoder.encode(`${headerB64}.${payloadB64}`);
  const signature = Uint8Array.from(atob(signatureB64.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
  
  const valid = await crypto.subtle.verify('HMAC', key, signature, data);
  if (!valid) {
    throw new Error('Invalid signature');
  }
  
  const payload = JSON.parse(atob(payloadB64.replace(/-/g, '+').replace(/_/g, '/')));
  
  if (payload.exp && payload.exp < Date.now() / 1000) {
    throw new Error('Token expired');
  }
  
  return payload;
}

// 404 handler
app.notFound((c) => {
  return c.json({ error: 'Not found' }, 404);
});

// Error handler
app.onError((err, c) => {
  console.error('Error:', err);
  return c.json({ 
    error: 'Internal server error',
    message: c.env.ENVIRONMENT === 'development' ? err.message : undefined
  }, 500);
});

export default app;

// Export Durable Object class
export { SplitCostDurableObject } from './durable-object';
