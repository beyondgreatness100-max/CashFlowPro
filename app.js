// ==========================================
// SPLITCOST APP - Main Application Logic
// ==========================================

// Current user state
let currentUser = null;
let currentGroup = null;
let unsubscribers = [];

// ==========================================
// AUTHENTICATION
// ==========================================

// Sign up with email and password
async function signUp(email, password, displayName) {
    try {
        const userCredential = await auth.createUserWithEmailAndPassword(email, password);
        const user = userCredential.user;
        
        // Update profile
        await user.updateProfile({ displayName: displayName });
        
        // Create user document in Firestore
        await db.collection('users').doc(user.uid).set({
            id: user.uid,
            email: email,
            displayName: displayName,
            photoURL: null,
            createdAt: firebase.firestore.FieldValue.serverTimestamp(),
            updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
            settings: {
                currency: 'USD',
                theme: 'dark'
            }
        });
        
        showToast('Account created successfully! 🎉');
        return user;
    } catch (error) {
        console.error('Sign up error:', error);
        showToast(error.message, 'error');
        throw error;
    }
}

// Sign in with email and password
async function signIn(email, password) {
    try {
        const userCredential = await auth.signInWithEmailAndPassword(email, password);
        showToast('Welcome back! 👋');
        return userCredential.user;
    } catch (error) {
        console.error('Sign in error:', error);
        showToast(error.message, 'error');
        throw error;
    }
}

// Sign in with Google
async function signInWithGoogle() {
    try {
        const provider = new firebase.auth.GoogleAuthProvider();
        const result = await auth.signInWithPopup(provider);
        const user = result.user;
        
        // Check if user document exists, if not create it
        const userDoc = await db.collection('users').doc(user.uid).get();
        if (!userDoc.exists) {
            await db.collection('users').doc(user.uid).set({
                id: user.uid,
                email: user.email,
                displayName: user.displayName,
                photoURL: user.photoURL,
                createdAt: firebase.firestore.FieldValue.serverTimestamp(),
                updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
                settings: {
                    currency: 'USD',
                    theme: 'dark'
                }
            });
        }
        
        showToast('Welcome! 🎉');
        return user;
    } catch (error) {
        console.error('Google sign in error:', error);
        showToast(error.message, 'error');
        throw error;
    }
}

// Sign out
async function signOut() {
    try {
        // Clean up listeners
        unsubscribers.forEach(unsub => unsub());
        unsubscribers = [];
        
        await auth.signOut();
        currentUser = null;
        currentGroup = null;
        showToast('Signed out successfully');
        showAuthScreen();
    } catch (error) {
        console.error('Sign out error:', error);
        showToast(error.message, 'error');
    }
}

// Auth state listener
auth.onAuthStateChanged(async (user) => {
    if (user) {
        currentUser = user;
        // Get additional user data from Firestore
        const userDoc = await db.collection('users').doc(user.uid).get();
        if (userDoc.exists) {
            currentUser.data = userDoc.data();
        }
        showMainApp();
        initializeApp();
    } else {
        currentUser = null;
        showAuthScreen();
    }
});

// ==========================================
// FRIENDS MANAGEMENT
// ==========================================

// Search for user by email
async function searchUserByEmail(email) {
    try {
        const snapshot = await db.collection('users')
            .where('email', '==', email.toLowerCase())
            .limit(1)
            .get();
        
        if (snapshot.empty) {
            return null;
        }
        
        return snapshot.docs[0].data();
    } catch (error) {
        console.error('Search user error:', error);
        return null;
    }
}

