// Marca uma fatura como paga e LIBERA o plano do usuário (idempotente).
// Compartilhado entre o checkout manual (/checkout/confirm) e o webhook do Cora,
// pra a regra de liberação ficar num lugar só.
const pool = require('../db/postgres');
const { planCycleDays } = require('./billing');

async function markInvoicePaidAndActivate(invoiceId, gatewayTransactionId) {
  const inv = (await pool.query('SELECT * FROM invoices WHERE id = $1', [invoiceId])).rows[0];
  if (!inv) return { ok: false, reason: 'not_found' };
  if (inv.status === 'paid') return { ok: true, already_paid: true, user_id: inv.user_id, plan: inv.plan };

  await pool.query(
    `UPDATE invoices SET status='paid', paid_at=now(),
       gateway_transaction_id=COALESCE($1, gateway_transaction_id), updated_at=now()
     WHERE id=$2`,
    [gatewayTransactionId || null, invoiceId]
  );

  const planRow = (await pool.query('SELECT billing_period, is_free FROM plans WHERE slug=$1', [inv.plan])).rows[0];
  const days = planCycleDays(planRow || null);

  await pool.query(
    `UPDATE users SET plan=$1, payment_status='active',
       plan_expires_at=(now() + ($2 || ' days')::interval), active=true, updated_at=now()
     WHERE id=$3`,
    [inv.plan, String(days), inv.user_id]
  );
  await pool.query('SELECT create_user_defaults($1)', [inv.user_id]).catch(() => {});

  console.log(`[plano] liberado por pagamento — fatura ${invoiceId}, user ${inv.user_id}, plano ${inv.plan} (+${days}d)`);
  return { ok: true, user_id: inv.user_id, plan: inv.plan, days };
}

module.exports = { markInvoicePaidAndActivate };
