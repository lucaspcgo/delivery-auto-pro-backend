const express = require('express');
const pool = require('../db/postgres');
const { authenticateToken } = require('../middleware/auth');
const router = express.Router();

router.use(authenticateToken);

// POST /api/v1/restaurants/authorize — PRIMEIRO (antes de /:id para não conflitar)
// DEBUG: teste o que iFood retorna
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

// GET /api/v1/restaurants
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

// GET /api/v1/restaurants/:id
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

// POST /api/v1/restaurants
router.post('/', async (req, res) => {
  const { name, owner_name, phone, email, address } = req.body;
  if (!name) return res.status(400).json({ error: 'Nome é obrigatório' });
  try {
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

// PUT /api/v1/restaurants/:id
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

// DELETE /api/v1/restaurants/:id
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

// POST /api/v1/restaurants/:id/platforms
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

// DELETE /api/v1/restaurants/:id/platforms/:platform
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
