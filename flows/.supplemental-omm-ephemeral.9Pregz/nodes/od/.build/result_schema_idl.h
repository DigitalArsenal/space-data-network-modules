#pragma once

constexpr const char kResultSchemaIdl[] = R"SDSIDL(
enum CelestialFrame : byte {
  
  
  GCRF,

  
  
  ICRF,

  
  
  J2000,

  
  
  J2000A,

  
  
  EME2000,

  
  
  TEMEOFDATE,

  
  
  GTOD,

  
  
  CIRS,

  
  
  MOD_EARTH,

  
  
  MOD_CB,

  
  
  MOD_MOON,

  
  
  TOD_EARTH,

  
  
  TOD_CB,

  
  
  TOD_MOON,

  
  
  TOE_EARTH,

  
  
  TOE_CB,

  
  
  TOE_MOON,

  
  
  ITRF2000,

  
  
  ITRF93,

  
  
  ITRF97,

  
  
  EFG,

  
  
  FIXED_CB,

  
  
  FIXED_EARTH,

  
  WGS84,

  
  
  DTRFYYYY,

  
  
  ALIGN_EARTH,

  
  
  ALIGN_CB,

  
  
  B1950
}



enum SpacecraftFrame : byte {
  
  
  ACC_i,

  
  
  ACTUATOR_i,

  
  
  AST_i,

  
  
  CSS_i,

  
  
  DSS_i,

  
  
  ESA_i,

  
  
  GYRO_FRAME_i,

  
  
  IMU_FRAME_i,

  
  
  INSTRUMENT_i,

  
  
  MTA_i,

  
  
  RW_i,

  
  
  SA_i,

  
  
  SC_BODY_i,

  
  
  SENSOR_i,

  
  
  STARTRACKER_i,

  
  
  TAM_i
}



enum OrbitFrame : byte {
  
  
  EQW_INERTIAL,

  
  
  LVLH_INERTIAL,

  
  
  LVLH_ROTATING,

  
  
  NSW_INERTIAL,

  
  
  NSW_ROTATING,

  
  
  NTW_INERTIAL,

  
  
  NTW_ROTATING,

  
  
  PQW_INERTIAL,

  
  
  RSW_INERTIAL,

  
  
  RSW_ROTATING,

  
  
  SEZ_INERTIAL,

  
  
  SEZ_ROTATING,

  
  
  TNW_INERTIAL,

  
  
  TNW_ROTATING,

  
  
  VNC_INERTIAL,

  
  
  VNC_ROTATING
}


enum CustomFrame : byte {
  
  ECEF,

  
  TEME,

  
  TEMEOFEPOCH,

  
  ENU,

  
  NED,

  
  NEU,

  
  RIC,

  
  RTN,

  
  TVN,

  
  VVLH,

  
  QSW,

  
  LTP,

  
  LVLH,

  
  PNE,

  
  BRF,

  
  RSW,

  
  TNW,

  
  UVW
}


table CelestialFrameWrapper { frame: CelestialFrame; }
table SpacecraftFrameWrapper { frame: SpacecraftFrame; }
table OrbitFrameWrapper     { frame: OrbitFrame; }
table CustomFrameWrapper    { frame: CustomFrame; }

union RFMUnion {
  CelestialFrameWrapper,
  SpacecraftFrameWrapper,
  OrbitFrameWrapper,
  CustomFrameWrapper
}


table RFM {
  REFERENCE_FRAME: RFMUnion;
  INDEX: int;
  NAME: string;
}

enum timingStandard : byte {
  
  GMST,
  
  GPS,
  
  MET,
  
  MRT,
  
  SCLK,
  
  TAI,
  
  TCB,
  
  TDB,
  
  TCG,
  
  TT,
  
  UT1,
  
  UTC,
  
  GLONASS,
  
  GST,
  
  QZSS,
  
  BDT,
  
  NAVIC,
  
  SBAS
}

enum timEpochRepresentation : byte {
  
  JULIAN_DATE,
  
  MODIFIED_JULIAN_DATE,
  
  UNIX_SECONDS,
  
  ISO8601,
  
  GPS_SECONDS,
  
  GNSS_WEEK_SECONDS,
  
  CCSDS_TIME_CODE,
  
  MISSION_ELAPSED_SECONDS
}

