// Garante que a rota GET /integrations SEMPRE devolve os cards das plataformas,
// mesmo quando o usuário não tem linhas na tabela integrations (self-heal),
// e mesmo quando a criação self-heal falha (cai em placeholder, não quebra).
process.env.PLAN_GATING_ENABLED = 'false';

jest.mock('../src/db/postgres', () => require('./helpers/mockPool').mockPool());
jest.mock('../src/middleware/auth', () => ({
  authenticateToken: (req, _res, next) => { req.user = { id: 1 }; next(); },
}));

const express = require('express');
const request = require('supertest');
const pool = require('../src/db/postgres');
const integrationsRouter = require('../src/routes/integrations');

function app() {
  const a = express();
  a.use(express.json());
  a.use('/integrations', integrationsRouter);
  return a;
}

test('usuário sem linhas: devolve 3 cards (ifood, keeta, 99food) após self-heal', async () => {
  pool.query
    .mockResolvedValueOnce({ rows: [] }) // SELECT
    .mockResolvedValueOnce({ rows: [{ id: 1, platform: 'ifood', name: 'iFood', status: 'disconnected', api_status: 'offline' }] })
    .mockResolvedValueOnce({ rows: [{ id: 2, platform: '99food', name: '99Food', status: 'disconnected', api_status: 'offline' }] })
    .mockResolvedValueOnce({ rows: [{ id: 3, platform: 'keeta', name: 'Keeta', status: 'disconnected', api_status: 'offline' }] });

  const res = await request(app()).get('/integrations');
  expect(res.status).toBe(200);
  expect(res.body.map(i => i.platform)).toEqual(['ifood', 'keeta', '99food']);
});

test('self-heal falha (ex.: sem constraint): ainda devolve 3 cards placeholder, sem quebrar', async () => {
  pool.query
    .mockResolvedValueOnce({ rows: [] }) // SELECT
    .mockRejectedValue(new Error('no unique constraint for ON CONFLICT'));

  const res = await request(app()).get('/integrations');
  expect(res.status).toBe(200);
  expect(res.body).toHaveLength(3);
  expect(res.body.every(i => i.status === 'disconnected')).toBe(true);
  expect(res.body.map(i => i.platform)).toEqual(['ifood', 'keeta', '99food']);
});
