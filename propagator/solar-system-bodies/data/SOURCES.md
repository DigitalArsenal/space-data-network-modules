# Solar-system dataset

Kernels, imagery and small bodies for OrbPro's scene.bodies, delivered by CID.

## Kernels (kernels/)

Decade shards cut by tools/build_kernels.py (CSPICE_N0067, no refit) from:

- `de440s.bsp`: https://naif.jpl.nasa.gov/pub/naif/generic_kernels/spk/planets/de440s.bsp (sha256 c1c7feeab882263f...)
- `mar099s.bsp`: https://naif.jpl.nasa.gov/pub/naif/generic_kernels/spk/satellites/mar099s.bsp (sha256 997dc93ba640e476...)
- `jup365.bsp`: https://naif.jpl.nasa.gov/pub/naif/generic_kernels/spk/satellites/jup365.bsp (sha256 dbf016c01ba4d022...)
- `sat441.bsp`: https://naif.jpl.nasa.gov/pub/naif/generic_kernels/spk/satellites/sat441.bsp (sha256 d7e444a9ba7a52b8...)
- `ura184_part-3.bsp`: https://naif.jpl.nasa.gov/pub/naif/generic_kernels/spk/satellites/ura184_part-3.bsp (sha256 273cd4ccc470d109...)
- `nep097.bsp`: https://naif.jpl.nasa.gov/pub/naif/generic_kernels/spk/satellites/nep097.bsp (sha256 5c1132fdc48c54e5...)
- `plu060.bsp`: https://naif.jpl.nasa.gov/pub/naif/generic_kernels/spk/satellites/plu060.bsp (sha256 dfbb102491a26ed4...)
- `sb441-n16.bsp`: https://ssd.jpl.nasa.gov/ftp/eph/small_bodies/asteroids_de441/sb441-n16.bsp (sha256 919d612ce3c72a78...)
- `moon_pa_de440_200625.bpc`: https://naif.jpl.nasa.gov/pub/naif/generic_kernels/pck/moon_pa_de440_200625.bpc (sha256 60cd55aa401ea2ea...)
- `pck00011.tpc`: https://naif.jpl.nasa.gov/pub/naif/generic_kernels/pck/pck00011.tpc (sha256 3dff7b1dbeceaa01...)
- `gm_de440.tpc`: https://naif.jpl.nasa.gov/pub/naif/generic_kernels/pck/gm_de440.tpc (sha256 924ddf4fb9ead9fe...)
- `moon_de440_250416.tf`: https://naif.jpl.nasa.gov/pub/naif/generic_kernels/fk/satellites/moon_de440_250416.tf (sha256 a47c71e9c9f33796...)

Credit: Ephemerides and orientation: NASA/JPL NAIF (DE440, JPL satellite and small-body ephemerides), IAU WGCCRE 2015. Licence: NASA/JPL NAIF generic kernels: produced by NASA's Jet Propulsion Laboratory, distributed freely by the NAIF node of the Planetary Data System.

## Imagery (imagery/<NAIF id>/)

Public-domain global mosaics, planetocentric latitude converted to planetodetic on the PCK ellipsoid, geographic tiling 2 x 1 at level 0, by tools/build-imagery.py.