enum timCcsdsTimeCodeKind : byte {
  
  NONE,
  
  UNSEGMENTED,
  
  DAY_SEGMENTED,
  
  CALENDAR_SEGMENTED
}

enum timConversionStatus : byte {
  
  OK,
  
  INVALID_INPUT,
  
  UNSUPPORTED_TIME_SYSTEM,
  
  LEAP_SECOND_DATA_REQUIRED,
  
  EOP_DATA_REQUIRED,
  
  OUT_OF_RANGE
}


table TIMCcsdsTimeCode {
  
  CODE_KIND:timCcsdsTimeCodeKind;
  
  PREAMBLE_FIELD1:ubyte;
  
  PREAMBLE_FIELD2:ubyte;
  
  TIME_FIELD:[ubyte];
  
  AGENCY_DEFINED_EPOCH_ISO8601:string;
  
  CCSDS_EPOCH_ISO8601:string;
}


table TIMInstant {
  
  TIME_SYSTEM: timingStandard;
  
  EPOCH_FORMAT:timEpochRepresentation;
  
  JULIAN_DATE:double;
  
  SECONDS:double;
  
  ISO8601:string;
  
  SUBSECOND_NANOS:int;
  
  EPOCH_LABEL:string;
  
  GNSS_WEEK:int;
  
  HAS_GNSS_ROLLOVER_REFERENCE:bool;
  
  GNSS_ROLLOVER_REFERENCE_ISO8601:string;
  
  CCSDS_TIME_CODE:TIMCcsdsTimeCode;
}


table TIMConversionRequest {
  
  SOURCE:TIMInstant;
  
  TARGET_TIME_SYSTEM:timingStandard;
  
  TARGET_EPOCH_FORMAT:timEpochRepresentation;
  
  TAI_MINUS_UTC_SECONDS:double;
  
  HAS_TAI_MINUS_UTC:bool;
  
  DUT1_SECONDS:double;
  
  HAS_DUT1:bool;
  
  TRACE_ID:string;
}


table TIMConversionResult {
  
  SOURCE:TIMInstant;
  
  TARGET:TIMInstant;
  
  DELTA_SECONDS:double;
  
  STATUS:timConversionStatus;
  
  ERROR_MESSAGE:string;
  
  TRACE_ID:string;
}


table TIM {
  
  TIME_SYSTEM: timingStandard;
  
  INSTANT:TIMInstant;
  
  CONVERSION_REQUEST:TIMConversionRequest;
  
  CONVERSION_RESULT:TIMConversionResult;
}

enum meanElementSource : byte {
  
  SGP4,
  
  SGP4XP,
  
  DSST,
  
  USM
}


table MET {
  MEAN_ELEMENT_THEORY:meanElementSource;
}

enum ephemerisFormat : byte {
  
  SGP,
  
  SGP4,
  
  SDP4,
  
  SGP8,
  
  SDP8
}


table OMM {
  
  CCSDS_OMM_VERS:double;
  
  CREATION_DATE:string;
  
  ORIGINATOR:string;

  
  OBJECT_NAME:string;
  
  OBJECT_ID:string;
  
  CENTER_NAME:string;
  
  
  REFERENCE_FRAME:RFM;
  
  REFERENCE_FRAME_EPOCH:string;
  
  TIME_SYSTEM:timingStandard = UTC;
  
  MEAN_ELEMENT_THEORY:meanElementSource = SGP4;

  
  COMMENT:string;
  
  EPOCH:string;
  
  SEMI_MAJOR_AXIS:double;
  
  MEAN_MOTION:double;
  
  ECCENTRICITY:double;
  
  INCLINATION:double;
  
  RA_OF_ASC_NODE:double;
  
  ARG_OF_PERICENTER:double;
  
  MEAN_ANOMALY:double;
  
  GM:double;

  
  MASS:double;
  
  SOLAR_RAD_AREA:double;
  
  SOLAR_RAD_COEFF:double;
  
  DRAG_AREA:double;
  
  DRAG_COEFF:double;

  
  
  EPHEMERIS_TYPE:ephemerisFormat = SGP4;
  
  CLASSIFICATION_TYPE:string;
  
  NORAD_CAT_ID:uint32;
  
  ELEMENT_SET_NO:uint32;
  
  REV_AT_EPOCH:double;
  
  BSTAR:double;
  
  MEAN_MOTION_DOT:double;
  
  MEAN_MOTION_DDOT:double;

  
  
  
  COV_REFERENCE_FRAME:RFM;
  
  
  
  
  
  
  COVARIANCE:[double];

  
  USER_DEFINED_BIP_0044_TYPE:uint;
  
  USER_DEFINED_OBJECT_DESIGNATOR:string;
  
  USER_DEFINED_EARTH_MODEL:string;
  
  USER_DEFINED_EPOCH_TIMESTAMP: double;
  
  USER_DEFINED_MICROSECONDS: double;
}

