// Atualiza automaticamente o cache do cardápio (tabela menu_items) das lojas
// 99Food conectadas — assim as FOTOS dos produtos aparecem no KDS sem o usuário
// precisar clicar em "Buscar cardápio" toda vez.
const pool = require('../db/postgres');
const food99 = require('./food99');
const menu99food = require('./menu99food');

const INTERVALO = 6 * 60 * 60 * 1000; // a cada 6 horas
const ESPACO_ENTRE_LOJAS = 3000;       // 3s entre lojas (respeita limite do 99Food)

async function refreshOnce() {
  let stores;
  try {
    stores = await pool.query(
      `SELECT rp.restaurant_id, rp.app_shop_id, rp.platform_store_id
       FROM restaurant_platforms rp
       WHERE rp.platform = '99food' AND rp.status = 'authorized'
         AND COALESCE(rp.app_shop_id, rp.platform_store_id) IS NOT NULL`
    );
  } catch (err) {
    console.warn('[menu-cache] não foi possível listar lojas:', err.message);
    return;
  }

  for (const s of stores.rows) {
    const shopId = s.app_shop_id || s.platform_store_id;
    try {
      const token = await food99.getValidToken(shopId);
      const raw = await menu99food.fetchRawMenu(token);
      const items = menu99food.simplifyItems(raw, shopId);
      if (items.length) {
        await pool.query(
          `INSERT INTO menu_items (restaurant_id, platform, platform_store_id, items_data, updated_at, created_at)
           VALUES ($1, '99food', $2, $3, NOW(), NOW())
           ON CONFLICT (restaurant_id, platform) DO UPDATE SET
             items_data = EXCLUDED.items_data, updated_at = NOW()`,
          [s.restaurant_id, shopId, JSON.stringify(items)]
        );
        console.log(`[menu-cache] loja ${shopId}: ${items.length} item(ns) atualizados (fotos incluídas)`);
      }
    } catch (err) {
      // errno 10101 = a loja não está mais autorizada no 99Food (loja de teste
      // removida, vínculo desfeito, etc.). Desativa o vínculo para não tentar de
      // novo a cada ciclo (para de poluir o log e economiza chamada).
      if (/10101/.test(err.message) || /store authorization.*not exist/i.test(err.message)) {
        try {
          await pool.query(
            `UPDATE restaurant_platforms SET status = 'disconnected', updated_at = NOW()
             WHERE platform = '99food' AND COALESCE(app_shop_id, platform_store_id) = $1`,
            [shopId]
          );
          console.log(`[menu-cache] loja ${shopId} não autorizada (10101) — vínculo desativado, não será mais tentada`);
        } catch (e) { console.warn(`[menu-cache] não desativei loja ${shopId}: ${e.message}`); }
      } else {
        console.warn(`[menu-cache] loja ${shopId}: ${err.message}`);
      }
    }
    await new Promise(r => setTimeout(r, ESPACO_ENTRE_LOJAS));
  }
}

let started = false;
function startMenuCacheRefresh() {
  if (started) return;
  started = true;
  // Primeira atualização 1 min após subir (evita bater no rate-limit logo no boot)
  setTimeout(() => { refreshOnce().catch(e => console.error('[menu-cache] erro:', e.message)); }, 60 * 1000);
  setInterval(() => { refreshOnce().catch(e => console.error('[menu-cache] erro:', e.message)); }, INTERVALO);
  console.log('[menu-cache] atualização automática do cardápio ligada (a cada 6h)');
}

module.exports = { startMenuCacheRefresh, refreshOnce };
