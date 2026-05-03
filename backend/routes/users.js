import { Router } from 'express';
import bcrypt from 'bcrypt';
import { v4 as uuidv4 } from 'uuid';
import { requireAuth, requireRole } from '../auth.js';
import {
  getAllUsers,
  getUserByExternalId,
  getUserByUsername,
  createUser,
  updateUser,
  updateUserPassword,
  deleteUser,
} from '../convexClient.js';
import { validateStrongPassword } from '../security.js';

const router = Router();

// All user management routes require admin
router.use(requireAuth, requireRole('admin'));

function activeAdmins(users) {
  return users.filter((user) => user.role === 'admin' && user.is_active !== false);
}

async function wouldRemoveLastActiveAdmin(targetId, updates = {}) {
  const users = await getAllUsers();
  const target = users.find((user) => user.externalId === targetId);
  if (!target || target.role !== 'admin' || target.is_active === false) return false;
  const nextRole = updates.role ?? target.role;
  const nextActive = updates.is_active ?? target.is_active;
  const removingAdminPower = nextRole !== 'admin' || nextActive === false || updates.delete === true;
  if (!removingAdminPower) return false;
  return activeAdmins(users).length <= 1;
}

// List all users (excludes password_hash)
router.get('/', async (req, res) => {
  try {
    const users = await getAllUsers();
    const sanitized = users.map(u => ({
      id: u.externalId,
      username: u.username,
      display_name: u.display_name,
      role: u.role,
      is_active: u.is_active,
      created_by: u.created_by || null,
      created_at: u.created_at,
      updated_at: u.updated_at,
    }));
    res.json(sanitized);
  } catch (err) {
    console.error('[Users] List error:', err.message);
    res.status(500).json({ error: 'Failed to list users' });
  }
});

// Create user
router.post('/', async (req, res) => {
  try {
    const { username, display_name, password, role } = req.body;
    if (!username || !password || !role) {
      return res.status(400).json({ error: 'Username, password, and role are required' });
    }
    const passwordError = validateStrongPassword(password);
    if (passwordError) {
      return res.status(400).json({ error: passwordError });
    }
    const validRoles = ['admin', 'manager', 'poster'];
    if (!validRoles.includes(role)) {
      return res.status(400).json({ error: `Role must be one of: ${validRoles.join(', ')}` });
    }

    // Check for duplicate username
    const existing = await getUserByUsername(username);
    if (existing) {
      return res.status(409).json({ error: 'Username already exists' });
    }

    const hash = await bcrypt.hash(password, 12);
    const userId = uuidv4();
    await createUser({
      externalId: userId,
      username,
      display_name: display_name || username,
      password_hash: hash,
      role,
      is_active: true,
      created_by: req.user.id,
    });

    res.json({
      success: true,
      user: {
        id: userId,
        username,
        display_name: display_name || username,
        role,
        is_active: true,
      }
    });
  } catch (err) {
    console.error('[Users] Create error:', err.message);
    res.status(500).json({ error: err.message || 'Failed to create user' });
  }
});

// Update user (display_name, role, is_active)
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { display_name, role, is_active } = req.body;

    const user = await getUserByExternalId(id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Cannot change own role
    if (id === req.user.id && role !== undefined && role !== user.role) {
      return res.status(400).json({ error: 'Cannot change your own role' });
    }
    if (id === req.user.id && is_active === false) {
      return res.status(400).json({ error: 'Cannot deactivate your own account' });
    }

    if (role) {
      const validRoles = ['admin', 'manager', 'poster'];
      if (!validRoles.includes(role)) {
        return res.status(400).json({ error: `Role must be one of: ${validRoles.join(', ')}` });
      }
    }

    const updates = {};
    if (display_name !== undefined) updates.display_name = display_name;
    if (role !== undefined) updates.role = role;
    if (is_active !== undefined) updates.is_active = is_active;

    if (await wouldRemoveLastActiveAdmin(id, updates)) {
      return res.status(400).json({ error: 'Cannot remove the last active admin account' });
    }

    await updateUser(id, updates);

    res.json({ success: true });
  } catch (err) {
    console.error('[Users] Update error:', err.message);
    res.status(500).json({ error: 'Failed to update user' });
  }
});

// Reset user password (admin sets new password)
router.put('/:id/reset-password', async (req, res) => {
  try {
    const { id } = req.params;
    const { newPassword } = req.body;
    const passwordError = validateStrongPassword(newPassword, 'New password');
    if (passwordError) {
      return res.status(400).json({ error: passwordError });
    }

    const user = await getUserByExternalId(id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    if (id === req.user.id) {
      const { currentPassword } = req.body;
      if (!currentPassword || !(await bcrypt.compare(currentPassword, user.password_hash))) {
        return res.status(400).json({ error: 'Current password is required to reset your own password' });
      }
    }

    const hash = await bcrypt.hash(newPassword, 12);
    await updateUserPassword(id, hash);

    res.json({ success: true });
  } catch (err) {
    console.error('[Users] Reset password error:', err.message);
    res.status(500).json({ error: 'Failed to reset password' });
  }
});

// Delete user
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    // Cannot delete self
    if (id === req.user.id) {
      return res.status(400).json({ error: 'Cannot delete your own account' });
    }

    const user = await getUserByExternalId(id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    if (await wouldRemoveLastActiveAdmin(id, { delete: true })) {
      return res.status(400).json({ error: 'Cannot delete the last active admin account' });
    }

    await deleteUser(id);
    res.json({ success: true });
  } catch (err) {
    console.error('[Users] Delete error:', err.message);
    res.status(500).json({ error: 'Failed to delete user' });
  }
});

export default router;