enum AtmosphericModelFamily : byte {
  
  
  
  CIRA_XX,

  
  
  
  DTM_XX,

  
  
  
  GITM,

  
  
  
  GOST,

  
  
  
  GRAM_XX,

  
  
  
  HP,

  
  
  
  JAC_HASDM,

  
  
  
  JAC_GILL,

  
  
  
  JB08,

  
  
  
  JR71,

  
  
  
  JXX,

  
  
  
  MET_XX,

  
  
  
  MSIS_86,

  
  
  
  MSISE_90,

  
  
  
  NRLMSIS00E,

  
  
  
  TIECGM,

  
  
  
  USSA_XX
}


table ATM {
  
  MODEL: AtmosphericModelFamily;
  
  YEAR: int;
}

enum PolarizationType: byte {
  linear,
  circular,
  elliptical,
  unpolarized
}


enum SimplePolarization: byte {
  vertical,
  horizontal,
  leftHandCircular,
  rightHandCircular
}


table FrequencyRange {
  
  LOWER: double;
  
  UPPER: double;
}


table StokesParameters {
  
  I: double;
  
  Q: double;
  
  U: double;
  
  V: double;
}


table Band {
  
  NAME: string;
  
  FREQUENCY_RANGE: FrequencyRange;
}


enum DataMode: byte {
  
  EXERCISE,
  
  REAL,
  
  SIMULATED,
  
  TEST
}

enum DeviceType: byte {
  
  
  
  
  UNKNOWN,
  
  OPTICAL,

  

  
  INFRARED_SENSOR,
  
  ULTRAVIOLET_SENSOR,
  
  X_RAY_SENSOR,
  
  GAMMA_RAY_SENSOR,

  

  
  RADAR,
  
  PHASED_ARRAY_RADAR,
  
  SYNTHETIC_APERTURE_RADAR,
  
  BISTATIC_RADIO_TELESCOPE,
  
  RADIO_TELESCOPE,

  

  
  ATMOSPHERIC_SENSOR,
  
  SPACE_WEATHER_SENSOR,
  
  ENVIRONMENTAL_SENSOR,

  

  
  SEISMIC_SENSOR,
  
  GRAVIMETRIC_SENSOR,
  
  MAGNETIC_SENSOR,
  
  ELECTROMAGNETIC_SENSOR,
  
  THERMAL_SENSOR,
  
  CHEMICAL_SENSOR,
  
  BIOLOGICAL_SENSOR,
  
  RADIATION_SENSOR,
  
  PARTICLE_DETECTOR,

  

  
  LIDAR,
  
  SONAR,
  
  TELESCOPE,
  
  SPECTROSCOPIC_SENSOR,
  
  PHOTOMETRIC_SENSOR,
  
  POLARIMETRIC_SENSOR,
  
  INTERFEROMETRIC_SENSOR,
  
  MULTISPECTRAL_SENSOR,
  
  HYPERSPECTRAL_SENSOR,

  

  
  GPS_RECEIVER,

  

  
  RADIO_COMMUNICATIONS,
  
  LASER_COMMUNICATIONS,
  
  SATELLITE_COMMUNICATIONS,

  

  
  LASER_INSTRUMENT,
  
  RF_ANALYZER,
  
  IONOSPHERIC_SENSOR,

  

  
  LASER_IMAGING,
  
  OPTICAL_TELESCOPE,
  
  HIGH_RESOLUTION_OPTICAL,

  

  RADIO,
  
  MICROWAVE_TRANSMITTER,
  
  RF_MONITOR,
  
  HF_RADIO_COMMUNICATIONS,
}


