const express = require('express');
const pool = require('../db/postgres');
const food99 = require('../services/food99');
const { tryAutoAccept } = require('../services/autoAccept');
const { attachItemImages } = require('../services/orderImages');
const { extractOrderExtras } = require('../services/orderExtras');
const { authenticateToken, requireAdmin } = require('../middleware/auth');
const { makeDebugHandler } = require('./orderDebug');
const router = express.Router();

// GET /debug — painel de depuração: campos brutos + mapeamento (SÓ admin)
router.get('/debug', authenticateToken, requireAdmin, makeDebugHandler('99food'));

router.post('/', async (req, res) => {
  res.status(200).json({ errno: 0, errmsg: 'ok' });
  const body = req.body;
  console.log('[99food webhook] recebido:', JSON.stringify(body).substring(0, 200));

  try {
    // IMPORTANTE: o order_id do 99Food é um inteiro de 64 bits. O JSON.parse do Express
    // arredonda esses números (ex.: ...419347 vira ...419000), então pegamos os dígitos
    // EXATOS direto do corpo cru (texto). Só caímos no valor arredondado se não achar.
    let orderId = null;
    const rawMatch = typeof req.rawBody === 'string' && req.rawBody.match(/"order_id"\s*:\s*"?(\d+)"?/);
    if (rawMatch) orderId = rawMatch[1];
    else orderId = body.order_id || body.orderId || body.data?.order_id || body.data?.order_info?.order_id;
    const appShopId = body.app_shop_id || body.appShopId;
    const orderData = body.data?.order_info || body.data || body;
    if (!orderId || !appShopId) { console.warn('[99food webhook] payload sem order_id ou app_shop_id'); return; }

    // 1. Encontra o user_id pela loja
    const loja = await pool.query(
      `SELECT rp.id, rp.restaurant_id, r.name, r.user_id FROM restaurant_platforms rp
       JOIN restaurants r ON r.id = rp.restaurant_id
       WHERE rp.platform = '99food' AND rp.app_shop_id = $1 AND rp.status = 'authorized'`,
      [appShopId]
    );

    let userId = null;
    if (loja.rows.length > 0) {
      userId = loja.rows[0].user_id;
      console.log(`[99food webhook] loja encontrada: ${loja.rows[0].name} (user: ${userId})`);
    } else {
      console.log(`[99food webhook] loja ${appShopId} NAO cadastrada — rejeitando`);
      return;
    }

    // Busca os DETALHES completos do pedido (2ª chamada na API) — traz o nome real
    // do cliente, que o aviso do webhook costuma mandar mascarado ("privacy protection").
    let order = orderData;
    try {
      const authToken = await food99.getValidToken(appShopId);
      const detail = await food99.getOrderDetail(authToken, orderId);
      if (detail && typeof detail === 'object') {
        order = { ...orderData, ...detail }; // detalhes completos por cima do aviso
        console.log(`[99food webhook] pedido ${orderId} detalhado via API`);
      }
    } catch (e) {
      console.warn('[99food webhook] não consegui detalhar pedido, usando aviso do webhook:', e.message);
    }
    const shopName = order.shop?.shop_name || order.shop_name || order.store?.shop_name || '';

    // DIAGNÓSTICO (temporário): em pedido REAL, mostra os NOMES dos campos (não os valores
    // sensíveis) pra descobrirmos o campo certo do número do pedido e da foto do item.
    try {
      const isMock = /mock/i.test(shopName) || /^didi$/i.test(String(order.receive_address?.name || ''));
      if (!isMock) {
        const items = order.order_items || [];
        const numKeys = Object.keys(order).filter(k => /index|serial|num|seq|show|display/i.test(k));
        const item0 = items[0] || {};
        const imgKeys = Object.keys(item0).filter(k => /img|image|photo|head|pic/i.test(k));
        console.log('[99food diag] chaves numero-pedido:', numKeys.map(k => `${k}=${order[k]}`).join(', ') || 'NENHUMA');
        console.log('[99food diag] chaves do item[0]:', Object.keys(item0).join(', '));
        console.log('[99food diag] chaves foto no item:', imgKeys.map(k => `${k}=${item0[k]}`).join(', ') || 'NENHUMA');
      }
    } catch (e) { console.warn('[99food diag] falhou:', e.message); }

    // Atualiza o NOME do restaurante com o nome real da loja (quando ainda está genérico)
    const nomeAtual = loja.rows[0].name || '';
    if (shopName && (/^Loja\s*99Food/i.test(nomeAtual) || !nomeAtual.trim())) {
      try {
        await pool.query(`UPDATE restaurants SET name = $1, updated_at = now() WHERE id = $2`,
          [shopName, loja.rows[0].restaurant_id]);
        console.log(`[99food webhook] nome do restaurante atualizado para "${shopName}"`);
      } catch (e) { console.warn('[99food webhook] não atualizou nome:', e.message); }
    }

    // Monta o endereço a partir dos campos reais (o campo `addr` não existe no 99Food).
    // Vários campos vêm com "privacy protection" (mascarados) — descartamos esses.
    const ra = order.receive_address || {};
    const semMascara = (s) => (s && !/privacy protection/i.test(String(s)) ? String(s).trim() : '');
    const endereco = semMascara(ra.poi_address)
      || [[semMascara(ra.street_name), semMascara(ra.house_number)].filter(Boolean).join(', '), semMascara(ra.district), semMascara(ra.city)].filter(Boolean).join(' - ')
      || null;

    // Nome do cliente: receive_address.name costuma vir "privacy protection".
    // O nome real fica em first_name/last_name — montamos a partir deles.
    const nomeCliente = [semMascara(ra.first_name), semMascara(ra.last_name)].filter(Boolean).join(' ')
      || semMascara(ra.name) || null;

    // 2. Salva o pedido com user_id
    await pool.query(
      `INSERT INTO orders (platform, platform_order_id, app_shop_id, status, customer_name, customer_phone, delivery_address, items, total_price, raw_payload, user_id, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now(),now())
       ON CONFLICT (platform, platform_order_id) DO UPDATE SET status=EXCLUDED.status, raw_payload=EXCLUDED.raw_payload, updated_at=now()`,
      ['99food', String(orderId), appShopId, String(order.status || 100),
       nomeCliente, ra.phone || null,
       endereco, JSON.stringify(order.order_items || []),
       (order.price?.real_pay_price || order.price?.order_price || 0) / 100, JSON.stringify(order), userId]
    );
    await pool.query(`UPDATE integrations SET orders_count=orders_count+1, last_sync_at=now(), updated_at=now() WHERE platform='99food' AND user_id=$1`, [userId]);
    console.log(`[99food webhook] pedido ${orderId} salvo (loja: ${shopName || appShopId}, user: ${userId})`);
    await tryAutoAccept('99food', orderId, appShopId, userId);
  } catch (err) { console.error('[99food webhook] erro:', err.message); }
});

