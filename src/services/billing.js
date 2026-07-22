// Converte billing_period em dias de validade do plano. Aceita os valores em
// inglês (weekly/monthly/yearly) E os rótulos em português que o painel pode
// enviar (semanal/mensal/anual), pra não calcular ciclo errado. "único"/"gratuito"
// caem no padrão mensal (30 dias).
function billingIntervalDays(period) {
  const p = String(period || '').trim().toLowerCase();
  if (p === 'weekly' || p === 'semanal') return 7;
  if (p === 'yearly' || p === 'annual' || p === 'anual') return 365;
  return 30; // monthly / mensal / único / gratuito (default)
}

module.exports = { billingIntervalDays };
