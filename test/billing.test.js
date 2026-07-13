const { billingIntervalDays } = require('../src/services/billing');

test('mapeia períodos', () => {
  expect(billingIntervalDays('weekly')).toBe(7);
  expect(billingIntervalDays('monthly')).toBe(30);
  expect(billingIntervalDays('yearly')).toBe(365);
  expect(billingIntervalDays('qualquer')).toBe(30);
});
