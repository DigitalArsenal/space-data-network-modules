#!/usr/bin/env python3
"""Read-only PyPI archive audit for TMPL lane 09; writes only --output-dir.

No package installation, repository edits, generated bindings, or physics.
Run: python3 audit_published_dependencies.py --output-dir /private/tmp/lane09-audit
"""
import argparse
import hashlib
import io
import json
from pathlib import Path
import re
import tarfile
import urllib.request
import zipfile

SOURCES = [
    ("spacedatastandards.org", "23.3.3.0.3.7", ".whl", "cb6f6dbafb33a314a9a3a527a8f81ca8c03346e24c62f9f42dff7a462c4e1824"),
    ("spacedatastandards.org", "1.99.0", ".whl", "02a5f99cee2d714a946539d1126156e915ca7a05c50836f7fc297362e5ec9ec6"),
    ("wasmedge", "0.0.1", ".tar.gz", "ac9ad194b370f0ca07783f05d3e817a2f3f4443134b9cf53518aab0d9c024197"),
]
MEMBERS = {
    "propagator/sgp4": ["OMM/OMM.py", "CAT/CAT.py", "REC/REC.py", "orbpro/propagator/PropagatorBatchRequest.py", "orbpro/plugins/PropagatorState.py", "orbpro/query/CatalogQueryRequest.py", "orbpro/query/CatalogQueryResult.py"],
    "propagator/hpop": ["orbpro/hpop/InvokeRequest.py", "orbpro/hpop/InvokeResponse.py", "orbpro/propagator/PropagatorBatchRequest.py", "orbpro/plugins/PropagatorState.py", "orbpro/propagator/PropagatorPrepareTrajectorySegmentsRequest.py", "orbpro/propagator/PropagatorPrepareTrajectorySegmentsResult.py", "orbpro/propagator/PropagatorDescribeTrajectorySegmentsRequest.py", "orbpro/propagator/PropagatorDescribeTrajectorySegmentsResult.py"],
    "analysis/estimation": ["orbpro/estimation/EstimationEnvelope.py", "orbpro/estimation/EstimationRequest.py", "orbpro/estimation/EstimationResult.py", "CRD/CRD.py", "MEM/MEM.py", "OCM/OCM.py", "ODR/ODR.py", "TDM/TDM.py", "TRH/TRH.py"],
    "analysis/conjunction-assessment": ["CDM/CDM.py", "CSM/CSM.py", "OMM/OMM.py", "orbpro/conjunction/ConjunctionEvent.py", "orbpro/conjunction/ConjunctionPairRequest.py", "orbpro/conjunction/ConjunctionFindTcaResult.py", "orbpro/conjunction/ConjunctionAlfanoRequest.py", "orbpro/conjunction/ConjunctionAlfanoResult.py", "orbpro/conjunction/ConjunctionPcRequest.py", "orbpro/conjunction/ConjunctionPcResult.py", "orbpro/conjunction/ConjunctionScreenCatalogRequest.py", "orbpro/conjunction/ConjunctionScreenCatalogResult.py"],
    "analysis/access": ["ACW/ACW.py"],
    "propagator/events": ["EOP/EOP.py", "EVL/EVL.py", "FRM/FRM.py", "OEM/OEM.py", "PCE/PCE.py", "RFM/RFM.py"],
    "analysis/lambert-izzo": ["LMO/LMO.py", "LMS/LMS.py"],
    "foundation/time": ["TIM/TIM.py", "TIM/TIMInstant.py", "TIM/TIMConversionRequest.py", "TIM/TIMConversionResult.py", "TIM/TIMCcsdsTimeCode.py"],
    "foundation/frames": ["FRM/FRM.py", "EOP/EOP.py", "RFM/RFM.py"],
}
REQUIRED_FIELDS = {
    "TIM/TIM.py": ["TIME_SYSTEM", "INSTANT", "CONVERSION_REQUEST", "CONVERSION_RESULT"],
    "EOP/EOP.py": ["DATE", "MJD", "X_POLE_WANDER_RADIANS", "Y_POLE_WANDER_RADIANS", "X_CELESTIAL_POLE_OFFSET_RADIANS", "Y_CELESTIAL_POLE_OFFSET_RADIANS", "UT1_MINUS_UTC_SECONDS", "TAI_MINUS_UTC_SECONDS", "LENGTH_OF_DAY_CORRECTION_SECONDS", "DATA_TYPE", "SERIES", "IAU_CONVENTION", "X_POLE_WANDER_UNCERTAINTY_RADIANS", "Y_POLE_WANDER_UNCERTAINTY_RADIANS", "X_CELESTIAL_POLE_OFFSET_UNCERTAINTY_RADIANS", "Y_CELESTIAL_POLE_OFFSET_UNCERTAINTY_RADIANS", "UT1_MINUS_UTC_UNCERTAINTY_SECONDS", "LENGTH_OF_DAY_UNCERTAINTY_SECONDS", "X_POLE_WANDER_RADIANS_HP", "Y_POLE_WANDER_RADIANS_HP", "X_CELESTIAL_POLE_OFFSET_RADIANS_HP", "Y_CELESTIAL_POLE_OFFSET_RADIANS_HP", "UT1_MINUS_UTC_SECONDS_HP", "LENGTH_OF_DAY_CORRECTION_SECONDS_HP", "DATA_SET_EPOCH", "DATA_SET_CID"],
}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    reports = []
    for package, version, suffix, expected_hash in SOURCES:
        api_url = f"https://pypi.org/pypi/{package}/{version}/json"
        metadata = json.load(urllib.request.urlopen(api_url))
        release = next(x for x in metadata["urls"] if x["filename"].endswith(suffix))
        archive = urllib.request.urlopen(release["url"]).read()
        actual_hash = hashlib.sha256(archive).hexdigest()
        if actual_hash != expected_hash:
            raise RuntimeError(f"Unexpected archive bytes: {release['filename']}")
        (args.output_dir / release["filename"]).write_bytes(archive)
        report = {"package": package, "version": version, "metadata_url": api_url, "download_url": release["url"], "filename": release["filename"], "uploaded_at": release["upload_time_iso_8601"], "sha256": actual_hash}
        if suffix == ".whl":
            with zipfile.ZipFile(io.BytesIO(archive)) as wheel:
                names = set(wheel.namelist())
                report["member_count"] = len(names)
                report["documented_namespace_present"] = any(x.startswith("spacedatastandards/") for x in names)
                report["orbpro_namespace_present"] = any(x.startswith("orbpro/") for x in names)
                report["module_members"] = {module: {member: member in names for member in members} for module, members in MEMBERS.items()}
                report["missing_fields"] = {}
                for member, required_fields in REQUIRED_FIELDS.items():
                    text = wheel.read(member).decode()
                    methods = set(re.findall(r"^    def (\w+)\(", text, re.M))
                    report["missing_fields"][member] = sorted(set(required_fields) - methods)
                report["bare_import_examples"] = {}
                for member in ["RFM/RFM.py", "REC/REC.py", "CDM/CDM.py", "LMO/LMO.py"]:
                    if member in names:
                        report["bare_import_examples"][member] = re.findall(r"^(?:import|from) [A-Za-z]\w*.*", wheel.read(member).decode(), re.M)
        else:
            with tarfile.open(fileobj=io.BytesIO(archive), mode="r:gz") as source:
                report["members"] = source.getnames()
                report["wasmedge_init"] = source.extractfile("wasmedge-0.0.1/wasmedge/__init__.py").read().decode()
        reports.append(report)
    output = {"purpose": "Published-dependency inventory, not a physics or runtime test", "archives": reports}
    encoded = json.dumps(output, indent=2) + "\n"
    (args.output_dir / "dependency-audit.json").write_text(encoded)
    print(encoded)


if __name__ == "__main__":
    main()
