const { mockPool } = require('./helpers/mockPool');

test('mockPool retorna query mockada', () => {
  const pool = mockPool();
  expect(typeof pool.query).toBe('function');
});
