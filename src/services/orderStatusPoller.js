// Consulta periodicamente o STATUS dos pedidos ativos do 99Food na API e atualiza
// o nosso sistema — porque o 99Food NÃO nos avisa por webhook quando o pedido é
// concluído/cancelado. Sem isso, pedidos já entregues ficam eternamente em
// "Aguardando" no KDS (aparecendo como atrasados).
//
// Sinal principal (independe da tabela de códigos de status do 99Food):
//   complete_time > 0  -> pedido ENTREGUE/concluído  (status 'delivered')
//   cancel_time   > 0  -> pedido CANCELADO           (status 'cancelled')
// Senão, guardamos o status cru que a API devolver.
const pool = require('../db/postgres');
const food99 = require('./food99');
const { normalizeStage, stageRank } = require('./kdsStages');

const INTERVALO = 120 * 1000; // a cada 2 min
const ESPACO = 2000;          // 2s entre chamadas (respeita limite do 99Food)
const LOTE = 30;              // no máx. 30 pedidos por ciclo

async function pollOnce() {
  let orders;
  try {
    // Pedidos 99Food ativos (não finalizados) das últimas 12h, mais “parados” primeiro
    orders = await pool.query(
      `SELECT platform_order_id, app_shop_id, user_id, status
         FROM orders
        WHERE platform = '99food'
          AND created_at > now() - interval '12 hours'
          AND LOWER(status) NOT IN ('delivered','cancelled','concluded','completed','canceled')
        ORDER BY updated_at ASC
        LIMIT ${LOTE}`
    );
  } catch (err) {
    console.warn('[order-poll] não listou pedidos:', err.message);
    return;
  }
  if (orders.rows.length === 0) return;

  for (const o of orders.rows) {
    try {
      const token = await food99.getValidToken(o.app_shop_id);
      const detail = await food99.getOrderDetail(token, o.platform_order_id);
      if (!detail || typeof detail !== 'object') { await sleep(ESPACO); continue; }

      // Regra: só AVANÇA (nunca regride). Estado final por complete_time/cancel_time;
      // caso contrário, adota o status do 99Food SOMENTE se ele estiver numa etapa
      // MAIS ADIANTADA que a nossa (ex.: nós em 'ready'/aguardando e o 99Food já em
      // 400/entregando -> avança para entregando; mas nunca volta 'ready' -> 200).
      let novo = null;
      if (Number(detail.complete_time) > 0) novo = 'delivered';
      else if (Number(detail.cancel_time) > 0) novo = 'cancelled';
      else if (detail.status != null && stageRank(detail.status) > stageRank(o.status)) {
        novo = String(detail.status);
      }

      if (novo && String(novo) !== String(o.status)) {
        await pool.query(
          `UPDATE orders SET status = $1, raw_payload = $2, updated_at = now()
            WHERE platform = '99food' AND platform_order_id = $3 AND user_id = $4`,
          [novo, JSON.stringify(detail), o.platform_order_id, o.user_id]
        );
        console.log(`[order-poll] pedido ${o.platform_order_id}: ${o.status} -> ${novo} (etapa "${normalizeStage(novo)}")`);
      }
    } catch (err) {
      // errno 10005 = limite de chamadas: para este ciclo e tenta no próximo
      if (/10005/.test(err.message)) {
        console.warn('[order-poll] limite do 99Food atingido — pausando ciclo');
        return;
      }
      // 12004 (simulador) e outros: ignora esse pedido e segue
    }
    await sleep(ESPACO);
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

let started = false;
function startOrderStatusPolling() {
  if (started) return;
  started = true;
  setTimeout(() => { pollOnce().catch(e => console.error('[order-poll] erro:', e.message)); }, 30 * 1000);
  setInterval(() => { pollOnce().catch(e => console.error('[order-poll] erro:', e.message)); }, INTERVALO);
  console.log('[order-poll] sincronização de status dos pedidos 99Food ligada (a cada 2 min)');
}

module.exports = { startOrderStatusPolling, pollOnce };
