const pool = require('../db/postgres');
const food99 = require('./food99');
const ifood = require('./ifood');

async function tryAutoAccept(platform, orderId, appShopId) {
  try {
    // Busca regras ativas para essa plataforma
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
