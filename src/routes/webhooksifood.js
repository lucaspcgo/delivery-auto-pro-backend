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
      console.log(`[ifood webhook] evento: ${eventType}, pedido: ${orderId}`);

      if (!orderId) continue;

      if (eventType === 'PLACED' || eventType === 'PLC') {
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

        await pool.query(
          `INSERT INTO orders (platform, platform_order_id, app_shop_id, status, customer_name, customer_phone, delivery_address, items, total_price, raw_payload, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now(),now())
           ON CONFLICT (platform, platform_order_id) DO UPDATE SET status=EXCLUDED.status, raw_payload=EXCLUDED.raw_payload, updated_at=now()`,
          ['ifood', orderId, order.merchant?.id || null, '100',
           customerName, customerPhone, address,
           JSON.stringify(items), totalPrice, JSON.stringify(order)]
        );
        await pool.query(`UPDATE integrations SET orders_count=orders_count+1, last_sync_at=now(), updated_at=now() WHERE platform='ifood'`);
        console.log(`[ifood webhook] pedido ${orderId} salvo`);

        // Tenta aceitar automaticamente
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
    const result = await pool.query(`SELECT id, platform, platform_order_id, app_shop_id, status, customer_name, delivery_address, items, total_price, created_at, updated_at FROM orders WHERE platform='ifood' ORDER BY created_at DESC LIMIT 50`);
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

// POST /api/v1/orders/ifood/:orderId/ready
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
