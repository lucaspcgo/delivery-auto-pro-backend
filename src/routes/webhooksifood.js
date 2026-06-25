const express = require('express');
const pool = require('../db/postgres');
const ifood = require('../services/ifood');
const { tryAutoAccept } = require('../services/autoAccept');
const router = express.Router();

router.post('/', async (req, res) => {
  res.status(200).json({ ok: true });
  const events = Array.isArray(req.body) ? req.body : [req.body];
  console.log(`[ifood webhook] recebido ${events.length} evento(s)`);

  for (const event of events) {
    try {
      const orderId = event.orderId || event.id;
      const eventType = event.code || event.fullCode || event.type;
      const merchantId = event.merchantId || null;
      console.log(`[ifood webhook] evento: ${eventType}, pedido: ${orderId}, loja: ${merchantId}`);

      if (!orderId) continue;

      if (eventType === 'PLACED' || eventType === 'PLC') {
        // Verifica se a loja está cadastrada
        let restaurantId = null;
        if (merchantId) {
          const loja = await pool.query(
            `SELECT rp.id, rp.restaurant_id, r.name FROM restaurant_platforms rp
             JOIN restaurants r ON r.id = rp.restaurant_id
             WHERE rp.platform = 'ifood' AND rp.platform_merchant_id = $1 AND rp.status = 'authorized'`,
            [merchantId]
          );
          if (loja.rows.length > 0) {
            restaurantId = loja.rows[0].restaurant_id;
            console.log(`[ifood webhook] loja encontrada: ${loja.rows[0].name}`);
          } else {
            console.log(`[ifood webhook] loja ${merchantId} NAO cadastrada — processando mesmo assim`);
          }
        }

        const order = await ifood.getOrderDetails(orderId);
        const customerName = order.customer?.name || 'Cliente iFood';
        const customerPhone = order.customer?.phone?.number || null;
        const address = order.delivery?.deliveryAddress
          ? `${order.delivery.deliveryAddress.streetName}, ${order.delivery.deliveryAddress.streetNumber} - ${order.delivery.deliveryAddress.neighborhood}`
          : null;
        const items = (order.items || []).map(i => ({
          name: i.name,
          amount: i.quantity,
          total_price: Math.round((i.totalPrice || 0) * 100),
          sub_item_list: (i.subItems || []).map(s => ({
            name: s.name,
            total_price: Math.round((s.totalPrice || 0) * 100)
          }))
        }));
        const totalPrice = order.total?.orderAmount || 0;
        const shopName = order.merchant?.name || '';

        await pool.query(
          `INSERT INTO orders (platform, platform_order_id, app_shop_id, status, customer_name, customer_phone, delivery_address, items, total_price, raw_payload, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now(),now())
           ON CONFLICT (platform, platform_order_id) DO UPDATE SET status=EXCLUDED.status, raw_payload=EXCLUDED.raw_payload, updated_at=now()`,
          ['ifood', orderId, merchantId, '100',
           customerName, customerPhone, address,
           JSON.stringify(items), totalPrice, JSON.stringify(order)]
        );
        await pool.query(`UPDATE integrations SET orders_count=orders_count+1, last_sync_at=now(), updated_at=now() WHERE platform='ifood'`);
        console.log(`[ifood webhook] pedido ${orderId} salvo (loja: ${shopName || merchantId})`);

        await tryAutoAccept('ifood', orderId, null);

      } else if (eventType === 'CONFIRMED' || eventType === 'CFM') {
        await pool.query(`UPDATE orders SET status='confirmed', updated_at=now() WHERE platform='ifood' AND platform_order_id=$1`, [orderId]);
        console.log(`[ifood webhook] pedido ${orderId} confirmado`);

      } else if (eventType === 'CANCELLED' || eventType === 'CAN') {
        await pool.query(`UPDATE orders SET status='cancelled', updated_at=now() WHERE platform='ifood' AND platform_order_id=$1`, [orderId]);
        console.log(`[ifood webhook] pedido ${orderId} cancelado`);

      } else {
        console.log(`[ifood webhook] evento ${eventType} ignorado`);
      }
    } catch (err) {
      console.error('[ifood webhook] erro:', err.message);
    }
  }
});

router.get('/orders', async (req, res) => {
  try {
    const { date } = req.query;
    let query = `SELECT id, platform, platform_order_id, app_shop_id, status, customer_name, delivery_address, items, total_price, created_at, updated_at FROM orders WHERE platform='ifood'`;
    const params = [];
    if (date) {
      query += ` AND DATE(created_at AT TIME ZONE 'America/Sao_Paulo') = $1`;
      params.push(date);
    }
    query += ` ORDER BY created_at DESC LIMIT 100`;
    const result = await pool.query(query, params);
    return res.json(result.rows);
  } catch (err) { return res.status(500).json({ error: 'Erro ao buscar pedidos' }); }
});

router.post('/:orderId/confirm', async (req, res) => {
  const { orderId } = req.params;
  try {
    await ifood.confirmOrder(orderId);
    await pool.query(`UPDATE orders SET status='confirmed', updated_at=now() WHERE platform='ifood' AND platform_order_id=$1`, [orderId]);
    console.log(`[ifood confirm] pedido ${orderId} confirmado`);
    return res.json({ success: true });
  } catch (err) {
    console.error('[ifood confirm] erro:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

router.post('/:orderId/cancel', async (req, res) => {
  const { orderId } = req.params;
  const { reason } = req.body;
  try {
    await ifood.cancelOrder(orderId, reason);
    await pool.query(`UPDATE orders SET status='cancelled', updated_at=now() WHERE platform='ifood' AND platform_order_id=$1`, [orderId]);
    console.log(`[ifood cancel] pedido ${orderId} cancelado`);
    return res.json({ success: true });
  } catch (err) {
    console.error('[ifood cancel] erro:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

router.post('/:orderId/ready', async (req, res) => {
  const { orderId } = req.params;
  try {
    await pool.query(`UPDATE orders SET status='ready', updated_at=now() WHERE platform='ifood' AND platform_order_id=$1`, [orderId]);
    console.log(`[ready] pedido ${orderId} marcado como pronto`);
    return res.json({ success: true });
  } catch (err) {
    console.error('[ready] erro:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