// Send friend request
async function sendFriendRequest(friendEmail) {
    try {
        if (friendEmail === currentUser.email) {
            showToast("You can't add yourself as a friend!", 'error');
            return false;
        }
        
        // Find user by email
        const friendData = await searchUserByEmail(friendEmail);
        if (!friendData) {
            showToast('User not found. They need to create an account first.', 'error');
            return false;
        }
        
        // Check if friendship already exists
        const existingFriendship = await db.collection('friends')
            .where('users', 'array-contains', currentUser.uid)
            .get();
        
        const alreadyFriends = existingFriendship.docs.some(doc => {
            const data = doc.data();
            return data.users.includes(friendData.id);
        });
        
        if (alreadyFriends) {
            showToast('You are already friends or have a pending request.', 'error');
            return false;
        }
        
        // Create friend request
        await db.collection('friends').add({
            users: [currentUser.uid, friendData.id],
            status: 'pending',
            requestedBy: currentUser.uid,
            createdAt: firebase.firestore.FieldValue.serverTimestamp(),
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        });
        
        showToast('Friend request sent! 📨');
        return true;
    } catch (error) {
        console.error('Send friend request error:', error);
        showToast(error.message, 'error');
        return false;
    }
}

// Accept friend request
async function acceptFriendRequest(friendshipId) {
    try {
        await db.collection('friends').doc(friendshipId).update({
            status: 'accepted',
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        });
        showToast('Friend request accepted! 🎉');
    } catch (error) {
        console.error('Accept friend request error:', error);
        showToast(error.message, 'error');
    }
}

// Reject/Delete friend request
async function removeFriend(friendshipId) {
    try {
        await db.collection('friends').doc(friendshipId).delete();
        showToast('Friend removed');
    } catch (error) {
        console.error('Remove friend error:', error);
        showToast(error.message, 'error');
    }
}

// Get all friends (real-time listener)
function subscribToFriends(callback) {
    const unsubscribe = db.collection('friends')
        .where('users', 'array-contains', currentUser.uid)
        .onSnapshot(async (snapshot) => {
            const friends = [];
            const pendingRequests = [];
            
            for (const doc of snapshot.docs) {
                const data = doc.data();
                const friendId = data.users.find(id => id !== currentUser.uid);
                
                // Get friend's user data
                const friendDoc = await db.collection('users').doc(friendId).get();
                const friendData = friendDoc.exists ? friendDoc.data() : null;
                
                const friendInfo = {
                    friendshipId: doc.id,
                    oderId: friendId,
                    displayName: friendData?.displayName || 'Unknown',
                    email: friendData?.email || '',
                    photoURL: friendData?.photoURL || null,
                    status: data.status,
                    requestedBy: data.requestedBy,
                    createdAt: data.createdAt
                };
                
                if (data.status === 'accepted') {
                    friends.push(friendInfo);
                } else if (data.status === 'pending') {
                    pendingRequests.push(friendInfo);
                }
            }
            
            callback({ friends, pendingRequests });
        });
    
    unsubscribers.push(unsubscribe);
    return unsubscribe;
}

// ==========================================
// GROUPS MANAGEMENT
// ==========================================

// Create a new group
async function createGroup(name, icon, memberIds = []) {
    try {
        // Get member details
        const members = [{
            id: currentUser.uid,
            displayName: currentUser.displayName || currentUser.email,
            email: currentUser.email,
            role: 'admin',
            joinedAt: firebase.firestore.FieldValue.serverTimestamp()
        }];
        
        const allMemberIds = [currentUser.uid];
        
        for (const memberId of memberIds) {
            const memberDoc = await db.collection('users').doc(memberId).get();
            if (memberDoc.exists) {
                const memberData = memberDoc.data();
                members.push({
                    id: memberId,
                    displayName: memberData.displayName || memberData.email,
                    email: memberData.email,
                    role: 'member',
                    joinedAt: firebase.firestore.FieldValue.serverTimestamp()
                });
                allMemberIds.push(memberId);
            }
        }
        
        const groupRef = await db.collection('groups').add({
            name: name,
            icon: icon || '👥',
            description: '',
            createdBy: currentUser.uid,
            members: members,
            memberIds: allMemberIds,
            totalExpenses: 0,
            currency: currentUser.data?.settings?.currency || 'USD',
            createdAt: firebase.firestore.FieldValue.serverTimestamp(),
            updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
            isActive: true
        });
        
        // Initialize balances for all members
        for (const memberId of allMemberIds) {
            await db.collection('balances').doc(`${groupRef.id}_${memberId}`).set({
                groupId: groupRef.id,
                oderId: memberId,
                displayName: members.find(m => m.id === memberId)?.displayName || '',
                totalPaid: 0,
                totalOwed: 0,
                netBalance: 0,
                updatedAt: firebase.firestore.FieldValue.serverTimestamp()
            });
        }
        
        // Create activity
        await createActivity(groupRef.id, 'group_created', {
            groupName: name
        }, `${currentUser.displayName} created the group "${name}"`);
        
        showToast('Group created! 🎉');
        return groupRef.id;
    } catch (error) {
        console.error('Create group error:', error);
        showToast(error.message, 'error');
        throw error;
    }
}

