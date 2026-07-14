// Liga/desliga o gating de planos. Padrão OFF (passthrough) para deploy seguro.
function isPlanGatingEnabled() {
  return process.env.PLAN_GATING_ENABLED === 'true';
}
module.exports = { isPlanGatingEnabled };
