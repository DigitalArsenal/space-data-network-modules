import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('..',import.meta.url));
test('nonlinear UKF, linear/PV/clock, adaptive noise, Orekit EKF/UKF authority',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'estimation-depth-'));
 try{const binary=path.join(dir,'depth');execFileSync(process.env.CXX||'c++',['-std=c++17','-O2','-Wall','-Wextra','-Werror','-I',path.join(root,'src'),path.join(root,'src/estimation.cpp'),path.join(root,'tests/depth_validation.cpp'),'-o',binary],{stdio:'inherit'});execFileSync(binary,[path.join(root,'tests/fixtures/orekit-pv-reference.txt')],{stdio:'inherit'});}finally{fs.rmSync(dir,{recursive:true,force:true});}
});
