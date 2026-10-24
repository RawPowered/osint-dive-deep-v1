#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.join(__dirname, '..');
const required = [
  'RELEASE.json','package.json','sql/schema.sql','src/config.js','src/app.js','server.js',
  'README.md',
  'deploy/compatibility/COMPATIBILITY_MATRIX.json',
];
const missing = required.filter((file) => !fs.existsSync(path.join(root, file)));
const js = [];
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes:true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(file);
    else if (entry.isFile() && entry.name.endsWith('.js')) js.push(file);
  }
}
walk(root);
const syntaxErrors = [];
for (const file of js) {
  try {
    let source = fs.readFileSync(file, 'utf8');
    if (source.startsWith('#!')) source = source.replace(/^#!.*(?:\r?\n|$)/, '');
    new vm.Script(source, { filename:file });
  } catch (error) {
    syntaxErrors.push({ file:path.relative(root,file), error:String(error.stack || error.message).slice(0,2000) });
  }
}
const packageJson = JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
const missingScriptFiles = [];
for (const [name, command] of Object.entries(packageJson.scripts || {})) {
  for (const match of command.matchAll(/\bnode\s+((?:test|scripts)\/[A-Za-z0-9._/-]+\.js)\b/g)) {
    if (!fs.existsSync(path.join(root,match[1]))) missingScriptFiles.push({ script:name,file:match[1] });
  }
}
const result = { ok:missing.length===0 && syntaxErrors.length===0 && missingScriptFiles.length===0, files:js.length, missing, syntaxErrors, missingScriptFiles };
console.log(JSON.stringify(result,null,2));
if (!result.ok) process.exitCode=1;
