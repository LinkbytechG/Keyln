import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';

test('Swift session-menu policy preserves hidden targets, ambiguity and command boundaries; T99 finds only the Connection Center command; T100 picks Finder tabs by folder',t=>{
 const directory=mkdtempSync(join(tmpdir(),'keyln-window-policy-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
 const binary=join(directory,'probe');
 execFileSync('/usr/bin/xcrun',['swiftc','-O','-module-cache-path',join(directory,'cache'),'tests/window-target-policy/main.swift','native/macos-helper/Windows.swift','native/macos-helper/Finder.swift','-o',binary],{stdio:'pipe'});
 const result=JSON.parse(execFileSync(binary,[],{encoding:'utf8'}));assert.equal(result.ok,true);assert.equal(Object.keys(result.checks).length,28);for(const [name,passed]of Object.entries(result.checks))assert.equal(passed,true,name);
});
