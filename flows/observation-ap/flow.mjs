// flows/observation-ap: laser normal points to an AP $OCM (B2 part 2's design in the modules). The flow routes typed
// records between modules and computes nothing: flows/observation-od fits the normal points, propagator/ffm
// propagate_oem carries the estimate under the same dynamics, propagator/sdn-ap fit writes the AP set.
//
//   const out = await observationAp(hosts, ingress);
//   out.refused  -> '<code>: <message>' of the module that refused, unchanged
//   out.egress   -> { ap_ocm: [$OCM], estimate: [$OCM], ephemeris: [$OEM] }
//
// hosts: { laserOd, estimation, ffm, sdnAp }, each an SDK module host with invoke({ methodId, inputs }) on the shipped
// artifacts of flows/observation-od, analysis/estimation, propagator/ffm and propagator/sdn-ap.
// ingress (bytes): observations [$TDM], stations [$GST], earthOrientation ($PRW EARTH_ORIENTATION), kernel ($PRW
// NATIVE_INPUT), execution ($PRW EXECUTION_REQUEST: the first guess, TARGET_EPOCH, the dynamics, the solve-for
// parameters), configuration (sdn-ap fit's $PCF), optional spaceWeather [$SPW] and odConfig (ModuleConfig).
import * as flatbuffers from 'flatbuffers';
import * as P from 'spacedatastandards.org/lib/js/PRW/main.js';
import * as PCF from 'spacedatastandards.org/lib/js/PCF/main.js';
import { OCM } from 'spacedatastandards.org/lib/js/OCM/main.js';

// The carry: 24 h back from the estimate's epoch at 60 s (B2 part 2).
export const CARRY = Object.freeze({ hours: 24, stepSeconds: 60 });

const T = (name, rootTypeName = name) => ({ schemaName: `${name}.fbs`, fileIdentifier: `$${name}`, rootTypeName, wireFormat: 'flatbuffer' });
const TYPES = { TDM: T('TDM'), GST: T('GST'), PRW: T('PRW'), PCF: T('PCF'), OEM: T('OEM'), PVN: T('PVN'), SPW: T('SPW'),
  EST: { ...T('Estimation', 'EstimationEnvelope'), fileIdentifier: '$EST' },
  MCFG: { schemaName: 'ModuleConfig.fbs', fileIdentifier: 'MCFG', rootTypeName: 'ModuleConfig', wireFormat: 'flatbuffer' } };
const frame = (portId, typeRef, payload) => ({ portId, typeRef, payload });
const outputs = (r, port) => r.outputs.filter((o) => o.portId === port).map((o) => new Uint8Array(o.payload));

class Refused extends Error {}
async function call(host, methodId, inputs) {
  const r = await host.invoke({ methodId, inputs });
  if (r.statusCode !== 0) throw new Refused(`${r.errorCode ?? ''}: ${r.errorMessage ?? ''}`);
  return r;
}

// 1. The estimate: flows/observation-od step, its propagation answered by propagator/ffm invoke and its estimation by
// analysis/estimation fit_batch, until it emits the $OCM (flows/observation-od README).
async function estimate(hosts, ingress) {
  const fixed = [...ingress.observations.map((p) => frame('observations', TYPES.TDM, p)),
    ...ingress.stations.map((p) => frame('stations', TYPES.GST, p)),
    frame('earth_orientation', TYPES.PRW, ingress.earthOrientation), frame('execution', TYPES.PRW, ingress.execution),
    ...(ingress.odConfig ? [frame('config', TYPES.MCFG, ingress.odConfig)] : [])];
  let sent = null, result = null, samples = null;
  for (;;) {
    const r = await call(hosts.laserOd, 'step', [...fixed, ...(sent ? [frame('estimation', TYPES.EST, sent)] : []),
      ...(result ? [frame('result', TYPES.EST, result)] : []), ...(samples ? [frame('samples', TYPES.PRW, samples)] : [])]);
    const [ocm] = outputs(r, 'ocm'), [propagation] = outputs(r, 'propagation'), [next] = outputs(r, 'estimation');
    if (ocm) return ocm;
    if (propagation) {
      [samples] = outputs(await call(hosts.ffm, 'invoke', [frame('request', TYPES.PRW, propagation),
        frame('kernel', TYPES.PRW, ingress.kernel), frame('earth_orientation', TYPES.PRW, ingress.earthOrientation)]), 'response');
      continue;
    }
    if (!next) throw new Refused('bad-input: flows/observation-od step emitted nothing');
    sent = next; samples = null;
    [result] = outputs(await call(hosts.estimation, 'fit_batch', [frame('request', TYPES.EST, sent)]), 'result');
  }
}

