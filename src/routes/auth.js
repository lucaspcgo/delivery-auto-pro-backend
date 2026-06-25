// POST /api/v1/auth/register — Registrar novo usuário
router.post('/register', async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) {
    return res.status(400).json({ error: 'Nome, email e senha são obrigatórios' });
  }
  try {
    // Verifica se email já existe
    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'Email já registrado' });
    }

    // Hash da senha
    const hashedPassword = await bcrypt.hash(password, 10);

    // Calcula data de expiração do trial (7 dias)
    const trialExpiresAt = new Date();
    trialExpiresAt.setDate(trialExpiresAt.getDate() + 7);

    // Cria usuário
    const result = await pool.query(
      `INSERT INTO users (name, email, password_hash, role, plan, active, payment_status, plan_expires_at)
       VALUES ($1, $2, $3, $4, $5, true, $6, $7)
       RETURNING id, name, email, plan, plan_expires_at`,
      [name, email, hashedPassword, 'user', 'free', 'active', trialExpiresAt]
    );

    const newUser = result.rows[0];

    // ✅ CRIAR INTEGRAÇÕES E AUTOMAÇÕES PADRÃO
    await pool.query('SELECT create_user_defaults($1)', [newUser.id]);

    // Gera token JWT
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