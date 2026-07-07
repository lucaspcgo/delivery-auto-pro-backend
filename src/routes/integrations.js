const express = require('express');
const pool = require('../db/postgres');
const food99 = require('../services/food99');
const ifood = require('../services/ifood');
const ifoodDistributed = require('../services/ifood-distributed');
const ifoodAPI = require('../services/ifood-api-complete');
const menu99food = require('../services/menu99food');
const menuifood = require('../services/menuifood');
const { authenticateToken } = require('../middleware/auth');
const router = express.Router();

const PLATAFORMAS_VALIDAS = ['ifood', '99food', 'keeta'];

// Aplicar autenticação em todas as rotas
router.use(authenticateToken);

router.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, platform, name, description, status, orders_count,
              last_sync_at, api_status, created_at, updated_at
       FROM integrations
       WHERE user_id = $1
       ORDER BY CASE platform WHEN 'ifood' THEN 1 WHEN 'keeta' THEN 2 WHEN '99food' THEN 3 END`,
      [req.user.id]
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
       WHERE platform=$1 AND user_id=$2 RETURNING *`, [platform, req.user.id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Integração não encontrada' });

    // Buscar lojas da API e cadastrar automaticamente
    if (platform === 'ifood') {
      await syncIfoodMerchants(req.user.id);
    } else if (platform === '99food') {
      await sync99foodShops(req.user.id);
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
       WHERE platform=$1 AND user_id=$2 RETURNING *`, [platform, req.user.id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Integração não encontrada' });
    return res.json(result.rows[0]);
  } catch (err) {
    console.error('[POST /integrations/:platform/disconnect] erro:', err);
    return res.status(500).json({ error: 'Erro ao desconectar integração' });
  }
});

// ===== Autorização DISTRIBUÍDA do iFood (lojas de terceiros) =====

// Passo 1: gera o código que o dono da loja digita no portal do iFood
router.post('/ifood/authorize/start', async (req, res) => {
  try {
    const data = await ifoodDistributed.startAuthorization(req.user.id);
    console.log(`[ifood-auth] código gerado para user ${req.user.id}: ${data.userCode}`);
    return res.json(data);
  } catch (err) {
    console.error('[ifood-auth start] erro:', err.message);
    return res.status(500).json({ error: 'Erro ao iniciar autorização', details: err.message });
  }
});

// Passo 2: após o dono autorizar no portal, troca o código por tokens e
// cadastra automaticamente as lojas autorizadas
router.post('/ifood/authorize/complete', async (req, res) => {
  try {
    const { authorizationCode } = req.body;
    await ifoodDistributed.completeAuthorization(req.user.id, authorizationCode);
    const token = await ifoodDistributed.getAccessToken(req.user.id);
    const merchants = await ifoodAPI.getMerchants(token);

    const connected = [];
    for (const merchant of merchants) {
      const merchantId = merchant.id || merchant.merchantId;
      const merchantName = merchant.name || merchant.corporateName || 'Loja iFood';

      const existing = await pool.query(
        `SELECT r.id FROM restaurants r
         JOIN restaurant_platforms rp ON rp.restaurant_id = r.id
         WHERE rp.platform = 'ifood' AND rp.platform_merchant_id = $1 AND r.user_id = $2`,
        [merchantId, req.user.id]
      );

      let restaurantId;
      if (existing.rows.length === 0) {
        const inserted = await pool.query(
          `INSERT INTO restaurants (name, owner_name, user_id) VALUES ($1, $2, $3) RETURNING id`,
          [merchantName, 'Via iFood (autorizado)', req.user.id]
        );
        restaurantId = inserted.rows[0].id;
      } else {
        restaurantId = existing.rows[0].id;
      }

      await pool.query(
        `INSERT INTO restaurant_platforms (restaurant_id, platform, platform_merchant_id, status, user_id)
         VALUES ($1, 'ifood', $2, 'authorized', $3)
         ON CONFLICT (restaurant_id, platform) DO UPDATE SET
           platform_merchant_id = EXCLUDED.platform_merchant_id,
           status = 'authorized', updated_at = now()`,
        [restaurantId, merchantId, req.user.id]
      );

      connected.push({ id: merchantId, name: merchantName });
    }

    console.log(`[ifood-auth] user ${req.user.id} autorizou ${connected.length} loja(s)`);
    return res.json({ success: true, connected });
  } catch (err) {
    console.error('[ifood-auth complete] erro:', err.message);
    return res.status(400).json({ error: 'Erro ao concluir autorização', details: err.message });
  }
});

// Status: o usuário já autorizou alguma loja iFood?
router.get('/ifood/authorize/status', async (req, res) => {
  try {
    const authorized = await ifoodDistributed.isAuthorized(req.user.id);
    return res.json({ authorized });
  } catch (err) {
    return res.status(500).json({ error: 'Erro ao verificar status', details: err.message });
  }
});

// Retorna a URL de autorização do app 99Food (para o botão "Autorizar")
router.get('/99food/authorize-url', (req, res) => {
  const url = process.env.FOOD99_AUTHORIZE_URL || null;
  return res.json({ url });
});

// ===== Conectar loja 99Food pelo Shop ID =====
router.post('/99food/connect-shop', async (req, res) => {
  const shopIdInput = req.body.shop_id || req.body.app_shop_id;
  const { name } = req.body;
  if (!shopIdInput) {
    return res.status(400).json({ error: 'Shop ID é obrigatório' });
  }
  // Usamos o mesmo id do 99Food como app_shop_id (mapeamento 1:1, único por loja)
  const app_shop_id = String(shopIdInput);
  try {
    // Se a loja ainda não estiver vinculada (bind), o token falha — então
    // fazemos o bind automaticamente e tentamos de novo.
    try {
      await food99.getValidToken(app_shop_id);
    } catch (notBound) {
      console.log(`[99food connect] loja ${app_shop_id} não vinculada — fazendo bind automático...`);
      await food99.bindStore(shopIdInput, app_shop_id);
      await food99.getValidToken(app_shop_id);
    }

    const shopName = name || `Loja 99Food ${app_shop_id}`;

    // Cria/reaproveita o restaurante desta loja para o usuário
    const existing = await pool.query(
      `SELECT r.id FROM restaurants r
       JOIN restaurant_platforms rp ON rp.restaurant_id = r.id
       WHERE rp.platform = '99food' AND rp.app_shop_id = $1 AND r.user_id = $2`,
      [String(app_shop_id), req.user.id]
    );

    let restaurantId;
    if (existing.rows.length === 0) {
      const inserted = await pool.query(
        `INSERT INTO restaurants (name, owner_name, user_id) VALUES ($1, $2, $3) RETURNING id`,
        [shopName, 'Via 99Food', req.user.id]
      );
      restaurantId = inserted.rows[0].id;
    } else {
      restaurantId = existing.rows[0].id;
    }

    await pool.query(
      `INSERT INTO restaurant_platforms (restaurant_id, platform, app_shop_id, status, user_id)
       VALUES ($1, '99food', $2, 'authorized', $3)
       ON CONFLICT (restaurant_id, platform) DO UPDATE SET
         app_shop_id = EXCLUDED.app_shop_id, status = 'authorized', updated_at = now()`,
      [restaurantId, String(app_shop_id), req.user.id]
    );

    console.log(`[99food connect] user ${req.user.id} conectou loja ${app_shop_id} (${shopName})`);
    return res.json({ success: true, restaurant_id: restaurantId, app_shop_id: String(app_shop_id), name: shopName });
  } catch (err) {
    console.error('[99food connect] erro:', err.message);
    return res.status(400).json({ error: 'Não foi possível conectar a loja 99Food', details: err.message });
  }
});

// Busca merchants do iFood e cadastra como restaurantes
async function syncIfoodMerchants(user_id) {
  try {
    const token = await ifood.getValidToken();
    const https = require('https');
    const merchants = await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'merchant-api.ifood.com.br',
        path: '/merchants',
        method: 'GET',
        headers: { 'Authorization': `Bearer ${token}` }
      }, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
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
         WHERE rp.platform = 'ifood' AND rp.platform_merchant_id = $1 AND r.user_id = $2`,
        [merchantId, user_id]
      );

      let restaurantId;
      if (existing.rows.length === 0) {
        const inserted = await pool.query(
          `INSERT INTO restaurants (name, owner_name, user_id) VALUES ($1, $2, $3) RETURNING id`,
          [merchantName, 'Via iFood API', user_id]
        );
        restaurantId = inserted.rows[0].id;
        console.log(`[sync-ifood] restaurante criado: ${merchantName} (${merchantId})`);
      } else {
        restaurantId = existing.rows[0].id;
        console.log(`[sync-ifood] restaurante já existe: ${merchantName} (${merchantId})`);
      }

      // Conecta plataforma
      await pool.query(
        `INSERT INTO restaurant_platforms (restaurant_id, platform, platform_merchant_id, status, user_id)
         VALUES ($1, 'ifood', $2, 'authorized', $3)
         ON CONFLICT (restaurant_id, platform) DO UPDATE SET
           platform_merchant_id = EXCLUDED.platform_merchant_id,
           status = 'authorized', updated_at = now()`,
        [restaurantId, merchantId, user_id]
      );

      // NOVO: Sincronizar cardápio automaticamente
      await syncMenuForRestaurant(restaurantId, 'ifood', merchantId, token);
    }

    console.log(`[sync-ifood] ${merchants.length} merchant(s) sincronizado(s)`);
  } catch (err) {
    console.error('[sync-ifood] erro:', err.message);
  }
}

