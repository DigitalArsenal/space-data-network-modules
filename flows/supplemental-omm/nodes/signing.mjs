const embeddedDevelopmentSigningSeeds = new Set(
  ["43", "44", "45", "51", "52", "53", "54", "55"].map((byte) =>
    byte.repeat(32),
  ),
);

function pair(environment, seedName, keyName) {
  const seed = String(environment[seedName] ?? "").trim();
  const keyId = String(environment[keyName] ?? "").trim();
  if ((seed && !keyId) || (!seed && keyId)) {
    throw new Error(`${seedName} and ${keyName} must be supplied together`);
  }
  return { seed, keyId };
}
export function isEmbeddedDevelopmentSigningSeed(seed) {
  return embeddedDevelopmentSigningSeeds.has(String(seed ?? "").toLowerCase());
}

export function resolveSupplementalSigning({
  environment = process.env,
  environmentPrefix,
  developmentSigningSeed,
  defaultSigningKeyId,
}) {
  const productionMode =
    environment.NODE_ENV === "production" ||
    environment.SUPPLEMENTAL_OMM_BUILD_MODE === "production";
  const specific = pair(
    environment,
    `${environmentPrefix}_SIGNING_SEED_HEX`,
    `${environmentPrefix}_SIGNING_KEY_ID`,
  );
  const shared = pair(
    environment,
    "SUPPLEMENTAL_OMM_SIGNING_SEED_HEX",
    "SUPPLEMENTAL_OMM_SIGNING_KEY_ID",
  );
  const configured = specific.seed ? specific : shared;
  if (productionMode && !configured.seed) {
    throw new Error(
      "production Supplemental OMM builds require " +
        "SUPPLEMENTAL_OMM_SIGNING_SEED_HEX and " +
        "SUPPLEMENTAL_OMM_SIGNING_KEY_ID",
    );
  }
  const signingSeed = configured.seed || developmentSigningSeed;
  const signingKeyId = configured.keyId || defaultSigningKeyId;
  if (!/^[0-9a-fA-F]{64}$/.test(signingSeed ?? "")) {
    throw new Error(
      `${environmentPrefix}_SIGNING_SEED_HEX must contain a 32-byte Ed25519 seed`,
    );
  }
  const developmentOnly = isEmbeddedDevelopmentSigningSeed(signingSeed);
  if (productionMode && developmentOnly) {
    throw new Error(
      "production Supplemental OMM builds reject every embedded development signing seed",
    );
  }
  return {
    signingSeed,
    signingKeyId,
    developmentOnly,
    productionMode,
  };
}
