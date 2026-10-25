// $PCF 1.0.4 (SDS 1.270.0) configurations for the tests: every method with options takes one on its
// required `configuration` port.
import * as flatbuffers from "flatbuffers";
import { PCFT } from "spacedatastandards.org/lib/js/PCF/PCF.js";
import { PCFFitPolicyT } from "spacedatastandards.org/lib/js/PCF/PCFFitPolicy.js";
import { PCFMeanElementOptionsT } from "spacedatastandards.org/lib/js/PCF/PCFMeanElementOptions.js";
import { PCFOutputT } from "spacedatastandards.org/lib/js/PCF/PCFOutput.js";
import { PCFForceModelT } from "spacedatastandards.org/lib/js/PCF/PCFForceModel.js";
import { PCFEmpiricalTermsT } from "spacedatastandards.org/lib/js/PCF/PCFEmpiricalTerms.js";
import { PCFEpochStoreT } from "spacedatastandards.org/lib/js/PCF/PCFEpochStore.js";
import { pcfTheory } from "spacedatastandards.org/lib/js/PCF/pcfTheory.js";

export { pcfTheory };
export const PCF_TYPE = { schemaName: "PCF.fbs", fileIdentifier: "$PCF", rootTypeName: "PCF" };

/// The methods with a `configuration` port.
export const CONFIGURED_METHODS = new Set(["propagate", "fit", "maneuver"]);

const tables = {
  fit: ["FIT", PCFFitPolicyT],
  mean: ["MEAN_ELEMENT", PCFMeanElementOptionsT],
  output: ["OUTPUT", PCFOutputT],
  forces: ["FORCES", PCFForceModelT],
  epochStore: ["EPOCH_STORE", PCFEpochStoreT],
};

/// A table of scalars with every field on the wire, at its default where unset (forceDefaults for that table only: a
/// builder forcing defaults everywhere writes null offsets for absent strings and tables).
export function explicit(T, fields = {}) {
  const t = Object.assign(new T(), fields);
  const pack = t.pack.bind(t);
  t.pack = (b) => { b.forceDefaults(true); const o = pack(b); b.forceDefaults(false); return o; };
  return t;
}

export { PCFEmpiricalTermsT };

/// A $PCF payload: `theory` a pcfTheory name or value; each table given as an object of its fields (the rest at
/// their defaults, which the builder leaves off the wire); forces.EMPIRICAL_TERMS may be given as an object of its
/// fields.
export function pcf({ theory = "UNSPECIFIED", ...given } = {}) {
  const c = new PCFT();
  c.THEORY = typeof theory === "string" ? pcfTheory[theory] : theory;
  for (const [key, fields] of Object.entries(given)) {
    if (!tables[key]) throw new Error(`pcf: no table ${key}`);
    const [name, T] = tables[key];
    c[name] = Object.assign(new T(), fields);
    if (key === "forces" && fields.EMPIRICAL_TERMS && !(fields.EMPIRICAL_TERMS instanceof PCFEmpiricalTermsT))
      c[name].EMPIRICAL_TERMS = Object.assign(new PCFEmpiricalTermsT(), fields.EMPIRICAL_TERMS);
  }
  const b = new flatbuffers.Builder(256);
  b.finish(c.pack(b), "$PCF");
  return b.asUint8Array();
}

/// The `configuration` input of a request.
export const configuration = (options = {}) => ({ portId: "configuration", typeRef: PCF_TYPE, payload: pcf(options) });

/// A command whose requests to a configured method carry `defaults` when they name no configuration.
export function withConfiguration(command, defaults = {}) {
  return {
    ...command,
    invoke: (req) =>
      command.invoke(
        CONFIGURED_METHODS.has(req.methodId) && !req.inputs.some((i) => i.portId === "configuration")
          ? { ...req, inputs: [...req.inputs, configuration(typeof defaults === "function" ? defaults(req) : defaults)] }
          : req,
      ),
  };
}
