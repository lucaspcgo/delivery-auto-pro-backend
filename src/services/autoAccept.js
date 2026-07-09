const pool = require('../db/postgres');
const food99 = require('./food99');
const ifoodDistributed = require('./ifood-distributed');

// Garante a coluna do tempo de aceite (idempotente). accept_delay_seconds = quantos
// segundos esperar ANTES de aceitar o pedido (0 = na hora).
let schemaReady = null;
function ensureAutomationSchema() {
  if (!schemaReady) {
    schemaReady = pool.query(
      `ALTER TABLE automation_rules ADD COLUMN IF NOT EXISTS accept_delay_seconds INTEGER DEFAULT 0`
    ).catch(err => { schemaReady = null; throw err; });
  }
  return schemaReady;
}

// Aceita automaticamente um pedido conforme a regra de automação DO USUÁRIO dono da loja.
// storeId = app_shop_id (99food) ou merchantId (iFood, guardado em orders.app_shop_id).
async function tryAutoAccept(platform, orderId, storeId, userId) {
  try {
    if (!userId) {
      console.log(`[auto-accept] sem userId para pedido ${orderId} (${platform}) — ignorando`);
      return false;
    }

    await ensureAutomationSchema();

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
    // Espera accept_delay_seconds antes de ACEITAR; depois delay_seconds antes de marcar PRONTO.
    const acceptDelay = (rule.accept_delay_seconds != null ? rule.accept_delay_seconds : 0) * 1000; // padrão: na hora
    const readyDelay = (rule.delay_seconds != null ? rule.delay_seconds : 480) * 1000; // padrão 8 min

    console.log(`[auto-accept] pedido ${orderId} (${platform}, user ${userId}) aceita em ${Math.round(acceptDelay / 1000)}s; pronto ${Math.round(readyDelay / 1000)}s após aceitar`);

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
              await food99.readyOrder(authToken, orderId).catch(e =>
                console.warn(`[auto-ready] ready 99food ${orderId}: ${e.message}`));
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
    }, acceptDelay);

    return true;
  } catch (err) {
    console.error('[auto-accept] erro:', err.message);
    return false;
  }
}

module.exports = { tryAutoAccept, ensureAutomationSchema };
