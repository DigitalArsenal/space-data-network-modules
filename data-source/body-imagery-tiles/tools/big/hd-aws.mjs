// Keep the 64-operation transfer pool without starting 64 CPU-heavy CLI
// processes at once. Admission is shared by every preflight, PUT and GET.
import os from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';

const exec=promisify(execFile);
export function createAwsRunner(command) {
  const words=command.split(' ').filter(Boolean);
  let admission=Promise.resolve(),lastStart=0,lastNotice=0;
  return async args=>{
    const ready=admission.then(async()=>{
      for(;;) {
        if(os.loadavg()[0]<25) {
          await delay(Math.max(0,lastStart+100-Date.now()));
          if(os.loadavg()[0]>=25)continue;
          lastStart=Date.now();return;
        }
        if(Date.now()-lastNotice>=60000) {
          console.error('R2 CLI admission waiting for load average below 25');
          lastNotice=Date.now();
        }
        await delay(1000);
      }
    });
    admission=ready.catch(()=>{});
    await ready;
    return (await exec(words[0],[...words.slice(1),...args],{maxBuffer:64*1024*1024,encoding:'buffer'})).stdout;
  };
}
