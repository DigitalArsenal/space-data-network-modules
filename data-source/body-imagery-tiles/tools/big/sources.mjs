// The large-body sources the module tiles (src/sources_big.hpp is the table the module computes with; this is what the tools and
// the manifests need to name them). tests/bodies.e2e.test.mjs checks the two agree against each source's own header.
const PD_USGS = "https://www.usgs.gov/information-policies-and-instructions/copyrights-and-credits";
const PD_NASA = "https://www.nasa.gov/nasa-brand-center/images-and-media/";
const S3 = "https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/";

export const SOURCES = {
  "mercury-mdis-bdr": {
    body: "Mercury", naif: 199, product: "", maxLevel: 8, bands: 1, tileset: "mdis-bdr-mercury", resolutionM: { deepest: 116.9, source: 166 },
    name: "Mercury MESSENGER MDIS basemap BDR global mosaic 166 m", url: `${S3}Mercury_MESSENGER_MDIS_Basemap_BDR_Mosaic_Global_166m.tif`,
    etag: "a4cd0c5c563f0580176483c08a97af3b-507", edition: "2022-11-10T05:12:12Z", size: [92160, 46080], strip0: 738101, lon0: 0,
    crs: "planetocentric, sphere 2439400 m", license: "Public domain (NASA/JHUAPL/CIW)", licenseUrl: PD_USGS,
    credit: "NASA/Johns Hopkins University Applied Physics Laboratory/Carnegie Institution of Washington; mosaic USGS Astrogeology",
  },
  "ceres-dawn-lamo": {
    body: "Ceres", naif: 2000001, product: "", maxLevel: 7, bands: 1, tileset: "dawn-fc-lamo-ceres", resolutionM: { deepest: 45.1, source: 35 },
    name: "Ceres Dawn FC LAMO clear-filter global mosaic 35 m (DAWN-A-FC2-5-CERESMOSAIC-V1.0)", url: "https://sbnarchive.psi.edu/pds3/dawn/fc/DWNCLCFC2_2/DATA/CE_LAMO_G_00N_180E_EQU_CLR.IMG",
    etag: "d42e9850-53bc66a53e640", edition: "2016-09-05T17:57:37Z", size: [84376, 42187], strip0: 253128, lon0: 180,
    crs: "planetocentric, sphere 470000 m, Kait longitude system (IAU)", license: "Public domain (NASA Dawn, PDS)", licenseUrl: PD_NASA,
    credit: "NASA/JPL-Caltech/UCLA/MPS/DLR/IDA; mosaic DLR (Roatsch et al.)",
  },
  "vesta-dawn-lamo": {
    body: "Vesta", naif: 2000004, product: "", maxLevel: 7, bands: 1, tileset: "dawn-fc-lamo-vesta", resolutionM: { deepest: 24.4, source: 20 },
    name: "Vesta Dawn FC LAMO clear-filter global mosaic 20 m (DAWN-A-FC2-5-MOSAIC-V1.0)", url: "https://sbnarchive.psi.edu/pds3/dawn/fc/DWNVFC2_2/DATA/LAMO_CLEAR/VE_LAMO_00N_330E_CYL_CLEAR.IMG",
    etag: "bf458cf7-50ec5ca10d440", edition: "2015-02-11T01:19:05Z", size: [80111, 40054], strip0: 240333, lon0: 330,
    crs: "planetocentric, sphere 255000 m, Claudia Double Prime longitude system (IAU)", license: "Public domain (NASA Dawn, PDS)", licenseUrl: PD_NASA,
    credit: "NASA/JPL-Caltech/UCLA/MPS/DLR/IDA; mosaic DLR (Roatsch et al.)",
  },
  "venus-magellan-left": {
    body: "Venus", naif: 299, product: "", maxLevel: 10, bands: 1, tileset: "magellan-sar-left-venus", resolutionM: { deepest: 72.5, source: 75 },
    name: "Venus Magellan SAR left-look global mosaic 75 m (no data filled from the C3-MDIR 2025 m mosaic)", url: `${S3}Venus_Magellan_LeftLook_mosaic_global_75m.tif`,
    etag: "f242b14ace35ace3f9c81422c9c1a2ee-6979", edition: "2022-12-16T01:02:22Z", size: [506928, 230948], strip0: 3695971, lon0: 0,
    crs: "planetocentric, sphere 6051000 m, 80 S to 84 N", license: "Public domain (USGS Astrogeology; NASA/JPL Magellan)", licenseUrl: PD_USGS,
    credit: "NASA/JPL Magellan; mosaic USGS Astrogeology", fill: "venus-magellan-c3mdir",
  },
  "venus-magellan-c3mdir": {
    body: "Venus", naif: 299, product: "", maxLevel: 5, bands: 1, tileset: "magellan-c3mdir-venus", resolutionM: { deepest: 2320, source: 2025 },
    name: "Venus Magellan C3-MDIR global mosaic 2025 m", url: `${S3}Venus_Magellan_C3-MDIR_Global_Mosaic_2025m.tif`,
    etag: "6c5c001af6270d6be425447e7669eef5-22", edition: "2022-11-10T06:15:56Z", size: [18775, 9388], strip0: 75753, lon0: 0,
    crs: "planetocentric, sphere 6051000 m", license: "Public domain (USGS Astrogeology; NASA/JPL Magellan)", licenseUrl: PD_USGS,
    credit: "NASA/JPL Magellan; mosaic USGS Astrogeology",
  },
};
/** The key of the file's folder in the bucket: imagery/<naif>[/<product>]. */
export const prefixOf = (s) => `imagery/${s.naif}`;