| NAIF | Levels | Credit | Licence | Source |
| --- | --- | --- | --- | --- |
| 199 | 0-5 | NASA/JHUAPL/CIW MESSENGER MDIS, USGS Astrogeology | public domain (USGS Astrogeology, NASA) | https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/Mercury_MESSENGER_MDIS_Basemap_MD3Color_Mosaic_Global_64ppd.tif |
| 299 | 0-4 | NASA/JPL Magellan, USGS Astrogeology | public domain (USGS Astrogeology, NASA) | https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/Venus_Magellan_C3-MDIR_Colorized_Global_Mosaic_4641m.tif |
| 301 | 0-5 | NASA/GSFC/Arizona State University LRO LROC WAC, NASA Scientific Visualization Studio (CGI Moon Kit) | public domain (NASA SVS) | https://svs.gsfc.nasa.gov/vis/a000000/a004700/a004720/lroc_color_poles_16k.tif |
| 499 | 0-5 | NASA/JPL Viking Orbiter, USGS Astrogeology MDIM colour | public domain (USGS Astrogeology, NASA) | https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/Mars_Viking_ClrMosaic_global_925m.tif |
| 501 | 0-4 | NASA/JPL Galileo SSI and Voyager, USGS Astrogeology | public domain (USGS Astrogeology, NASA) | https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/Io_GalileoSSI-Voyager_Global_Mosaic_ClrMerge_1km.tif |
| 502 | 0-4 | NASA/JPL Galileo SSI and Voyager, USGS Astrogeology | public domain (USGS Astrogeology, NASA) | https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/Europa_Voyager_GalileoSSI_global_mosaic_500m.tif |
| 503 | 0-4 | NASA/JPL Galileo SSI and Voyager, USGS Astrogeology | public domain (USGS Astrogeology, NASA) | https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/Ganymede_Voyager_GalileoSSI_Global_ClrMosaic_1435m.tif |
| 504 | 0-4 | NASA/JPL Galileo SSI and Voyager, USGS Astrogeology | public domain (USGS Astrogeology, NASA) | https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/Callisto_Voyager_GalileoSSI_global_mosaic_1km.tif |
| 599 | 0-3 | NASA/JPL/Space Science Institute Cassini ISS (PIA07782) | public domain (NASA/JPL Photojournal) | https://assets.science.nasa.gov/content/dam/science/psd/photojournal/pia/pia07/pia07782/PIA07782.tif |
| 602 | 0-4 | NASA/JPL/Space Science Institute Cassini ISS, USGS Astrogeology | public domain (USGS Astrogeology, NASA) | https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/Enceladus_Cassini_ISS_Global_Mosaic_100m_HPF.tif |
| 603 | 0-4 | NASA/JPL/Space Science Institute Cassini ISS, USGS Astrogeology | public domain (USGS Astrogeology, NASA) | https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/Tethys_Cassini_mosaic_global_293m.tif |
| 604 | 0-4 | NASA/JPL/Space Science Institute Cassini ISS and Voyager, USGS Astrogeology | public domain (USGS Astrogeology, NASA) | https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/Dione_Cassini_Voyager_mosaic_global_154m.tif |
| 605 | 0-4 | NASA/JPL/Space Science Institute Cassini ISS and Voyager, USGS Astrogeology | public domain (USGS Astrogeology, NASA) | https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/Rhea_Cassini_Voyager_mosaic_global_417m.tif |
| 606 | 0-3 | NASA/JPL/Space Science Institute Cassini ISS, USGS Astrogeology | public domain (USGS Astrogeology, NASA) | https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/Titan_ISS_P19658_Mosaic_Global_4km.tif |
| 608 | 0-3 | NASA/JPL/Space Science Institute Cassini ISS and Voyager, USGS Astrogeology | public domain (USGS Astrogeology, NASA) | https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/Iapetus_Cassini_Voyager_mosaic_global_783m.tif |
| 801 | 0-4 | NASA/JPL Voyager 2, USGS Astrogeology | public domain (USGS Astrogeology, NASA) | https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/Triton_Voyager2_ClrMosaic_GlobalFill_600m.tif |
| 901 | 0-4 | NASA/JHUAPL/SwRI New Horizons LORRI and MVIC, USGS Astrogeology | public domain (USGS Astrogeology, NASA) | https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/Charon_NewHorizons_Global_Mosaic_300m_Jul2017_8bit.tif |
| 999 | 0-4 | NASA/JHUAPL/SwRI New Horizons LORRI and MVIC, USGS Astrogeology | public domain (USGS Astrogeology, NASA) | https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/Pluto_NewHorizons_Global_Mosaic_300m_Jul2017_8bit.tif |

## Small bodies (smallbodies/)

895,910 numbered asteroids as SDS $OMM records (CENTER_NAME SUN; REFERENCE_FRAME mean ecliptic and equinox of J2000 (RFM coordinate system, origin NAIF 10); TIME_SYSTEM TT; osculating elements (MEAN_ELEMENT_THEORY unset, SDS MET has no OSCULATING value); SEMI_MAJOR_AXIS km; GM km^3/s^2; USER_DEFINED_PARAMETERS H, G, DIAMETER_KM), from https://ftp.lowell.edu/pub/elgb/astorb.dat.gz (sha256 ddbe380ad76979db..., 2026-10-12T04:43:20Z).

Credit: Asteroid orbits: astorb.dat, Dr. Edward Bowell, Lowell Observatory (NASA grant NAG5-4741 and the Lowell Observatory endowment).

Licence: astorb.dat may be freely used, copied, and transmitted provided attribution to Dr. Edward Bowell and the funding sources (NASA grant NAG5-4741, the Lowell Observatory endowment) is made.