// 2. The carry request: the caller's execution with INITIAL the estimate (the $OCM's GCRF state, km to m) and the
// fitted dynamic parameters set where flows/observation-od sets them for its own rounds; nothing solved, no samples
// (STM_TECHNIQUE as the caller stated it: propagator/ffm requires one).
function carryRequest(execution, ocm) {
  const exec = P.PRW.getSizePrefixedRootAsPRW(new flatbuffers.ByteBuffer(execution)).unpack().EXECUTION_REQUEST;
  const s = ocm.STATE_DATA, f = exec.FORCES, state = exec.INITIAL.STATE;
  state.POSITION = Object.assign(new P.FRMVector3T(), { X: s[0] * 1000, Y: s[1] * 1000, Z: s[2] * 1000 });
  state.VELOCITY = Object.assign(new P.FRMVector3T(), { X: s[3] * 1000, Y: s[4] * 1000, Z: s[5] * 1000 });
  state.EPOCH = ocm.STATE_EPOCHS[0];
  for (const p of ocm.ORBIT_DETERMINATION.OD_DYNAMIC_PARAMETERS) {
    if (p.PARAMETER === P.prwDynamicParameter.IN_TRACK_ACCELERATION) Object.assign(f, { HAS_IN_TRACK_ACCELERATION_M_S2: true, IN_TRACK_ACCELERATION_M_S2: p.VALUE });
    else if (p.PARAMETER === P.prwDynamicParameter.DRAG_AREA_OVER_MASS) f.DRAG_COEFFICIENT = p.VALUE * f.INITIAL_MASS_KG / f.AREA_M2;
    else if (p.PARAMETER === P.prwDynamicParameter.SRP_AREA_OVER_MASS) f.REFLECTIVITY_COEFFICIENT = p.VALUE * f.INITIAL_MASS_KG / f.AREA_M2;
    else throw new Refused(`bad-input: dynamic parameter ${P.prwDynamicParameter[p.PARAMETER]} has no FORCES field`);
  }
  Object.assign(exec, { DYNAMIC_PARAMETERS: [], SAMPLE_EPOCHS: [] });
  exec.TARGET_EPOCH.ISO8601 = state.EPOCH; // required by the schema; propagate_oem ends at the last OUTPUT epoch
  const b = new flatbuffers.Builder(1 << 14);
  P.PRW.finishSizePrefixedPRWBuffer(b, Object.assign(new P.PRWT(), { EXECUTION_REQUEST: exec }).pack(b));
  return b.asUint8Array().slice();
}

// The carry's $PCF OUTPUT: GCRF, from CARRY.hours before the estimate's epoch to it, every CARRY.stepSeconds.
function carryOutput(epoch) {
  const stop = Date.parse(epoch.replace(/(\.\d{3})\d*/, '$1'));
  const output = Object.assign(new PCF.PCFOutputT(), { FRAME: PCF.pcfOutputFrame.GCRF, START_TIME: new Date(stop - CARRY.hours * 3600e3).toISOString(),
    STOP_TIME: epoch, STEP_SECONDS: CARRY.stepSeconds });
  const b = new flatbuffers.Builder(512);
  b.finish(Object.assign(new PCF.PCFT(), { OUTPUT: output }).pack(b), '$PCF');
  return b.asUint8Array().slice();
}

const pvnOf = (ocm) => {
  const b = new flatbuffers.Builder(512);
  b.finish(ocm.PROVENANCE.pack(b), '$PVN');
  return b.asUint8Array().slice();
};

export async function observationAp(hosts, ingress) {
  try {
    const estimateBytes = await estimate(hosts, ingress);
    const ocm = OCM.getRootAsOCM(new flatbuffers.ByteBuffer(estimateBytes)).unpack();
    const [ephemeris] = outputs(await call(hosts.ffm, 'propagate_oem', [frame('request', TYPES.PRW, carryRequest(ingress.execution, ocm)),
      frame('configuration', TYPES.PCF, carryOutput(ocm.STATE_EPOCHS[0])), frame('kernel', TYPES.PRW, ingress.kernel),
      frame('earth_orientation', TYPES.PRW, ingress.earthOrientation)]), 'ephemeris');
    const fit = await call(hosts.sdnAp, 'fit', [frame('ephemeris', TYPES.OEM, ephemeris), frame('configuration', TYPES.PCF, ingress.configuration),
      frame('provenance', TYPES.PVN, pvnOf(ocm)), ...(ingress.spaceWeather ?? []).map((p) => frame('space_weather', TYPES.SPW, p))]);
    return { egress: { ap_ocm: outputs(fit, 'elements'), estimate: [estimateBytes], ephemeris: [ephemeris] } };
  } catch (e) {
    if (e instanceof Refused) return { refused: e.message };
    throw e;
  }
}
