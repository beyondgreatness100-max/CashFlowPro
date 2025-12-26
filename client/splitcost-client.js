// =====================================================
// SPLITCOST REAL-TIME CLIENT
// JavaScript client for WebSocket connection
// =====================================================

class SplitCostClient {
  constructor(config = {}) {
    this.baseUrl = config.baseUrl || 'https://api.splitcost.app';
    this.wsUrl = config.wsUrl || 'wss://api.splitcost.app';
    this.token = config.token || localStorage.getItem('splitcost_token');
    this.userId = config.userId;
    this.ws = null;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
    this.reconnectDelay = 1000;
    this.listeners = new Map();
    this.pingInterval = null;
  }

  // ==================== HTTP API ====================
  
  async request(method, endpoint, data = null) {
    const headers = {
      'Content-Type': 'application/json',
    };
    
    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }
    
    const options = {
      method,
      headers,
    };
    
    if (data && method !== 'GET') {
      options.body = JSON.stringify(data);
    }
    
    const response = await fetch(`${this.baseUrl}${endpoint}`, options);
    const json = await response.json();
    
    if (!response.ok) {
      throw new Error(json.error || 'Request failed');
    }
    
    return json;
  }

  // Auth
  async register(email, password, name, phone = null) {
    const result = await this.request('POST', '/api/auth/register', { email, password, name, phone });
    if (result.success) {
      this.token = result.data.token;
      this.userId = result.data.user.id;
      localStorage.setItem('splitcost_token', this.token);
    }
    return result;
  }

  async login(email, password) {
    const result = await this.request('POST', '/api/auth/login', { email, password });
    if (result.success) {
      this.token = result.data.token;
      this.userId = result.data.user.id;
      localStorage.setItem('splitcost_token', this.token);
    }
    return result;
  }

  logout() {
    this.token = null;
    this.userId = null;
    localStorage.removeItem('splitcost_token');
    this.disconnect();
  }

  // Users
  async getProfile() {
    return this.request('GET', '/api/users/me');
  }

  async updateProfile(data) {
    return this.request('PUT', '/api/users/me', data);
  }

  async searchUsers(query) {
    return this.request('GET', `/api/users/search?q=${encodeURIComponent(query)}`);
  }

  // Friends
  async getFriends() {
    return this.request('GET', '/api/friends');
  }

  async getPendingRequests() {
    return this.request('GET', '/api/friends/pending');
  }

  async sendFriendRequest(emailOrPhone) {
    const data = emailOrPhone.includes('@') ? { email: emailOrPhone } : { phone: emailOrPhone };
    return this.request('POST', '/api/friends/request', data);
  }

  async acceptFriendRequest(requestId) {
    return this.request('POST', `/api/friends/accept/${requestId}`);
  }

  async rejectFriendRequest(requestId) {
    return this.request('DELETE', `/api/friends/request/${requestId}`);
  }

  async removeFriend(friendId) {
    return this.request('DELETE', `/api/friends/${friendId}`);
  }

  async getFriendBalance(friendId) {
    return this.request('GET', `/api/friends/${friendId}/balance`);
  }

  // Groups
  async getGroups() {
    return this.request('GET', '/api/groups');
  }

  async getGroup(groupId) {
    return this.request('GET', `/api/groups/${groupId}`);
  }

  async createGroup(data) {
    return this.request('POST', '/api/groups', data);
  }

  async updateGroup(groupId, data) {
    return this.request('PUT', `/api/groups/${groupId}`, data);
  }

  async addGroupMember(groupId, memberId) {
    return this.request('POST', `/api/groups/${groupId}/members`, { memberId });
  }

  async removeGroupMember(groupId, memberId) {
    return this.request('DELETE', `/api/groups/${groupId}/members/${memberId}`);
  }

  async getGroupBalances(groupId) {
    return this.request('GET', `/api/groups/${groupId}/balances`);
  }

  async getGroupActivities(groupId, before = null) {
    const params = before ? `?before=${before}` : '';
    return this.request('GET', `/api/groups/${groupId}/activities${params}`);
  }

  // Expenses
  async getExpenses(groupId = null) {
    const params = groupId ? `?groupId=${groupId}` : '';
    return this.request('GET', `/api/expenses${params}`);
  }

  async getExpense(expenseId) {
    return this.request('GET', `/api/expenses/${expenseId}`);
  }

  async createExpense(data) {
    return this.request('POST', '/api/expenses', data);
  }

  async updateExpense(expenseId, data) {
    return this.request('PUT', `/api/expenses/${expenseId}`, data);
  }

  async deleteExpense(expenseId) {
    return this.request('DELETE', `/api/expenses/${expenseId}`);
  }

  async addComment(expenseId, message) {
    return this.request('POST', `/api/expenses/${expenseId}/comments`, { message });
  }

  // Settlements
  async getSettlements(status = 'all', groupId = null) {
    let params = `?status=${status}`;
    if (groupId) params += `&groupId=${groupId}`;
    return this.request('GET', `/api/settlements${params}`);
  }

  async createSettlement(data) {
    return this.request('POST', '/api/settlements', data);
  }

  async confirmSettlement(settlementId) {
    return this.request('POST', `/api/settlements/${settlementId}/confirm`);
  }

  async rejectSettlement(settlementId) {
    return this.request('POST', `/api/settlements/${settlementId}/reject`);
  }

  // Balances
  async getBalances() {
    return this.request('GET', '/api/balances');
  }

  // Notifications
  async getNotifications(unreadOnly = false) {
    const params = unreadOnly ? '?unread=true' : '';
    return this.request('GET', `/api/notifications${params}`);
  }

  async markNotificationRead(notificationId) {
    return this.request('POST', `/api/notifications/${notificationId}/read`);
  }

  async markAllNotificationsRead() {
    return this.request('POST', '/api/notifications/read-all');
  }

  // ==================== WEBSOCKET ====================

  connect(groupId = null) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      return;
    }

    const endpoint = groupId 
      ? `${this.wsUrl}/ws/${groupId}?userId=${this.userId}`
      : `${this.wsUrl}/ws/user/${this.userId}?userId=${this.userId}`;

    this.ws = new WebSocket(endpoint);

    this.ws.onopen = () => {
      console.log('🔌 Connected to SplitCost real-time');
      this.reconnectAttempts = 0;
      this.emit('connected', {});
      
      // Start ping interval
      this.pingInterval = setInterval(() => {
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.send('ping', {});
        }
      }, 30000);
    };

    this.ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        this.handleMessage(message);
      } catch (e) {
        console.error('Failed to parse message:', e);
      }
    };

    this.ws.onclose = () => {
      console.log('🔌 Disconnected from SplitCost');
      this.emit('disconnected', {});
      clearInterval(this.pingInterval);
      
      // Attempt reconnect
      if (this.reconnectAttempts < this.maxReconnectAttempts) {
        this.reconnectAttempts++;
        const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);
        console.log(`Reconnecting in ${delay}ms...`);
        setTimeout(() => this.connect(groupId), delay);
      }
    };

    this.ws.onerror = (error) => {
      console.error('WebSocket error:', error);
      this.emit('error', { error });
    };
  }

  disconnect() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    clearInterval(this.pingInterval);
  }

  send(type, data) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type, data }));
    }
  }

  handleMessage(message) {
    const { type, data, sender, timestamp } = message;
    
    // Emit to all listeners for this event type
    this.emit(type, { data, sender, timestamp });
    
    // Also emit to generic 'message' listeners
    this.emit('message', message);
  }

  // Event handling
  on(event, callback) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    this.listeners.get(event).push(callback);
    return () => this.off(event, callback);
  }

  off(event, callback) {
    if (this.listeners.has(event)) {
      const callbacks = this.listeners.get(event);
      const index = callbacks.indexOf(callback);
      if (index > -1) {
        callbacks.splice(index, 1);
      }
    }
  }

  emit(event, data) {
    if (this.listeners.has(event)) {
      for (const callback of this.listeners.get(event)) {
        callback(data);
      }
    }
  }

  // ==================== HELPER METHODS ====================

  // Calculate split amounts
  static calculateEqualSplit(amount, userIds) {
    const perPerson = amount / userIds.length;
    return userIds.map(userId => ({
      userId,
      amount: Math.round(perPerson * 100) / 100
    }));
  }

  static calculatePercentageSplit(amount, percentages) {
    return Object.entries(percentages).map(([userId, percentage]) => ({
      userId,
      amount: Math.round((amount * percentage / 100) * 100) / 100,
      percentage
    }));
  }

  static calculateSharesSplit(amount, shares) {
    const totalShares = Object.values(shares).reduce((a, b) => a + b, 0);
    return Object.entries(shares).map(([userId, userShares]) => ({
      userId,
      amount: Math.round((amount * userShares / totalShares) * 100) / 100,
      shares: userShares
    }));
  }

  // Format currency
  static formatCurrency(amount, symbol = '$') {
    return `${symbol}${Math.abs(amount).toFixed(2)}`;
  }

  // Format relative time
  static formatRelativeTime(dateString) {
    const date = new Date(dateString);
    const now = new Date();
    const diff = now - date;
    
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);
    
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes}m ago`;
    if (hours < 24) return `${hours}h ago`;
    if (days < 7) return `${days}d ago`;
    
    return date.toLocaleDateString();
  }
}

// Export for use
if (typeof module !== 'undefined' && module.exports) {
  module.exports = SplitCostClient;
}
if (typeof window !== 'undefined') {
  window.SplitCostClient = SplitCostClient;
}
