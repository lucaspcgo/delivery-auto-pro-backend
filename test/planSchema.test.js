const { mockPool } = require('./helpers/mockPool');
jest.mock('../src/db/postgres', () => require('./helpers/mockPool').mockPool());

const pool = require('../src/db/postgres');
const { ensurePlanSchema } = require('../src/db/planSchema');

test('ensurePlanSchema roda DDL de capabilities e defaults', async () => {
  pool.query.mockResolvedValue({ rows: [] });
  await ensurePlanSchema();
  const sql = pool.query.mock.calls.map(c => c[0]).join('\n');
  expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS capabilities/i);
  expect(sql).toMatch(/max_restaurants/i);
  expect(sql).toMatch(/max_orders_month/i);
});
