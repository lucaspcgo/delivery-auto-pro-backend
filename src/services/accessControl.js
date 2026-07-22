const pool = require('../db/postgres');

// Motivo do bloqueio de acesso de um usuário, ou null se está liberado.
//
// Respeita o CICLO do plano: plan_expires_at é gravado conforme o billing_period
// (semanal=7, mensal=30, anual=365 dias). Quando essa data passa, o acesso é
// cortado — vale tanto pro trial free quanto pro plano pago não renovado.
// Admin nunca é bloqueado.
function accessBlockReason(u) {
  if (!u) return 'not_found';
  if (u.is_admin) return null;
  if (u.active === false) return 'account_inactive';
  if (u.payment_status === 'suspended') return 'payment_suspended';
  if (u.plan_expires_at && new Date(u.plan_expires_at) < new Date()) return 'plan_expired';
  return null;
}

// Busca o usuário e diz se está bloqueado. Se o plano venceu (plan_expired),
// já marca payment_status='suspended' pra refletir no painel admin e no login.
async function checkUserAccess(userId) {
  const r = await pool.query(
    `SELECT id, active, is_admin, plan, payment_status, plan_expires_at
       FROM users WHERE id = $1`,
    [userId]
  );
  const u = r.rows[0];
  const reason = accessBlockReason(u);
  if (reason === 'plan_expired' && u && u.payment_status !== 'suspended') {
    await pool.query(
      `UPDATE users SET payment_status='suspended', updated_at=now() WHERE id=$1`, [u.id]
    ).catch(() => { /* não trava o fluxo se o UPDATE falhar */ });
  }
  return { blocked: !!reason, reason, user: u };
}

module.exports = { accessBlockReason, checkUserAccess };
