jest.mock('../src/db/postgres', () => require('./helpers/mockPool').mockPool());
const pool = require('../src/db/postgres');
const { resolveUserPlan, hasCapability, getLimit } = require('../src/services/planAccess');

const planRow = {
  slug: 'pro', name: 'Pro', active: true,
  capabilities: { menu_sync: true, auto_accept: true },
  max_restaurants: 3, max_orders_month: 2000,
};

test('resolveUserPlan carrega plano pelo slug', async () => {
  pool.query.mockResolvedValueOnce({ rows: [planRow] });
  const p = await resolveUserPlan({ id: 1, plan: 'pro' });
  expect(p.capabilities.menu_sync).toBe(true);
  expect(p.max_restaurants).toBe(3);
});

test('resolveUserPlan cai no free se slug não existe', async () => {
  pool.query
    .mockResolvedValueOnce({ rows: [] })  // busca 'inexistente'
    .mockResolvedValueOnce({ rows: [{ slug: 'free', name: 'Free', active: true, capabilities: {}, max_restaurants: 1, max_orders_month: 100 }] });
  const p = await resolveUserPlan({ id: 1, plan: 'inexistente' });
  expect(p.slug).toBe('free');
});

test('hasCapability true/false', async () => {
  pool.query.mockResolvedValue({ rows: [planRow] });
  expect(await hasCapability({ plan: 'pro' }, 'menu_sync')).toBe(true);
  expect(await hasCapability({ plan: 'pro' }, 'inexistente')).toBe(false);
});

test('getLimit devolve número', async () => {
  pool.query.mockResolvedValue({ rows: [planRow] });
  expect(await getLimit({ plan: 'pro' }, 'max_restaurants')).toBe(3);
});
