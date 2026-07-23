// Visão Geral do admin: além dos cards antigos, traz métricas de decisão
// (crescimento de clientes, MRR, cobrança em atraso, automação).
process.env.PLAN_GATING_ENABLED = 'false';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-com-mais-de-32-caracteres-aqui-ok';

jest.mock('../src/db/postgres', () => require('./helpers/mockPool').mockPool());

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

test('retorna cards antigos e novas métricas de decisão', async () => {
  pool.query
    // users
    .mockResolvedValueOnce({ rows: [{ total: '31', ativos: '30', inativos: '1', suspensos: '2',
      gerentes: '1', admins: '1', novos_mes: '5', novos_mes_anterior: '4', novos_semana: '2',
      vencendo_7d: '3', vencidos: '1' }] })
    // byPlan
    .mockResolvedValueOnce({ rows: [{ plan: 'pro', total: '10' }, { plan: 'starter', total: '15' }] })
    // invoices
    .mockResolvedValueOnce({ rows: [{ total: '40', receita: '249', receita_mes: '97',
      receita_mes_anterior: '50', pendentes: '2', pendentes_valor: '194', em_atraso: '1',
      em_atraso_valor: '97', pagas: '3' }] })
    // mrr
    .mockResolvedValueOnce({ rows: [{ mrr: '444', assinantes_pagantes: '3' }] })
    // restaurants
    .mockResolvedValueOnce({ rows: [{ total: '80', novos_mes: '6' }] })
    // platforms
    .mockResolvedValueOnce({ rows: [{ ifood: '50', food99: '30' }] })
    // orders
    .mockResolvedValueOnce({ rows: [{ total: '16143', gmv: '1174749.78', pedidos_mes: '1200',
      gmv_mes: '90000', pedidos_hoje: '40', cancelados: '30' }] })
    // automation
    .mockResolvedValueOnce({ rows: [{ auto: '900', auto_mes: '600' }] });

  const res = await request(app()).get('/admin/stats').set('Authorization', `Bearer ${adminToken()}`);
  expect(res.status).toBe(200);

  // cards antigos preservados
  expect(res.body.users.total).toBe(31);
  expect(res.body.orders.gmv).toBeCloseTo(1174749.78);
  expect(res.body.restaurants).toBe(80);

  // novas métricas
  expect(res.body.clientes.novos_mes).toBe(5);
  expect(res.body.clientes.vencendo_7d).toBe(3);
  expect(res.body.financeiro.mrr_estimado).toBe(444);
  expect(res.body.financeiro.em_atraso_valor).toBe(97);
  // crescimento receita: (97-50)/50 = 94%
  expect(res.body.financeiro.crescimento_receita_pct).toBe(94);
  // taxa automação mês: 600/1200 = 50%
  expect(res.body.operacao.taxa_automacao_mes_pct).toBe(50);
  expect(res.body.operacao.lojas_ifood).toBe(50);
});
