// "Robô" de polling do iFood: pergunta ao iFood pelos pedidos das lojas
// autorizadas, processa e confirma o recebimento. Usado no modelo distribuído,
// onde não há webhook configurável no portal.

const ifoodDistributed = require('./ifood-distributed');
const { processEvent } = require('./ifood-events');

const POLL_INTERVAL_MS = 30000; // iFood recomenda 1 chamada a cada 30s

let timer = null;

async function pollOnce() {
  let auths;
  try {
    // MULTI-CONTA: cada autorização (conta iFood) tem sua própria fila de
    // eventos, então consultamos uma por uma com o token daquele acesso.
    auths = await ifoodDistributed.listAuthorizations();
  } catch (err) {
    console.error('[ifood-poller] erro ao listar autorizações:', err.message);
    return;
  }
  if (!auths.length) return;

  for (const auth of auths) {
    try {
      const token = await ifoodDistributed.getAccessTokenByAuthId(auth.id);
      const events = await ifoodDistributed.pollEvents(token);
      if (!events.length) continue;

      console.log(`[ifood-poller] acesso ${auth.id} (user ${auth.user_id}): ${events.length} evento(s)`);
      for (const ev of events) {
        try { await processEvent(ev); }
        catch (e) { console.error(`[ifood-poller] erro ao processar evento:`, e.message); }
      }
      // Confirma o recebimento (mesmo se algum falhou, para não travar a fila)
      await ifoodDistributed.acknowledgeEvents(token, events.map(e => e.id).filter(Boolean));
    } catch (err) {
      console.error(`[ifood-poller] acesso ${auth.id}:`, err.message);
    }
  }
}

function startPolling() {
  if (timer) return;
  console.log(`[ifood-poller] iniciado (a cada ${POLL_INTERVAL_MS / 1000}s)`);
  timer = setInterval(() => {
    pollOnce().catch(e => console.error('[ifood-poller] loop:', e.message));
  }, POLL_INTERVAL_MS);
}

module.exports = { startPolling, pollOnce };
