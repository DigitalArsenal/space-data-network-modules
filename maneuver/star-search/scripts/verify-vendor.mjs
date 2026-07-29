/*
 * Vendor integrity gate for the Star port.
 *
 * This family is a PORT, not a verbatim vendor (see
 * vendor/star-search/PROVENANCE.md for why: the upstream is Python + numba +
 * spiceypy and there is no C/C++ upstream to copy). So there are no vendored
 * sources to hash-check before every build the way the CCSDS-124 codec does.
 *
 * What IS checked:
 *   1. The verbatim upstream LICENSE is present and unmodified.
 *   2. PROVENANCE.md is present and pins an upstream commit.
 *   3. The manifest's attribution block agrees with PROVENANCE.md.
 *
 * What is checked only on demand (--against-clone <path>): the SHA-256 of every
 * upstream Python source the port derives from, so a maintainer can prove the
 * port is still being read against the revision it was written against. That is
 * not run on every build because it needs a clone of the upstream repo.
 */
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const vendorRoot = path.join(packageRoot, "vendor", "star-search");

const UPSTREAM_COMMIT = "5c667064e8fc5816a94fc1124906997560fd6c55";
const LICENSE_SHA256 =
  "ac971e8a637971fb33890b32ea4a09128bb69759c1fe07592113ab7d31d6c6bf";

/** SHA-256 of every upstream source the port derives from, at UPSTREAM_COMMIT. */
export const DERIVED_FROM = {
  "star/lambert.py":
    "58b4ad33e7bc82b15f7d7d2f4079d5d9ac6a692ed0306bc4946ac7edde5c18a1",
  "star/encounter_database.py":
    "46800b2ff3ddacdf465614b528c0c16ee22cc487757730e0b2211f8f11420c47",
  "star/leg_database.py":
    "9e81c5795fb6c867800fc276aac93bbfe8a5b7019d5e73a443eea5d4de453f29",
  "star/flyby_database.py":
    "db98d4fe79b650911245bfc8de6d4c72092ad5321f19fcd48f0a5c8bc368909d",
  "star/combo.py":
    "bb29ce7dbe68733e2361e90c4363f84716a71537855a1a3494540858a6d54624",
  "star/maneuver_placement.py":
    "2b89a3f3f59502fd008e5f2945eb52fdcfeac58f1512632241f6d6a16b184b48",
  "star/resonant.py":
    "927dd58928d9f3d41ff87dacf924a652b8d010865634fbe5889a81504d4f8bab",
  "star/time_opt.py":
    "2455aa2a171c4453787589a8df444e03672c846328a5997bcce4cf87e29baa1e",
  "star/pipeline.py":
    "ad882b274ab42de0d00e6fb9383d346173406bd4a5ae6998fcf55c517b3b8ce9",
  "star/constants/_get_gm.py":
    "54894cb349ce1aa08e109392fcb6836d56bed730e1a536bee6b53b7366cf6f12",
  "star/constants/_get_radii.py":
    "a2e958092fb011979058a66ac137a02d03608a6913ebab4f3be3fb03f99013b3",
  "star/constants/_get_sma.py":
    "ccf3e8d23226e95f2f2a13f1e57c6264c0ac7b96db6813292a650ae4978bbdf1",
  "star/constants/time.py":
    "d9befb1dcd48450f241d0ed42a020ed581cf580271c29d421e132c6f99a304b9",
  "star/constants/__init__.py":
    "1f2cd2d5658eaf1efd4b1e5dde2cc478de9dc3156bd4853f93935e43c2fe7769",
  LICENSE: LICENSE_SHA256,
};

async function sha256(file) {
  return crypto
    .createHash("sha256")
    .update(await fs.readFile(file))
    .digest("hex");
}

export async function verifyVendor({ quiet = true, againstClone = null } = {}) {
  const problems = [];

  const licensePath = path.join(vendorRoot, "LICENSE");
  try {
    const actual = await sha256(licensePath);
    if (actual !== LICENSE_SHA256) {
      problems.push(
        `vendor/star-search/LICENSE was modified (sha256 ${actual}, expected ${LICENSE_SHA256}). ` +
          `The upstream MIT text must be preserved verbatim.`,
      );
    }
  } catch {
    problems.push("vendor/star-search/LICENSE is missing — MIT text must ship.");
  }

  const provenancePath = path.join(vendorRoot, "PROVENANCE.md");
  try {
    const provenance = await fs.readFile(provenancePath, "utf8");
    if (!provenance.includes(UPSTREAM_COMMIT)) {
      problems.push(
        `vendor/star-search/PROVENANCE.md does not pin ${UPSTREAM_COMMIT}.`,
      );
    }
  } catch {
    problems.push("vendor/star-search/PROVENANCE.md is missing.");
  }

  try {
    const manifest = JSON.parse(
      await fs.readFile(path.join(packageRoot, "plugin-manifest.json"), "utf8"),
    );
    const a = manifest.attribution ?? {};
    if (a.upstreamCommit !== UPSTREAM_COMMIT) {
      problems.push(
        `plugin-manifest.json attribution.upstreamCommit (${a.upstreamCommit}) ` +
          `disagrees with PROVENANCE.md (${UPSTREAM_COMMIT}).`,
      );
    }
    if (a.license !== "MIT") {
      problems.push(`plugin-manifest.json attribution.license must be "MIT".`);
    }
    if (!Array.isArray(a.algorithmCitations) || a.algorithmCitations.length < 3) {
      problems.push(
        "plugin-manifest.json attribution.algorithmCitations must credit all " +
          "three papers (Landau 2022 search, Landau 2018 DSM placement, " +
          "Arora & Russell 2013 Lambert).",
      );
    }
  } catch (error) {
    problems.push(`plugin-manifest.json unreadable: ${error.message}`);
  }

  if (againstClone) {
    for (const [rel, expected] of Object.entries(DERIVED_FROM)) {
      const file = path.join(againstClone, rel);
      try {
        const actual = await sha256(file);
        if (actual !== expected) {
          problems.push(
            `UPSTREAM DRIFT: ${rel} is ${actual}, port was written against ${expected}. ` +
              `Re-review the port against the new revision before renewing any parity claim.`,
          );
        }
      } catch {
        problems.push(`upstream clone missing ${rel}`);
      }
    }
  }

  if (problems.length > 0) {
    throw new Error(
      `Vendor/attribution verification FAILED:\n  - ${problems.join("\n  - ")}`,
    );
  }
  if (!quiet) {
    console.log(
      `vendor ok: upstream ${UPSTREAM_COMMIT.slice(0, 7)}, MIT license verbatim, ` +
        `attribution consistent${againstClone ? ", upstream sources unchanged" : ""}.`,
    );
  }
  return true;
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const idx = process.argv.indexOf("--against-clone");
  const againstClone = idx > -1 ? process.argv[idx + 1] : null;
  await verifyVendor({ quiet: false, againstClone });
}
