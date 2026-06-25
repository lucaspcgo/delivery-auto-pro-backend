const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const pool = require('../db/postgres');
const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'delivery-auto-pro-secret-2026';

router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email e senha são obrigatórios' });
  }
  try {
    const result = await pool.query('SELECT * FROM users WHERE email = $1 AND active = true', [email]);
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Email ou senha inválidos' });
    }
    const user = result.rows[0];
    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) {
      return res.status(401).json({ error: 'Email ou senha inválidos' });
    }

    if (user.plan === 'free' && user.plan_expires_at && new Date(user.plan_expires_at) < new Date()) {
      await pool.query(`UPDATE integrations SET status='disconnected', api_status='offline', updated_at=now()`);
      await pool.query(`UPDATE users SET payment_status='suspended', updated_at=now() WHERE id=$1`, [user.id]);
      return res.status(403).json({
        error: 'Seu período gratuito de 7 dias expirou. Assine um plano para continuar.',
        trial_expired: true,
        redirect: '/checkout'
      });
    }

    if (user.payment_status === 'suspended') {
      return res.status(403).json({
        error: 'Acesso suspenso. Regularize seu pagamento.',
        payment_suspended: true,
        redirect: '/checkout'
      });
    }

    const token = jwt.sign(
      { id: user.id, email: user.email, name: user.name, role: user.role, is_admin: user.is_admin, plan: user.plan },
      JWT_SECRET, { expiresIn: '24h' }
    );
    console.log(`[auth] login: ${user.email} (${user.role}, admin: ${user.is_admin}, plano: ${user.plan})`);
    return res.json({
      token,
      user: { id: user.id, name: user.name, email: user.email, role: user.role, is_admin: user.is_admin, plan: user.plan, payment_status: user.payment_status, plan_expires_at: user.plan_expires_at }
    });
  } catch (err) {
    console.error('[auth] erro:', err.message);
    return res.status(500).json({ error: 'Erro interno' });
  }
});

router.post('/register', async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) {
    return res.status(400).json({ error: 'Nome, email e senha são obrigatórios' });
  }
  try {
    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'Email já registrado' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const trialExpiresAt = new Date();
    trialExpiresAt.setDate(trialExpiresAt.getDate() + 7);

    const result = await pool.query(
      `INSERT INTO users (name, email, password_hash, role, plan, active, payment_status, plan_expires_at)
       VALUES ($1, $2, $3, $4, $5, true, $6, $7)
       RETURNING id, name, email, plan, plan_expires_at`,
      [name, email, hashedPassword, 'user', 'free', 'active', trialExpiresAt]
    );

    const newUser = result.rows[0];
    await pool.query('SELECT create_user_defaults($1)', [newUser.id]);

    const token = jwt.sign(
      { id: newUser.id, email: newUser.email, name: newUser.name, role: 'user', is_admin: false, plan: 'free' },
      JWT_SECRET, { expiresIn: '24h' }
    );

    console.log(`[auth] registro: ${email}`);
    return res.status(201).json({
      token,
      user: { id: newUser.id, name: newUser.name, email: newUser.email, plan: 'free', plan_expires_at: trialExpiresAt }
    });
  } catch (err) {
    console.error('[auth] erro no registro:', err.message);
    return res.status(500).json({ error: 'Erro ao registrar usuário' });
  }
});

router.get('/me', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token não fornecido' });
  }
  try {
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET);

    const user = await pool.query(
      `SELECT id, name, email, role, plan, is_admin, payment_status, plan_expires_at FROM users WHERE id=$1`,
      [decoded.id]
    );
    if (user.rows.length === 0) return res.status(401).json({ error: 'Usuário não encontrado' });
    const u = user.rows[0];

    if (u.plan === 'free' && u.plan_expires_at && new Date(u.plan_expires_at) < new Date()) {
      await pool.query(`UPDATE integrations SET status='disconnected', api_status='offline', updated_at=now()`);
      await pool.query(`UPDATE users SET payment_status='suspended', updated_at=now() WHERE id=$1`, [u.id]);
      return res.status(403).json({ error: 'Período gratuito expirado', trial_expired: true, redirect: '/checkout' });
    }

    let trial_days_left = null;
    if (u.plan === 'free' && u.plan_expires_at) {
      trial_days_left = Math.max(0, Math.ceil((new Date(u.plan_expires_at) - new Date()) / (1000 * 60 * 60 * 24)));
    }

    return res.json({
      user: { id: u.id, name: u.name, email: u.email, role: u.role, is_admin: u.is_admin, plan: u.plan, payment_status: u.payment_status, plan_expires_at: u.plan_expires_at, trial_days_left }
    });
  } catch (err) {
    return res.status(401).json({ error: 'Token inválido ou expirado' });
  }
});

module.exports = router;