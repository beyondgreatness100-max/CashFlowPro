// =====================================================
// SPLITCOST DURABLE OBJECT
// Handles real-time WebSocket connections and broadcasts
// =====================================================

interface WebSocketSession {
  webSocket: WebSocket;
  odId: string;
  quit: boolean;
}

interface BroadcastMessage {
  type: string;
  data: any;
  sender?: string;
  timestamp: string;
}

export class SplitCostDurableObject {
  state: DurableObjectState;
  env: any;
  sessions: Map<string, WebSocketSession>;
  
  constructor(state: DurableObjectState, env: any) {
    this.state = state;
    this.env = env;
    this.sessions = new Map();
  }
  
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    
    // Handle WebSocket upgrade
    if (request.headers.get('Upgrade') === 'websocket') {
      return this.handleWebSocket(request);
    }
    
    // Handle HTTP requests for broadcasting
    if (request.method === 'POST' && url.pathname === '/broadcast') {
      const data = await request.json();
      this.broadcast(data);
      return new Response('OK', { status: 200 });
    }
    
    // Get connected users count
    if (request.method === 'GET' && url.pathname === '/status') {
      return new Response(JSON.stringify({
        connectedUsers: this.sessions.size,
        users: Array.from(this.sessions.keys())
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    return new Response('Not found', { status: 404 });
  }
  
  async handleWebSocket(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const userId = url.searchParams.get('userId');
    
    if (!userId) {
      return new Response('Missing userId', { status: 400 });
    }
    
    // Create WebSocket pair
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    
    // Accept the WebSocket
    this.state.acceptWebSocket(server);
    
    // Store session
    const session: WebSocketSession = {
      webSocket: server,
      odId: this.state.id.toString(),
      quit: false
    };
    
    this.sessions.set(userId, session);
    
    // Set up message handler
    server.addEventListener('message', async (event) => {
      try {
        const message = JSON.parse(event.data as string);
        await this.handleMessage(userId, message);
      } catch (e) {
        console.error('Error handling message:', e);
      }
    });
    
    // Set up close handler
    server.addEventListener('close', () => {
      this.sessions.delete(userId);
      this.broadcast({
        type: 'user_disconnected',
        data: { userId },
        timestamp: new Date().toISOString()
      }, userId);
    });
    
    // Set up error handler
    server.addEventListener('error', (e) => {
      console.error('WebSocket error:', e);
      this.sessions.delete(userId);
    });
    
    // Notify others of new connection
    this.broadcast({
      type: 'user_connected',
      data: { userId },
      timestamp: new Date().toISOString()
    }, userId);
    
    // Send welcome message
    server.send(JSON.stringify({
      type: 'connected',
      data: {
        message: 'Connected to SplitCost real-time',
        connectedUsers: Array.from(this.sessions.keys())
      },
      timestamp: new Date().toISOString()
    }));
    
    return new Response(null, {
      status: 101,
      webSocket: client
    });
  }
  
  async handleMessage(userId: string, message: any) {
    const { type, data } = message;
    
    switch (type) {
      case 'ping':
        this.sendToUser(userId, {
          type: 'pong',
          data: {},
          timestamp: new Date().toISOString()
        });
        break;
        
      case 'typing':
        this.broadcast({
          type: 'user_typing',
          data: { userId, ...data },
          sender: userId,
          timestamp: new Date().toISOString()
        }, userId);
        break;
        
      case 'expense_added':
      case 'expense_updated':
      case 'expense_deleted':
      case 'settlement_added':
      case 'settlement_confirmed':
      case 'comment_added':
      case 'member_joined':
      case 'member_left':
        // Broadcast to all connected users
        this.broadcast({
          type,
          data,
          sender: userId,
          timestamp: new Date().toISOString()
        });
        break;
        
      case 'request_sync':
        // User is requesting latest data
        this.sendToUser(userId, {
          type: 'sync_response',
          data: {
            // Would fetch from DB in real implementation
            message: 'Sync data would be here'
          },
          timestamp: new Date().toISOString()
        });
        break;
        
      default:
        console.log('Unknown message type:', type);
    }
  }
  
  broadcast(message: BroadcastMessage, excludeUserId?: string) {
    const messageStr = JSON.stringify(message);
    
    for (const [odId, session] of this.sessions) {
      if (excludeUserId && odId === excludeUserId) continue;
      if (session.quit) continue;
      
      try {
        session.webSocket.send(messageStr);
      } catch (e) {
        console.error('Error sending to user:', odId, e);
        session.quit = true;
      }
    }
  }
  
  sendToUser(userId: string, message: BroadcastMessage) {
    const session = this.sessions.get(userId);
    if (session && !session.quit) {
      try {
        session.webSocket.send(JSON.stringify(message));
      } catch (e) {
        console.error('Error sending to user:', userId, e);
        session.quit = true;
      }
    }
  }
  
  // Handle hibernation (Cloudflare feature)
  async webSocketMessage(ws: WebSocket, message: string) {
    // Find the user ID for this WebSocket
    for (const [userId, session] of this.sessions) {
      if (session.webSocket === ws) {
        try {
          const parsed = JSON.parse(message);
          await this.handleMessage(userId, parsed);
        } catch (e) {
          console.error('Error handling message:', e);
        }
        break;
      }
    }
  }
  
  async webSocketClose(ws: WebSocket, code: number, reason: string) {
    // Find and remove the session
    for (const [odId, session] of this.sessions) {
      if (session.webSocket === ws) {
        this.sessions.delete(odId);
        this.broadcast({
          type: 'user_disconnected',
          data: { odId },
          timestamp: new Date().toISOString()
        });
        break;
      }
    }
  }
  
  async webSocketError(ws: WebSocket, error: unknown) {
    console.error('WebSocket error:', error);
  }
}