table IDM {
  
  ID: string;
  
  NAME: string;
  
  DATA_MODE: DataMode;
  
  UPLINK: FrequencyRange;
  
  DOWNLINK: FrequencyRange;
  
  BEACON: FrequencyRange;
  
  BAND: [Band];
  
  POLARIZATION_TYPE: PolarizationType;
  
  SIMPLE_POLARIZATION: SimplePolarization;
  
  STOKES_PARAMETERS: StokesParameters;
  
  POWER_REQUIRED: double;
  
  POWER_TYPE: string;
  
  TRANSMIT: bool;
  
  RECEIVE: bool;
  
  SENSOR_TYPE: DeviceType;
  
  SOURCE: string;
  
  LAST_OB_TIME: string;
  
  LOWER_LEFT_ELEVATION_LIMIT: double;
  
  UPPER_LEFT_AZIMUTH_LIMIT: double;
  
  LOWER_RIGHT_ELEVATION_LIMIT: double;
  
  LOWER_LEFT_AZIMUTH_LIMIT: double;
  
  UPPER_RIGHT_ELEVATION_LIMIT: double;
  
  UPPER_RIGHT_AZIMUTH_LIMIT: double;
  
  LOWER_RIGHT_AZIMUTH_LIMIT: double;
  
  UPPER_LEFT_ELEVATION_LIMIT: double;
  
  RIGHT_GEO_BELT_LIMIT: double;
  
  LEFT_GEO_BELT_LIMIT: double;
  
  MAGNITUDE_LIMIT: double;
  
  TASKABLE: bool;
}

table PLD {
  PAYLOAD_DURATION: string;
  MASS_AT_LAUNCH: float;
  DIMENSIONS: string;
  SOLAR_ARRAY_AREA: float;
  SOLAR_ARRAY_DIMENSIONS: string;
  NOMINAL_OPERATIONAL_LIFETIME: string;
  INSTRUMENTS: [IDM]; 
}

enum legacyCountryCode : byte {
  
  AB,
  
  ABS,
  
  AC,
  
  ALG,
  
  ANG,
  
  ARGN,
  
  ARM,
  
  ASRA,
  
  AUS,
  
  AZER,
  
  BEL,
  
  BELA,
  
  BERM,
  
  BGD,
  
  BHUT,
  
  BOL,
  
  BRAZ,
  
  BUL,
  
  CA,
  
  CHBZ,
  
  CHTU,
  
  CHLE,
  
  CIS,
  
  COL,
  
  CRI,
  
  CZCH,
  
  DEN,
  
  DJI,
  
  ECU,
  
  EGYP,
  
  ESA,
  
  ESRO,
  
  EST,
  
  ETH,
  
  EUME,
  
  EUTE,
  
  FGER,
  
  FIN,
  
  FR,
  
  FRIT,
  
  GER,
  
  GHA,
  
  GLOB,
  
  GREC,
  
  GRSA,
  
  GUAT,
  
  HUN,
  
  IM,
  
  IND,
  
  INDO,
  
  IRAN,
  
  IRAQ,
  
  IRID,
  
  IRL,
  
  ISRA,
  
  ISRO,
  
  ISS,
  
  IT,
  
  ITSO,
  
  JPN,
  
  KAZ,
  
  KEN,
  
  LAOS,
  
  LKA,
  
  LTU,
  
  LUXE,
  
  MA,
  
  MALA,
  
  MCO,
  
  MDA,
  
  MEX,
  
  MMR,
  
  MNG,
  
  MUS,
  
  NATO,
  
  NETH,
  
  NICO,
  
  NIG,
  
  NKOR,
  
  NOR,
  
  NPL,
  
  NZ,
  
  O3B,
  
  ORB,
  
  PAKI,
  
  PERU,
  
  POL,
  
  POR,
  
  PRC,
  
  PRY,
  
  PRES,
  
  QAT,
  
  RASC,
  
  ROC,
  
  ROM,
  
  RP,
  
  RWA,
  
  SAFR,
  
  SAUD,
  
  SDN,
  
  SEAL,
  
  SES,
  
  SGJP,
  
  SING,
  
  SKOR,
  
  SPN,
  
  STCT,
  
  SVN,
  
  SWED,
  
  SWTZ,
  
  TBD,
  
  THAI,
  
  TMMC,
  
