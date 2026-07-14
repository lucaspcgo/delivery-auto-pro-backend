process.env.PLAN_GATING_ENABLED = 'true';
jest.mock('../src/db/postgres', () => require('./helpers/mockPool').mockPool());
const pool = require('../src/db/postgres');
const { checkRestaurantLimit } = require('../src/services/planAccess');

test('bloqueia ao atingir o limite', async () => {
  pool.query
    .mockResolvedValueOnce({ rows: [{ slug:'starter', name:'S', active:true, capabilities:{}, max_restaurants:1, max_orders_month:0 }] }) // resolveUserPlan
    .mockResolvedValueOnce({ rows: [{ count: '1' }] }); // contagem
  const r = await checkRestaurantLimit(1, { plan: 'starter' });
  expect(r.allowed).toBe(false);
});

test('permite quando ilimitado (0)', async () => {
  pool.query
    .mockResolvedValueOnce({ rows: [{ slug:'pro', name:'P', active:true, capabilities:{}, max_restaurants:0, max_orders_month:0 }] })
    .mockResolvedValueOnce({ rows: [{ count: '9' }] });
  const r = await checkRestaurantLimit(1, { plan: 'pro' });
  expect(r.allowed).toBe(true);
});
