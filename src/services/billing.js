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

// Normaliza o período pra um dos valores canônicos aceitos pela trava do banco
// (weekly/monthly/yearly/one_time/free). Aceita rótulos PT e inglês.
function normalizeBillingPeriod(v) {
  const p = String(v || '').trim().toLowerCase();
  if (p === 'weekly' || p === 'semanal') return 'weekly';
  if (p === 'yearly' || p === 'annual' || p === 'anual') return 'yearly';
  if (p === 'one_time' || p === 'onetime' || p === 'único' || p === 'unico' || p === 'single') return 'one_time';
  if (p === 'free' || p === 'gratuito' || p === 'gratis' || p === 'grátis') return 'free';
  return 'monthly'; // mensal / monthly / vazio → padrão
}

// Conjunto canônico (usado também pela trava CHECK do banco).
const BILLING_PERIODS = ['weekly', 'monthly', 'yearly', 'one_time', 'free'];

module.exports = { billingIntervalDays, normalizeBillingPeriod, BILLING_PERIODS };
