'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SKIP = new Set(['.git', 'node_modules', '.vercel', 'coverage', 'dist', 'build']);
const failures = [];
let checkedFiles = 0;
let checkedBlocks = 0;

function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (/\.(?:js|cjs|mjs|html)$/i.test(entry.name)) checkFile(full);
  }
}

function parse(source, label) {
  checkedBlocks++;
  try {
    new Function(source);
  } catch (error) {
    failures.push({ file: path.relative(ROOT, label), error: error.message });
  }
}

function checkFile(file) {
  checkedFiles++;
  const source = fs.readFileSync(file, 'utf8');
  if (/\.(?:js|cjs|mjs)$/i.test(file)) {
    parse(source, file);
    return;
  }
  const scripts = source.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi);
  let index = 0;
  for (const match of scripts) {
    index++;
    const attrs = match[1] || '';
    const body = match[2] || '';
    if (/\bsrc\s*=/.test(attrs) || !body.trim()) continue;
    const type = (attrs.match(/\btype\s*=\s*["']([^"']+)["']/i) || [])[1];
    if (type && !/^(?:text|application)\/(?:java|ecma)script$|^module$/i.test(type)) continue;
    parse(body, file + ' (inline script ' + index + ')');
  }
}

walk(ROOT);
console.log('Checked ' + checkedFiles + ' source files and ' + checkedBlocks + ' JavaScript blocks.');
if (failures.length) {
  for (const failure of failures) {
    console.error('::error file=' + failure.file + '::' + failure.error);
  }
  process.exitCode = 1;
} else {
  console.log('All JavaScript syntax checks passed.');
}
