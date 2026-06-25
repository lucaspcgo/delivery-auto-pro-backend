const pool = require('../db/postgres');
const food99 = require('./food99');
const ifood = require('./ifood');

async function tryAutoAccept(platform, orderId, appShopId) {
  try {
    const rules = await pool.query(
      `SELECT * FROM automation_rules 
       WHERE action = 'auto_accept' AND enabled = true 
       AND (platform = $1 OR platform = 'all')
       ORDER BY platform DESC LIMIT 1`,
      [platform]
    );

    if (rules.rows.length === 0) {
      console.log(`[auto-accept] sem regra ativa para ${platform}`);
      return false;
    }

    const rule = rules.rows[0];
    const delay = rule.delay_seconds * 1000;

    console.log(`[auto-accept] pedido ${orderId} (${platform}) será aceito em ${rule.delay_seconds}s`);

    setTimeout(async () => {
      try {
        if (platform === '99food') {
          const authToken = await food99.getValidToken(appShopId);
          await food99.confirmOrder(authToken, orderId);
        } else if (platform === 'ifood') {
          await ifood.confirmOrder(orderId);
        }

        await pool.query(
          `UPDATE orders SET status = 'confirmed', updated_at = now() 
           WHERE platform = $1 AND platform_order_id = $2`,
          [platform, String(orderId)]
        );

        console.log(`[auto-accept] pedido ${orderId} (${platform}) ACEITO automaticamente`);

        // Após aceitar, marca como PRONTO automaticamente após 10 segundos
        setTimeout(async () => {
          try {
            if (platform === 'ifood') {
              // iFood: readyToPickup → dispatch
              const token = await ifood.getValidToken();
              const https = require('https');
              // Ready to pickup
              await new Promise((resolve, reject) => {
                const req = https.request({
                  hostname: 'merchant-api.ifood.com.br',
                  path: `/order/v1.0/orders/${orderId}/readyToPickup`,
                  method: 'POST',
                  headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
                }, (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d)); });
                req.on('error', reject);
                req.end();
              });
              // Dispatch
              await ifood.dispatchOrder(orderId);
              console.log(`[auto-ready] pedido ${orderId} (ifood) marcado como PRONTO e DESPACHADO`);
            } else if (platform === '99food') {
              // 99Food: ready
              const authToken = await food99.getValidToken(appShopId);
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
               WHERE platform = $1 AND platform_order_id = $2`,
              [platform, String(orderId)]
            );

            console.log(`[auto-ready] pedido ${orderId} (${platform}) PRONTO automaticamente`);
          } catch (err) {
            console.error(`[auto-ready] erro ao marcar pronto ${orderId}:`, err.message);
          }
        }, 10000); // 10 segundos após aceitar

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