// Busca lojas da 99Food cadastradas e sincroniza
async function sync99foodShops(user_id) {
  try {
    const appShopId = 'loja_teste_001';
    const shopName = 'Marmita da Betinha';

    const existing = await pool.query(
      `SELECT r.id FROM restaurants r
       JOIN restaurant_platforms rp ON rp.restaurant_id = r.id
       WHERE rp.platform = '99food' AND rp.app_shop_id = $1 AND r.user_id = $2`,
      [appShopId, user_id]
    );

    let restaurantId;
    if (existing.rows.length === 0) {
      const inserted = await pool.query(
        `INSERT INTO restaurants (name, owner_name, user_id) VALUES ($1, $2, $3) RETURNING id`,
        [shopName, 'Via 99Food API', user_id]
      );
      restaurantId = inserted.rows[0].id;
      console.log(`[sync-99food] restaurante criado: ${shopName}`);
    } else {
      restaurantId = existing.rows[0].id;
      console.log(`[sync-99food] restaurante já existe: ${shopName}`);
    }

    await pool.query(
      `INSERT INTO restaurant_platforms (restaurant_id, platform, app_shop_id, platform_store_id, status, user_id)
       VALUES ($1, '99food', $2, '5764616188962800939', 'authorized', $3)
       ON CONFLICT (restaurant_id, platform) DO UPDATE SET
         app_shop_id = EXCLUDED.app_shop_id,
         platform_store_id = EXCLUDED.platform_store_id,
         status = 'authorized', updated_at = now()`,
      [restaurantId, appShopId, user_id]
    );

    // NOVO: Sincronizar cardápio automaticamente
    await syncMenuForRestaurant(restaurantId, '99food', appShopId, null);

    console.log(`[sync-99food] loja sincronizada: ${shopName}`);
  } catch (err) {
    console.error('[sync-99food] erro:', err.message);
  }
}

