const express = require('express');
const pool = require('../db/postgres');
const food99 = require('../services/food99');
const ifood = require('../services/ifood');
const router = express.Router();

const PLATAFORMAS_VALIDAS = ['ifood', '99food', 'keeta'];

router.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, platform, name, description, status, orders_count,
              last_sync_at, api_status, created_at, updated_at
       FROM integrations
       ORDER BY CASE platform WHEN 'ifood' THEN 1 WHEN 'keeta' THEN 2 WHEN '99food' THEN 3 END`
    );
    return res.json(result.rows);
  } catch (err) {
    console.error('[GET /integrations] erro:', err);
    return res.status(500).json({ error: 'Erro ao buscar integrações' });
  }
});

router.post('/:platform/connect', async (req, res) => {
  const { platform } = req.params;
  if (!PLATAFORMAS_VALIDAS.includes(platform)) {
    return res.status(400).json({ error: 'Plataforma inválida' });
  }
  try {
    const result = await pool.query(
      `UPDATE integrations SET status='connected', api_status='online', last_sync_at=now(), updated_at=now()
       WHERE platform=$1 RETURNING *`, [platform]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Integração não encontrada' });

    // Buscar lojas da API e cadastrar automaticamente
    if (platform === 'ifood') {
      await syncIfoodMerchants();
    } else if (platform === '99food') {
      await sync99foodShops();
    }

    return res.json(result.rows[0]);
  } catch (err) {
    console.error('[POST /integrations/:platform/connect] erro:', err);
    return res.status(500).json({ error: 'Erro ao conectar integração' });
  }
});

router.post('/:platform/disconnect', async (req, res) => {
  const { platform } = req.params;
  if (!PLATAFORMAS_VALIDAS.includes(platform)) {
    return res.status(400).json({ error: 'Plataforma inválida' });
  }
  try {
    const result = await pool.query(
      `UPDATE integrations SET status='disconnected', api_status='offline', updated_at=now()
       WHERE platform=$1 RETURNING *`, [platform]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Integração não encontrada' });
    return res.json(result.rows[0]);
  } catch (err) {
    console.error('[POST /integrations/:platform/disconnect] erro:', err);
    return res.status(500).json({ error: 'Erro ao desconectar integração' });
  }
});

// Busca merchants do iFood e cadastra como restaurantes
async function syncIfoodMerchants() {
  try {
    const token = await ifood.getValidToken();
    const https = require('https');
    const merchants = await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'merchant-api.ifood.com.br',
        path: '/merchant/v1.0/merchants',
        method: 'GET',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
      }, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try { resolve(JSON.parse(data)); } catch (e) { resolve([]); }
        });
      });
      req.on('error', reject);
      req.end();
    });

    if (!Array.isArray(merchants)) {
      console.log('[sync-ifood] resposta não é array:', JSON.stringify(merchants).substring(0, 200));
      return;
    }

    for (const merchant of merchants) {
      const merchantId = merchant.id || merchant.merchantId;
      const merchantName = merchant.name || merchant.corporateName || 'Loja iFood';

      // Cria restaurante se não existe
      const existing = await pool.query(
        `SELECT r.id FROM restaurants r
         JOIN restaurant_platforms rp ON rp.restaurant_id = r.id
         WHERE rp.platform = 'ifood' AND rp.platform_merchant_id = $1`,
        [merchantId]
      );

      let restaurantId;
      if (existing.rows.length === 0) {
        const inserted = await pool.query(
          `INSERT INTO restaurants (name, owner_name) VALUES ($1, $2) RETURNING id`,
          [merchantName, 'Via iFood API']
        );
        restaurantId = inserted.rows[0].id;
        console.log(`[sync-ifood] restaurante criado: ${merchantName} (${merchantId})`);
      } else {
        restaurantId = existing.rows[0].id;
        console.log(`[sync-ifood] restaurante já existe: ${merchantName} (${merchantId})`);
      }

      // Conecta plataforma
      await pool.query(
        `INSERT INTO restaurant_platforms (restaurant_id, platform, platform_merchant_id, status)
         VALUES ($1, 'ifood', $2, 'authorized')
         ON CONFLICT (restaurant_id, platform) DO UPDATE SET
           platform_merchant_id = EXCLUDED.platform_merchant_id,
           status = 'authorized', updated_at = now()`,
        [restaurantId, merchantId]
      );
    }

    console.log(`[sync-ifood] ${merchants.length} merchant(s) sincronizado(s)`);
  } catch (err) {
    console.error('[sync-ifood] erro:', err.message);
  }
}

// Busca lojas da 99Food cadastradas e sincroniza
async function sync99foodShops() {
  try {
    // A 99Food não tem endpoint para listar lojas — usamos as lojas já cadastradas no portal
    // Busca a loja de teste que já temos
    const appShopId = 'loja_teste_001';
    const shopName = 'Marmita da Betinha';

    const existing = await pool.query(
      `SELECT r.id FROM restaurants r
       JOIN restaurant_platforms rp ON rp.restaurant_id = r.id
       WHERE rp.platform = '99food' AND rp.app_shop_id = $1`,
      [appShopId]
    );

    let restaurantId;
    if (existing.rows.length === 0) {
      const inserted = await pool.query(
        `INSERT INTO restaurants (name, owner_name) VALUES ($1, $2) RETURNING id`,
        [shopName, 'Via 99Food API']
      );
      restaurantId = inserted.rows[0].id;
      console.log(`[sync-99food] restaurante criado: ${shopName}`);
    } else {
      restaurantId = existing.rows[0].id;
      console.log(`[sync-99food] restaurante já existe: ${shopName}`);
    }

    await pool.query(
      `INSERT INTO restaurant_platforms (restaurant_id, platform, app_shop_id, platform_store_id, status)
       VALUES ($1, '99food', $2, '5764616188962800939', 'authorized')
       ON CONFLICT (restaurant_id, platform) DO UPDATE SET
         app_shop_id = EXCLUDED.app_shop_id,
         platform_store_id = EXCLUDED.platform_store_id,
         status = 'authorized', updated_at = now()`,
      [restaurantId, appShopId]
    );

    console.log(`[sync-99food] loja sincronizada: ${shopName}`);
  } catch (err) {
    console.error('[sync-99food] erro:', err.message);
  }
}

module.exports = router;
