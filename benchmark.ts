import { performance } from 'perf_hooks';

const SERVER_NAME = "ctscout-mcp-server";
const SERVER_VERSION = "0.2.5";
const USER_AGENT = `${SERVER_NAME}/${SERVER_VERSION}`;

function withInterpolation() {
  return `${SERVER_NAME}/${SERVER_VERSION}`;
}

function withConstant() {
  return USER_AGENT;
}

const ITERATIONS = 10000000;

// Warmup
for (let i = 0; i < 10000; i++) {
  withInterpolation();
  withConstant();
}

const start1 = performance.now();
for (let i = 0; i < ITERATIONS; i++) {
  withInterpolation();
}
const end1 = performance.now();
const time1 = end1 - start1;

const start2 = performance.now();
for (let i = 0; i < ITERATIONS; i++) {
  withConstant();
}
const end2 = performance.now();
const time2 = end2 - start2;

console.log(`Interpolation: ${time1.toFixed(2)} ms`);
console.log(`Constant: ${time2.toFixed(2)} ms`);
console.log(`Improvement: ${((time1 - time2) / time1 * 100).toFixed(2)}%`);
