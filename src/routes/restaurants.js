const express = require('express');
const pool = require('../db/postgres');
const { authenticateToken } = require('../middleware/auth');
const { checkRestaurantLimit } = require('../services/planAccess');
const router = express.Router();

// DEBUG: teste iFood (SEM autenticação)
router.post('/test-ifood/:merchant_id', async (req, res) => {
  const { merchant_id } = req.params;
  try {
    const ifood = require('../services/ifood');
    const token = await ifood.getValidToken();
    const https = require('https');
    const merchantData = await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'merchant-api.ifood.com.br',
        path: `/merchant/v1.0/merchants/${merchant_id}`,
        method: 'GET',
        headers: { 'Authorization': `Bearer ${token}` }
      }, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => resolve(JSON.parse(data)));
      });
      req.on('error', reject);
      req.end();
    });
    res.json({ merchant_id, response: merchantData });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Autenticação obrigatória a partir daqui
router.use(authenticateToken);

// PUT /automation — liga/desliga a automação de UMA loja.
// (Declarada ANTES de /:id para não ser confundida com um id.)
// Body: { platform, store_id, enabled }  (store_id = app_shop_id ou merchant id)
router.put('/automation', async (req, res) => {
  const { platform, store_id, enabled } = req.body || {};
  if (!platform || !store_id || typeof enabled === 'undefined') {
    return res.status(400).json({ error: 'platform, store_id e enabled são obrigatórios' });
  }
  const on = enabled === true || enabled === 'true' || enabled === 1 || enabled === '1';
  try {
    // Garante que a coluna existe (idempotente)
    await pool.query(`ALTER TABLE restaurant_platforms ADD COLUMN IF NOT EXISTS automation_enabled BOOLEAN DEFAULT true`);
    const upd = await pool.query(
      `UPDATE restaurant_platforms SET automation_enabled = $1, updated_at = now()
        WHERE platform = $2 AND user_id = $3
          AND (app_shop_id = $4 OR platform_merchant_id = $4 OR platform_store_id = $4)
        RETURNING restaurant_id, app_shop_id, platform_merchant_id, automation_enabled`,
      [on, platform, req.user.id, String(store_id)]
    );
    if (upd.rowCount === 0) return res.status(404).json({ error: 'Loja não encontrada para este usuário' });
    console.log(`[automation] loja ${store_id} (${platform}) automação ${on ? 'LIGADA' : 'DESLIGADA'} (user ${req.user.id})`);
    return res.json({ success: true, platform, store_id: String(store_id), automation_enabled: on });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// POST /authorize — buscar loja e cadastrar
router.post('/authorize', async (req, res) => {
  const { platform, platform_id } = req.body;
  if (!platform || !platform_id) return res.status(400).json({ error: 'Plataforma e ID são obrigatórios' });

  try {
    let shopName = '';
    let shopAddress = '';
    let merchantId = null;
    let appShopId = null;
    let storeId = null;

    if (platform === 'ifood') {
      const ifood = require('../services/ifood');
      const token = await ifood.getValidToken();
      const https = require('https');
      const merchantData = await new Promise((resolve, reject) => {
        const req = https.request({
          hostname: 'merchant-api.ifood.com.br',
          path: `/merchant/v1.0/merchants/${platform_id}`,
          method: 'GET',
          headers: { 'Authorization': `Bearer ${token}` }
        }, (res) => {
          let data = '';
          res.on('data', c => data += c);
          res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(new Error('Resposta inválida')); } });
        });
        req.on('error', reject);
        req.end();
      });
      if (merchantData.status === 404 || merchantData.code) {
        return res.status(404).json({ error: 'Loja não encontrada no iFood. Verifique o Merchant ID.' });
      }
      shopName = merchantData.name || merchantData.corporateName || `iFood - ${platform_id}`;
      shopAddress = merchantData.address ? `${merchantData.address.streetName}, ${merchantData.address.streetNumber} - ${merchantData.address.neighborhood}` : '';
      merchantId = platform_id;

    } else if (platform === '99food') {
      const food99 = require('../services/food99');
      try {
        await food99.getValidToken(platform_id);
        shopName = `Loja 99Food (${platform_id})`;
        appShopId = platform_id;
      } catch (err) {
        return res.status(404).json({ error: 'Loja não encontrada na 99Food. Verifique o App Shop ID.' });
      }

    } else if (platform === 'keeta') {
      shopName = `Loja Keeta (${platform_id})`;
      storeId = platform_id;
    }

    const existing = await pool.query(
      `SELECT r.id, r.name FROM restaurants r
       JOIN restaurant_platforms rp ON rp.restaurant_id = r.id
       WHERE rp.platform = $1 AND (rp.platform_merchant_id = $2 OR rp.app_shop_id = $2 OR rp.platform_store_id = $2) AND r.user_id = $3`,
      [platform, platform_id, req.user.id]
    );

    if (existing.rows.length > 0) {
      return res.json({
        exists: true,
        restaurant: existing.rows[0],
        shop_name: existing.rows[0].name,
        message: 'Restaurante já cadastrado!'
      });
    }

    const inserted = await pool.query(
      `INSERT INTO restaurants (name, address, user_id) VALUES ($1, $2, $3) RETURNING *`,
      [shopName, shopAddress || null, req.user.id]
    );
    const restaurantId = inserted.rows[0].id;

    await pool.query(
      `INSERT INTO restaurant_platforms (restaurant_id, platform, platform_merchant_id, app_shop_id, platform_store_id, status, user_id)
       VALUES ($1, $2, $3, $4, $5, 'authorized', $6)`,
      [restaurantId, platform, merchantId, appShopId, storeId, req.user.id]
    );

    console.log(`[authorize] restaurante ${shopName} cadastrado via ${platform} (${platform_id}) - user: ${req.user.id}`);

    return res.json({
      exists: false,
      restaurant: inserted.rows[0],
      shop_name: shopName,
      shop_address: shopAddress,
      message: 'Loja encontrada e cadastrada!'
    });

  } catch (err) {
    console.error('[authorize] erro:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// GET /
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT r.*, 
        (SELECT json_agg(rp.*) FROM restaurant_platforms rp WHERE rp.restaurant_id = r.id) as platforms
       FROM restaurants r
       WHERE r.active = true AND r.user_id = $1
       ORDER BY r.created_at DESC`,
      [req.user.id]
    );
    return res.json(result.rows);
  } catch (err) {
    console.error('[restaurants] erro:', err.message);
    return res.status(500).json({ error: 'Erro ao buscar restaurantes' });
  }
});

// GET /:id
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      `SELECT r.*, 
        (SELECT json_agg(rp.*) FROM restaurant_platforms rp WHERE rp.restaurant_id = r.id) as platforms
       FROM restaurants r WHERE r.id = $1 AND r.user_id = $2`, 
      [id, req.user.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Restaurante não encontrado' });
    return res.json(result.rows[0]);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// POST /
router.post('/', async (req, res) => {
  const { name, owner_name, phone, email, address } = req.body;
  if (!name) return res.status(400).json({ error: 'Nome é obrigatório' });
  try {
    const gate = await checkRestaurantLimit(req.user.id, req.user);
    if (!gate.allowed) {
      return res.status(403).json({ error: 'plan_limit_reached', limit: 'max_restaurants', max: gate.limit });
    }
    const result = await pool.query(
      `INSERT INTO restaurants (name, owner_name, phone, email, address, user_id)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [name, owner_name || null, phone || null, email || null, address || null, req.user.id]
    );
    console.log(`[restaurants] criado: ${name} (user: ${req.user.id})`);
    return res.status(201).json(result.rows[0]);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// PUT /:id
router.put('/:id', async (req, res) => {
  const { id } = req.params;
  const { name, owner_name, phone, email, address } = req.body;
  try {
    const check = await pool.query(
      'SELECT id FROM restaurants WHERE id = $1 AND user_id = $2',
      [id, req.user.id]
    );
    if (check.rowCount === 0) {
      return res.status(403).json({ error: 'Acesso negado' });
    }

    const result = await pool.query(
      `UPDATE restaurants SET name=COALESCE($1,name), owner_name=COALESCE($2,owner_name), 
       phone=COALESCE($3,phone), email=COALESCE($4,email), address=COALESCE($5,address), 
       updated_at=now() WHERE id=$6 AND user_id=$7 RETURNING *`,
      [name, owner_name, phone, email, address, id, req.user.id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Restaurante não encontrado' });
    return res.json(result.rows[0]);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// DELETE /:id
router.delete('/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(
      'UPDATE restaurants SET active=false, updated_at=now() WHERE id=$1 AND user_id=$2 RETURNING id',
      [id, req.user.id]
    );
    if (result.rowCount === 0) {
      return res.status(403).json({ error: 'Acesso negado' });
    }
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// POST /:id/platforms
router.post('/:id/platforms', async (req, res) => {
  const { id } = req.params;
  const { platform, platform_store_id, platform_merchant_id, app_shop_id } = req.body;
  if (!platform) return res.status(400).json({ error: 'Plataforma é obrigatória' });
  try {
    const check = await pool.query(
      'SELECT id FROM restaurants WHERE id = $1 AND user_id = $2',
      [id, req.user.id]
    );
    if (check.rowCount === 0) {
      return res.status(403).json({ error: 'Acesso negado' });
    }

    const result = await pool.query(
      `INSERT INTO restaurant_platforms (restaurant_id, platform, platform_store_id, platform_merchant_id, app_shop_id, status, user_id)
       VALUES ($1,$2,$3,$4,$5,'authorized',$6)
       ON CONFLICT (restaurant_id, platform) DO UPDATE SET 
         platform_store_id=EXCLUDED.platform_store_id,
         platform_merchant_id=EXCLUDED.platform_merchant_id,
         app_shop_id=EXCLUDED.app_shop_id,
         status='authorized',
         updated_at=now()
       RETURNING *`,
      [id, platform, platform_store_id || null, platform_merchant_id || null, app_shop_id || null, req.user.id]
    );
    console.log(`[restaurants] plataforma ${platform} conectada ao restaurante ${id}`);
    return res.json(result.rows[0]);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// DELETE /:id/platforms/:platform
router.delete('/:id/platforms/:platform', async (req, res) => {
  const { id, platform } = req.params;
  try {
    const check = await pool.query(
      'SELECT id FROM restaurants WHERE id = $1 AND user_id = $2',
      [id, req.user.id]
    );
    if (check.rowCount === 0) {
      return res.status(403).json({ error: 'Acesso negado' });
    }

    await pool.query(
      `UPDATE restaurant_platforms SET status='disconnected', updated_at=now() 
       WHERE restaurant_id=$1 AND platform=$2`,
      [id, platform]
    );
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
