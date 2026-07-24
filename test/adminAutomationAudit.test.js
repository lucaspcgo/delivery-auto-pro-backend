// Auditoria PROFUNDA da automação por usuário: relatório com veredito,
// percentuais, detalhamento por loja e amostra dos pedidos (prova pro cliente).
process.env.PLAN_GATING_ENABLED = 'false';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-com-mais-de-32-caracteres-aqui-ok';

jest.mock('../src/db/postgres', () => require('./helpers/mockPool').mockPool());
// Evita que o ensureAutomationSchema consuma queries mockadas.
jest.mock('../src/services/autoAccept', () => ({ ensureAutomationSchema: jest.fn().mockResolvedValue() }));

const jwt = require('jsonwebtoken');
const express = require('express');
const request = require('supertest');
const pool = require('../src/db/postgres');
const { JWT_SECRET } = require('../src/config/env');
const adminRouter = require('../src/routes/admin');

function app() {
  const a = express();
  a.use(express.json());
  a.use('/admin', adminRouter);
  return a;
}
const adminToken = () => jwt.sign({ id: 1, is_admin: true, role: 'admin' }, JWT_SECRET, { expiresIn: '1h' });

beforeEach(() => pool.query.mockReset());

test('exige user_id', async () => {
  const res = await request(app()).get('/admin/automation-audit').set('Authorization', `Bearer ${adminToken()}`);
  expect(res.status).toBe(400);
});

test('monta relatório com veredito, percentuais e por loja', async () => {
  pool.query
    // user
    .mockResolvedValueOnce({ rows: [{ id: 'u1', name: 'Loja X', email: 'x@x.com', plan: 'pro', active: true }] })
    // rules
    .mockResolvedValueOnce({ rows: [{ id: 1, action: 'auto_ready', platform: 'all', enabled: true, accept_delay_seconds: 0, delay_seconds: 120 }] })
    // agg
    .mockResolvedValueOnce({ rows: [{ total: '10', aceitos_auto: '10', prontos_auto: '8',
      despachados_auto: '7', cancelados: '1', ultimo_pronto_auto: '2026-07-24T10:00:00Z',
      seg_medio_ate_pronto: '95.4' }] })
    // por loja
    .mockResolvedValueOnce({ rows: [
      { app_shop_id: 'shopA', total: '6', prontos_auto: '6', ultimo_pronto_auto: '2026-07-24T10:00:00Z' },
      { app_shop_id: 'shopB', total: '4', prontos_auto: '2', ultimo_pronto_auto: '2026-07-23T09:00:00Z' },
    ] })
    // amostra
    .mockResolvedValueOnce({ rows: [
      { id: 'o1', platform: 'ifood', platform_order_id: 'A1', app_shop_id: 'shopA', status: 'entregue',
        created_at: '2026-07-24T09:58:00Z', updated_at: '2026-07-24T10:00:00Z',
        automation_accepted_at: '2026-07-24T09:58:30Z', automation_ready_at: '2026-07-24T10:00:00Z',
        automation_dispatched_at: null },
      { id: 'o2', platform: 'ifood', platform_order_id: 'A2', app_shop_id: 'shopB', status: 'entregue',
        created_at: '2026-07-23T08:58:00Z', updated_at: '2026-07-23T09:10:00Z',
        automation_accepted_at: null, automation_ready_at: null, automation_dispatched_at: null },
    ] });

  const res = await request(app())
    .get('/admin/automation-audit?user_id=u1&days=30')
    .set('Authorization', `Bearer ${adminToken()}`);

  expect(res.status).toBe(200);
  expect(res.body.user.email).toBe('x@x.com');
  expect(res.body.automacao_config.alguma_ligada).toBe(true);
  expect(res.body.resumo.total_pedidos).toBe(10);
  expect(res.body.resumo.prontos_automacao).toBe(8);
  expect(res.body.resumo.prontos_pct).toBe(80);
  expect(res.body.resumo.tempo_medio_ate_pronto_seg).toBe(95);
  expect(res.body.resumo.veredito).toMatch(/8 de 10/);
  expect(res.body.por_loja).toHaveLength(2);
  expect(res.body.por_loja[0].prontos_pct).toBe(100);
  // prova por pedido
  expect(res.body.pedidos[0].pronto_via).toBe('automação (API)');
  expect(res.body.pedidos[1].pronto_via).toBe('manual/gestor');
});
