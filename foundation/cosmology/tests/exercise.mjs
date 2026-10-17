// Shared E2E IO only: sends SDS requests through the complete module ABI.
import {encodeRequest} from '../codec.js';

export async function exercise(harness, oracle) {
  const calls = oracle.cases.map(c => ({name: c.name, request: encodeRequest(c.method, c.input)}));
  const invalid = (name, method, values) => calls.push({name, invalid: true, request: encodeRequest(method, values)});
  for (const [name, value] of [['negative', [-.01]], ['too high', [1100.1]], ['NaN', [NaN]],
    ['infinite', [Infinity]], ['empty', []], ['scalar', 1], ['oversized', new Array(4097).fill(0)]]) {
    invalid(name, 'distances', {redshift_cmb: value});
  }
  invalid('missing', 'distances', {});
  invalid('unknown parameter', 'distances', {redshift_cmb: [.1], distance: [1]});
  const point = {galactic_longitude_rad: [0], galactic_latitude_rad: [0]};
  invalid('invalid latitude', 'supergalactic', {...point, galactic_latitude_rad: [2], comoving_distance_mpc: [1]});
  invalid('negative distance', 'supergalactic', {...point, comoving_distance_mpc: [-1]});
  invalid('mismatched vectors', 'supergalactic', {...point, comoving_distance_mpc: [1, 2]});
  invalid('unphysical observed z', 'cmb_redshift', {...point, redshift_heliocentric: [-1]});
  invalid('unresolved blueshift', 'place', {...point, redshift_cmb: [-.001]});
  invalid('missing group redshift', 'place', {...point, redshift_cmb: [.1], tempel2017_group_id: [1]});
  invalid('group without membership', 'place', {...point, redshift_cmb: [.1], tempel2017_group_id: [0], tempel2017_group_redshift_cmb: [.1]});
  invalid('invalid group ID', 'place', {...point, redshift_cmb: [.1], tempel2017_group_id: [1.5], tempel2017_group_redshift_cmb: [.1]});
  invalid('inconsistent group redshifts', 'place', {galactic_longitude_rad: [0, 0], galactic_latitude_rad: [0, 0],
    redshift_cmb: [.1, .1], tempel2017_group_id: [1, 1], tempel2017_group_redshift_cmb: [.1, .2]});
  invalid('negative CF4', 'place', {...point, redshift_cmb: [.1], cf4_luminosity_distance_mpc: [-1]});
  invalid('unreachable CF4', 'place', {...point, redshift_cmb: [.1], cf4_luminosity_distance_mpc: [1e10]});
  const malformed = encodeRequest('distances', {redshift_cmb: [.1]});
  malformed.inputs[0].payload = new Uint8Array([0, 0, 0, 0, 36, 80, 67, 69]);
  calls.push({name: 'malformed FlatBuffer', invalid: true, request: malformed});
  calls.push({name: 'maximum batch', request: encodeRequest('distances', {redshift_cmb: new Array(4096).fill(0)})});
  calls.push({name: 'valid after failures', request: encodeRequest('distances', {redshift_cmb: [0]})});
  const responses = [];
  for (const call of calls) {
    const response = await harness.invoke(call.request);
    responses.push({name: call.name, invalid: Boolean(call.invalid), statusCode: response.statusCode,
      errorCode: response.errorCode ?? '', errorMessage: response.errorMessage ?? '',
      outputs: response.outputs.map(output => ({portId: output.portId,
        typeRef: output.typeRef, payload: Array.from(output.payload)}))});
  }
  return responses;
}
