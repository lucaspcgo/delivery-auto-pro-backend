process.env.TRIAL_DAYS = process.env.TRIAL_DAYS || '3';
const { billingIntervalDays, planCycleDays } = require('../src/services/billing');

test('mapeia períodos', () => {
  expect(billingIntervalDays('weekly')).toBe(7);
  expect(billingIntervalDays('monthly')).toBe(30);
  expect(billingIntervalDays('yearly')).toBe(365);
  expect(billingIntervalDays('qualquer')).toBe(30);
});

test('planCycleDays: free usa trial (3), pago usa o ciclo', () => {
  expect(planCycleDays({ is_free: true, billing_period: 'monthly' })).toBe(3); // free = 3 dias
  expect(planCycleDays({ is_free: false, billing_period: 'weekly' })).toBe(7);
  expect(planCycleDays({ is_free: false, billing_period: 'monthly' })).toBe(30);
});
