const express = require('express');
const pool = require('../db/postgres');
const { authenticateToken, requireAdmin } = require('../middleware/auth');
const ifoodAPI = require('../services/ifood-api-complete');
const ifoodDistributed = require('../services/ifood-distributed');
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

// POST /api/v1/admin/menu/fetch — Buscar cardápio via API real
router.post('/fetch', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { restaurant_id, platform } = req.body;
    
    if (!restaurant_id || !platform) {
      return res.status(400).json({ error: 'restaurant_id e platform são obrigatórios' });
    }

    console.log(`[menu fetch] Buscando cardápio: restaurante=${restaurant_id}, plataforma=${platform}`);

    // Buscar dados de acesso da plataforma
    const platData = await pool.query(
      `SELECT rp.platform_store_id, rp.platform_merchant_id
       FROM restaurant_platforms rp
       WHERE rp.restaurant_id = $1 AND rp.platform = $2`,
      [restaurant_id, platform]
    );

    if (platData.rows.length === 0) {
      console.log('[menu fetch] Plataforma não configurada');
      return res.json({ platform, items: [], items_count: 0, message: 'Nenhuma integração configurada' });
    }

    const { platform_merchant_id, platform_store_id } = platData.rows[0];
    let items = [];

    // Buscar via API REAL do iFood (usando o token da loja autorizada — modelo distribuído)
    if (platform === 'ifood') {
      try {
        const token = await ifoodDistributed.getAccessToken(req.user.id);
        const merchantId = platform_merchant_id || platform_store_id;
        console.log(`[menu fetch] usando merchantId=${merchantId}`);
        items = await ifoodAPI.getMenuItems(merchantId, token);
        console.log(`[menu fetch] ${items.length} items obtidos do iFood via API`);
      } catch (err) {
        console.error('[menu fetch] erro ao buscar do iFood:', err.message);
        return res.status(500).json({ error: 'Erro ao buscar cardápio do iFood', details: err.message });
      }
    } else if (platform === '99food') {
      // TODO: Implementar 99Food API
      return res.json({ platform, items: [], items_count: 0, message: '99Food em desenvolvimento' });
    }

    // Salvar items no banco
    if (items.length > 0) {
      const itemsJson = JSON.stringify(items);
      await pool.query(
        `INSERT INTO menu_items (restaurant_id, platform, platform_store_id, items_data, updated_at, created_at)
         VALUES ($1, $2, $3, $4, NOW(), NOW())
         ON CONFLICT (restaurant_id, platform) DO UPDATE SET
           items_data = EXCLUDED.items_data,
           updated_at = NOW()`,
        [restaurant_id, platform, platform_merchant_id || platform_store_id, itemsJson]
      );
    }

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

    // Inserir no banco
    const result = await pool.query(
      `INSERT INTO menu_copies (from_restaurant_id, to_restaurant_id, from_platform, to_platform, items_copied, copied_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       RETURNING id`,
      [from_restaurant_id, to_restaurant_id, from_platform || '', to_platform || '', JSON.stringify(selected_items || [])]
    );

    console.log(`[menu copy] Cópia registrada com ID: ${result.rows[0]?.id}`);

    res.json({ 
      success: true, 
      message: `${itemsCount} itens copiados com sucesso!`,
      copied_items: itemsCount,
      copy_id: result.rows[0]?.id
    });
  } catch (err) {
    console.error('[menu copy] erro:', err.message);
    res.status(500).json({ error: 'Erro ao copiar cardápio', details: err.message });
  }
});

module.exports = router;