// Add member to group
async function addMemberToGroup(groupId, userEmail) {
    try {
        // Find user by email
        const userData = await searchUserByEmail(userEmail);
        if (!userData) {
            showToast('User not found', 'error');
            return false;
        }
        
        const groupRef = db.collection('groups').doc(groupId);
        const groupDoc = await groupRef.get();
        
        if (!groupDoc.exists) {
            showToast('Group not found', 'error');
            return false;
        }
        
        const groupData = groupDoc.data();
        
        // Check if already a member
        if (groupData.memberIds.includes(userData.id)) {
            showToast('User is already a member', 'error');
            return false;
        }
        
        // Add member
        const newMember = {
            id: userData.id,
            displayName: userData.displayName || userData.email,
            email: userData.email,
            role: 'member',
            joinedAt: firebase.firestore.FieldValue.serverTimestamp()
        };
        
        await groupRef.update({
            members: firebase.firestore.FieldValue.arrayUnion(newMember),
            memberIds: firebase.firestore.FieldValue.arrayUnion(userData.id),
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        });
        
        // Initialize balance for new member
        await db.collection('balances').doc(`${groupId}_${userData.id}`).set({
            groupId: groupId,
            oderId: userData.id,
            displayName: userData.displayName || userData.email,
            totalPaid: 0,
            totalOwed: 0,
            netBalance: 0,
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        });
        
        // Create activity
        await createActivity(groupId, 'member_joined', {
            oderId: userData.id,
            displayName: userData.displayName
        }, `${userData.displayName} joined the group`);
        
        showToast(`${userData.displayName} added to group! 👋`);
        return true;
    } catch (error) {
        console.error('Add member error:', error);
        showToast(error.message, 'error');
        return false;
    }
}

// Leave group
async function leaveGroup(groupId) {
    try {
        const groupRef = db.collection('groups').doc(groupId);
        const groupDoc = await groupRef.get();
        const groupData = groupDoc.data();
        
        // Remove current user from members
        const updatedMembers = groupData.members.filter(m => m.id !== currentUser.uid);
        const updatedMemberIds = groupData.memberIds.filter(id => id !== currentUser.uid);
        
        if (updatedMemberIds.length === 0) {
            // Delete group if no members left
            await groupRef.update({ isActive: false });
        } else {
            await groupRef.update({
                members: updatedMembers,
                memberIds: updatedMemberIds,
                updatedAt: firebase.firestore.FieldValue.serverTimestamp()
            });
        }
        
        // Create activity
        await createActivity(groupId, 'member_left', {
            oderId: currentUser.uid,
            displayName: currentUser.displayName
        }, `${currentUser.displayName} left the group`);
        
        showToast('You left the group');
        currentGroup = null;
    } catch (error) {
        console.error('Leave group error:', error);
        showToast(error.message, 'error');
    }
}

