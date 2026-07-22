const express = require('express');
const jwt = require('jsonwebtoken');
const pool = require('../db/postgres');
const router = express.Router();

const { JWT_SECRET } = require('../config/env');

// GET /api/v1/plans — lista planos ativos (público)
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, slug, name, price, billing_period, popular, is_free, max_restaurants, max_orders_month, features, sort_order
       FROM plans WHERE active = true ORDER BY sort_order ASC`
    );
    return res.json(result.rows);
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

// Middleware admin para rotas de gestão
function adminAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) return res.status(401).json({ error: 'Token não fornecido' });
  try {
    const decoded = jwt.verify(authHeader.split(' ')[1], JWT_SECRET);
    if (!decoded.is_admin) return res.status(403).json({ error: 'Acesso negado' });
    req.user = decoded;
    next();
  } catch (err) { return res.status(401).json({ error: 'Token inválido' }); }
}

// GET /api/v1/plans/all — lista TODOS os planos incluindo inativos (admin)
router.get('/all', adminAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM plans ORDER BY sort_order ASC');
    return res.json(result.rows);
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

// POST /api/v1/plans — criar novo plano (admin)
router.post('/', adminAuth, async (req, res) => {
  const { slug, name, price, billing_period, popular, is_free, capabilities, max_restaurants, max_orders_month, features, sort_order } = req.body;
  if (!slug || !name) return res.status(400).json({ error: 'Slug e nome são obrigatórios' });
  try {
    const result = await pool.query(
      `INSERT INTO plans (slug, name, price, billing_period, popular, is_free, capabilities, max_restaurants, max_orders_month, features, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [slug, name, price || 0, billing_period || 'monthly', popular || false, is_free || false,
       JSON.stringify(capabilities || {}), max_restaurants || 1, max_orders_month || 0,
       JSON.stringify(features || []), sort_order || 0]
    );
    console.log(`[plans] plano criado: ${name} (${slug})`);
    return res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'Slug já existe' });
    console.error(`[plans] FALHA ao criar plano ${slug}: ${err.message} (code: ${err.code})`);
    return res.status(500).json({ error: err.message, code: err.code });
  }
});

// PUT /api/v1/plans/:id — atualizar plano (admin)
router.put('/:id', adminAuth, async (req, res) => {
  const { name, price, billing_period, popular, is_free, active, capabilities, max_restaurants, max_orders_month, features, sort_order } = req.body;
  try {
    const result = await pool.query(
      `UPDATE plans SET
       name=COALESCE($1,name), price=COALESCE($2,price), billing_period=COALESCE($3,billing_period),
       popular=COALESCE($4,popular), is_free=COALESCE($5,is_free), active=COALESCE($6,active),
       capabilities=COALESCE($7,capabilities),
       max_restaurants=COALESCE($8,max_restaurants), max_orders_month=COALESCE($9,max_orders_month),
       features=COALESCE($10,features), sort_order=COALESCE($11,sort_order), updated_at=now()
       WHERE id=$12 RETURNING *`,
      [name, price, billing_period, popular, is_free, active,
       capabilities ? JSON.stringify(capabilities) : null,
       max_restaurants, max_orders_month,
       features ? JSON.stringify(features) : null, sort_order, req.params.id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Plano não encontrado' });
    console.log(`[plans] plano atualizado: ${result.rows[0].name}`);
    return res.json(result.rows[0]);
  } catch (err) {
    console.error(`[plans] FALHA ao atualizar plano ${req.params.id}: ${err.message} (code: ${err.code})`);
    return res.status(500).json({ error: err.message, code: err.code });
  }
});

// DELETE /api/v1/plans/:id — desativar plano (admin)
router.delete('/:id', adminAuth, async (req, res) => {
  try {
    await pool.query('UPDATE plans SET active=false, updated_at=now() WHERE id=$1', [req.params.id]);
    return res.json({ success: true });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

module.exports = router;
