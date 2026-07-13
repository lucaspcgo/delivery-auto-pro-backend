const pool = require('../db/postgres');

const COLS = 'slug, name, active, capabilities, max_restaurants, max_orders_month';

async function loadPlanBySlug(slug) {
  const r = await pool.query(`SELECT ${COLS} FROM plans WHERE slug = $1`, [slug]);
  return r.rows[0] || null;
}

function shape(row) {
  return {
    slug: row.slug,
    name: row.name,
    plan_active: row.active,
    capabilities: row.capabilities || {},
    max_restaurants: row.max_restaurants || 0,
    max_orders_month: row.max_orders_month || 0,
  };
}

// Resolve o plano do usuário; cai em 'free' se o slug não existir.
async function resolveUserPlan(user) {
  const slug = user && user.plan ? user.plan : 'free';
  let row = await loadPlanBySlug(slug);
  if (!row) row = await loadPlanBySlug('free');
  if (!row) {
    return { slug: 'free', name: 'Free', plan_active: true, capabilities: {}, max_restaurants: 0, max_orders_month: 0 };
  }
  return shape(row);
}

async function hasCapability(user, key) {
  const p = await resolveUserPlan(user);
  return p.capabilities[key] === true;
}

async function getLimit(user, key) {
  const p = await resolveUserPlan(user);
  return p[key] || 0;
}

module.exports = { resolveUserPlan, hasCapability, getLimit };
