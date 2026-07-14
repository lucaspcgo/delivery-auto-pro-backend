jest.mock('../src/db/postgres');

const planAccess = require('../src/services/planAccess');
const pool = require('../src/db/postgres');
const { requireCapability } = require('../src/middleware/planGuard');
const { checkRestaurantLimit } = require('../src/services/planAccess');

function mockRes() {
  return { statusCode: 0, body: null, status(c){ this.statusCode=c; return this; }, json(b){ this.body=b; return this; } };
}

describe('PLAN_GATING_ENABLED flag OFF (default)', () => {
  const original = process.env.PLAN_GATING_ENABLED;

  afterEach(() => {
    if (original === undefined) delete process.env.PLAN_GATING_ENABLED;
    else process.env.PLAN_GATING_ENABLED = original;
  });

  test('requireCapability chama next() mesmo sem a capacidade quando flag está OFF (unset)', async () => {
    delete process.env.PLAN_GATING_ENABLED;
    jest.spyOn(planAccess, 'hasCapability').mockResolvedValue(false);
    const res = mockRes();
    const next = jest.fn();
    await requireCapability('menu_sync')({ user: { id: 1 } }, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.statusCode).toBe(0);
    expect(res.body).toBeNull();
  });

  test('requireCapability chama next() mesmo sem a capacidade quando flag está OFF (false)', async () => {
    process.env.PLAN_GATING_ENABLED = 'false';
    jest.spyOn(planAccess, 'hasCapability').mockResolvedValue(false);
    const res = mockRes();
    const next = jest.fn();
    await requireCapability('menu_sync')({ user: { id: 1 } }, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.statusCode).toBe(0);
    expect(res.body).toBeNull();
  });
});

describe('checkRestaurantLimit com flag OFF', () => {
  const original = process.env.PLAN_GATING_ENABLED;

  afterEach(() => {
    if (original === undefined) delete process.env.PLAN_GATING_ENABLED;
    else process.env.PLAN_GATING_ENABLED = original;
  });

  test('retorna allowed:true sem consultar o banco', async () => {
    delete process.env.PLAN_GATING_ENABLED;
    pool.query.mockClear();
    const r = await checkRestaurantLimit(1, { plan: 'free' });
    expect(r).toEqual({ allowed: true });
    expect(pool.query).not.toHaveBeenCalled();
  });
});