// Subscribe to user's groups (real-time)
function subscribeToGroups(callback) {
    const unsubscribe = db.collection('groups')
        .where('memberIds', 'array-contains', currentUser.uid)
        .where('isActive', '==', true)
        .orderBy('updatedAt', 'desc')
        .onSnapshot((snapshot) => {
            const groups = snapshot.docs.map(doc => ({
                id: doc.id,
                ...doc.data()
            }));
            callback(groups);
        });
    
    unsubscribers.push(unsubscribe);
    return unsubscribe;
}

// Subscribe to single group (real-time)
function subscribeToGroup(groupId, callback) {
    const unsubscribe = db.collection('groups').doc(groupId)
        .onSnapshot((doc) => {
            if (doc.exists) {
                callback({ id: doc.id, ...doc.data() });
            }
        });
    
    unsubscribers.push(unsubscribe);
    return unsubscribe;
}

// ==========================================
// EXPENSES MANAGEMENT
// ==========================================

// Add expense to group
async function addExpense(groupId, description, amount, paidById, splitMethod, splits, category = 'general') {
    try {
        const groupDoc = await db.collection('groups').doc(groupId).get();
        const groupData = groupDoc.data();
        
        // Get payer info
        const payer = groupData.members.find(m => m.id === paidById);
        
        // Create expense
        const expenseRef = await db.collection('expenses').add({
            groupId: groupId,
            description: description,
            amount: parseFloat(amount),
            currency: groupData.currency,
            paidBy: {
                oderId: paidById,
                displayName: payer?.displayName || 'Unknown'
            },
            splitMethod: splitMethod,
            splits: splits,
            category: category,
            receipt: null,
            notes: '',
            date: firebase.firestore.FieldValue.serverTimestamp(),
            createdBy: currentUser.uid,
            createdAt: firebase.firestore.FieldValue.serverTimestamp(),
            updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
            isDeleted: false
        });
        
        // Update balances
        await updateBalances(groupId, paidById, amount, splits);
        
        // Update group total
        await db.collection('groups').doc(groupId).update({
            totalExpenses: firebase.firestore.FieldValue.increment(parseFloat(amount)),
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        });
        
        // Create activity
        await createActivity(groupId, 'expense_added', {
            expenseId: expenseRef.id,
            description: description,
            amount: amount
        }, `${currentUser.displayName} added "${description}" - $${amount.toFixed(2)}`);
        
        showToast('Expense added! 💸');
        return expenseRef.id;
    } catch (error) {
        console.error('Add expense error:', error);
        showToast(error.message, 'error');
        throw error;
    }
}

