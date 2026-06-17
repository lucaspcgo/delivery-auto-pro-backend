require('dotenv').config();
const express = require('express');
const cors = require('cors');
const pool = require('./db/postgres');
const redis = require('./db/redis');
const integrationsRouter = require('./routes/integrations');
const webhooks99foodRouter = require('./routes/webhooks99food');
const app = express();
const PORT = process.env.PORT || 3001;
app.use(cors());
app.use(express.json());
app.get('/health', async (req, res) => {
  let dbStatus = 'erro';
  let redisStatus = 'erro';
  try { await pool.query('SELECT 1'); dbStatus = 'ok'; } catch (err) { console.error('[health] postgres:', err.message); }
  try { await redis.ping(); redisStatus = 'ok'; } catch (err) { console.error('[health] redis:', err.message); }
  res.json({ status: 'ok', postgres: dbStatus, redis: redisStatus, timestamp: new Date().toISOString() });
});
app.use('/api/v1/integrations', integrationsRouter);
app.use('/api/v1/webhooks/99food', webhooks99foodRouter);
app.use('/api/v1/orders/99food', webhooks99foodRouter);
app.use((req, res) => { res.status(404).json({ error: 'Rota não encontrada' }); });
app.listen(PORT, () => { console.log(`Delivery Auto Pro backend rodando na porta ${PORT}`); });
