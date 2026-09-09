// Public contract: https://open-meteo.com/en/docs#api_documentation
// The first temperature samples (13, 12.7) and Berlin grid coordinate come
// from the documentation's July 1, 2022 response. Other fields are synthetic
// dimensional-analysis vectors, not observations. Repeated hours complete a
// one-day response; all expected values below are independently calculated.
export const config={latitude:52.52,longitude:13.41,forecast_days:1,access:'noncommercial',variables:[
  'temperature_2m','dew_point_2m','relative_humidity_2m','cloud_cover','wind_speed_10m','pressure_msl','surface_pressure','precipitation',
]};
export const receipt={retrieved_at_ms:1656633700000,producer_peer_id:'16Uiu2HAm1apfD3rAJJjgx4AC5Ms3PejRBwoqEsKpRx36uYwXuW9h'};
export function response() {
  const values={temperature_2m:13,dew_point_2m:0,relative_humidity_2m:50,cloud_cover:75,wind_speed_10m:10,pressure_msl:1013.25,surface_pressure:900,precipitation:2.5};
  const units={temperature_2m:'°C',dew_point_2m:'°C',relative_humidity_2m:'%',cloud_cover:'%',wind_speed_10m:'m/s',pressure_msl:'hPa',surface_pressure:'hPa',precipitation:'mm'};
  const hourly={time:Array.from({length:24},(_,i)=>1656633600+i*3600)};
  for(const [name,value] of Object.entries(values)) hourly[name]=Array(24).fill(value);
  hourly.temperature_2m[1]=12.7; hourly.temperature_2m[2]=null;
  return {latitude:52.52,longitude:13.419,elevation:44.812,generationtime_ms:2.2119,utc_offset_seconds:0,timezone:'GMT',hourly,hourly_units:{time:'unixtime',...units}};
}
export function http(value,status=200) {
  const bytes=Buffer.from(typeof value==='string'?value:JSON.stringify(value));
  const header=Buffer.alloc(8); header.write('$HRB'); header.writeInt32LE(status,4);
  return Buffer.concat([header,bytes]);
}
export function input(portId,value) {
  const payload=value instanceof Uint8Array?value:Buffer.from(JSON.stringify(value));
  return {portId,payload,typeRef:{wireFormat:'aligned-binary',requiredAlignment:1,byteLength:payload.length}};
}
