// $PCF 1.0.7 (SDS 1.278.0) configurations for the tests. fit states its force model: every fit $PCF carries
// FORCES.ATMOSPHERE_MODEL, written on the wire (NRLMSISE00 is the schema's default value, so the binding would leave
// it off).
import * as flatbuffers from "flatbuffers";
import { PCFT } from "spacedatastandards.org/lib/js/PCF/PCF.js";
import { PCFForceModel } from "spacedatastandards.org/lib/js/PCF/PCFForceModel.js";
import { pcfAtmosphereFamily } from "spacedatastandards.org/lib/js/PCF/pcfAtmosphereFamily.js";
import { PCFFitPolicyT } from "spacedatastandards.org/lib/js/PCF/PCFFitPolicy.js";
import { PCFOutputT } from "spacedatastandards.org/lib/js/PCF/PCFOutput.js";
import { PCFForceModelT } from "spacedatastandards.org/lib/js/PCF/PCFForceModel.js";
import { PCFEpochStoreT } from "spacedatastandards.org/lib/js/PCF/PCFEpochStore.js";
import { PCFGaussianPriorT } from "spacedatastandards.org/lib/js/PCF/PCFGaussianPrior.js";
import { pcfTheory } from "spacedatastandards.org/lib/js/PCF/pcfTheory.js";
import { pcfPriorForm } from "spacedatastandards.org/lib/js/PCF/pcfPriorForm.js";

export { pcfTheory, pcfPriorForm, pcfAtmosphereFamily };

// FORCES.ATMOSPHERE_MODEL is written whenever a FORCES table is: fit reads it as stated, never as a default
const addAtmosphereModel = PCFForceModel.addAtmosphereModel;
PCFForceModel.addAtmosphereModel = (b, value) => {
  const was = b.force_defaults;
  b.forceDefaults(true);
  addAtmosphereModel(b, value);
  b.forceDefaults(was);
};

/// fit's FORCES of stock SGP4XP (Jacchia 1970 on the theory's flux model) and of AP (NRLMSISE-00 on the rows); `more`
/// adds fields (the gravity caps, DENSITY_CORRECTION).
export const XP_FORCES = Object.freeze({ EPHEMERIS_SOURCE: "", ATMOSPHERE_MODEL: pcfAtmosphereFamily.JACCHIA70 });
export const MSIS_FORCES = Object.freeze({ EPHEMERIS_SOURCE: "", ATMOSPHERE_MODEL: pcfAtmosphereFamily.NRLMSISE00 });

/// A FIT.DRAG_PRIOR or FIT.SRP_PRIOR with its sigma (HAS_SIGMA true); under LOG_NORMAL `mean` is the median and `sigma`
/// the standard deviation of the natural log.
export const prior = (mean, sigma) => Object.assign(new PCFGaussianPriorT(), { MEAN: mean, SIGMA: sigma, HAS_SIGMA: true });

export const PCF_TYPE = { schemaName: "PCF.fbs", fileIdentifier: "$PCF", rootTypeName: "PCF" };

/// The methods with a `configuration` port.
export const CONFIGURED_METHODS = new Set(["propagate", "fit", "maneuver"]);

const tables = {
  fit: ["FIT", PCFFitPolicyT],
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

/// A $PCF payload: `theory` a pcfTheory name or value; each table given as an object of its fields (the rest at
/// their defaults, which the builder leaves off the wire).
export function pcf({ theory = "UNSPECIFIED", ...given } = {}) {
  const c = new PCFT();
  c.THEORY = typeof theory === "string" ? pcfTheory[theory] : theory;
  for (const [key, fields] of Object.entries(given)) {
    if (!tables[key]) throw new Error(`pcf: no table ${key}`);
    const [name, T] = tables[key];
    c[name] = Object.assign(new T(), fields);
  }
  const b = new flatbuffers.Builder(256);
  b.finish(c.pack(b), "$PCF");
  return b.asUint8Array();
}

/// The `configuration` input of a request.
export const configuration = (options = {}) => ({ portId: "configuration", typeRef: PCF_TYPE, payload: pcf(options) });

/// fit's `configuration`: FORCES default to stock SGP4XP's (XP_FORCES) when the options name none.
export const fitConfiguration = (options = {}) => configuration({ ...options, forces: options.forces ?? XP_FORCES });

/// A command whose requests to a configured method carry `defaults` when they name no configuration.
export function withConfiguration(command, defaults = {}) {
  return {
    ...command,
    invoke: (req) =>
      command.invoke(
        CONFIGURED_METHODS.has(req.methodId) && !req.inputs.some((i) => i.portId === "configuration")
          ? { ...req, inputs: [...req.inputs, (req.methodId === "fit" ? fitConfiguration : configuration)(typeof defaults === "function" ? defaults(req) : defaults)] }
          : req,
      ),
  };
}
