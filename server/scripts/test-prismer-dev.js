/**
 * Simple tester for prismer.dev API base URL using the documentation in
 * `src/app/docs/api-requirements.md`.
 *
 * Run:
 *   node scripts/test-prismer-dev.js
 */

const https = require('https');

const BASE_URL = 'https://prismer.dev/api/v1';
const AUTH_HEADER = 'Bearer sk-prismer-test-placeholder';

const endpoints = [
  'dashboard/stats',
  'activities',
  'cloud/keys',
  'billing/invoices',
  'billing/payment-methods',
  'notifications',
];

function httpGet(path) {
  const url = `${BASE_URL}/${path}`;

  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        method: 'GET',
        headers: {
          Authorization: AUTH_HEADER,
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk.toString();
        });
        res.on('end', () => {
          resolve({
            url,
            status: res.statusCode,
            body: data,
          });
        });
      }
    );

    req.on('error', (err) => {
      reject(err);
    });

    req.end();
  });
}

async function main() {
  console.log(`Testing prismer.dev base URL: ${BASE_URL}\n`);

  for (const ep of endpoints) {
    try {
      console.log(`=== GET ${BASE_URL}/${ep} ===`);
      const res = await httpGet(ep);
      console.log('Status:', res.status);
      const preview = res.body ? res.body.slice(0, 400) : '';
      console.log(preview || '<empty body>');
      console.log();
    } catch (err) {
      console.error(`Error calling ${BASE_URL}/${ep}:`, err.message);
      console.log();
    }
  }
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});


