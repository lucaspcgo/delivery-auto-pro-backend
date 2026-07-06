const https = require('https');

async function getMenuItems(appShopId, authToken) {
  try {
    const query = `auth_token=${encodeURIComponent(authToken)}&shop_id=${appShopId}`;
    const path = `/v1/order/shop/menu/items?${query}`;
    
    return new Promise((resolve) => {
      https.get({ hostname: 'openapi.didi-food.com', path }, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            const items = (parsed.items || []).map(item => ({
              id: item.item_id || item.id,
              name: item.name,
              price: parseFloat(item.price || 0),
              category: item.category_name || 'Sem categoria',
              available: item.available !== false
            }));
            resolve(items);
          } catch {
            resolve([]);
          }
        });
      }).on('error', () => resolve([]));
    });
  } catch (err) {
    console.error('[99food menu] erro:', err.message);
    return [];
  }
}

module.exports = { getMenuItems };
