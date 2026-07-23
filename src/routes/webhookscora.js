// Webhook do Cora: chamado quando uma cobrança muda de status (ex.: paga).
// Por segurança NÃO confia cegamente no corpo do webhook — consulta a cobrança
// na API do Cora pra confirmar que está PAGA antes de liberar o plano.
const express = require('express');
const pool = require('../db/postgres');
const cora = require('../services/cora');
const { markInvoicePaidAndActivate } = require('../services/planActivation');
const router = express.Router();

// Extrai o id da cobrança do payload (a Cora pode mandar em formatos diferentes).
function extractInvoiceId(body) {
  if (!body || typeof body !== 'object') return null;
  return body.invoice_id || body.resource_id || body.id
    || (body.resource && (body.resource.id || body.resource.invoice_id))
    || (body.data && (body.data.id || body.data.invoice_id))
    || null;
}

router.post('/', async (req, res) => {
  // Responde rápido pro Cora não reenviar; processa em seguida.
  res.status(200).json({ received: true });

  try {
    const coraInvoiceId = extractInvoiceId(req.body);
    if (!coraInvoiceId) {
      console.warn('[cora webhook] sem id de cobrança no payload:', JSON.stringify(req.body).slice(0, 200));
      return;
    }

    // Confirma o status DIRETO na Cora (não confia só no webhook).
    let status = null;
    try {
      const invoice = await cora.getInvoice(coraInvoiceId);
      status = invoice && (invoice.status || invoice.state);
    } catch (e) {
      console.warn(`[cora webhook] não consegui consultar cobrança ${coraInvoiceId} na Cora: ${e.message}`);
      return;
    }

    if (String(status).toUpperCase() !== 'PAID') {
      console.log(`[cora webhook] cobrança ${coraInvoiceId} está "${status}" (ainda não paga) — ignorando`);
      return;
    }

    // Acha NOSSA fatura pelo id da cobrança do Cora (guardado em gateway_transaction_id).
    const our = (await pool.query(
      `SELECT id FROM invoices WHERE gateway_transaction_id = $1 AND payment_gateway = 'cora' ORDER BY created_at DESC LIMIT 1`,
      [String(coraInvoiceId)]
    )).rows[0];
    if (!our) {
      console.warn(`[cora webhook] cobrança ${coraInvoiceId} paga, mas sem fatura correspondente no sistema`);
      return;
    }

    const r = await markInvoicePaidAndActivate(our.id, String(coraInvoiceId));
    console.log(`[cora webhook] cobrança ${coraInvoiceId} PAGA — fatura ${our.id} liberada (user ${r.user_id})`);
  } catch (err) {
    console.error('[cora webhook] erro:', err.message);
  }
});

module.exports = router;
