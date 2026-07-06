const express = require('express');
const pool = require('../db/postgres');
const { authenticateToken, requireAdmin } = require('../middleware/auth');
const router = express.Router();

// GET /api/v1/admin/menu/restaurants
router.get('/restaurants', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const restaurants = await pool.query(
      `SELECT r.id, r.name, r.user_id,
              json_agg(json_build_object('platform', rp.platform, 'platform_id', rp.platform_store_id, 'status', rp.status)) as integrations
       FROM restaurants r
       LEFT JOIN restaurant_platforms rp ON r.id = rp.restaurant_id
       GROUP BY r.id, r.name, r.user_id
       ORDER BY r.name`
    );
    res.json(restaurants.rows);
  } catch (err) {
    console.error('[admin menu] erro:', err.message);
    res.status(500).json({ error: 'Erro ao buscar restaurantes' });
  }
});

// POST /api/v1/admin/menu/fetch
router.post('/fetch', authenticateToken, requireAdmin, async (req, res) => {
  const { restaurant_id, platform } = req.body;
  if (!restaurant_id || !platform) {
    return res.status(400).json({ error: 'restaurant_id e platform são obrigatórios' });
  }
  res.json({ platform, items: [], items_count: 0 });
});

module.exports = router;
