// Converte billing_period em dias de validade do plano.
function billingIntervalDays(period) {
  if (period === 'weekly') return 7;
  if (period === 'yearly') return 365;
  return 30; // monthly (default)
}

module.exports = { billingIntervalDays };
