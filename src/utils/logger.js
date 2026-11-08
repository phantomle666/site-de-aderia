const pool = require('../config/database');

async function logAudit(req, { action, targetType, targetId = null, beforeState = null, afterState = null }) {
  try {
    const adminId = req.session?.admin?.id || null;
    const adminUsername = req.session?.admin?.username || 'SYSTEM/ANON';
    const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress || 'unknown';

    await pool.query(
      `INSERT INTO audit_logs (admin_id, admin_username, action, target_type, target_id, ip_address, before_state, after_state)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        adminId,
        adminUsername,
        action,
        targetType,
        String(targetId),
        ip,
        beforeState ? JSON.stringify(beforeState) : null,
        afterState ? JSON.stringify(afterState) : null
      ]
    );
  } catch (err) {
    console.error('[AUDIT_ERROR] Échec enregistrement audit:', err.message);
  }
}

module.exports = { logAudit };
