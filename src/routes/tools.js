const express = require('express');
const pool = require('../db/postgres');
const food99 = require('../services/food99');
const { authenticateToken } = require('../middleware/auth');
const router = express.Router();

router.use(authenticateToken);

// GET /api/v1/tools/stores — lista todas as lojas conectadas do usuário (id + nome).
// Útil para saber "de qual loja é este ID".
router.get('/stores', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT r.name AS store_name, rp.platform,
              COALESCE(rp.app_shop_id, rp.platform_merchant_id, rp.platform_store_id) AS store_id,
              rp.status
         FROM restaurant_platforms rp
         JOIN restaurants r ON r.id = rp.restaurant_id
        WHERE r.user_id = $1
        ORDER BY r.name ASC`,
      [req.user.id]
    );
    return res.json({ count: r.rows.length, stores: r.rows });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/v1/tools/store?store_id=XXX[&platform=99food&live=1]
// Retorna o nome da loja pelo ID. Busca no nosso banco e, se live=1 e for 99Food
// conectada, tenta também o nome AO VIVO na API do 99Food.
router.get('/store', async (req, res) => {
  const storeId = String(req.query.store_id || '').trim();
  const platform = req.query.platform ? String(req.query.platform) : null;
  const live = req.query.live === '1';
  if (!storeId) return res.status(400).json({ error: 'store_id é obrigatório' });

  try {
    // 1) Procura no nosso banco (entre as lojas do usuário)
    const params = [req.user.id, storeId];
    let q = `SELECT r.name AS store_name, rp.platform, rp.status,
                    COALESCE(rp.app_shop_id, rp.platform_merchant_id, rp.platform_store_id) AS store_id
               FROM restaurant_platforms rp
               JOIN restaurants r ON r.id = rp.restaurant_id
              WHERE r.user_id = $1
                AND (rp.app_shop_id = $2 OR rp.platform_merchant_id = $2 OR rp.platform_store_id = $2)`;
    if (platform) { q += ` AND rp.platform = $3`; params.push(platform); }
    q += ` LIMIT 1`;
    const db = await pool.query(q, params);
    const dbRow = db.rows[0] || null;

    const out = {
      store_id: storeId,
      platform: platform || dbRow?.platform || null,
      found: !!dbRow,
      name: dbRow?.store_name || null,
      status: dbRow?.status || null,
      live_name: null,
      live_error: null,
    };

    // 2) Nome ao vivo (só 99Food conectada — precisa do token da loja)
    if (live && (out.platform === '99food' || platform === '99food')) {
      try {
        const token = await food99.getValidToken(storeId);
        const detail = await food99.getStoreDetail(token);
        out.live_name = detail?.name || detail?.shop_name || null;
      } catch (e) {
        out.live_error = e.message;
      }
    }

    if (!out.found && !out.live_name) {
      return res.status(404).json({ ...out, error: 'Loja não encontrada para este ID (não está conectada nesta conta)' });
    }
    return res.json(out);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