  TUN,
  
  TURK,
  
  UAE,
  
  UK,
  
  UKR,
  
  UNK,
  
  URY,
  
  US,
  
  USBZ,
  
  VAT,
  
  VENZ,
  
  VTNM,
  
  ZWE
}


table LCC {
  OWNER: legacyCountryCode;
}

enum spaceObjectClass: byte {
  
  PAYLOAD,
  
  ROCKET_BODY,
  
  DEBRIS,
  
  UNKNOWN
}

enum operationalState: byte {
  
  OPERATIONAL,
  
  NONOPERATIONAL,
  
  PARTIALLY_OPERATIONAL,
  
  BACKUP_STANDBY,
  
  SPARE,
  
  EXTENDED_MISSION,
  
  DECAYED,
  
  UNKNOWN
}

enum dataAvailability: byte {
  
  NO_CURRENT_ELEMENTS,
  
  NO_INITIAL_ELEMENTS,
  
  NO_ELEMENTS_AVAILABLE,
  
  OK
}

enum orbitRegime: byte {
  
  ORBIT,
  
  LANDING,
  
  IMPACT,
  
  DOCKED,
  
  ROUNDTRIP
}

enum massCategory: byte {
  DRY,
  WET
}


table CAT {
  
  OBJECT_NAME: string;
  
  OBJECT_ID: string;
  
  NORAD_CAT_ID: uint;
  
  OBJECT_TYPE: spaceObjectClass = UNKNOWN;
  
  OPS_STATUS_CODE: operationalState = UNKNOWN;
  
  OWNER: legacyCountryCode;
  
  LAUNCH_DATE: string;
  
  LAUNCH_SITE: string;
  
  DECAY_DATE: string;
  
  PERIOD: double;
  
  INCLINATION: double;
  
  APOGEE: double;
  
  PERIGEE: double;
  
  RCS: double;
  
  DATA_STATUS_CODE: dataAvailability;
  
  ORBIT_CENTER: string;
  
  ORBIT_TYPE: orbitRegime;
  
  DEPLOYMENT_DATE: string;
  
  MANEUVERABLE: bool;
  
  SIZE: double;
  
  MASS: double;
  
  MASS_TYPE: massCategory = DRY;
  
  PAYLOADS: [PLD];
}

enum polynomialBasisType : byte {
  
  
  CHEBYSHEV,

  
  
  LEGENDRE,

  
  
  HERMITE,

  
  
  LAGRANGE,

  
  POWER_SERIES
}


enum ppeAnomalyType : byte {
  
  TRUE_ANOMALY,

  
  MEAN_ANOMALY,

  
  ECCENTRIC_ANOMALY
}


enum sizeShapeProfile : byte {
  
  SMA,

  
  R_PERIAPSIS
}

















table PPEPositionRecord {
  
  
  
  EPOCH_MID: string (required);

  
  
  EPOCH_HALF_SPAN: double;

  
  
  
  NUM_COEFFICIENTS: uint16;

  
  BASIS_TYPE: polynomialBasisType = CHEBYSHEV;

  
  
  POS_COEFF_X: [double] (required);

  
  
  POS_COEFF_Y: [double] (required);

  
  
  POS_COEFF_Z: [double] (required);

  
  
  HAS_VELOCITY_COEFFICIENTS: bool = false;

  
  
  VEL_COEFF_X: [double];

  
  VEL_COEFF_Y: [double];

  
  VEL_COEFF_Z: [double];

  
  MAX_POSITION_RESIDUAL: double;

  
  RMS_POSITION_RESIDUAL: double;
}
















table PPEOrbitalElementRecord {
  
  EPOCH_MID: string (required);

  
  EPOCH_HALF_SPAN: double;

  
  NUM_COEFFICIENTS: uint16;

  
  BASIS_TYPE: polynomialBasisType = CHEBYSHEV;

  
  SIZE_SHAPE_TYPE: sizeShapeProfile = SMA;

  
  ANOMALY_TYPE: ppeAnomalyType = TRUE_ANOMALY;

  
  
  COEFF_SIZE_SHAPE: [double] (required);

  
  
  COEFF_ECCENTRICITY: [double] (required);

  
  
  COEFF_INCLINATION: [double] (required);

  
  
  COEFF_RAAN: [double] (required);

  
  
  COEFF_ARG_PERIAPSIS: [double] (required);

  
  
  COEFF_ANOMALY: [double] (required);

  
  
  MAX_ELEMENT_RESIDUAL: double;

  
  RMS_ELEMENT_RESIDUAL: double;
}











