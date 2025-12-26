// =====================================================
// GROUPS API ROUTES
// =====================================================

import { Hono } from 'hono';
import { nanoid } from 'nanoid';

interface Env {
  DB: D1Database;
  SPLITCOST_DO: DurableObjectNamespace;
}

export const groupRoutes = new Hono<{ Bindings: Env }>();

// Get all groups for user
groupRoutes.get('/', async (c) => {
  const userId = c.get('userId');
  
  try {
    const groups = await c.env.DB.prepare(`
      SELECT 
        g.*,
        gm.role as my_role,
        (SELECT COUNT(*) FROM group_members WHERE group_id = g.id AND is_active = 1) as member_count,
        (SELECT COALESCE(SUM(amount), 0) FROM expenses WHERE group_id = g.id AND is_deleted = 0) as total_expenses,
        (SELECT COALESCE(SUM(CASE WHEN b.user_id = ? THEN b.amount ELSE 0 END), 0) 
         FROM balances b WHERE b.group_id = g.id) as my_balance
      FROM groups g
      JOIN group_members gm ON g.id = gm.group_id AND gm.user_id = ?
      WHERE g.is_active = 1 AND gm.is_active = 1
      ORDER BY g.updated_at DESC
    `).bind(userId, userId).all();
    
    return c.json({
      success: true,
      data: groups.results
    });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// Get single group with details
groupRoutes.get('/:groupId', async (c) => {
  const userId = c.get('userId');
  const groupId = c.req.param('groupId');
  
  try {
    // Check membership
    const membership = await c.env.DB.prepare(`
      SELECT * FROM group_members WHERE group_id = ? AND user_id = ? AND is_active = 1
    `).bind(groupId, userId).first();
    
    if (!membership) {
      return c.json({ error: 'Not a member of this group' }, 403);
    }
    
    // Get group details
    const group = await c.env.DB.prepare(`
      SELECT g.*, u.name as created_by_name
      FROM groups g
      JOIN users u ON g.created_by = u.id
      WHERE g.id = ? AND g.is_active = 1
    `).bind(groupId).first();
    
    if (!group) {
      return c.json({ error: 'Group not found' }, 404);
    }
    
    // Get members
    const members = await c.env.DB.prepare(`
      SELECT 
        u.id,
        u.name,
        u.email,
        u.avatar_url,
        gm.role,
        gm.joined_at,
        COALESCE(
          (SELECT SUM(amount) FROM balances WHERE user_id = ? AND friend_id = u.id AND group_id = ?),
          0
        ) as balance_with_me
      FROM group_members gm
      JOIN users u ON gm.user_id = u.id
      WHERE gm.group_id = ? AND gm.is_active = 1
      ORDER BY gm.role DESC, u.name ASC
    `).bind(userId, groupId, groupId).all();
    
    // Get recent expenses
    const recentExpenses = await c.env.DB.prepare(`
      SELECT 
        e.*,
        u.name as paid_by_name
      FROM expenses e
      JOIN users u ON e.paid_by = u.id
      WHERE e.group_id = ? AND e.is_deleted = 0
      ORDER BY e.expense_date DESC, e.created_at DESC
      LIMIT 10
    `).bind(groupId).all();
    
    // Get group totals
    const totals = await c.env.DB.prepare(`
      SELECT 
        COALESCE(SUM(amount), 0) as total_expenses,
        COUNT(*) as expense_count
      FROM expenses
      WHERE group_id = ? AND is_deleted = 0
    `).bind(groupId).first();
    
    return c.json({
      success: true,
      data: {
        ...group,
        members: members.results,
        recentExpenses: recentExpenses.results,
        totals,
        myRole: membership.role
      }
    });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// Create group
groupRoutes.post('/', async (c) => {
  const userId = c.get('userId');
  const {
    name,
    description,
    icon = '👥',
    groupType = 'general',
    currency = 'USD',
    currencySymbol = '$',
    memberIds = []
  } = await c.req.json();
  
  if (!name) {
    return c.json({ error: 'Group name required' }, 400);
  }
  
  try {
    const groupId = nanoid();
    const now = new Date().toISOString();
    
    // Create group
    await c.env.DB.prepare(`
      INSERT INTO groups (
        id, name, description, icon, created_by, group_type, 
        currency, currency_symbol, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      groupId, name, description || null, icon, userId, groupType,
      currency, currencySymbol, now, now
    ).run();
    
    // Add creator as admin
    const creatorMemberId = nanoid();
    await c.env.DB.prepare(`
      INSERT INTO group_members (id, group_id, user_id, role, joined_at)
      VALUES (?, ?, ?, 'admin', ?)
    `).bind(creatorMemberId, groupId, userId, now).run();
    
    // Add other members
    for (const memberId of memberIds) {
      if (memberId === userId) continue;
      
      const memberRecordId = nanoid();
      await c.env.DB.prepare(`
        INSERT INTO group_members (id, group_id, user_id, role, joined_at)
        VALUES (?, ?, ?, 'member', ?)
      `).bind(memberRecordId, groupId, memberId, now).run();
      
      // Initialize balances between members
      for (const otherMemberId of [userId, ...memberIds]) {
        if (otherMemberId === memberId) continue;
        
        const balanceId1 = nanoid();
        const balanceId2 = nanoid();
        
        await c.env.DB.batch([
          c.env.DB.prepare(`
            INSERT OR IGNORE INTO balances (id, user_id, friend_id, group_id, amount, last_updated)
            VALUES (?, ?, ?, ?, 0, ?)
          `).bind(balanceId1, memberId, otherMemberId, groupId, now),
          c.env.DB.prepare(`
            INSERT OR IGNORE INTO balances (id, user_id, friend_id, group_id, amount, last_updated)
            VALUES (?, ?, ?, ?, 0, ?)
          `).bind(balanceId2, otherMemberId, memberId, groupId, now)
        ]);
      }
      
      // Send notification
      const notifId = nanoid();
      const currentUser = await c.env.DB.prepare(
        'SELECT name FROM users WHERE id = ?'
      ).bind(userId).first();
      
      await c.env.DB.prepare(`
        INSERT INTO notifications (id, user_id, type, title, message, reference_type, reference_id, created_at)
        VALUES (?, ?, 'group_invite', ?, ?, 'group', ?, ?)
      `).bind(
        notifId,
        memberId,
        'Added to Group',
        `${currentUser?.name} added you to "${name}"`,
        groupId,
        now
      ).run();
      
      // Broadcast to user
      try {
        const doId = c.env.SPLITCOST_DO.idFromName(`user:${memberId}`);
        const stub = c.env.SPLITCOST_DO.get(doId);
        await stub.fetch(new Request('http://internal/broadcast', {
          method: 'POST',
          body: JSON.stringify({
            type: 'group_joined',
            data: { groupId, name, icon }
          })
        }));
      } catch (e) {
        console.error('Failed to broadcast:', e);
      }
    }
    
    // Create activity
    const activityId = nanoid();
    await c.env.DB.prepare(`
      INSERT INTO activities (id, group_id, user_id, activity_type, message, created_at)
      VALUES (?, ?, ?, 'group_created', ?, ?)
    `).bind(activityId, groupId, userId, `Group "${name}" created`, now).run();
    
    return c.json({
      success: true,
      data: {
        groupId,
        name,
        icon
      }
    });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// Update group
groupRoutes.put('/:groupId', async (c) => {
  const userId = c.get('userId');
  const groupId = c.req.param('groupId');
  const updates = await c.req.json();
  
  try {
    // Check if user is admin
    const membership = await c.env.DB.prepare(`
      SELECT role FROM group_members WHERE group_id = ? AND user_id = ? AND is_active = 1
    `).bind(groupId, userId).first();
    
    if (!membership || membership.role !== 'admin') {
      return c.json({ error: 'Only admins can update the group' }, 403);
    }
    
    const updateFields: string[] = [];
    const updateValues: any[] = [];
    
    if (updates.name !== undefined) {
      updateFields.push('name = ?');
      updateValues.push(updates.name);
    }
    if (updates.description !== undefined) {
      updateFields.push('description = ?');
      updateValues.push(updates.description);
    }
    if (updates.icon !== undefined) {
      updateFields.push('icon = ?');
      updateValues.push(updates.icon);
    }
    if (updates.simplifyDebts !== undefined) {
      updateFields.push('simplify_debts = ?');
      updateValues.push(updates.simplifyDebts ? 1 : 0);
    }
    
    updateFields.push('updated_at = ?');
    updateValues.push(new Date().toISOString());
    updateValues.push(groupId);
    
    await c.env.DB.prepare(`
      UPDATE groups SET ${updateFields.join(', ')} WHERE id = ?
    `).bind(...updateValues).run();
    
    // Broadcast update
    const doId = c.env.SPLITCOST_DO.idFromName(groupId);
    const stub = c.env.SPLITCOST_DO.get(doId);
    await stub.fetch(new Request('http://internal/broadcast', {
      method: 'POST',
      body: JSON.stringify({
        type: 'group_updated',
        data: { groupId, updates }
      })
    }));
    
    return c.json({
      success: true,
      message: 'Group updated'
    });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// Add member to group
groupRoutes.post('/:groupId/members', async (c) => {
  const userId = c.get('userId');
  const groupId = c.req.param('groupId');
  const { memberId, email, phone } = await c.req.json();
  
  try {
    // Check if user is admin
    const membership = await c.env.DB.prepare(`
      SELECT role FROM group_members WHERE group_id = ? AND user_id = ? AND is_active = 1
    `).bind(groupId, userId).first();
    
    if (!membership || membership.role !== 'admin') {
      return c.json({ error: 'Only admins can add members' }, 403);
    }
    
    // Find user
    let newMemberId = memberId;
    if (!newMemberId && (email || phone)) {
      const user = await c.env.DB.prepare(`
        SELECT id FROM users WHERE email = ? OR phone = ?
      `).bind(email || '', phone || '').first();
      
      if (!user) {
        return c.json({ error: 'User not found' }, 404);
      }
      newMemberId = user.id;
    }
    
    if (!newMemberId) {
      return c.json({ error: 'Member ID, email, or phone required' }, 400);
    }
    
    // Check if already a member
    const existing = await c.env.DB.prepare(`
      SELECT * FROM group_members WHERE group_id = ? AND user_id = ?
    `).bind(groupId, newMemberId).first();
    
    if (existing) {
      if (existing.is_active) {
        return c.json({ error: 'Already a member' }, 400);
      }
      // Reactivate
      await c.env.DB.prepare(`
        UPDATE group_members SET is_active = 1, left_at = NULL, joined_at = datetime('now')
        WHERE group_id = ? AND user_id = ?
      `).bind(groupId, newMemberId).run();
    } else {
      const memberRecordId = nanoid();
      await c.env.DB.prepare(`
        INSERT INTO group_members (id, group_id, user_id, role, joined_at)
        VALUES (?, ?, ?, 'member', datetime('now'))
      `).bind(memberRecordId, groupId, newMemberId).run();
    }
    
    // Initialize balances with existing members
    const existingMembers = await c.env.DB.prepare(`
      SELECT user_id FROM group_members WHERE group_id = ? AND is_active = 1 AND user_id != ?
    `).bind(groupId, newMemberId).all();
    
    for (const member of existingMembers.results as any[]) {
      const balanceId1 = nanoid();
      const balanceId2 = nanoid();
      
      await c.env.DB.batch([
        c.env.DB.prepare(`
          INSERT OR IGNORE INTO balances (id, user_id, friend_id, group_id, amount, last_updated)
          VALUES (?, ?, ?, ?, 0, datetime('now'))
        `).bind(balanceId1, newMemberId, member.user_id, groupId),
        c.env.DB.prepare(`
          INSERT OR IGNORE INTO balances (id, user_id, friend_id, group_id, amount, last_updated)
          VALUES (?, ?, ?, ?, 0, datetime('now'))
        `).bind(balanceId2, member.user_id, newMemberId, groupId)
      ]);
    }
    
    // Create activity
    const group = await c.env.DB.prepare('SELECT name FROM groups WHERE id = ?').bind(groupId).first();
    const newMember = await c.env.DB.prepare('SELECT name FROM users WHERE id = ?').bind(newMemberId).first();
    
    const activityId = nanoid();
    await c.env.DB.prepare(`
      INSERT INTO activities (id, group_id, user_id, activity_type, message, created_at)
      VALUES (?, ?, ?, 'member_joined', ?, datetime('now'))
    `).bind(activityId, groupId, newMemberId, `${newMember?.name} joined the group`).run();
    
    // Notify the new member
    const notifId = nanoid();
    await c.env.DB.prepare(`
      INSERT INTO notifications (id, user_id, type, title, message, reference_type, reference_id, created_at)
      VALUES (?, ?, 'group_invite', ?, ?, 'group', ?, datetime('now'))
    `).bind(notifId, newMemberId, 'Added to Group', `You were added to "${group?.name}"`, groupId).run();
    
    // Broadcast to group
    const doId = c.env.SPLITCOST_DO.idFromName(groupId);
    const stub = c.env.SPLITCOST_DO.get(doId);
    await stub.fetch(new Request('http://internal/broadcast', {
      method: 'POST',
      body: JSON.stringify({
        type: 'member_joined',
        data: { groupId, memberId: newMemberId, memberName: newMember?.name }
      })
    }));
    
    return c.json({
      success: true,
      message: 'Member added'
    });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// Remove member from group
groupRoutes.delete('/:groupId/members/:memberId', async (c) => {
  const userId = c.get('userId');
  const groupId = c.req.param('groupId');
  const memberId = c.req.param('memberId');
  
  try {
    // Check authorization (admin or self)
    if (memberId !== userId) {
      const membership = await c.env.DB.prepare(`
        SELECT role FROM group_members WHERE group_id = ? AND user_id = ? AND is_active = 1
      `).bind(groupId, userId).first();
      
      if (!membership || membership.role !== 'admin') {
        return c.json({ error: 'Only admins can remove members' }, 403);
      }
    }
    
    // Check for unsettled balances
    const unsettled = await c.env.DB.prepare(`
      SELECT SUM(ABS(amount)) as total FROM balances 
      WHERE group_id = ? AND (user_id = ? OR friend_id = ?) AND amount != 0
    `).bind(groupId, memberId, memberId).first();
    
    if (unsettled && (unsettled.total as number) > 0.01) {
      return c.json({ 
        error: 'Cannot leave with unsettled balances',
        unsettledAmount: unsettled.total
      }, 400);
    }
    
    // Soft remove member
    await c.env.DB.prepare(`
      UPDATE group_members SET is_active = 0, left_at = datetime('now')
      WHERE group_id = ? AND user_id = ?
    `).bind(groupId, memberId).run();
    
    // Create activity
    const member = await c.env.DB.prepare('SELECT name FROM users WHERE id = ?').bind(memberId).first();
    const activityId = nanoid();
    await c.env.DB.prepare(`
      INSERT INTO activities (id, group_id, user_id, activity_type, message, created_at)
      VALUES (?, ?, ?, 'member_left', ?, datetime('now'))
    `).bind(activityId, groupId, memberId, `${member?.name} left the group`).run();
    
    // Broadcast
    const doId = c.env.SPLITCOST_DO.idFromName(groupId);
    const stub = c.env.SPLITCOST_DO.get(doId);
    await stub.fetch(new Request('http://internal/broadcast', {
      method: 'POST',
      body: JSON.stringify({
        type: 'member_left',
        data: { groupId, memberId, memberName: member?.name }
      })
    }));
    
    return c.json({
      success: true,
      message: 'Member removed'
    });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// Get group balances (simplified debts)
groupRoutes.get('/:groupId/balances', async (c) => {
  const userId = c.get('userId');
  const groupId = c.req.param('groupId');
  
  try {
    // Check membership
    const membership = await c.env.DB.prepare(`
      SELECT * FROM group_members WHERE group_id = ? AND user_id = ? AND is_active = 1
    `).bind(groupId, userId).first();
    
    if (!membership) {
      return c.json({ error: 'Not a member' }, 403);
    }
    
    // Get all balances in group
    const balances = await c.env.DB.prepare(`
      SELECT 
        b.user_id,
        b.friend_id,
        b.amount,
        u1.name as user_name,
        u2.name as friend_name
      FROM balances b
      JOIN users u1 ON b.user_id = u1.id
      JOIN users u2 ON b.friend_id = u2.id
      WHERE b.group_id = ? AND b.amount > 0
    `).bind(groupId).all();
    
    // Simplify debts algorithm
    const group = await c.env.DB.prepare(
      'SELECT simplify_debts FROM groups WHERE id = ?'
    ).bind(groupId).first();
    
    let simplifiedDebts = balances.results;
    
    if (group?.simplify_debts) {
      simplifiedDebts = simplifyDebts(balances.results as any[]);
    }
    
    return c.json({
      success: true,
      data: {
        raw: balances.results,
        simplified: simplifiedDebts
      }
    });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// Get group activity/chat
groupRoutes.get('/:groupId/activities', async (c) => {
  const userId = c.get('userId');
  const groupId = c.req.param('groupId');
  const limit = parseInt(c.req.query('limit') || '50');
  const before = c.req.query('before');
  
  try {
    // Check membership
    const membership = await c.env.DB.prepare(`
      SELECT * FROM group_members WHERE group_id = ? AND user_id = ? AND is_active = 1
    `).bind(groupId, userId).first();
    
    if (!membership) {
      return c.json({ error: 'Not a member' }, 403);
    }
    
    let query = `
      SELECT 
        a.*,
        u.name as user_name,
        u.avatar_url as user_avatar
      FROM activities a
      JOIN users u ON a.user_id = u.id
      WHERE a.group_id = ?
    `;
    
    const params: any[] = [groupId];
    
    if (before) {
      query += ' AND a.created_at < ?';
      params.push(before);
    }
    
    query += ' ORDER BY a.created_at DESC LIMIT ?';
    params.push(limit);
    
    const activities = await c.env.DB.prepare(query).bind(...params).all();
    
    return c.json({
      success: true,
      data: activities.results
    });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// Simplify debts algorithm
function simplifyDebts(balances: any[]): any[] {
  // Calculate net balance for each person
  const netBalance: { [key: string]: number } = {};
  
  for (const b of balances) {
    netBalance[b.user_id] = (netBalance[b.user_id] || 0) + b.amount;
    netBalance[b.friend_id] = (netBalance[b.friend_id] || 0) - b.amount;
  }
  
  // Separate into creditors and debtors
  const creditors: { id: string; amount: number }[] = [];
  const debtors: { id: string; amount: number }[] = [];
  
  for (const [id, amount] of Object.entries(netBalance)) {
    if (amount > 0.01) {
      creditors.push({ id, amount });
    } else if (amount < -0.01) {
      debtors.push({ id, amount: -amount });
    }
  }
  
  // Sort by amount
  creditors.sort((a, b) => b.amount - a.amount);
  debtors.sort((a, b) => b.amount - a.amount);
  
  // Create simplified transactions
  const simplified: any[] = [];
  
  let i = 0, j = 0;
  while (i < creditors.length && j < debtors.length) {
    const creditor = creditors[i];
    const debtor = debtors[j];
    
    const amount = Math.min(creditor.amount, debtor.amount);
    
    if (amount > 0.01) {
      simplified.push({
        from_user_id: debtor.id,
        to_user_id: creditor.id,
        amount: Math.round(amount * 100) / 100
      });
    }
    
    creditor.amount -= amount;
    debtor.amount -= amount;
    
    if (creditor.amount < 0.01) i++;
    if (debtor.amount < 0.01) j++;
  }
  
  return simplified;
}
