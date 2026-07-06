const express = require('express');
const pool = require('../db/postgres');
const { authenticateToken, requireAdmin } = require('../middleware/auth');
const menu99food = require('../services/menu99food');
const menuifood = require('../services/menuifood');
const router = express.Router();

// GET /api/v1/admin/menu/restaurants
router.get('/restaurants', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const restaurants = await pool.query(
      `SELECT r.id, r.name, r.user_id,
              json_agg(json_build_object('platform', rp.platform, 'platform_id', rp.platform_store_id, 'status', rp.status)) as integrations
       FROM restaurants r
       LEFT JOIN restaurant_platforms rp ON r.id = rp.restaurant_id
       WHERE r.user_id = $1
       GROUP BY r.id, r.name, r.user_id
       ORDER BY r.name`,
      [req.user.id]
    );
    res.json(restaurants.rows);
  } catch (err) {
    console.error('[admin menu] erro ao listar restaurantes:', err.message);
    res.status(500).json({ error: 'Erro ao buscar restaurantes' });
  }
});

// POST /api/v1/admin/menu/fetch
router.post('/fetch', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { restaurant_id, platform } = req.body;
    if (!restaurant_id || !platform) {
      return res.status(400).json({ error: 'restaurant_id e platform são obrigatórios' });
    }

    // Buscar dados de acesso da plataforma
    const platData = await pool.query(
      `SELECT rp.platform_store_id, rp.access_token, rp.access_data
       FROM restaurant_platforms rp
       WHERE rp.restaurant_id = $1 AND rp.platform = $2`,
      [restaurant_id, platform]
    );

    if (platData.rows.length === 0) {
      return res.status(404).json({ error: 'Plataforma não configurada para este restaurante' });
    }

    const { platform_store_id, access_token, access_data } = platData.rows[0];
    let items = [];

    if (platform === '99food') {
      items = await menu99food.getMenuItems(platform_store_id, access_token);
    } else if (platform === 'ifood') {
      items = await menuifood.getMenuItems(platform_store_id, access_token);
    }

    res.json({ platform, items, items_count: items.length });
  } catch (err) {
    console.error('[admin menu fetch] erro:', err.message);
    res.status(500).json({ error: 'Erro ao buscar cardápio' });
  }
});

// GET /api/v1/admin/menu/items/:restaurant_id/:platform
router.get('/items/:restaurant_id/:platform', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { restaurant_id, platform } = req.params;
    const items = await pool.query(
      `SELECT items_data FROM menu_items 
       WHERE restaurant_id = $1 AND platform = $2`,
      [restaurant_id, platform]
    );
    res.json(items.rows);
  } catch (err) {
    console.error('[admin menu items] erro:', err.message);
    res.status(500).json({ error: 'Erro ao buscar itens salvos' });
  }
});

// POST /api/v1/admin/menu/copy
router.post('/copy', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { from_restaurant_id, to_restaurant_id, from_platform, to_platform, selected_items } = req.body;
    
    if (!from_restaurant_id || !to_restaurant_id || !from_platform || !to_platform) {
      return res.status(400).json({ error: 'Todos os parâmetros são obrigatórios' });
    }

    // Registrar cópia no banco
    const copy = await pool.query(
      `INSERT INTO menu_copies (from_restaurant_id, to_restaurant_id, from_platform, to_platform, items_copied, copied_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       RETURNING *`,
      [from_restaurant_id, to_restaurant_id, from_platform, to_platform, JSON.stringify(selected_items || [])]
    );

    res.json({ success: true, copied_items: selected_items?.length || 0, copy_id: copy.rows[0].id });
  } catch (err) {
    console.error('[admin menu copy] erro:', err.message);
    res.status(500).json({ error: 'Erro ao copiar cardápio' });
  }
});

module.exports = router;
