#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const root = path.join(__dirname, '..');
const files = fs.readdirSync(path.join(root,'test')).filter((name)=>name.endsWith('.test.js')).sort();
const failures=[];
for (const name of files) {
  const result=spawnSync(process.execPath,[path.join(root,'test',name)],{stdio:'inherit',env:process.env});
  if (result.status!==0) failures.push(name);
}
console.log(JSON.stringify({total:files.length,passed:files.length-failures.length,failed:failures.length,failures},null,2));
if (failures.length) process.exitCode=1;
