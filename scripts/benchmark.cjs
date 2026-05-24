const { performance } = require('perf_hooks');

process.env.CTSCOUT_API_KEY = "test_key";

function getApiKeyUncached() {
  const key = process.env.CTSCOUT_API_KEY;
  if (!key || key.trim().length === 0) {
    throw new Error("...");
  }
  return key;
}

let cachedKey;
function getApiKeyCached() {
  if (cachedKey !== undefined) return cachedKey;
  const key = process.env.CTSCOUT_API_KEY;
  if (!key || key.trim().length === 0) {
    throw new Error("...");
  }
  cachedKey = key;
  return key;
}

const ITERATIONS = 10000000;

const start1 = performance.now();
for (let i = 0; i < ITERATIONS; i++) {
  getApiKeyUncached();
}
const end1 = performance.now();
console.log(`Uncached: ${end1 - start1} ms`);

const start2 = performance.now();
for (let i = 0; i < ITERATIONS; i++) {
  getApiKeyCached();
}
const end2 = performance.now();
console.log(`Cached: ${end2 - start2} ms`);
