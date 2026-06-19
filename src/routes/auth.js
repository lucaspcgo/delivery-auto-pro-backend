// TEMPORÁRIO — criar/resetar senha (remover depois)
router.post('/reset-password', async (req, res) => {
  const { email, newPassword } = req.body;
  if (!email || !newPassword) return res.status(400).json({ error: 'email e newPassword obrigatórios' });
  try {
    const hash = await bcrypt.hash(newPassword, 10);
    await pool.query('UPDATE users SET password_hash = $1, updated_at = now() WHERE email = $2', [hash, email]);
    return res.json({ success: true, message: 'Senha atualizada' });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});
