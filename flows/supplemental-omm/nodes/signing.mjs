// The release signer of the Supplemental OMM bundle. The nodes and the source and host-capability modules build
// UNSIGNED; scripts/release.mjs signs every child and the outer bundle with ONE key, given only through the
// environment: SUPPLEMENTAL_OMM_SIGNING_SEED_HEX (a 32-byte Ed25519 seed, hex) and SUPPLEMENTAL_OMM_SIGNING_KEY_ID.
// There is no default key. The seeds the old per-node builds embedded for development are public, so they are
// refused. A production release (NODE_ENV=production or SUPPLEMENTAL_OMM_BUILD_MODE=production) also compiles the
// WasmEdge universal-AOT section into every child and the parent before signing.
const embeddedDevelopmentSigningSeeds = new Set(
  ["43", "44", "45", "51", "52", "53", "54", "55"].map((byte) => byte.repeat(32)),
);

export function isEmbeddedDevelopmentSigningSeed(seed) {
  return embeddedDevelopmentSigningSeeds.has(String(seed ?? "").toLowerCase());
}

export function resolveReleaseSigning(environment = process.env) {
  const productionMode =
    environment.NODE_ENV === "production" || environment.SUPPLEMENTAL_OMM_BUILD_MODE === "production";
  const signingSeed = String(environment.SUPPLEMENTAL_OMM_SIGNING_SEED_HEX ?? "").trim();
  const signingKeyId = String(environment.SUPPLEMENTAL_OMM_SIGNING_KEY_ID ?? "").trim();
  if (!signingSeed || !signingKeyId) {
    throw new Error(
      "a Supplemental OMM release requires SUPPLEMENTAL_OMM_SIGNING_SEED_HEX and SUPPLEMENTAL_OMM_SIGNING_KEY_ID",
    );
  }
  if (!/^[0-9a-fA-F]{64}$/.test(signingSeed)) {
    throw new Error("SUPPLEMENTAL_OMM_SIGNING_SEED_HEX must contain a 32-byte Ed25519 seed");
  }
  if (isEmbeddedDevelopmentSigningSeed(signingSeed)) {
    throw new Error("a Supplemental OMM release rejects every embedded development signing seed");
  }
  return { signingSeed, signingKeyId, productionMode };
}
