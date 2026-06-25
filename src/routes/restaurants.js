const express = require('express');
const pool = require('../db/postgres');
const router = express.Router();

// GET /api/v1/restaurants — lista todos os restaurantes
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT r.*, 
        (SELECT json_agg(rp.*) FROM restaurant_platforms rp WHERE rp.restaurant_id = r.id) as platforms
       FROM restaurants r
       WHERE r.active = true
       ORDER BY r.created_at DESC`
    );
    return res.json(result.rows);
  } catch (err) {
    console.error('[restaurants] erro:', err.message);
    return res.status(500).json({ error: 'Erro ao buscar restaurantes' });
  }
});

// GET /api/v1/restaurants/:id — detalhes de um restaurante
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      `SELECT r.*, 
        (SELECT json_agg(rp.*) FROM restaurant_platforms rp WHERE rp.restaurant_id = r.id) as platforms
       FROM restaurants r WHERE r.id = $1`, [id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Restaurante não encontrado' });
    return res.json(result.rows[0]);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/v1/restaurants — criar restaurante
router.post('/', async (req, res) => {
  const { name, owner_name, phone, email, address } = req.body;
  if (!name) return res.status(400).json({ error: 'Nome é obrigatório' });
  try {
    const result = await pool.query(
      `INSERT INTO restaurants (name, owner_name, phone, email, address)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [name, owner_name || null, phone || null, email || null, address || null]
    );
    console.log(`[restaurants] criado: ${name}`);
    return res.status(201).json(result.rows[0]);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// PUT /api/v1/restaurants/:id — atualizar restaurante
router.put('/:id', async (req, res) => {
  const { id } = req.params;
  const { name, owner_name, phone, email, address } = req.body;
  try {
    const result = await pool.query(
      `UPDATE restaurants SET name=COALESCE($1,name), owner_name=COALESCE($2,owner_name), 
       phone=COALESCE($3,phone), email=COALESCE($4,email), address=COALESCE($5,address), 
       updated_at=now() WHERE id=$6 RETURNING *`,
      [name, owner_name, phone, email, address, id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Restaurante não encontrado' });
    return res.json(result.rows[0]);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// DELETE /api/v1/restaurants/:id — desativar restaurante
router.delete('/:id', async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query('UPDATE restaurants SET active=false, updated_at=now() WHERE id=$1', [id]);
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/v1/restaurants/:id/platforms — conectar plataforma ao restaurante
router.post('/:id/platforms', async (req, res) => {
  const { id } = req.params;
  const { platform, platform_store_id, platform_merchant_id, app_shop_id } = req.body;
  if (!platform) return res.status(400).json({ error: 'Plataforma é obrigatória' });
  try {
    const result = await pool.query(
      `INSERT INTO restaurant_platforms (restaurant_id, platform, platform_store_id, platform_merchant_id, app_shop_id, status)
       VALUES ($1,$2,$3,$4,$5,'authorized')
       ON CONFLICT (restaurant_id, platform) DO UPDATE SET 
         platform_store_id=EXCLUDED.platform_store_id,
         platform_merchant_id=EXCLUDED.platform_merchant_id,
         app_shop_id=EXCLUDED.app_shop_id,
         status='authorized',
         updated_at=now()
       RETURNING *`,
      [id, platform, platform_store_id || null, platform_merchant_id || null, app_shop_id || null]
    );
    console.log(`[restaurants] plataforma ${platform} conectada ao restaurante ${id}`);
    return res.json(result.rows[0]);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// DELETE /api/v1/restaurants/:id/platforms/:platform — desconectar plataforma
router.delete('/:id/platforms/:platform', async (req, res) => {
  const { id, platform } = req.params;
  try {
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
// POST /api/v1/restaurants/authorize — busca loja na API e cadastra
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
      shopName = merchantData.name || merchantData.corporateName || 'Loja iFood';
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

    // Verifica se já existe
    const existing = await pool.query(
      `SELECT r.id, r.name FROM restaurants r
       JOIN restaurant_platforms rp ON rp.restaurant_id = r.id
       WHERE rp.platform = $1 AND (rp.platform_merchant_id = $2 OR rp.app_shop_id = $2 OR rp.platform_store_id = $2)`,
      [platform, platform_id]
    );

    if (existing.rows.length > 0) {
      return res.json({
        exists: true,
        restaurant: existing.rows[0],
        shop_name: existing.rows[0].name,
        message: 'Restaurante já cadastrado!'
      });
    }

    // Cria restaurante
    const inserted = await pool.query(
      `INSERT INTO restaurants (name, address) VALUES ($1, $2) RETURNING *`,
      [shopName, shopAddress || null]
    );
    const restaurantId = inserted.rows[0].id;

    // Conecta plataforma
    await pool.query(
      `INSERT INTO restaurant_platforms (restaurant_id, platform, platform_merchant_id, app_shop_id, platform_store_id, status)
       VALUES ($1, $2, $3, $4, $5, 'authorized')`,
      [restaurantId, platform, merchantId, appShopId, storeId]
    );

    console.log(`[authorize] restaurante ${shopName} cadastrado via ${platform} (${platform_id})`);

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

module.exports = router;