table PPE {
  
  COMMENT: [string];

  
  OBJECT: CAT;

  
  CENTER_NAME: string;

  
  REFERENCE_FRAME: RFM;

  
  TIME_SYSTEM: timingStandard;

  
  START_TIME: string;

  
  STOP_TIME: string;

  
  
  DEFAULT_BASIS_TYPE: polynomialBasisType = CHEBYSHEV;

  
  
  POSITION_RECORDS: [PPEPositionRecord];

  
  
  ORBITAL_ELEMENT_RECORDS: [PPEOrbitalElementRecord];

  
  EPHEMERIS_SOURCE: string;

  
  
  NOMINAL_SEGMENT_SPAN: double;

  
  
  NOMINAL_NUM_COEFFICIENTS: uint16;
}

enum trajectoryType : byte {
  
  CARTESIAN_PV,

  
  CARTESIAN_PVA,

  
  
  POLYNOMIAL_POS,

  
  
  POLYNOMIAL_OE,

  
  HERMITE,

  
  LAGRANGE
}

table Header {
  
  CCSDS_OCM_VERS: string;
  
  COMMENT: [string];
  
  CLASSIFICATION: string;
  
  CREATION_DATE: string;
  
  ORIGINATOR: string;
  
  MESSAGE_ID: string;
}

table Metadata {
  
  COMMENT: [string];
  
  OBJECT_NAME: string;
  
  INTERNATIONAL_DESIGNATOR: string;
  
  CATALOG_NAME: string;
  
  OBJECT_DESIGNATOR: string;
  
  ALTERNATE_NAMES: [string];
  
  ORIGINATOR_POC: string;
  
  ORIGINATOR_POSITION: string;
  
  ORIGINATOR_PHONE: string;
  
  ORIGINATOR_EMAIL: string;
  
  ORIGINATOR_ADDRESS: string;
  
  TECH_ORG: string;
  
  TECH_POC: string;
  
  TECH_POSITION: string;
  
  TECH_PHONE: string;
  
  TECH_EMAIL: string;
  
  TECH_ADDRESS: string;
  
  PREVIOUS_MESSAGE_ID: string;
  
  NEXT_MESSAGE_ID: string;
  
  ADM_MSG_LINK: string;
  
  CDM_MSG_LINK: string;
  
  PRM_MSG_LINK: string;
  
  RDM_MSG_LINK: string;
  
  TDM_MSG_LINK: [string];
  
  OPERATOR: string;
  
  OWNER: string;
  
  COUNTRY: string;
  
  CONSTELLATION: string;
  
  OBJECT_TYPE: string;
  
  TIME_SYSTEM: string;
  
  EPOCH_TZERO: string;
  
  OPS_STATUS: string;
  
  ORBIT_CATEGORY: string;
  
  OCM_DATA_ELEMENTS: [string];
  
  SCLK_OFFSET_AT_EPOCH: double;
  
  SCLK_SEC_PER_SI_SEC: double;
  
  PREVIOUS_MESSAGE_EPOCH: string;
  
  NEXT_MESSAGE_EPOCH: string;
  
  START_TIME: string;
  
  STOP_TIME: string;
  
  TIME_SPAN: double;
  
  TAIMUTC_AT_TZERO: double;
  
  NEXT_LEAP_EPOCH: string;
  
  NEXT_LEAP_TAIMUTC: double;
  
  UT1MUTC_AT_TZERO: double;
  
  EOP_SOURCE: string;
  
  INTERP_METHOD_EOP: string;
  
  CELESTIAL_SOURCE: string;
}

table StateVector {
  
  EPOCH: string;
  
  X: double;
  
  Y: double;
  
  Z: double;
  
  X_DOT: double;
  
  Y_DOT: double;
  
  Z_DOT: double;
  
  X_DDOT: double;
  
  Y_DDOT: double;
  
  Z_DDOT: double;
}

