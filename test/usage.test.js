jest.mock('../src/db/postgres', () => require('./helpers/mockPool').mockPool());
jest.mock('../src/services/planAccess');
jest.mock('../src/middleware/auth', () => ({
  authenticateToken: (req, res, next) => {
    req.user = { id: 1, email: 'test@example.com' };
    next();
  },
}));

const pool = require('../src/db/postgres');
const planAccess = require('../src/services/planAccess');
const { buildUsage } = require('../src/routes/usage');

test('over_limit true quando excede pedidos/mês', async () => {
  planAccess.resolveUserPlan.mockResolvedValue({ slug:'starter', capabilities:{}, max_restaurants:1, max_orders_month:100 });
  pool.query
    .mockResolvedValueOnce({ rows: [{ count: '1' }] })   // restaurants
    .mockResolvedValueOnce({ rows: [{ count: '150' }] }); // orders mês
  const u = await buildUsage({ id: 1, plan: 'starter' });
  expect(u.over_limit).toBe(true);
  expect(u.orders_this_month).toBe(150);
});
