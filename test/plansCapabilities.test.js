process.env.JWT_SECRET = process.env.JWT_SECRET || 'x'.repeat(40);

jest.mock('../src/db/postgres', () => require('./helpers/mockPool').mockPool());
jest.mock('jsonwebtoken', () => ({
  verify: jest.fn(() => ({ is_admin: true })),
  sign: jest.fn(() => 'fake.jwt.token'),
}));

const express = require('express');
const request = require('supertest');
const pool = require('../src/db/postgres');
const plansRouter = require('../src/routes/plans');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/plans', plansRouter);
  return app;
}

describe('POST /api/v1/plans persiste capabilities', () => {
  test('inclui capabilities (JSON) nos params do INSERT', async () => {
    const app = buildApp();
    const capabilities = { menu_sync: true, auto_accept: false };
    pool.query.mockResolvedValueOnce({
      rows: [{ id: 1, slug: 'pro', name: 'Pro', capabilities }],
    });

    const res = await request(app)
      .post('/api/v1/plans')
      .set('Authorization', 'Bearer admintoken')
      .send({ slug: 'pro', name: 'Pro', price: 99, billing_period: 'monthly', capabilities });

    expect(res.status).toBe(201);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/capabilities/);
    expect(params).toContain(JSON.stringify(capabilities));
  });
});

describe('PUT /api/v1/plans/:id persiste capabilities', () => {
  test('inclui capabilities (JSON) nos params do UPDATE', async () => {
    const app = buildApp();
    const capabilities = { menu_sync: true };
    pool.query.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ id: 5, slug: 'pro', name: 'Pro', capabilities }],
    });

    const res = await request(app)
      .put('/api/v1/plans/5')
      .set('Authorization', 'Bearer admintoken')
      .send({ capabilities });

    expect(res.status).toBe(200);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/capabilities\s*=\s*COALESCE/);
    expect(params).toContain(JSON.stringify(capabilities));
  });
});
