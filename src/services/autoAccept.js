const pool = require('../db/postgres');
const food99 = require('./food99');
const ifoodDistributed = require('./ifood-distributed');
const { stageRank } = require('./kdsStages');
const { isPlanGatingEnabled } = require('../config/featureFlags');
const { checkUserAccess } = require('./accessControl');

// Atualiza o status SÓ se for AVANÇO (nunca regride). Evita que o timer da
// automação (aceite/pronto) puxe de volta um pedido que já foi pra entrega ou
// já foi entregue. Retorna true se avançou.
async function advanceIfForward(platform, orderId, userId, newStatus) {
  const r = await pool.query(
    `SELECT status FROM orders WHERE platform=$1 AND platform_order_id=$2 AND user_id=$3`,
    [platform, String(orderId), userId]
  );
  if (r.rowCount === 0) return false;
  const cur = r.rows[0].status;
  if (stageRank(newStatus) <= stageRank(cur)) {
    console.log(`[auto] pedido ${orderId} já está em etapa igual/mais adiantada (${cur}) — não regride para ${newStatus}`);
    return false;
  }
  await pool.query(
    `UPDATE orders SET status=$4, updated_at=now() WHERE platform=$1 AND platform_order_id=$2 AND user_id=$3`,
    [platform, String(orderId), userId, newStatus]
  );
  return true;
}

