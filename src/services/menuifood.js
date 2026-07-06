const https = require('https');

async function getMenuItems(merchantId, token) {
  try {
    return new Promise((resolve) => {
      https.get({
        hostname: 'merchant-api.ifood.com.br',
        path: `/catalog/v2.0/merchants/${merchantId}/menu`,
        headers: { 'Authorization': `Bearer ${token}` }
      }, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            const items = [];
            (parsed.sections || []).forEach(section => {
              (section.items || []).forEach(item => {
                items.push({
                  id: item.id,
                  name: item.name,
                  price: (item.price || 0) / 100,
                  category: section.name || 'Sem categoria',
                  available: item.available !== false
                });
              });
            });
            resolve(items);
          } catch {
            resolve([]);
          }
        });
      }).on('error', () => resolve([]));
    });
  } catch (err) {
    console.error('[ifood menu] erro:', err.message);
    return [];
  }
}

module.exports = { getMenuItems };
