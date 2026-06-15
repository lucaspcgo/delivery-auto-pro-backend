const Redis = require('ioredis');

// Conexão com o Redis (memória rápida / cache / filas)
// A connection string vem da variável de ambiente REDIS_URL
const redis = new Redis(process.env.REDIS_URL, {
  maxRetriesPerRequest: 3,
});

redis.on('error', (err) => {
  console.error('[redis] erro de conexão:', err.message);
});

redis.on('connect', () => {
  console.log('[redis] conectado com sucesso');
});

module.exports = redis;
