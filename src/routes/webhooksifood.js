const express = require('express');
const pool = require('../db/postgres');
const ifoodDistributed = require('../services/ifood-distributed');
const { processEvent } = require('../services/ifood-events');
const { attachItemImages } = require('../services/orderImages');
const { extractOrderExtras } = require('../services/orderExtras');
const { authenticateToken, requireAdmin } = require('../middleware/auth');
const { makeDebugHandler } = require('./orderDebug');
const { normalizeStage } = require('../services/kdsStages');
const router = express.Router();

// GET /debug — painel de depuração: campos brutos + mapeamento (SÓ admin)
router.get('/debug', authenticateToken, requireAdmin, makeDebugHandler('ifood'));

router.post('/', async (req, res) => {
  res.status(200).json({ ok: true });
  const events = Array.isArray(req.body) ? req.body : [req.body];
  console.log(`[ifood webhook] recebido ${events.length} evento(s)`);

  for (const event of events) {
    try {
      await processEvent(event);
    } catch (err) {
      console.error('[ifood webhook] erro:', err.message);
    }
  }
});

// GET /orders — requer autenticação
router.get('/orders', authenticateToken, async (req, res) => {
  try {
    const { date } = req.query;
    let query = `SELECT id, platform, platform_order_id, app_shop_id, status, customer_name, customer_phone, delivery_address, items, total_price, raw_payload, created_at, updated_at FROM orders WHERE platform='ifood' AND user_id=$1`;
    const params = [req.user.id];
    if (date) { query += ` AND DATE(created_at AT TIME ZONE 'America/Sao_Paulo') = $2`; params.push(date); }
    query += ` ORDER BY created_at DESC LIMIT 100`;
    const result = await pool.query(query, params);
    const orders = await attachItemImages(result.rows, 'ifood', req.user.id);
    for (const o of orders) {
      Object.assign(o, extractOrderExtras(o.raw_payload, 'ifood'));
      o.kds_stage = normalizeStage(o.status); // etapa/coluna do KDS
      delete o.raw_payload; // não devolve o payload cru (grande)
    }
    return res.json(orders);
  } catch (err) { return res.status(500).json({ error: 'Erro ao buscar pedidos' }); }
});

// POST /:orderId/confirm — requer autenticação
router.post('/:orderId/confirm', authenticateToken, async (req, res) => {
  const { orderId } = req.params;
  try {
    // Validar ownership
    const order = await pool.query(
      'SELECT * FROM orders WHERE platform = $1 AND platform_order_id = $2 AND user_id = $3',
      ['ifood', orderId, req.user.id]
    );
    if (order.rowCount === 0) {
      return res.status(403).json({ error: 'Acesso negado' });
    }

    await ifoodDistributed.confirmOrder(req.user.id, orderId);
    await pool.query(`UPDATE orders SET status='confirmed', updated_at=now() WHERE platform='ifood' AND platform_order_id=$1 AND user_id=$2`, [orderId, req.user.id]);
    console.log(`[ifood confirm] pedido ${orderId} confirmado (user: ${req.user.id})`);
    return res.json({ success: true });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

// POST /:orderId/cancel — requer autenticação
router.post('/:orderId/cancel', authenticateToken, async (req, res) => {
  const { orderId } = req.params;
  const { reason } = req.body;
  try {
    // Validar ownership
    const order = await pool.query(
      'SELECT * FROM orders WHERE platform = $1 AND platform_order_id = $2 AND user_id = $3',
      ['ifood', orderId, req.user.id]
    );
    if (order.rowCount === 0) {
      return res.status(403).json({ error: 'Acesso negado' });
    }

    await ifoodDistributed.cancelOrder(req.user.id, orderId, reason);
    await pool.query(`UPDATE orders SET status='cancelled', updated_at=now() WHERE platform='ifood' AND platform_order_id=$1 AND user_id=$2`, [orderId, req.user.id]);
    console.log(`[ifood cancel] pedido ${orderId} cancelado (user: ${req.user.id})`);
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
      ['ifood', orderId, req.user.id]
    );
    if (order.rowCount === 0) {
      return res.status(403).json({ error: 'Acesso negado' });
    }

    await ifoodDistributed.readyToPickup(req.user.id, orderId);
    await pool.query(`UPDATE orders SET status='ready', updated_at=now() WHERE platform='ifood' AND platform_order_id=$1 AND user_id=$2`, [orderId, req.user.id]);
    console.log(`[ifood ready] pedido ${orderId} pronto p/ retirada (user: ${req.user.id})`);
    return res.json({ success: true });
  } catch (err) {
    console.error(`[ifood ready] FALHA no pedido ${orderId}: ${err.message}`);
    return res.status(500).json({ error: 'Não foi possível marcar como pronto no iFood', details: err.message });
  }
});

// POST /:orderId/dispatch — saiu para entrega (SÓ entrega própria da loja). Requer autenticação.
router.post('/:orderId/dispatch', authenticateToken, async (req, res) => {
  const { orderId } = req.params;
  try {
    const order = await pool.query(
      'SELECT * FROM orders WHERE platform = $1 AND platform_order_id = $2 AND user_id = $3',
      ['ifood', orderId, req.user.id]
    );
    if (order.rowCount === 0) {
      return res.status(403).json({ error: 'Acesso negado' });
    }

    await ifoodDistributed.dispatchOrder(req.user.id, orderId);
    await pool.query(`UPDATE orders SET status='dispatched', updated_at=now() WHERE platform='ifood' AND platform_order_id=$1 AND user_id=$2`, [orderId, req.user.id]);
    console.log(`[ifood dispatch] pedido ${orderId} saiu para entrega (user: ${req.user.id})`);
    return res.json({ success: true });
  } catch (err) {
    console.error(`[ifood dispatch] FALHA no pedido ${orderId}: ${err.message}`);
    return res.status(500).json({ error: 'Não foi possível despachar no iFood (só vale para entrega própria)', details: err.message });
  }
});

module.exports = router;