const { Pool } = require('pg');

// Pool de conexões com o PostgreSQL
// A connection string vem da variável de ambiente DATABASE_URL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

pool.on('error', (err) => {
  console.error('[postgres] erro inesperado no pool:', err);
});

module.exports = pool;
