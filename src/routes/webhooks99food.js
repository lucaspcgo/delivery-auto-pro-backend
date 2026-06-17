const express = require('express');
const pool = require('../db/postgres');
const food99 = require('../services/food99');
const router = express.Router();

router.post('/', async (req, res) => {
  res.status(200).json({ errno: 0, errmsg: 'ok' });
  const body = req.body;
  console.log('[99food webhook] recebido:', JSON.stringify(body));
  try {
    const orderId = body.order_id || body.orderId || body.data?.order_id || body.data?.order_info?.order_id;
    const appShopId = body.app_shop_id || body.appShopId;
    const orderData = body.data?.order_info || body.data || body;
    if (!orderId || !appShopId) { console.warn('[99food webhook] payload sem order_id ou app_shop_id'); return; }
    const order = orderData;
    await pool.query(
      `INSERT INTO orders (platform, platform_order_id, app_shop_id, status, customer_name, customer_phone, delivery_address, items, total_price, raw_payload, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now(),now())
       ON CONFLICT (platform, platform_order_id) DO UPDATE SET status=EXCLUDED.status, raw_payload=EXCLUDED.raw_payload, updated_at=now()`,
      ['99food', String(orderId), appShopId, String(order.status || 100),
       order.receive_address?.name || null, order.receive_address?.phone || null,
       order.receive_address?.addr || null, JSON.stringify(order.order_items || []),
       (order.price?.actual_amount || order.price?.order_price || 0) / 100, JSON.stringify(order)]
    );
    await pool.query(`UPDATE integrations SET orders_count=orders_count+1, last_sync_at=now(), updated_at=now() WHERE platform='99food'`);
    console.log(`[99food webhook] pedido ${orderId} salvo`);
  } catch (err) { console.error('[99food webhook] erro:', err.message); }
});

router.get('/orders', async (req, res) => {
  try {
    const result = await pool.query(`SELECT id, platform, platform_order_id, app_shop_id, status, customer_name, delivery_address, items, total_price, created_at, updated_at FROM orders WHERE platform='99food' ORDER BY created_at DESC LIMIT 50`);
    return res.json(result.rows);
  } catch (err) { return res.status(500).json({ error: 'Erro ao buscar pedidos' }); }
});

router.post('/:orderId/confirm', async (req, res) => {
  const { orderId } = req.params;
  const { app_shop_id } = req.body;
  if (!app_shop_id) return res.status(400).json({ error: 'app_shop_id é obrigatório' });
  try {
    const tokenData = await food99.getToken(app_shop_id);
    await food99.confirmOrder(tokenData.auth_token, orderId);
    await pool.query(`UPDATE orders SET status='confirmed', updated_at=now() WHERE platform='99food' AND platform_order_id=$1`, [orderId]);
    console.log(`[confirm] pedido ${orderId} confirmado`);
    return res.json({ success: true });
  } catch (err) {
    console.error('[confirm] erro:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

router.post('/:orderId/cancel', async (req, res) => {
  const { orderId } = req.params;
  const { app_shop_id, cancel_code } = req.body;
  if (!app_shop_id) return res.status(400).json({ error: 'app_shop_id é obrigatório' });
  try {
    const tokenData = await food99.getToken(app_shop_id);
    await food99.cancelOrder(tokenData.auth_token, orderId, cancel_code || 1040);
    await pool.query(`UPDATE orders SET status='cancelled', updated_at=now() WHERE platform='99food' AND platform_order_id=$1`, [orderId]);
    console.log(`[cancel] pedido ${orderId} cancelado`);
    return res.json({ success: true });
  } catch (err) {
    console.error('[cancel] erro:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
