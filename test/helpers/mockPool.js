// Fábrica de um pool falso com query mockada.
function mockPool() {
  return { query: jest.fn() };
}
module.exports = { mockPool };
