// Synthetic catalog recipes and bounded, size-prefixed loading for frames measurements.
import assert from "node:assert/strict";
import fs from "node:fs";
import { population, ocmOfObject } from "./frame-cells.mjs";
import { T, ocmOf, repackOcm } from "./ocm.mjs";
export function catalogPopulation(n, profile = "recipe") {
  const share = p => Math.round(n * p / 100);
  const plan = profile === "public" ? [["leo500", share(40.1)], ["leo830", share(33.3)], ["ecc", share(11.8)], ["meo", share(1.6)], ["geo", share(5.3)]] :
    [["leo500", share(25.5)], ["leo830", share(45.05)], ["drag300", share(14.45)], ["meo", share(5)], ["geo", share(5)]];
  plan.push([profile === "public" ? "wide" : "ecc", n - plan.reduce((s, p) => s + p[1], 0)]);
  return population(plan, 20261113, 48);
}
export async function loadCatalog(f, pop, { covariance = false, maxDegree = 0 } = {}) {
  const template = covariance ? ocmOf(fs.readFileSync(new URL("../fixtures/synthetic-grid-hp300-e0-i70.ocm", import.meta.url))) : null;
  const invoke = async methodId => { const r = await f.h.invoke({ methodId, inputs: [] }); assert.equal(r.statusCode, 0, r.errorMessage); };
  await invoke("load_epochs_open");
  for (let k = 0; k < pop.length; k += 1000) {
    const payload = Buffer.concat(pop.slice(k, k + 1000).map((o, j) => {
      let u = ocmOfObject(o);
      if (template || (maxDegree && k + j < 32)) u = repackOcm(u, t => {
        if (template) {
          for (const key of Object.keys(template)) if (key.startsWith("COV")) t[key] = template[key];
          t.ORBIT_DETERMINATION = template.ORBIT_DETERMINATION;
          t.PROVENANCE = template.PROVENANCE;
          const p = t.COV_PROPAGATION;
          p.NOISE_NON_GRAVITATIONAL_RAD_DAY2 = p.NON_GRAVITATIONAL_SHARE * Math.abs(p.NON_GRAVITATIONAL_RATE_PER_DAY) * t.MEAN_ELEMENTS.MEAN_MOTION * 2 * Math.PI;
        }
        if (maxDegree && k + j < 32) t.PERTURBATIONS.MAXIMUM_TESSERAL_DEGREE = maxDegree;
      });
      const b = Buffer.alloc(4 + u.length); b.writeUInt32LE(u.length); b.set(u, 4); return b;
    }));
    const p = f.x.plugin_alloc(payload.length); assert.ok(p);
    new Uint8Array(f.mem(), p, payload.length).set(payload);
    const r = await f.h.invoke({ methodId: "load_epochs_part", externalArena: new Uint8Array(f.mem()), inputs: [{ portId: "ocm", typeRef: T("OCM"), offset: p, size: payload.length, alignment: 1 }] });
    f.x.plugin_free(p, payload.length); assert.equal(r.statusCode, 0, r.errorMessage);
  }
  await invoke("load_epochs_close");
  assert.equal(f.x.sdnap_epochs_count(), pop.length); f.adopt(pop.length);
}