table PhysicalProperties {
  
  COMMENT: [string];
  
  WET_MASS: double;
  
  DRY_MASS: double;
  
  MASS_UNITS: string;
  
  OEB_Q1: double;
  
  OEB_Q2: double;
  
  OEB_Q3: double;
  
  OEB_QC: double;
  
  OEB_MAX: double;
  
  OEB_INT: double;
  
  OEB_MIN: double;
  
  AREA_ALONG_OEB_MAX: double;
  
  AREA_ALONG_OEB_INT: double;
  
  AREA_ALONG_OEB_MIN: double;
  
  AREA_UNITS: string;
  
  DRAG_CONST_AREA: double;
  
  DRAG_COEFF_NOM: double;
  
  DRAG_UNCERTAINTY: double;
  
  SRP_CONST_AREA: double;
  
  SOLAR_RAD_COEFF: double;
  
  SRP_UNCERTAINTY: double;
}

table Perturbations {
  
  COMMENT: [string];
  
  ATMOSPHERIC_MODEL: ATM;
  
  GRAVITY_MODEL: string;
  
  GRAVITY_DEGREE: int;
  
  GRAVITY_ORDER: int;
  
  GM: double;
  
  N_BODY_PERTURBATIONS: [string];
  
  OCEAN_TIDES_MODEL: string;
  
  SOLID_TIDES_MODEL: string;
  
  ATMOSPHERIC_TIDES_MODEL: string;
  
  GEOPOTENTIAL_MODEL: string;
  
  SOLAR_RAD_PRESSURE: string;
  
  ALBEDO: string;
  
  THERMAL: string;
  
  RELATIVITY: string;
  
  ATMOSPHERIC_DRAG: string;
  
  FIXED_GEOMAG_KP: double;
  
  FIXED_F10P7: double;
  
  FIXED_F10P7_MEAN: double;
}

table Maneuver {
  
  MAN_ID: string;
  
  MAN_BASIS: string;
  
  MAN_DEVICE_ID: string;
  
  MAN_PREV_ID: string;
  
  MAN_PURPOSE: string;
  
  MAN_REF_FRAME: string;
  
  MAN_FRAME_EPOCH: string;
  
  MAN_TYPE: string;
  
  MAN_EPOCH_START: string;
  
  MAN_DURATION: double;
  
  MAN_UNITS: [string];
  
  DATA: [string];
  
  MAN_COMMENT: [string];
}

table OrbitDetermination {
  
  OD_ID: string;
  
  OD_PREV_ID: string;
  
  OD_ALGORITHM: string;
  
  OD_METHOD: string;
  
  OD_EPOCH: string;
  
  OD_TIME_TAG: string;
  
  OD_PROCESS_NOISE: string;
  
  OD_COV_REDUCTION: string;
  
  OD_NOISE_MODELS: string;
  
  OD_OBSERVATIONS_TYPE: [string];
  
  OD_OBSERVATIONS_USED: int;
  
  OD_TRACKS_USED: int;
  
  OD_DATA_WEIGHTING: string;
  
  OD_CONVERGENCE_CRITERIA: string;
  
  OD_EST_PARAMETERS: [string];
  
  OD_APRIORI_DATA: string;
  
  OD_RESIDUALS: string;
}

table UserDefinedParameters {
  
  PARAM_NAME: string;
  
  PARAM_VALUE: string;
}


table OCM {
  
  HEADER: Header;
  
  METADATA: Metadata;
  
  
  
  
  TRAJ_TYPE: trajectoryType = CARTESIAN_PV;

  
  
  TRAJ_TYPE_DESCRIPTION: string;

  
  STATE_STEP_SIZE:double;

  
  
  
  STATE_VECTOR_SIZE:uint8 = 6;

  
  
  
  
  STATE_DATA:[double];

  
  
  COVARIANCE_DATA:[double];

  
  
  
  
  POLYNOMIAL_POSITION_RECORDS: [PPEPositionRecord];

  
  
  
  
  POLYNOMIAL_OE_RECORDS: [PPEOrbitalElementRecord];

  
  PHYSICAL_PROPERTIES: PhysicalProperties;
  
  MANEUVER_DATA: [Maneuver];
  
  PERTURBATIONS: Perturbations;
  
  ORBIT_DETERMINATION: OrbitDetermination;
  
  USER_DEFINED_PARAMETERS: [UserDefinedParameters];
}
)SDSIDL";
