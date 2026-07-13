process.env.JWT_SECRET = process.env.JWT_SECRET || 'x'.repeat(40);

jest.mock('../src/db/postgres', () => require('./helpers/mockPool').mockPool());
jest.mock('jsonwebtoken', () => ({
  verify: jest.fn(() => ({ id: 1, email: 'a@a.com' })),
  sign: jest.fn(() => 'fake.jwt.token'),
}));

const express = require('express');
const request = require('supertest');
const pool = require('../src/db/postgres');
const checkoutRouter = require('../src/routes/checkout');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/checkout', checkoutRouter);
  return app;
}

describe('POST /api/v1/checkout/confirm deriva plan_expires_at do billing_period', () => {
  test('plano weekly usa intervalo de 7 dias', async () => {
    const app = buildApp();

    // 1: SELECT invoice
    pool.query.mockResolvedValueOnce({
      rows: [{ id: 10, status: 'pending', plan: 'weekly-plan', user_id: 3 }],
    });
    // 2: UPDATE invoices SET status='paid'
    pool.query.mockResolvedValueOnce({ rows: [] });
    // 3: SELECT billing_period FROM plans WHERE slug = $1
    pool.query.mockResolvedValueOnce({ rows: [{ billing_period: 'weekly' }] });
    // 4: UPDATE users SET plan=..., plan_expires_at=...
    pool.query.mockResolvedValueOnce({ rows: [] });
    // 5: SELECT create_user_defaults
    pool.query.mockResolvedValueOnce({ rows: [] });
    // 6: SELECT * FROM users WHERE id=$1
    pool.query.mockResolvedValueOnce({
      rows: [{ id: 3, email: 'a@a.com', name: 'A', role: 'user', is_admin: false, plan: 'weekly-plan' }],
    });

    const res = await request(app)
      .post('/api/v1/checkout/confirm')
      .send({ invoice_id: 10 });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const usersUpdateCall = pool.query.mock.calls.find(
      ([sql]) => sql.includes('UPDATE users') && sql.includes('plan_expires_at')
    );
    expect(usersUpdateCall).toBeDefined();
    const [sql, params] = usersUpdateCall;
    expect(sql).not.toMatch(/INTERVAL '30 days'/);
    expect(params).toContain('7');
  });
});
