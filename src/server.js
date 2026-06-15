require('dotenv').config();

const express = require('express');
const cors = require('cors');

const pool = require('./db/postgres');
const redis = require('./db/redis');
const integrationsRouter = require('./routes/integrations');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// Rota de health-check (útil para o EasyPanel verificar se o app está de pé)
app.get('/health', async (req, res) => {
  let dbStatus = 'erro';
  let redisStatus = 'erro';

  try {
    await pool.query('SELECT 1');
    dbStatus = 'ok';
  } catch (err) {
    console.error('[health] erro no postgres:', err.message);
  }

  try {
    await redis.ping();
    redisStatus = 'ok';
  } catch (err) {
    console.error('[health] erro no redis:', err.message);
  }

  res.json({
    status: 'ok',
    postgres: dbStatus,
    redis: redisStatus,
    timestamp: new Date().toISOString(),
  });
});

// Rotas da API
app.use('/api/v1/integrations', integrationsRouter);

// 404 padrão
app.use((req, res) => {
  res.status(404).json({ error: 'Rota não encontrada' });
});

app.listen(PORT, () => {
  console.log(`Delivery Auto Pro backend rodando na porta ${PORT}`);
});
