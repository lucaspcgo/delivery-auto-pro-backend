// Processa um evento de pedido do iFood (usado tanto pelo webhook quanto pelo polling).
const pool = require('../db/postgres');
const ifoodDistributed = require('./ifood-distributed');
const { tryAutoAccept } = require('./autoAccept');

async function processEvent(event) {
  const orderId = event.orderId || event.id;
  const eventType = event.code || event.fullCode || event.type;
  const merchantId = event.merchantId || null;
  console.log(`[ifood event] ${eventType}, pedido: ${orderId}, loja: ${merchantId}`);

  if (!orderId) return;

  // Identifica o user_id dono da loja pelo merchant
  let userId = null;
  if (merchantId) {
    const loja = await pool.query(
      `SELECT r.name, r.user_id FROM restaurant_platforms rp
       JOIN restaurants r ON r.id = rp.restaurant_id
       WHERE rp.platform = 'ifood' AND rp.platform_merchant_id = $1 AND rp.status = 'authorized'`,
      [merchantId]
    );
    if (loja.rows.length > 0) {
      userId = loja.rows[0].user_id;
    } else {
      console.log(`[ifood event] loja ${merchantId} não cadastrada/autorizada — ignorando`);
      return;
    }
  }

  if (eventType === 'PLACED' || eventType === 'PLC') {
    const order = await ifoodDistributed.getOrderDetails(userId, orderId);
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
      `INSERT INTO orders (platform, platform_order_id, app_shop_id, status, customer_name, customer_phone, delivery_address, items, total_price, raw_payload, user_id, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now(),now())
       ON CONFLICT (platform, platform_order_id) DO UPDATE SET status=EXCLUDED.status, raw_payload=EXCLUDED.raw_payload, updated_at=now()`,
      ['ifood', orderId, merchantId, '100',
       customerName, customerPhone, address,
       JSON.stringify(items), totalPrice, JSON.stringify(order), userId]
    );
    await pool.query(
      `UPDATE integrations SET orders_count=orders_count+1, last_sync_at=now(), updated_at=now() WHERE platform='ifood' AND user_id=$1`,
      [userId]
    );
    console.log(`[ifood event] pedido ${orderId} salvo (loja: ${shopName || merchantId}, user: ${userId})`);
    await tryAutoAccept('ifood', orderId, merchantId, userId);

  } else if (eventType === 'CONFIRMED' || eventType === 'CFM') {
    await pool.query(`UPDATE orders SET status='confirmed', updated_at=now() WHERE platform='ifood' AND platform_order_id=$1 AND user_id=$2`, [orderId, userId]);
    console.log(`[ifood event] pedido ${orderId} confirmado (user: ${userId})`);

  } else if (eventType === 'CANCELLED' || eventType === 'CAN') {
    await pool.query(`UPDATE orders SET status='cancelled', updated_at=now() WHERE platform='ifood' AND platform_order_id=$1 AND user_id=$2`, [orderId, userId]);
    console.log(`[ifood event] pedido ${orderId} cancelado (user: ${userId})`);

  } else {
    // Demais eventos do iFood avançam a ETAPA do pedido no KDS.
    // Mapa: código do evento → status canônico salvo no pedido.
    const STAGE_EVENTS = {
      SEPARATION_STARTED: 'preparing', SPS: 'preparing',
      SEPARATION_ENDED: 'preparing', SPE: 'preparing',
      READY_TO_PICKUP: 'ready', RTP: 'ready',
      DISPATCHED: 'dispatched', DSP: 'dispatched',
      ARRIVED: 'arrived', ARV: 'arrived',
      CONCLUDED: 'delivered', CON: 'delivered',
    };
    const novoStatus = STAGE_EVENTS[String(eventType).toUpperCase()];
    if (novoStatus) {
      await pool.query(`UPDATE orders SET status=$3, updated_at=now() WHERE platform='ifood' AND platform_order_id=$1 AND user_id=$2`, [orderId, userId, novoStatus]);
      console.log(`[ifood event] pedido ${orderId} avançou para "${novoStatus}" (evento ${eventType})`);
    } else {
      console.log(`[ifood event] tipo ${eventType} ignorado`);
    }
  }
}

module.exports = { processEvent };
