#!/usr/bin/env node
'use strict';
// Run only reviewed sketches in a task-isolated host with no tenant credentials.
// Remote assets are blocked: vendor the exact p5 build and authorized assets.
const path = require('path');
const fs = require('fs');
const { fileURLToPath, pathToFileURL } = require('url');

function parseArgs(args = process.argv.slice(2)) {
  const opts = { input: null, output: './frames', width: 1920, height: 1080,
    frames: 1, fps: 30, wait: 2000, selector: 'canvas' };
  const numeric = new Set(['width', 'height', 'frames', 'fps', 'wait']);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      if (!(key in opts) || key === 'input' || !args[i + 1] || args[i + 1].startsWith('--'))
        throw new Error('Unknown option or missing value: ' + arg);
      opts[key] = numeric.has(key) ? Number(args[++i]) : args[++i];
    } else if (opts.input === null) opts.input = arg;
    else throw new Error('Unexpected argument: ' + arg);
  }
  if (!opts.input) throw new Error('Usage: export-frames.js sketch.html [options]');
  for (const key of numeric) {
    if (!Number.isFinite(opts[key]) || opts[key] < (key === 'wait' ? 0 : 1))
      throw new Error('Invalid ' + key);
  }
  for (const key of ['width', 'height', 'frames'])
    if (!Number.isSafeInteger(opts[key])) throw new Error('Expected integer ' + key);
  if (opts.width > 8192 || opts.height > 8192 || opts.frames > 18000 || opts.fps > 120 || opts.wait > 30000)
    throw new Error('Capture exceeds resource limit');
  return opts;
}

function inside(root, filename) {
  const relative = path.relative(root, filename);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

async function capture(opts, puppeteer = require('puppeteer')) {
  const inputPath = fs.realpathSync(opts.input);
  const assetRoot = path.dirname(inputPath);
  const output = path.resolve(opts.output);
  fs.mkdirSync(output, { recursive: true });
  // Do not mix a new sequence with stale frames or overwrite existing assets.
  if (fs.readdirSync(output).length) throw new Error('Output directory must be empty');
  const browser = await puppeteer.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: opts.width, height: opts.height, deviceScaleFactor: 1 });
    await page.setRequestInterception(true);
    page.on('request', request => {
      let allowed = false;
      try {
        const url = new URL(request.url());
        allowed = url.protocol === 'data:' || url.protocol === 'blob:' ||
          (url.protocol === 'file:' && inside(assetRoot, fs.realpathSync(fileURLToPath(url))));
      } catch { /* Invalid, missing or escaping assets stay blocked. */ }
      (allowed ? request.continue() : request.abort()).catch(() => {});
    });
    await page.goto(pathToFileURL(inputPath).href, { waitUntil: 'networkidle0', timeout: 30000 });
    await page.waitForSelector(opts.selector, { timeout: 10000 });
    await page.waitForFunction('window._p5Ready === true', { timeout: 10000 });
    for (let i = 0; i < opts.frames; i++) {
      // An explicit hook supports both global and instance-mode p5, and fixed time.
      await page.evaluate(async ({ frame, fps }) => {
        if (typeof window.renderExportFrame !== 'function')
          throw new Error('Sketch must expose renderExportFrame(frame, seconds)');
        await window.renderExportFrame(frame, frame / fps);
        await new Promise(resolve => requestAnimationFrame(resolve));
      }, { frame: i, fps: opts.fps });
      const canvas = await page.$(opts.selector);
      if (!canvas) throw new Error('Canvas element not found');
      const size = await canvas.evaluate(node => ({ width: node.width, height: node.height }));
      if (size.width !== opts.width || size.height !== opts.height)
        throw new Error('Canvas backing dimensions do not match requested output');
      await canvas.screenshot({ path: path.join(output, 'frame-' + String(i).padStart(4, '0') + '.png'), type: 'png' });
    }
    console.log('Done: ' + opts.frames + ' verified frames');
  } finally {
    await browser.close();
  }
}

if (require.main === module) {
  Promise.resolve().then(() => capture(parseArgs())).catch(error => {
    console.error('Capture failed:', error.message);
    process.exitCode = 1;
  });
}
module.exports = { parseArgs, capture, inside };
