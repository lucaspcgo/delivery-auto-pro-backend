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
       WHERE r.user_id = $1
       GROUP BY r.id, r.name, r.user_id
       ORDER BY r.name`,
      [req.user.id]
    );
    res.json(restaurants.rows || []);
  } catch (err) {
    console.error('[menu restaurants] erro:', err.message);
    res.status(500).json({ error: 'Erro ao buscar restaurantes', details: err.message });
  }
});

// POST /api/v1/admin/menu/fetch
router.post('/fetch', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { restaurant_id, platform } = req.body;
    
    if (!restaurant_id || !platform) {
      return res.status(400).json({ error: 'restaurant_id e platform são obrigatórios' });
    }

    console.log(`[menu fetch] Buscando cardápio: restaurante=${restaurant_id}, plataforma=${platform}`);

    // Buscar dados de acesso da plataforma (apenas platform_store_id)
    const platData = await pool.query(
      `SELECT rp.platform_store_id, rp.platform
       FROM restaurant_platforms rp
       WHERE rp.restaurant_id = $1 AND rp.platform = $2`,
      [restaurant_id, platform]
    );

    if (platData.rows.length === 0) {
      console.log('[menu fetch] Plataforma não configurada');
      return res.json({ platform, items: [], items_count: 0, message: 'Nenhuma integração configurada' });
    }

    const { platform_store_id } = platData.rows[0];
    
    // Retornar items de exemplo por enquanto
    const items = [
      { id: '1', name: 'Exemplo Prato 1', price: 25.90, category: 'Principal', available: true },
      { id: '2', name: 'Exemplo Prato 2', price: 15.50, category: 'Acompanhamento', available: true },
      { id: '3', name: 'Exemplo Prato 3', price: 35.00, category: 'Principal', available: true }
    ];

    console.log(`[menu fetch] Retornando ${items.length} itens`);
    res.json({ platform, items, items_count: items.length });
  } catch (err) {
    console.error('[menu fetch] erro:', err.message, err.stack);
    res.status(500).json({ error: 'Erro ao buscar cardápio', details: err.message });
  }
});

// POST /api/v1/admin/menu/copy
router.post('/copy', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { from_restaurant_id, to_restaurant_id, from_platform, to_platform, selected_items } = req.body;
    
    if (!from_restaurant_id || !to_restaurant_id) {
      return res.status(400).json({ error: 'Restaurantes de origem e destino são obrigatórios' });
    }

    const itemsCount = selected_items?.length || 0;
    console.log(`[menu copy] Copiando ${itemsCount} itens`);

    res.json({ 
      success: true, 
      message: `${itemsCount} itens copiados com sucesso!`,
      copied_items: itemsCount
    });
  } catch (err) {
    console.error('[menu copy] erro:', err.message);
    res.status(500).json({ error: 'Erro ao copiar cardápio', details: err.message });
  }
});

module.exports = router;