// GET /orders — requer autenticação
router.get('/orders', authenticateToken, async (req, res) => {
  try {
    const { date } = req.query;
    let query = `SELECT id, platform, platform_order_id, app_shop_id, status, customer_name, customer_phone, delivery_address, items, total_price, raw_payload, created_at, updated_at FROM orders WHERE platform='99food' AND user_id=$1`;
    const params = [req.user.id];
    if (date) { query += ` AND DATE(created_at AT TIME ZONE 'America/Sao_Paulo') = $2`; params.push(date); }
    query += ` ORDER BY created_at DESC LIMIT 100`;
    const result = await pool.query(query, params);
    const orders = await attachItemImages(result.rows, '99food', req.user.id);
    for (const o of orders) {
      Object.assign(o, extractOrderExtras(o.raw_payload, '99food'));
      delete o.raw_payload; // não devolve o payload cru (grande)
    }
    return res.json(orders);
  } catch (err) { return res.status(500).json({ error: 'Erro ao buscar pedidos' }); }
});

// GET /token — requer autenticação
router.get('/token', authenticateToken, async (req, res) => {
  try {
    const appShopId = req.query.shop || 'loja_teste_001';
    const authToken = await food99.getValidToken(appShopId);
    return res.json({ auth_token: authToken, app_shop_id: appShopId });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

// POST /:orderId/confirm — requer autenticação
router.post('/:orderId/confirm', authenticateToken, async (req, res) => {
  const { orderId } = req.params;
  const { app_shop_id } = req.body;
  if (!app_shop_id) return res.status(400).json({ error: 'app_shop_id é obrigatório' });
  try {
    // Validar ownership
    const order = await pool.query(
      'SELECT * FROM orders WHERE platform = $1 AND platform_order_id = $2 AND user_id = $3',
      ['99food', orderId, req.user.id]
    );
    if (order.rowCount === 0) {
      return res.status(403).json({ error: 'Acesso negado' });
    }

    const authToken = await food99.getValidToken(app_shop_id);
    await food99.confirmOrder(authToken, orderId);
    await pool.query(`UPDATE orders SET status='confirmed', updated_at=now() WHERE platform='99food' AND platform_order_id=$1 AND user_id=$2`, [orderId, req.user.id]);
    console.log(`[confirm] pedido ${orderId} confirmado (user: ${req.user.id})`);
    return res.json({ success: true });
  } catch (err) {
    console.error(`[confirm] FALHA ao aceitar pedido ${orderId}: ${err.message}`);
    return res.status(500).json({ error: 'Não foi possível aceitar o pedido no 99Food', details: err.message });
  }
});

// POST /:orderId/pay-confirm — confirma recebimento do pagamento em dinheiro (requer autenticação)
router.post('/:orderId/pay-confirm', authenticateToken, async (req, res) => {
  const { orderId } = req.params;
  const { app_shop_id } = req.body;
  if (!app_shop_id) return res.status(400).json({ error: 'app_shop_id é obrigatório' });
  try {
    const order = await pool.query(
      'SELECT * FROM orders WHERE platform = $1 AND platform_order_id = $2 AND user_id = $3',
      ['99food', orderId, req.user.id]
    );
    if (order.rowCount === 0) {
      return res.status(403).json({ error: 'Acesso negado' });
    }

    const authToken = await food99.getValidToken(app_shop_id);
    await food99.payConfirm(authToken, orderId);
    console.log(`[pay-confirm] pagamento em dinheiro confirmado no pedido ${orderId} (user: ${req.user.id})`);
    return res.json({ success: true });
  } catch (err) {
    console.error(`[pay-confirm] FALHA no pedido ${orderId}: ${err.message}`);
    return res.status(500).json({ error: 'Não foi possível confirmar o pagamento em dinheiro no 99Food', details: err.message });
  }
});

// POST /:orderId/cancel — requer autenticação
router.post('/:orderId/cancel', authenticateToken, async (req, res) => {
  const { orderId } = req.params;
  const { app_shop_id, cancel_code } = req.body;
  if (!app_shop_id) return res.status(400).json({ error: 'app_shop_id é obrigatório' });
  try {
    // Validar ownership
    const order = await pool.query(
      'SELECT * FROM orders WHERE platform = $1 AND platform_order_id = $2 AND user_id = $3',
      ['99food', orderId, req.user.id]
    );
    if (order.rowCount === 0) {
      return res.status(403).json({ error: 'Acesso negado' });
    }

    const authToken = await food99.getValidToken(app_shop_id);
    await food99.cancelOrder(authToken, orderId, cancel_code || 1040);
    await pool.query(`UPDATE orders SET status='cancelled', updated_at=now() WHERE platform='99food' AND platform_order_id=$1 AND user_id=$2`, [orderId, req.user.id]);
    console.log(`[cancel] pedido ${orderId} cancelado (user: ${req.user.id})`);
    return res.json({ success: true });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

// POST /:orderId/ready — requer autenticação
router.post('/:orderId/ready', authenticateToken, async (req, res) => {
  const { orderId } = req.params;
  try {
    // Validar ownership
    const order = await pool.query(
      'SELECT * FROM orders WHERE platform = $1 AND platform_order_id = $2 AND user_id = $3',
      ['99food', orderId, req.user.id]
    );
    if (order.rowCount === 0) {
      return res.status(403).json({ error: 'Acesso negado' });
    }

    await pool.query(`UPDATE orders SET status='ready', updated_at=now() WHERE platform='99food' AND platform_order_id=$1 AND user_id=$2`, [orderId, req.user.id]);
    console.log(`[ready] pedido ${orderId} marcado como pronto (user: ${req.user.id})`);
    return res.json({ success: true });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

module.exports = router;