// Garante a coluna do tempo de aceite (idempotente). accept_delay_seconds = quantos
// segundos esperar ANTES de aceitar o pedido (0 = na hora).
// Garante as colunas (idempotente). Cada ALTER é INDEPENDENTE: se um falhar,
// NÃO derruba o outro nem trava a automação (o problema aqui já causou pedido
// parado sem aceite/pronto). Nunca faz throw.
let schemaReady = null;
function ensureAutomationSchema() {
  if (!schemaReady) {
    schemaReady = Promise.allSettled([
      pool.query(`ALTER TABLE automation_rules ADD COLUMN IF NOT EXISTS accept_delay_seconds INTEGER DEFAULT 0`),
      pool.query(`ALTER TABLE restaurant_platforms ADD COLUMN IF NOT EXISTS automation_enabled BOOLEAN DEFAULT true`),
      // Carimbos de AUDITORIA: gravados só quando a NOSSA automação executa a
      // ação via API (ação manual no gestor não carimba). Prova pro cliente de
      // que a automação aceitou/marcou pronto/despachou, e a que horas.
      pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS automation_accepted_at TIMESTAMPTZ`),
      pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS automation_ready_at TIMESTAMPTZ`),
      pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS automation_dispatched_at TIMESTAMPTZ`),
    ]).then(results => {
      results.forEach(r => { if (r.status === 'rejected') console.warn('[auto-accept] schema:', r.reason?.message); });
    });
  }
  return schemaReady;
}

// Carimba no pedido o momento em que a automação executou a ação (via API).
// `column` é um nome fixo interno (não vem do usuário) — seguro interpolar.
// Só grava se ainda estiver vazio (mantém o PRIMEIRO carimbo, o real).
async function stampAutomation(platform, orderId, userId, column) {
  try {
    await pool.query(
      `UPDATE orders SET ${column}=now()
        WHERE platform=$1 AND platform_order_id=$2 AND user_id=$3 AND ${column} IS NULL`,
      [platform, String(orderId), userId]
    );
  } catch (e) {
    console.warn(`[auto] não consegui carimbar ${column} do pedido ${orderId}: ${e.message}`);
  }
}

// Lê do payload salvo se o pedido iFood é AGENDADO e a que horas começa a
// janela de entrega. Retorna o timestamp (ms) do início da janela, ou null se
// for imediato / sem agendamento. Pedido agendado NÃO pode ser despachado antes
// dessa janela (regra da homologação iFood).
async function getIfoodScheduleStart(orderId, userId) {
  try {
    const r = await pool.query(
      `SELECT raw_payload FROM orders WHERE platform='ifood' AND platform_order_id=$1 AND user_id=$2`,
      [String(orderId), userId]
    );
    let raw = r.rows[0] && r.rows[0].raw_payload;
    if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch { raw = null; } }
    if (!raw || typeof raw !== 'object') return null;
    const timing = String(raw.orderTiming || raw.orderType || '').toUpperCase();
    if (timing !== 'SCHEDULED') return null;
    const start = raw.schedule?.deliveryDateTimeStart || raw.schedule?.scheduledDateTimeStart
      || raw.delivery?.deliveryDateTime || raw.scheduledTo || null;
    const ms = start ? new Date(start).getTime() : NaN;
    return Number.isFinite(ms) ? ms : null;
  } catch (e) {
    console.warn(`[auto-ready] não consegui ler agendamento do pedido ${orderId}: ${e.message}`);
    return null;
  }
}

// Despacha o pedido iFood e carimba. Usado tanto no fluxo imediato quanto no
// agendado (chamado na hora da janela).
async function dispatchIfoodAndStamp(storeId, orderId, userId) {
  await ifoodDistributed.dispatchOrder(storeId, orderId)
    .then(() => stampAutomation('ifood', orderId, userId, 'automation_dispatched_at'))
    .catch(e => console.warn(`[auto-ready] dispatch ${orderId}: ${e.message}`));
}

// Diz se a automação está LIGADA para uma loja específica. À PROVA DE FALHA:
// qualquer erro/ausência de registro => considera LIGADO (nunca bloqueia por engano).
async function isStoreAutomationEnabled(platform, storeId, userId) {
  try {
    const r = await pool.query(
      `SELECT automation_enabled FROM restaurant_platforms
        WHERE platform = $1 AND user_id = $3
          AND (app_shop_id = $2 OR platform_merchant_id = $2 OR platform_store_id = $2)
        LIMIT 1`,
      [platform, String(storeId), userId]
    );
    return r.rows.length === 0 || r.rows[0].automation_enabled !== false;
  } catch (e) {
    console.warn(`[auto-accept] não consegui checar liga/desliga da loja ${storeId} (assumindo LIGADO): ${e.message}`);
    return true; // na dúvida, deixa a automação rodar
  }
}

// Aceita automaticamente um pedido conforme a regra de automação DO USUÁRIO dono da loja.
// storeId = app_shop_id (99food) ou merchantId (iFood, guardado em orders.app_shop_id).
async function tryAutoAccept(platform, orderId, storeId, userId) {
  try {
    if (!userId) {
      console.log(`[auto-accept] sem userId para pedido ${orderId} (${platform}) — ignorando`);
      return false;
    }

    // Conta bloqueada (inativa / pagamento suspenso / plano vencido) NÃO tem
    // automação. Respeita o ciclo do plano. Só corta com a flag ligada.
    if (isPlanGatingEnabled()) {
      try {
        const { blocked, reason } = await checkUserAccess(userId);
        if (blocked) {
          console.log(`[auto-accept] conta do user ${userId} bloqueada (${reason}) — automação NÃO roda p/ pedido ${orderId}`);
          return false;
        }
      } catch (e) {
        console.warn(`[auto-accept] checagem de acesso do user ${userId} falhou (deixando rodar): ${e.message}`);
      }
    }

    await ensureAutomationSchema();

    // Respeita o liga/desliga da automação DAQUELA loja
    if (!(await isStoreAutomationEnabled(platform, storeId, userId))) {
      console.log(`[auto-accept] automação DESLIGADA para a loja ${storeId} (${platform}) — ignorando pedido ${orderId}`);
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
    // Espera accept_delay_seconds antes de ACEITAR; depois delay_seconds antes de marcar PRONTO.
    let acceptDelay = (rule.accept_delay_seconds != null ? rule.accept_delay_seconds : 0) * 1000; // padrão: na hora
    const readyDelay = (rule.delay_seconds != null ? rule.delay_seconds : 480) * 1000; // padrão 8 min

    // TEMPO MÍNIMO antes de aceitar pedidos do 99Food: dá tempo do gestor da 99
    // imprimir o pedido (que chega como NOVO) antes da gente aceitar via API.
    // Controlado por env AUTO_ACCEPT_MIN_DELAY_SECONDS (padrão 0 = não muda nada).
    const minAcceptSec = Number(process.env.AUTO_ACCEPT_MIN_DELAY_SECONDS || 0);
    if (platform === '99food' && minAcceptSec > 0 && acceptDelay < minAcceptSec * 1000) {
      acceptDelay = minAcceptSec * 1000;
      console.log(`[auto-accept] mínimo de ${minAcceptSec}s antes de aceitar (99food, p/ impressão do gestor)`);
    }

    console.log(`[auto-accept] pedido ${orderId} (${platform}, user ${userId}) aceita em ${Math.round(acceptDelay / 1000)}s; pronto ${Math.round(readyDelay / 1000)}s após aceitar`);

    setTimeout(async () => {
      try {
        if (platform === '99food') {
          const authToken = await food99.getValidToken(storeId);
          await food99.confirmOrder(authToken, orderId);
        } else if (platform === 'ifood') {
          // storeId = merchantId (identifica a loja e o acesso/token certo)
          await ifoodDistributed.confirmOrder(storeId, orderId);
        }

        await advanceIfForward(platform, orderId, userId, 'confirmed');
        await stampAutomation(platform, orderId, userId, 'automation_accepted_at');

        console.log(`[auto-accept] pedido ${orderId} (${platform}, user ${userId}) ACEITO automaticamente`);

        // Após aceitar, marca como PRONTO/DESPACHADO automaticamente
        setTimeout(async () => {
          try {
            if (platform === 'ifood') {
              await ifoodDistributed.readyToPickup(storeId, orderId)
                .then(() => stampAutomation(platform, orderId, userId, 'automation_ready_at'))
                .catch(e => console.warn(`[auto-ready] readyToPickup ${orderId}: ${e.message}`));

              // AGENDADO: só despacha DENTRO da janela agendada (nunca antes —
              // foi o que reprovou na homologação). Imediato: despacha já.
              const schedStart = await getIfoodScheduleStart(orderId, userId);
              if (schedStart && schedStart > Date.now()) {
                const wait = schedStart - Date.now();
                console.log(`[auto-ready] pedido ${orderId} (ifood) é AGENDADO — despacho só na janela, em ${Math.round(wait / 60000)}min`);
                // Timer até a janela (limite de segurança de ~24 dias do setTimeout).
                setTimeout(() => {
                  dispatchIfoodAndStamp(storeId, orderId, userId)
                    .then(() => console.log(`[auto-ready] pedido AGENDADO ${orderId} DESPACHADO na janela`));
                }, Math.min(wait, 2147483647));
                console.log(`[auto-ready] pedido ${orderId} (ifood) marcado como PRONTO (despacho agendado)`);
              } else {
                await dispatchIfoodAndStamp(storeId, orderId, userId);
                console.log(`[auto-ready] pedido ${orderId} (ifood) marcado como PRONTO e DESPACHADO`);
              }
            } else if (platform === '99food') {
              const authToken = await food99.getValidToken(storeId);
              await food99.readyOrder(authToken, orderId)
                .then(() => stampAutomation(platform, orderId, userId, 'automation_ready_at'))
                .catch(e => console.warn(`[auto-ready] ready 99food ${orderId}: ${e.message}`));
              console.log(`[auto-ready] pedido ${orderId} (99food) marcado como PRONTO`);
            }

            await advanceIfForward(platform, orderId, userId, 'ready');

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
