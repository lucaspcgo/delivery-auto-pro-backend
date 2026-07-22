// Liga/desliga o gating de planos. Padrão OFF (passthrough) para deploy seguro.
function isPlanGatingEnabled() {
  return process.env.PLAN_GATING_ENABLED === 'true';
}

// Dias de teste grátis do plano Free. Padrão 3 (ajustável por env TRIAL_DAYS).
function trialDays() {
  const n = Number(process.env.TRIAL_DAYS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 3;
}

module.exports = { isPlanGatingEnabled, trialDays };
