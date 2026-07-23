// Verificador automático de pagamentos do Cora. A cada X segundos consulta as
// cobranças pendentes na API do Cora; quando uma está PAGA, libera o plano.
// Não depende de webhook cadastrado (o webhook, se cadastrado, só antecipa).
const pool = require('../db/postgres');
const cora = require('./cora');
const { markInvoicePaidAndActivate } = require('./planActivation');

const INTERVAL_MS = (Number(process.env.CORA_POLL_SECONDS) > 0 ? Number(process.env.CORA_POLL_SECONDS) : 90) * 1000;

async function pollOnce() {
  if (!cora.isConfigured()) return;
  const pend = await pool.query(
    `SELECT id, gateway_transaction_id FROM invoices
      WHERE payment_gateway = 'cora' AND status = 'pending'
        AND gateway_transaction_id IS NOT NULL
        AND created_at > now() - interval '7 days'
      ORDER BY created_at DESC LIMIT 50`
  );
  for (const inv of pend.rows) {
    try {
      const coraInv = await cora.getInvoice(inv.gateway_transaction_id);
      const status = coraInv && (coraInv.status || coraInv.state);
      if (String(status).toUpperCase() === 'PAID') {
        await markInvoicePaidAndActivate(inv.id, String(inv.gateway_transaction_id));
        console.log(`[cora-poller] fatura ${inv.id} PAGA — plano liberado`);
      }
    } catch (e) {
      console.warn(`[cora-poller] erro ao checar fatura ${inv.id}: ${e.message}`);
    }
  }
}

let timer = null;
function startCoraPaymentPolling() {
  if (!cora.isConfigured()) {
    console.log('[cora-poller] Cora não configurado — verificador de pagamento desligado');
    return;
  }
  console.log(`[cora-poller] verificador de pagamento iniciado (a cada ${INTERVAL_MS / 1000}s)`);
  timer = setInterval(() => pollOnce().catch(e => console.error('[cora-poller]', e.message)), INTERVAL_MS);
}

module.exports = { startCoraPaymentPolling, pollOnce };
