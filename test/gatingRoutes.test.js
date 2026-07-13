const express = require('express');
const request = require('supertest');

jest.mock('../src/db/postgres', () => ({
  query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
}));

jest.mock('../src/services/planAccess', () => ({
  hasCapability: jest.fn(),
}));

jest.mock('../src/middleware/auth', () => ({
  authenticateToken: (req, res, next) => {
    req.user = { id: 1, plan: 'free' };
    next();
  },
  requireAdmin: (req, res, next) => next(),
}));

jest.mock('../src/services/ifood-api-complete', () => ({}));
jest.mock('../src/services/ifood-distributed', () => ({}));
jest.mock('../src/services/food99', () => ({}));
jest.mock('../src/services/menu99food', () => ({}));
jest.mock('../src/services/autoAccept', () => ({
  tryAutoAccept: jest.fn(),
  ensureAutomationSchema: jest.fn().mockResolvedValue(undefined),
}));

const { hasCapability } = require('../src/services/planAccess');

describe('plan gating on routes', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('menuadmin /fetch and /copy require menu_sync', () => {
    let app;
    beforeEach(() => {
      const menuRouter = require('../src/routes/menuadmin');
      app = express();
      app.use(express.json());
      app.use('/api/v1/admin/menu', menuRouter);
    });

    test('/fetch blocks with 403 when capability missing', async () => {
      hasCapability.mockResolvedValue(false);
      const res = await request(app)
        .post('/api/v1/admin/menu/fetch')
        .send({ restaurant_id: 1, platform: 'ifood' });
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: 'plan_upgrade_required', capability: 'menu_sync' });
    });

    test('/fetch does not block (no 403) when capability present', async () => {
      hasCapability.mockResolvedValue(true);
      const res = await request(app)
        .post('/api/v1/admin/menu/fetch')
        .send({ restaurant_id: 1, platform: 'ifood' });
      expect(res.status).not.toBe(403);
    });

    test('/copy blocks with 403 when capability missing', async () => {
      hasCapability.mockResolvedValue(false);
      const res = await request(app)
        .post('/api/v1/admin/menu/copy')
        .send({});
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: 'plan_upgrade_required', capability: 'menu_sync' });
    });

    test('/copy does not block (no 403) when capability present', async () => {
      hasCapability.mockResolvedValue(true);
      const res = await request(app)
        .post('/api/v1/admin/menu/copy')
        .send({});
      expect(res.status).not.toBe(403);
    });
  });

  describe('automations PUT /:id requires auto_accept', () => {
    let app;
    beforeEach(() => {
      const automationsRouter = require('../src/routes/automations');
      app = express();
      app.use(express.json());
      app.use('/api/v1/automations', automationsRouter);
    });

    test('PUT /:id blocks with 403 when capability missing', async () => {
      hasCapability.mockResolvedValue(false);
      const res = await request(app)
        .put('/api/v1/automations/1')
        .send({ enabled: true });
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: 'plan_upgrade_required', capability: 'auto_accept' });
    });

    test('PUT /:id passes the gate (no plan_upgrade_required) when capability present', async () => {
      hasCapability.mockResolvedValue(true);
      const res = await request(app)
        .put('/api/v1/automations/1')
        .send({ enabled: true });
      // Guard passed; downstream ownership check (no matching row from the
      // mocked pool) legitimately returns its own 403 "Acesso negado" — the
      // point is it's not the plan gate's 403.
      expect(res.body).not.toEqual({ error: 'plan_upgrade_required', capability: 'auto_accept' });
      expect(hasCapability).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }), 'auto_accept');
    });
  });
});
