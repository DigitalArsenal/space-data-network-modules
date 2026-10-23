// Host framing only: the raster WASM decodes ISIS/GeoTIFF scalar values and
// validity. This lossless Float32 staging layout is independently checked
// against every original GDAL pixel by deployment/prepare.py.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {createReader,readWindow} from '../../../files/geotiff/read-samples.mjs';
const [source,target,widthText,heightText]=process.argv.slice(2);
const width=Number(widthText),height=Number(heightText);
assert.ok(width>0&&height>0&&width*height<2_000_000);
const h=await createReader();
try {
 const sample=await readWindow(h,source,[0,0,width,height]);
 const values=new Float32Array(sample.values.length);
 for(let i=0;i<values.length;i++)values[i]=sample.valid[i]?sample.values[i]:NaN;
 fs.writeFileSync(target,Buffer.from(values.buffer));
 console.log(JSON.stringify({source,target,pixels:values.length,bytes:values.byteLength}));
}finally{await h.destroy();}
