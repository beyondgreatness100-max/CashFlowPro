// =====================================================
// EXPENSES API ROUTES
// =====================================================

import { Hono } from 'hono';
import { nanoid } from 'nanoid';

interface Env {
  DB: D1Database;
  SPLITCOST_DO: DurableObjectNamespace;
}

export const expenseRoutes = new Hono<{ Bindings: Env }>();

// Get all expenses for user
expenseRoutes.get('/', async (c) => {
  const userId = c.get('userId');
  const groupId = c.req.query('groupId');
  const limit = parseInt(c.req.query('limit') || '50');
  const offset = parseInt(c.req.query('offset') || '0');
  
  try {
    let query = `
      SELECT 
        e.*,
        u.name as paid_by_name,
        u.avatar_url as paid_by_avatar,
        g.name as group_name,
        g.icon as group_icon
      FROM expenses e
      JOIN users u ON e.paid_by = u.id
      LEFT JOIN groups g ON e.group_id = g.id
      WHERE e.is_deleted = 0
        AND (
          e.paid_by = ?
          OR e.id IN (SELECT expense_id FROM expense_splits WHERE user_id = ?)
        )
    `;
    
    const params: any[] = [userId, userId];
    
    if (groupId) {
      query += ' AND e.group_id = ?';
      params.push(groupId);
    }
    
    query += ' ORDER BY e.expense_date DESC, e.created_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);
    
    const expenses = await c.env.DB.prepare(query).bind(...params).all();
    
    // Get splits for each expense
    const expensesWithSplits = await Promise.all(
      expenses.results.map(async (expense: any) => {
        const splits = await c.env.DB.prepare(`
          SELECT 
            es.*,
            u.name as user_name,
            u.avatar_url as user_avatar
          FROM expense_splits es
          JOIN users u ON es.user_id = u.id
          WHERE es.expense_id = ?
        `).bind(expense.id).all();
        
        return {
          ...expense,
          splits: splits.results
        };
      })
    );
    
    return c.json({
      success: true,
      data: expensesWithSplits,
      pagination: {
        limit,
        offset,
        hasMore: expenses.results.length === limit
      }
    });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// Get single expense
expenseRoutes.get('/:expenseId', async (c) => {
  const userId = c.get('userId');
  const expenseId = c.req.param('expenseId');
  
  try {
    const expense = await c.env.DB.prepare(`
      SELECT 
        e.*,
        u.name as paid_by_name,
        u.avatar_url as paid_by_avatar,
        g.name as group_name,
        g.icon as group_icon
      FROM expenses e
      JOIN users u ON e.paid_by = u.id
      LEFT JOIN groups g ON e.group_id = g.id
      WHERE e.id = ? AND e.is_deleted = 0
    `).bind(expenseId).first();
    
    if (!expense) {
      return c.json({ error: 'Expense not found' }, 404);
    }
    
    // Get splits
    const splits = await c.env.DB.prepare(`
      SELECT 
        es.*,
        u.name as user_name,
        u.avatar_url as user_avatar
      FROM expense_splits es
      JOIN users u ON es.user_id = u.id
      WHERE es.expense_id = ?
    `).bind(expenseId).all();
    
    // Get comments
    const comments = await c.env.DB.prepare(`
      SELECT 
        cm.*,
        u.name as user_name,
        u.avatar_url as user_avatar
      FROM comments cm
      JOIN users u ON cm.user_id = u.id
      WHERE cm.expense_id = ? AND cm.is_deleted = 0
      ORDER BY cm.created_at ASC
    `).bind(expenseId).all();
    
    return c.json({
      success: true,
      data: {
        ...expense,
        splits: splits.results,
        comments: comments.results
      }
    });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// Create expense
expenseRoutes.post('/', async (c) => {
  const userId = c.get('userId');
  const {
    groupId,
    description,
    amount,
    currency = 'USD',
    currencySymbol = '$',
    category = 'general',
    paidBy,
    splitType = 'equal',
    splits,
    expenseDate,
    notes
  } = await c.req.json();
  
  if (!description || !amount || !splits || splits.length === 0) {
    return c.json({ error: 'Missing required fields' }, 400);
  }
  
  try {
    const expenseId = nanoid();
    const now = new Date().toISOString();
    
    // Create expense
    await c.env.DB.prepare(`
      INSERT INTO expenses (
        id, group_id, description, amount, currency, currency_symbol,
        category, paid_by, split_type, expense_date, notes, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      expenseId,
      groupId || null,
      description,
      amount,
      currency,
      currencySymbol,
      category,
      paidBy || userId,
      splitType,
      expenseDate || now.split('T')[0],
      notes || null,
      now,
      now
    ).run();
    
    // Create splits
    const splitInserts = splits.map((split: any) => {
      const splitId = nanoid();
      return c.env.DB.prepare(`
        INSERT INTO expense_splits (id, expense_id, user_id, amount, percentage, shares, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).bind(
        splitId,
        expenseId,
        split.userId,
        split.amount,
        split.percentage || null,
        split.shares || null,
        now
      );
    });
    
    await c.env.DB.batch(splitInserts);
    
    // Update balances
    const actualPaidBy = paidBy || userId;
    
    for (const split of splits) {
      if (split.userId === actualPaidBy) continue;
      
      // Person who didn't pay owes the payer
      await updateBalance(c.env.DB, actualPaidBy, split.userId, split.amount, groupId);
      await updateBalance(c.env.DB, split.userId, actualPaidBy, -split.amount, groupId);
    }
    
    // Create activity
    const activityId = nanoid();
    await c.env.DB.prepare(`
      INSERT INTO activities (id, group_id, user_id, activity_type, reference_id, message, created_at)
      VALUES (?, ?, ?, 'expense_added', ?, ?, ?)
    `).bind(
      activityId,
      groupId || null,
      userId,
      expenseId,
      `${description} - ${currencySymbol}${amount}`,
      now
    ).run();
    
    // Create notifications for people in the split
    for (const split of splits) {
      if (split.userId === userId) continue;
      
      const notifId = nanoid();
      const currentUser = await c.env.DB.prepare(
        'SELECT name FROM users WHERE id = ?'
      ).bind(userId).first();
      
      await c.env.DB.prepare(`
        INSERT INTO notifications (id, user_id, type, title, message, reference_type, reference_id, created_at)
        VALUES (?, ?, 'expense_added', ?, ?, 'expense', ?, ?)
      `).bind(
        notifId,
        split.userId,
        'New Expense',
        `${currentUser?.name} added "${description}" - You owe ${currencySymbol}${split.amount.toFixed(2)}`,
        expenseId,
        now
      ).run();
    }
    
    // Broadcast to group or involved users
    const broadcastData = {
      type: 'expense_added',
      data: {
        expenseId,
        description,
        amount,
        currencySymbol,
        paidBy: actualPaidBy,
        splits,
        groupId
      }
    };
    
    if (groupId) {
      // Broadcast to group
      const doId = c.env.SPLITCOST_DO.idFromName(groupId);
      const stub = c.env.SPLITCOST_DO.get(doId);
      await stub.fetch(new Request('http://internal/broadcast', {
        method: 'POST',
        body: JSON.stringify(broadcastData)
      }));
    } else {
      // Broadcast to each user involved
      for (const split of splits) {
        const doId = c.env.SPLITCOST_DO.idFromName(`user:${split.userId}`);
        const stub = c.env.SPLITCOST_DO.get(doId);
        await stub.fetch(new Request('http://internal/broadcast', {
          method: 'POST',
          body: JSON.stringify(broadcastData)
        })).catch(console.error);
      }
    }
    
    return c.json({
      success: true,
      data: {
        expenseId,
        message: 'Expense created successfully'
      }
    });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// Update expense
expenseRoutes.put('/:expenseId', async (c) => {
  const userId = c.get('userId');
  const expenseId = c.req.param('expenseId');
  const updates = await c.req.json();
  
  try {
    // Check if user can edit (is payer or in group as admin)
    const expense = await c.env.DB.prepare(`
      SELECT * FROM expenses WHERE id = ? AND is_deleted = 0
    `).bind(expenseId).first();
    
    if (!expense) {
      return c.json({ error: 'Expense not found' }, 404);
    }
    
    if (expense.paid_by !== userId) {
      // Check if user is group admin
      if (expense.group_id) {
        const member = await c.env.DB.prepare(`
          SELECT role FROM group_members 
          WHERE group_id = ? AND user_id = ? AND is_active = 1
        `).bind(expense.group_id, userId).first();
        
        if (!member || member.role !== 'admin') {
          return c.json({ error: 'Not authorized' }, 403);
        }
      } else {
        return c.json({ error: 'Not authorized' }, 403);
      }
    }
    
    const now = new Date().toISOString();
    
    // Build update query
    const updateFields: string[] = [];
    const updateValues: any[] = [];
    
    if (updates.description !== undefined) {
      updateFields.push('description = ?');
      updateValues.push(updates.description);
    }
    if (updates.amount !== undefined) {
      updateFields.push('amount = ?');
      updateValues.push(updates.amount);
    }
    if (updates.category !== undefined) {
      updateFields.push('category = ?');
      updateValues.push(updates.category);
    }
    if (updates.expenseDate !== undefined) {
      updateFields.push('expense_date = ?');
      updateValues.push(updates.expenseDate);
    }
    if (updates.notes !== undefined) {
      updateFields.push('notes = ?');
      updateValues.push(updates.notes);
    }
    
    updateFields.push('updated_at = ?');
    updateValues.push(now);
    updateValues.push(expenseId);
    
    await c.env.DB.prepare(`
      UPDATE expenses SET ${updateFields.join(', ')} WHERE id = ?
    `).bind(...updateValues).run();
    
    // If splits are updated, recalculate balances
    if (updates.splits) {
      // First, reverse old balance changes
      const oldSplits = await c.env.DB.prepare(`
        SELECT * FROM expense_splits WHERE expense_id = ?
      `).bind(expenseId).all();
      
      for (const split of oldSplits.results as any[]) {
        if (split.user_id === expense.paid_by) continue;
        await updateBalance(c.env.DB, expense.paid_by, split.user_id, -split.amount, expense.group_id);
        await updateBalance(c.env.DB, split.user_id, expense.paid_by, split.amount, expense.group_id);
      }
      
      // Delete old splits
      await c.env.DB.prepare('DELETE FROM expense_splits WHERE expense_id = ?').bind(expenseId).run();
      
      // Create new splits
      const paidBy = updates.paidBy || expense.paid_by;
      
      for (const split of updates.splits) {
        const splitId = nanoid();
        await c.env.DB.prepare(`
          INSERT INTO expense_splits (id, expense_id, user_id, amount, percentage, shares, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).bind(
          splitId,
          expenseId,
          split.userId,
          split.amount,
          split.percentage || null,
          split.shares || null,
          now
        ).run();
        
        // Update balance
        if (split.userId !== paidBy) {
          await updateBalance(c.env.DB, paidBy, split.userId, split.amount, expense.group_id);
          await updateBalance(c.env.DB, split.userId, paidBy, -split.amount, expense.group_id);
        }
      }
    }
    
    // Create activity
    const activityId = nanoid();
    await c.env.DB.prepare(`
      INSERT INTO activities (id, group_id, user_id, activity_type, reference_id, message, created_at)
      VALUES (?, ?, ?, 'expense_updated', ?, ?, ?)
    `).bind(
      activityId,
      expense.group_id,
      userId,
      expenseId,
      `Updated: ${updates.description || expense.description}`,
      now
    ).run();
    
    // Broadcast update
    const broadcastData = {
      type: 'expense_updated',
      data: {
        expenseId,
        updates,
        groupId: expense.group_id
      }
    };
    
    if (expense.group_id) {
      const doId = c.env.SPLITCOST_DO.idFromName(expense.group_id);
      const stub = c.env.SPLITCOST_DO.get(doId);
      await stub.fetch(new Request('http://internal/broadcast', {
        method: 'POST',
        body: JSON.stringify(broadcastData)
      }));
    }
    
    return c.json({
      success: true,
      message: 'Expense updated'
    });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// Delete expense (soft delete)
expenseRoutes.delete('/:expenseId', async (c) => {
  const userId = c.get('userId');
  const expenseId = c.req.param('expenseId');
  
  try {
    const expense = await c.env.DB.prepare(`
      SELECT * FROM expenses WHERE id = ? AND is_deleted = 0
    `).bind(expenseId).first();
    
    if (!expense) {
      return c.json({ error: 'Expense not found' }, 404);
    }
    
    // Check authorization
    if (expense.paid_by !== userId) {
      if (expense.group_id) {
        const member = await c.env.DB.prepare(`
          SELECT role FROM group_members 
          WHERE group_id = ? AND user_id = ? AND is_active = 1
        `).bind(expense.group_id, userId).first();
        
        if (!member || member.role !== 'admin') {
          return c.json({ error: 'Not authorized' }, 403);
        }
      } else {
        return c.json({ error: 'Not authorized' }, 403);
      }
    }
    
    const now = new Date().toISOString();
    
    // Reverse balance changes
    const splits = await c.env.DB.prepare(`
      SELECT * FROM expense_splits WHERE expense_id = ?
    `).bind(expenseId).all();
    
    for (const split of splits.results as any[]) {
      if (split.user_id === expense.paid_by) continue;
      await updateBalance(c.env.DB, expense.paid_by, split.user_id, -split.amount, expense.group_id);
      await updateBalance(c.env.DB, split.user_id, expense.paid_by, split.amount, expense.group_id);
    }
    
    // Soft delete
    await c.env.DB.prepare(`
      UPDATE expenses SET is_deleted = 1, deleted_at = ? WHERE id = ?
    `).bind(now, expenseId).run();
    
    // Create activity
    const activityId = nanoid();
    await c.env.DB.prepare(`
      INSERT INTO activities (id, group_id, user_id, activity_type, reference_id, message, created_at)
      VALUES (?, ?, ?, 'expense_deleted', ?, ?, ?)
    `).bind(
      activityId,
      expense.group_id,
      userId,
      expenseId,
      `Deleted: ${expense.description}`,
      now
    ).run();
    
    // Broadcast deletion
    if (expense.group_id) {
      const doId = c.env.SPLITCOST_DO.idFromName(expense.group_id);
      const stub = c.env.SPLITCOST_DO.get(doId);
      await stub.fetch(new Request('http://internal/broadcast', {
        method: 'POST',
        body: JSON.stringify({
          type: 'expense_deleted',
          data: { expenseId, groupId: expense.group_id }
        })
      }));
    }
    
    return c.json({
      success: true,
      message: 'Expense deleted'
    });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// Add comment to expense
expenseRoutes.post('/:expenseId/comments', async (c) => {
  const userId = c.get('userId');
  const expenseId = c.req.param('expenseId');
  const { message } = await c.req.json();
  
  if (!message) {
    return c.json({ error: 'Message required' }, 400);
  }
  
  try {
    const commentId = nanoid();
    const now = new Date().toISOString();
    
    await c.env.DB.prepare(`
      INSERT INTO comments (id, expense_id, user_id, message, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(commentId, expenseId, userId, message, now, now).run();
    
    // Get expense for group_id
    const expense = await c.env.DB.prepare(
      'SELECT group_id FROM expenses WHERE id = ?'
    ).bind(expenseId).first();
    
    // Broadcast comment
    if (expense?.group_id) {
      const doId = c.env.SPLITCOST_DO.idFromName(expense.group_id as string);
      const stub = c.env.SPLITCOST_DO.get(doId);
      await stub.fetch(new Request('http://internal/broadcast', {
        method: 'POST',
        body: JSON.stringify({
          type: 'comment_added',
          data: {
            commentId,
            expenseId,
            userId,
            message,
            timestamp: now
          }
        })
      }));
    }
    
    return c.json({
      success: true,
      data: { commentId }
    });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// Helper function to update balances
async function updateBalance(db: D1Database, userId: string, friendId: string, amount: number, groupId: string | null) {
  const balanceId = nanoid();
  
  // Update or insert balance
  await db.prepare(`
    INSERT INTO balances (id, user_id, friend_id, group_id, amount, last_updated)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT (user_id, friend_id, group_id) 
    DO UPDATE SET amount = amount + ?, last_updated = datetime('now')
  `).bind(balanceId, userId, friendId, groupId, amount, amount).run();
  
  // Also update the total balance (null group_id)
  if (groupId !== null) {
    const totalBalanceId = nanoid();
    await db.prepare(`
      INSERT INTO balances (id, user_id, friend_id, group_id, amount, last_updated)
      VALUES (?, ?, ?, NULL, ?, datetime('now'))
      ON CONFLICT (user_id, friend_id, group_id) 
      DO UPDATE SET amount = amount + ?, last_updated = datetime('now')
    `).bind(totalBalanceId, userId, friendId, amount, amount).run();
  }
}
