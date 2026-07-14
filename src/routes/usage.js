const express = require('express');
const pool = require('../db/postgres');
const { authenticateToken } = require('../middleware/auth');
const { requireActiveUser } = require('../middleware/planGuard');
const { resolveUserPlan } = require('../services/planAccess');
const router = express.Router();

// Monta o objeto de uso do usuário (testável isoladamente).
async function buildUsage(user) {
  const plan = await resolveUserPlan(user);
  const rc = await pool.query(`SELECT COUNT(*)::int AS count FROM restaurants WHERE user_id = $1`, [user.id]);
  const oc = await pool.query(
    `SELECT COUNT(*)::int AS count FROM orders
     WHERE user_id = $1 AND created_at >= date_trunc('month', now())`, [user.id]
  );
  const orders_this_month = parseInt(oc.rows[0].count, 10);
  const over_limit = plan.max_orders_month !== 0 && orders_this_month > plan.max_orders_month;
  return {
    plan: plan.slug,
    capabilities: plan.capabilities,
    restaurants_count: parseInt(rc.rows[0].count, 10),
    max_restaurants: plan.max_restaurants,
    orders_this_month,
    max_orders_month: plan.max_orders_month,
    over_limit,
  };
}

router.get('/', authenticateToken, requireActiveUser, async (req, res) => {
  try { return res.json(await buildUsage(req.user)); }
  catch (err) { return res.status(500).json({ error: 'usage_failed', details: err.message }); }
});

module.exports = router;
module.exports.buildUsage = buildUsage;
