const pool = require('../db/postgres');
const { hasCapability } = require('../services/planAccess');
const { isPlanGatingEnabled } = require('../config/featureFlags');

// Trava a rota se o plano do usuário não tem a capacidade.
function requireCapability(key) {
  return async (req, res, next) => {
    if (!isPlanGatingEnabled()) return next();
    try {
      if (await hasCapability(req.user, key)) return next();
      return res.status(403).json({ error: 'plan_upgrade_required', capability: key });
    } catch (err) {
      return res.status(500).json({ error: 'plan_check_failed', details: err.message });
    }
  };
}

// Rejeita usuário inativo ou com trial expirado.
async function requireActiveUser(req, res, next) {
  if (!isPlanGatingEnabled()) return next();
  try {
    const r = await pool.query(
      `SELECT active, plan, plan_expires_at FROM users WHERE id = $1`, [req.user.id]
    );
    const u = r.rows[0];
    if (!u || u.active === false) return res.status(403).json({ error: 'account_inactive' });
    if (u.plan === 'free' && u.plan_expires_at && new Date(u.plan_expires_at) < new Date()) {
      return res.status(403).json({ error: 'trial_expired' });
    }
    return next();
  } catch (err) {
    return res.status(500).json({ error: 'account_check_failed', details: err.message });
  }
}

module.exports = { requireCapability, requireActiveUser };