// Update balances after expense
async function updateBalances(groupId, payerId, totalAmount, splits) {
    const batch = db.batch();
    
    // Update payer's balance (they paid, so positive)
    const payerBalanceRef = db.collection('balances').doc(`${groupId}_${payerId}`);
    batch.update(payerBalanceRef, {
        totalPaid: firebase.firestore.FieldValue.increment(totalAmount),
        netBalance: firebase.firestore.FieldValue.increment(totalAmount),
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    
    // Update each split member's balance
    for (const split of splits) {
        const memberBalanceRef = db.collection('balances').doc(`${groupId}_${split.userId}`);
        batch.update(memberBalanceRef, {
            totalOwed: firebase.firestore.FieldValue.increment(split.amount),
            netBalance: firebase.firestore.FieldValue.increment(-split.amount),
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        });
    }
    
    await batch.commit();
}

// Delete expense
async function deleteExpense(expenseId) {
    try {
        const expenseDoc = await db.collection('expenses').doc(expenseId).get();
        const expenseData = expenseDoc.data();
        
        // Soft delete
        await db.collection('expenses').doc(expenseId).update({
            isDeleted: true,
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        });
        
        // Reverse balances
        await reverseBalances(expenseData.groupId, expenseData.paidBy.userId, expenseData.amount, expenseData.splits);
        
        // Update group total
        await db.collection('groups').doc(expenseData.groupId).update({
            totalExpenses: firebase.firestore.FieldValue.increment(-expenseData.amount),
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        });
        
        showToast('Expense deleted');
    } catch (error) {
        console.error('Delete expense error:', error);
        showToast(error.message, 'error');
    }
}

// Reverse balances when expense is deleted
async function reverseBalances(groupId, payerId, totalAmount, splits) {
    const batch = db.batch();
    
    const payerBalanceRef = db.collection('balances').doc(`${groupId}_${payerId}`);
    batch.update(payerBalanceRef, {
        totalPaid: firebase.firestore.FieldValue.increment(-totalAmount),
        netBalance: firebase.firestore.FieldValue.increment(-totalAmount),
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    
    for (const split of splits) {
        const memberBalanceRef = db.collection('balances').doc(`${groupId}_${split.userId}`);
        batch.update(memberBalanceRef, {
            totalOwed: firebase.firestore.FieldValue.increment(-split.amount),
            netBalance: firebase.firestore.FieldValue.increment(split.amount),
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        });
    }
    
    await batch.commit();
}

// Subscribe to group expenses (real-time)
function subscribeToExpenses(groupId, callback) {
    const unsubscribe = db.collection('expenses')
        .where('groupId', '==', groupId)
        .where('isDeleted', '==', false)
        .orderBy('createdAt', 'desc')
        .onSnapshot((snapshot) => {
            const expenses = snapshot.docs.map(doc => ({
                id: doc.id,
                ...doc.data()
            }));
            callback(expenses);
        });
    
    unsubscribers.push(unsubscribe);
    return unsubscribe;
}

// ==========================================
// SETTLEMENTS
// ==========================================

// Create settlement (pay someone)
async function createSettlement(groupId, toUserId, amount, method = 'cash', note = '') {
    try {
        // Get recipient info
        const toUserDoc = await db.collection('users').doc(toUserId).get();
        const toUserData = toUserDoc.data();
        
        const settlementRef = await db.collection('settlements').add({
            groupId: groupId,
            fromUser: {
                oderId: currentUser.uid,
                displayName: currentUser.displayName
            },
            toUser: {
                oderId: toUserId,
                displayName: toUserData?.displayName || 'Unknown'
            },
            amount: parseFloat(amount),
            currency: currentUser.data?.settings?.currency || 'USD',
            method: method,
            note: note,
            confirmedByReceiver: false,
            createdAt: firebase.firestore.FieldValue.serverTimestamp(),
            confirmedAt: null
        });
        
        // Update balances
        const fromBalanceRef = db.collection('balances').doc(`${groupId}_${currentUser.uid}`);
        const toBalanceRef = db.collection('balances').doc(`${groupId}_${toUserId}`);
        
        await fromBalanceRef.update({
            netBalance: firebase.firestore.FieldValue.increment(parseFloat(amount)),
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        });
        
        await toBalanceRef.update({
            netBalance: firebase.firestore.FieldValue.increment(-parseFloat(amount)),
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        });
        
        // Create activity
        await createActivity(groupId, 'settlement', {
            settlementId: settlementRef.id,
            fromUser: currentUser.displayName,
            toUser: toUserData?.displayName,
            amount: amount
        }, `${currentUser.displayName} paid ${toUserData?.displayName} $${amount.toFixed(2)}`);
        
        showToast('Payment recorded! ✅');
        return settlementRef.id;
    } catch (error) {
        console.error('Create settlement error:', error);
        showToast(error.message, 'error');
        throw error;
    }
}

// Confirm settlement received
async function confirmSettlement(settlementId) {
    try {
        await db.collection('settlements').doc(settlementId).update({
            confirmedByReceiver: true,
            confirmedAt: firebase.firestore.FieldValue.serverTimestamp()
        });
        showToast('Payment confirmed! 🎉');
    } catch (error) {
        console.error('Confirm settlement error:', error);
        showToast(error.message, 'error');
    }
}

// Subscribe to settlements
function subscribeToSettlements(groupId, callback) {
    const unsubscribe = db.collection('settlements')
        .where('groupId', '==', groupId)
        .orderBy('createdAt', 'desc')
        .onSnapshot((snapshot) => {
            const settlements = snapshot.docs.map(doc => ({
                id: doc.id,
                ...doc.data()
            }));
            callback(settlements);
        });
    
    unsubscribers.push(unsubscribe);
    return unsubscribe;
}

// ==========================================
// BALANCES & CALCULATIONS
// ==========================================

// Get group balances (real-time)
function subscribeToBalances(groupId, callback) {
    const unsubscribe = db.collection('balances')
        .where('groupId', '==', groupId)
        .onSnapshot((snapshot) => {
            const balances = snapshot.docs.map(doc => ({
                id: doc.id,
                ...doc.data()
            }));
            callback(balances);
        });
    
    unsubscribers.push(unsubscribe);
    return unsubscribe;
}

// Calculate simplified debts (minimum transactions)
function calculateSimplifiedDebts(balances) {
    const debts = [];
    
    // Separate debtors and creditors
    const debtors = balances.filter(b => b.netBalance < -0.01).map(b => ({
        ...b,
        amount: Math.abs(b.netBalance)
    }));
    const creditors = balances.filter(b => b.netBalance > 0.01).map(b => ({
        ...b,
        amount: b.netBalance
    }));
    
    // Sort for optimal matching
    debtors.sort((a, b) => b.amount - a.amount);
    creditors.sort((a, b) => b.amount - a.amount);
    
    // Match debtors to creditors
    let i = 0, j = 0;
    while (i < debtors.length && j < creditors.length) {
        const debtor = debtors[i];
        const creditor = creditors[j];
        
        const amount = Math.min(debtor.amount, creditor.amount);
        
        if (amount > 0.01) {
            debts.push({
                from: {
                    oderId: debtor.userId,
                    displayName: debtor.displayName
                },
                to: {
                    oderId: creditor.userId,
                    displayName: creditor.displayName
                },
                amount: Math.round(amount * 100) / 100
            });
        }
        
        debtor.amount -= amount;
        creditor.amount -= amount;
        
        if (debtor.amount < 0.01) i++;
        if (creditor.amount < 0.01) j++;
    }
    
    return debts;
}

// Get user's total balance across all groups
async function getUserTotalBalance() {
    try {
        const balancesSnapshot = await db.collection('balances')
            .where('userId', '==', currentUser.uid)
            .get();
        
        let totalOwed = 0;  // Money others owe you
        let totalOwe = 0;   // Money you owe others
        
        balancesSnapshot.docs.forEach(doc => {
            const balance = doc.data();
            if (balance.netBalance > 0) {
                totalOwed += balance.netBalance;
            } else {
                totalOwe += Math.abs(balance.netBalance);
            }
        });
        
        return { totalOwed, totalOwe };
    } catch (error) {
        console.error('Get total balance error:', error);
        return { totalOwed: 0, totalOwe: 0 };
    }
}

// ==========================================
// ACTIVITY FEED
// ==========================================

// Create activity entry
async function createActivity(groupId, type, data, message) {
    try {
        await db.collection('activities').add({
            groupId: groupId,
            type: type,
            actor: {
                oderId: currentUser.uid,
                displayName: currentUser.displayName
            },
            data: data,
            message: message,
            createdAt: firebase.firestore.FieldValue.serverTimestamp(),
            readBy: [currentUser.uid]
        });
    } catch (error) {
        console.error('Create activity error:', error);
    }
}

// Subscribe to group activities (real-time)
function subscribeToActivities(groupId, callback, limit = 50) {
    const unsubscribe = db.collection('activities')
        .where('groupId', '==', groupId)
        .orderBy('createdAt', 'desc')
        .limit(limit)
        .onSnapshot((snapshot) => {
            const activities = snapshot.docs.map(doc => ({
                id: doc.id,
                ...doc.data()
            }));
            callback(activities);
        });
    
    unsubscribers.push(unsubscribe);
    return unsubscribe;
}

// Mark activity as read
async function markActivityAsRead(activityId) {
    try {
        await db.collection('activities').doc(activityId).update({
            readBy: firebase.firestore.FieldValue.arrayUnion(currentUser.uid)
        });
    } catch (error) {
        console.error('Mark activity read error:', error);
    }
}

// ==========================================
// REAL-TIME PRESENCE
// ==========================================

// Set user presence in group
function setPresence(groupId, online = true) {
    if (!currentUser) return;
    
    const presenceRef = rtdb.ref(`presence/${groupId}/${currentUser.uid}`);
    
    presenceRef.set({
        oderId: currentUser.uid,
        displayName: currentUser.displayName,
        online: online,
        lastSeen: firebase.database.ServerValue.TIMESTAMP
    });
    
    // Set offline on disconnect
    presenceRef.onDisconnect().update({
        online: false,
        lastSeen: firebase.database.ServerValue.TIMESTAMP
    });
}

// Subscribe to group presence
function subscribeToPresence(groupId, callback) {
    const presenceRef = rtdb.ref(`presence/${groupId}`);
    
    presenceRef.on('value', (snapshot) => {
        const presenceData = snapshot.val() || {};
        const onlineMembers = Object.values(presenceData).filter(p => p.online);
        callback(onlineMembers);
    });
    
    return () => presenceRef.off('value');
}

// ==========================================
// UTILITY FUNCTIONS
// ==========================================

// Format currency
function formatCurrency(amount, currency = 'USD') {
    return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: currency
    }).format(amount);
}

// Show toast notification
function showToast(message, type = 'success') {
    const toast = document.getElementById('toast');
    if (toast) {
        toast.textContent = message;
        toast.className = `toast ${type} show`;
        setTimeout(() => {
            toast.className = 'toast';
        }, 3000);
    }
}

// Show auth screen
function showAuthScreen() {
    document.getElementById('authScreen').style.display = 'flex';
    document.getElementById('mainApp').style.display = 'none';
}

// Show main app
function showMainApp() {
    document.getElementById('authScreen').style.display = 'none';
    document.getElementById('mainApp').style.display = 'block';
}

// Initialize app after auth
function initializeApp() {
    // Load user's data
    loadUserDashboard();
    
    // Subscribe to groups
    subscribeToGroups((groups) => {
        renderGroups(groups);
    });
    
    // Subscribe to friends
    subscribToFriends(({ friends, pendingRequests }) => {
        renderFriends(friends);
        renderPendingRequests(pendingRequests);
    });
    
    // Update user balance summary
    updateBalanceSummary();
}

// Update balance summary on dashboard
async function updateBalanceSummary() {
    const { totalOwed, totalOwe } = await getUserTotalBalance();
    
    const owedElement = document.getElementById('totalOwedToYou');
    const oweElement = document.getElementById('totalYouOwe');
    
    if (owedElement) owedElement.textContent = formatCurrency(totalOwed);
    if (oweElement) oweElement.textContent = formatCurrency(totalOwe);
}

// Load user dashboard
function loadUserDashboard() {
    const userNameElement = document.getElementById('userName');
    if (userNameElement && currentUser) {
        userNameElement.textContent = currentUser.displayName || currentUser.email;
    }
}

// Export functions for global access
window.signUp = signUp;
window.signIn = signIn;
window.signInWithGoogle = signInWithGoogle;
window.signOut = signOut;
window.sendFriendRequest = sendFriendRequest;
window.acceptFriendRequest = acceptFriendRequest;
window.removeFriend = removeFriend;
window.createGroup = createGroup;
window.addMemberToGroup = addMemberToGroup;
window.leaveGroup = leaveGroup;
window.addExpense = addExpense;
window.deleteExpense = deleteExpense;
window.createSettlement = createSettlement;
window.confirmSettlement = confirmSettlement;
window.calculateSimplifiedDebts = calculateSimplifiedDebts;
window.formatCurrency = formatCurrency;