// NOVO: Sincronizar cardápio automaticamente quando loja é adicionada
async function syncMenuForRestaurant(restaurantId, platform, platformId, token) {
  try {
    console.log(`[menu-sync] Iniciando sincronização: restaurante=${restaurantId}, platform=${platform}`);

    let items = [];

    if (platform === 'ifood' && token) {
      items = await menuifood.getMenuItems(platformId, token);
    } else if (platform === '99food') {
      items = await menu99food.getMenuItems(platformId, process.env.FOOD99_TOKEN);
    }

    if (!items || items.length === 0) {
      console.log(`[menu-sync] Nenhum item encontrado para ${platform}`);
      return;
    }

    // Salvar items no banco
    const itemsJson = JSON.stringify(items);
    await pool.query(
      `INSERT INTO menu_items (restaurant_id, platform, platform_store_id, items_data, updated_at, created_at)
       VALUES ($1, $2, $3, $4, NOW(), NOW())
       ON CONFLICT (restaurant_id, platform) DO UPDATE SET
         items_data = EXCLUDED.items_data,
         updated_at = NOW()`,
      [restaurantId, platform, platformId, itemsJson]
    );

    console.log(`[menu-sync] ✅ ${items.length} items sincronizados para ${platform}`);
  } catch (err) {
    console.error(`[menu-sync] erro ao sincronizar cardápio:`, err.message);
  }
}

module.exports = router;
