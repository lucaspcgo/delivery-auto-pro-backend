const pool = require('../db/postgres');
const food99 = require('./food99');
const ifoodDistributed = require('./ifood-distributed');

// Aceita automaticamente um pedido conforme a regra de automação DO USUÁRIO dono da loja.
// storeId = app_shop_id (99food) ou merchantId (iFood, guardado em orders.app_shop_id).
async function tryAutoAccept(platform, orderId, storeId, userId) {
  try {
    if (!userId) {
      console.log(`[auto-accept] sem userId para pedido ${orderId} (${platform}) — ignorando`);
      return false;
    }

    // Busca a regra de auto-aceite DESTE usuário (isolamento por conta)
    const rules = await pool.query(
      `SELECT * FROM automation_rules
       WHERE user_id = $1 AND action = 'auto_accept' AND enabled = true
       AND (platform = $2 OR platform = 'all')
       ORDER BY platform DESC LIMIT 1`,
      [userId, platform]
    );

    if (rules.rows.length === 0) {
      console.log(`[auto-accept] sem regra ativa para ${platform} (user ${userId})`);
      return false;
    }

    const rule = rules.rows[0];
    const delay = (rule.delay_seconds || 0) * 1000;
    const readyDelay = (rule.ready_delay_seconds || 600) * 1000; // padrão 10 min

    console.log(`[auto-accept] pedido ${orderId} (${platform}, user ${userId}) será aceito em ${rule.delay_seconds || 0}s`);

    setTimeout(async () => {
      try {
        if (platform === '99food') {
          const authToken = await food99.getValidToken(storeId);
          await food99.confirmOrder(authToken, orderId);
        } else if (platform === 'ifood') {
          await ifoodDistributed.confirmOrder(userId, orderId);
        }

        await pool.query(
          `UPDATE orders SET status = 'confirmed', updated_at = now()
           WHERE platform = $1 AND platform_order_id = $2 AND user_id = $3`,
          [platform, String(orderId), userId]
        );

        console.log(`[auto-accept] pedido ${orderId} (${platform}, user ${userId}) ACEITO automaticamente`);

        // Após aceitar, marca como PRONTO/DESPACHADO automaticamente
        setTimeout(async () => {
          try {
            if (platform === 'ifood') {
              await ifoodDistributed.readyToPickup(userId, orderId).catch(e =>
                console.warn(`[auto-ready] readyToPickup ${orderId}: ${e.message}`));
              await ifoodDistributed.dispatchOrder(userId, orderId).catch(e =>
                console.warn(`[auto-ready] dispatch ${orderId}: ${e.message}`));
              console.log(`[auto-ready] pedido ${orderId} (ifood) marcado como PRONTO e DESPACHADO`);
            } else if (platform === '99food') {
              const authToken = await food99.getValidToken(storeId);
              const https = require('https');
              await new Promise((resolve, reject) => {
                const path = `/v1/order/order/ready?auth_token=${encodeURIComponent(authToken)}&order_id=${orderId}`;
                const req = https.request({
                  hostname: 'openapi.didi-food.com', path, method: 'GET',
                  headers: { 'Content-Type': 'application/json' }
                }, (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d)); });
                req.on('error', reject);
                req.end();
              });
              console.log(`[auto-ready] pedido ${orderId} (99food) marcado como PRONTO`);
            }

            await pool.query(
              `UPDATE orders SET status = 'ready', updated_at = now()
               WHERE platform = $1 AND platform_order_id = $2 AND user_id = $3`,
              [platform, String(orderId), userId]
            );

            console.log(`[auto-ready] pedido ${orderId} (${platform}, user ${userId}) PRONTO automaticamente`);
          } catch (err) {
            console.error(`[auto-ready] erro ao marcar pronto ${orderId}:`, err.message);
          }
        }, readyDelay);

      } catch (err) {
        console.error(`[auto-accept] erro ao aceitar ${orderId}:`, err.message);
      }
    }, delay);

    return true;
  } catch (err) {
    console.error('[auto-accept] erro:', err.message);
    return false;
  }
}

module.exports = { tryAutoAccept };
