#include "space_data_module_invoke.h"

#include "flatbuffers/flatbuffers.h"

#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <string>
#include <vector>

namespace {

constexpr double kPi = 3.141592653589793238462643383279502884;
constexpr double kTwoPi = 2.0 * kPi;
constexpr double kDegreesToRadians = kPi / 180.0;
constexpr double kRadiansToDegrees = 180.0 / kPi;
constexpr double kSecondsPerDay = 86400.0;
constexpr double kSmall = 1e-12;
constexpr double kSingularOrbitTolerance = 1e-10;
constexpr double kBasiliskSolarFlux = 1372.5398;
constexpr double kSpeedOfLightMetersPerSecond = 299792458.0;

struct OMM FLATBUFFERS_FINAL_CLASS : private ::flatbuffers::Table {
  static constexpr ::flatbuffers::voffset_t VT_CCSDS_OMM_VERS = 4;
  static constexpr ::flatbuffers::voffset_t VT_CREATION_DATE = 6;
  static constexpr ::flatbuffers::voffset_t VT_ORIGINATOR = 8;
  static constexpr ::flatbuffers::voffset_t VT_OBJECT_NAME = 10;
  static constexpr ::flatbuffers::voffset_t VT_OBJECT_ID = 12;
  static constexpr ::flatbuffers::voffset_t VT_CENTER_NAME = 14;
  static constexpr ::flatbuffers::voffset_t VT_REFERENCE_FRAME_EPOCH = 18;
  static constexpr ::flatbuffers::voffset_t VT_TIME_SYSTEM = 20;
  static constexpr ::flatbuffers::voffset_t VT_MEAN_ELEMENT_THEORY = 22;
  static constexpr ::flatbuffers::voffset_t VT_COMMENT = 24;
  static constexpr ::flatbuffers::voffset_t VT_EPOCH = 26;
  static constexpr ::flatbuffers::voffset_t VT_SEMI_MAJOR_AXIS = 28;
  static constexpr ::flatbuffers::voffset_t VT_MEAN_MOTION = 30;
  static constexpr ::flatbuffers::voffset_t VT_ECCENTRICITY = 32;
  static constexpr ::flatbuffers::voffset_t VT_INCLINATION = 34;
  static constexpr ::flatbuffers::voffset_t VT_RA_OF_ASC_NODE = 36;
  static constexpr ::flatbuffers::voffset_t VT_ARG_OF_PERICENTER = 38;
  static constexpr ::flatbuffers::voffset_t VT_MEAN_ANOMALY = 40;
  static constexpr ::flatbuffers::voffset_t VT_GM = 42;

  const ::flatbuffers::String* CREATION_DATE() const {
    return GetPointer<const ::flatbuffers::String*>(VT_CREATION_DATE);
  }
  const ::flatbuffers::String* ORIGINATOR() const {
    return GetPointer<const ::flatbuffers::String*>(VT_ORIGINATOR);
  }
  const ::flatbuffers::String* OBJECT_NAME() const {
    return GetPointer<const ::flatbuffers::String*>(VT_OBJECT_NAME);
  }
  const ::flatbuffers::String* OBJECT_ID() const {
    return GetPointer<const ::flatbuffers::String*>(VT_OBJECT_ID);
  }
  const ::flatbuffers::String* CENTER_NAME() const {
    return GetPointer<const ::flatbuffers::String*>(VT_CENTER_NAME);
  }
  const ::flatbuffers::String* REFERENCE_FRAME_EPOCH() const {
    return GetPointer<const ::flatbuffers::String*>(VT_REFERENCE_FRAME_EPOCH);
  }
  int8_t TIME_SYSTEM() const {
    return GetField<int8_t>(VT_TIME_SYSTEM, 11);
  }
  int8_t MEAN_ELEMENT_THEORY() const {
    return GetField<int8_t>(VT_MEAN_ELEMENT_THEORY, 0);
  }
  const ::flatbuffers::String* COMMENT() const {
    return GetPointer<const ::flatbuffers::String*>(VT_COMMENT);
  }
  const ::flatbuffers::String* EPOCH() const {
    return GetPointer<const ::flatbuffers::String*>(VT_EPOCH);
  }
  double SEMI_MAJOR_AXIS() const {
    return GetField<double>(VT_SEMI_MAJOR_AXIS, 0.0);
  }
  double ECCENTRICITY() const {
    return GetField<double>(VT_ECCENTRICITY, 0.0);
  }
  double INCLINATION() const {
    return GetField<double>(VT_INCLINATION, 0.0);
  }
  double RA_OF_ASC_NODE() const {
    return GetField<double>(VT_RA_OF_ASC_NODE, 0.0);
  }
  double ARG_OF_PERICENTER() const {
    return GetField<double>(VT_ARG_OF_PERICENTER, 0.0);
  }
  double MEAN_ANOMALY() const {
    return GetField<double>(VT_MEAN_ANOMALY, 0.0);
  }
  double GM() const {
    return GetField<double>(VT_GM, 0.0);
  }

  template <bool B = false>
  bool Verify(::flatbuffers::VerifierTemplate<B>& verifier) const {
    return VerifyTableStart(verifier) &&
           VerifyOffset(verifier, VT_CREATION_DATE) &&
           verifier.VerifyString(CREATION_DATE()) &&
           VerifyOffset(verifier, VT_ORIGINATOR) &&
           verifier.VerifyString(ORIGINATOR()) &&
           VerifyOffset(verifier, VT_OBJECT_NAME) &&
           verifier.VerifyString(OBJECT_NAME()) &&
           VerifyOffset(verifier, VT_OBJECT_ID) &&
           verifier.VerifyString(OBJECT_ID()) &&
           VerifyOffset(verifier, VT_CENTER_NAME) &&
           verifier.VerifyString(CENTER_NAME()) &&
           VerifyOffset(verifier, VT_REFERENCE_FRAME_EPOCH) &&
           verifier.VerifyString(REFERENCE_FRAME_EPOCH()) &&
           VerifyField<int8_t>(verifier, VT_TIME_SYSTEM, 1) &&
           VerifyField<int8_t>(verifier, VT_MEAN_ELEMENT_THEORY, 1) &&
           VerifyOffset(verifier, VT_COMMENT) &&
           verifier.VerifyString(COMMENT()) &&
           VerifyOffset(verifier, VT_EPOCH) &&
           verifier.VerifyString(EPOCH()) &&
           VerifyField<double>(verifier, VT_SEMI_MAJOR_AXIS, 8) &&
           VerifyField<double>(verifier, VT_MEAN_MOTION, 8) &&
           VerifyField<double>(verifier, VT_ECCENTRICITY, 8) &&
           VerifyField<double>(verifier, VT_INCLINATION, 8) &&
           VerifyField<double>(verifier, VT_RA_OF_ASC_NODE, 8) &&
           VerifyField<double>(verifier, VT_ARG_OF_PERICENTER, 8) &&
           VerifyField<double>(verifier, VT_MEAN_ANOMALY, 8) &&
           VerifyField<double>(verifier, VT_GM, 8) &&
           verifier.EndTable();
  }
};

struct ephemerisDataLine FLATBUFFERS_FINAL_CLASS : private ::flatbuffers::Table {
  static constexpr ::flatbuffers::voffset_t VT_EPOCH = 4;
  static constexpr ::flatbuffers::voffset_t VT_X = 6;
  static constexpr ::flatbuffers::voffset_t VT_Y = 8;
  static constexpr ::flatbuffers::voffset_t VT_Z = 10;
  static constexpr ::flatbuffers::voffset_t VT_X_DOT = 12;
  static constexpr ::flatbuffers::voffset_t VT_Y_DOT = 14;
  static constexpr ::flatbuffers::voffset_t VT_Z_DOT = 16;
  static constexpr ::flatbuffers::voffset_t VT_X_DDOT = 18;
  static constexpr ::flatbuffers::voffset_t VT_Y_DDOT = 20;
  static constexpr ::flatbuffers::voffset_t VT_Z_DDOT = 22;

  const ::flatbuffers::String* EPOCH() const {
    return GetPointer<const ::flatbuffers::String*>(VT_EPOCH);
  }
  double X() const {
    return GetField<double>(VT_X, 0.0);
  }
  double Y() const {
    return GetField<double>(VT_Y, 0.0);
  }
  double Z() const {
    return GetField<double>(VT_Z, 0.0);
  }
  double X_DOT() const {
    return GetField<double>(VT_X_DOT, 0.0);
  }
  double Y_DOT() const {
    return GetField<double>(VT_Y_DOT, 0.0);
  }
  double Z_DOT() const {
    return GetField<double>(VT_Z_DOT, 0.0);
  }
  double X_DDOT() const {
    return GetField<double>(VT_X_DDOT, 0.0);
  }
  double Y_DDOT() const {
    return GetField<double>(VT_Y_DDOT, 0.0);
  }
  double Z_DDOT() const {
    return GetField<double>(VT_Z_DDOT, 0.0);
  }

  template <bool B = false>
  bool Verify(::flatbuffers::VerifierTemplate<B>& verifier) const {
    return VerifyTableStart(verifier) &&
           VerifyOffset(verifier, VT_EPOCH) &&
           verifier.VerifyString(EPOCH()) &&
           VerifyField<double>(verifier, VT_X, 8) &&
           VerifyField<double>(verifier, VT_Y, 8) &&
           VerifyField<double>(verifier, VT_Z, 8) &&
           VerifyField<double>(verifier, VT_X_DOT, 8) &&
           VerifyField<double>(verifier, VT_Y_DOT, 8) &&
           VerifyField<double>(verifier, VT_Z_DOT, 8) &&
           VerifyField<double>(verifier, VT_X_DDOT, 8) &&
           VerifyField<double>(verifier, VT_Y_DDOT, 8) &&
           VerifyField<double>(verifier, VT_Z_DDOT, 8) &&
           verifier.EndTable();
  }
};

struct ephemerisDataBlock FLATBUFFERS_FINAL_CLASS : private ::flatbuffers::Table {
  static constexpr ::flatbuffers::voffset_t VT_COMMENT = 4;
  static constexpr ::flatbuffers::voffset_t VT_CENTER_NAME = 8;
  static constexpr ::flatbuffers::voffset_t VT_TIME_SYSTEM = 16;
  static constexpr ::flatbuffers::voffset_t VT_START_TIME = 18;
  static constexpr ::flatbuffers::voffset_t VT_STOP_TIME = 24;
  static constexpr ::flatbuffers::voffset_t VT_STEP_SIZE = 30;
  static constexpr ::flatbuffers::voffset_t VT_STATE_VECTOR_SIZE = 32;
  static constexpr ::flatbuffers::voffset_t VT_EPHEMERIS_DATA_LINES = 36;

  const ::flatbuffers::String* COMMENT() const {
    return GetPointer<const ::flatbuffers::String*>(VT_COMMENT);
  }
  const ::flatbuffers::String* CENTER_NAME() const {
    return GetPointer<const ::flatbuffers::String*>(VT_CENTER_NAME);
  }
  int8_t TIME_SYSTEM() const {
    return GetField<int8_t>(VT_TIME_SYSTEM, 0);
  }
  const ::flatbuffers::String* START_TIME() const {
    return GetPointer<const ::flatbuffers::String*>(VT_START_TIME);
  }
  const ::flatbuffers::String* STOP_TIME() const {
    return GetPointer<const ::flatbuffers::String*>(VT_STOP_TIME);
  }
  const ::flatbuffers::Vector<::flatbuffers::Offset<ephemerisDataLine>>* EPHEMERIS_DATA_LINES() const {
    return GetPointer<const ::flatbuffers::Vector<::flatbuffers::Offset<ephemerisDataLine>>*>(
        VT_EPHEMERIS_DATA_LINES);
  }

  template <bool B = false>
  bool Verify(::flatbuffers::VerifierTemplate<B>& verifier) const {
    return VerifyTableStart(verifier) &&
           VerifyOffset(verifier, VT_COMMENT) &&
           verifier.VerifyString(COMMENT()) &&
           VerifyOffset(verifier, VT_CENTER_NAME) &&
           verifier.VerifyString(CENTER_NAME()) &&
           VerifyField<int8_t>(verifier, VT_TIME_SYSTEM, 1) &&
           VerifyOffset(verifier, VT_START_TIME) &&
           verifier.VerifyString(START_TIME()) &&
           VerifyOffset(verifier, VT_STOP_TIME) &&
           verifier.VerifyString(STOP_TIME()) &&
           VerifyField<double>(verifier, VT_STEP_SIZE, 8) &&
           VerifyField<uint8_t>(verifier, VT_STATE_VECTOR_SIZE, 1) &&
           VerifyOffset(verifier, VT_EPHEMERIS_DATA_LINES) &&
           verifier.VerifyVector(EPHEMERIS_DATA_LINES()) &&
           verifier.VerifyVectorOfTables(EPHEMERIS_DATA_LINES()) &&
           verifier.EndTable();
  }
};

struct OEM FLATBUFFERS_FINAL_CLASS : private ::flatbuffers::Table {
  static constexpr ::flatbuffers::voffset_t VT_CLASSIFICATION = 4;
  static constexpr ::flatbuffers::voffset_t VT_CCSDS_OEM_VERS = 6;
  static constexpr ::flatbuffers::voffset_t VT_CREATION_DATE = 8;
  static constexpr ::flatbuffers::voffset_t VT_ORIGINATOR = 10;
  static constexpr ::flatbuffers::voffset_t VT_EPHEMERIS_DATA_BLOCK = 12;

  const ::flatbuffers::String* CREATION_DATE() const {
    return GetPointer<const ::flatbuffers::String*>(VT_CREATION_DATE);
  }
  const ::flatbuffers::Vector<::flatbuffers::Offset<ephemerisDataBlock>>* EPHEMERIS_DATA_BLOCK() const {
    return GetPointer<const ::flatbuffers::Vector<::flatbuffers::Offset<ephemerisDataBlock>>*>(
        VT_EPHEMERIS_DATA_BLOCK);
  }

  template <bool B = false>
  bool Verify(::flatbuffers::VerifierTemplate<B>& verifier) const {
    return VerifyTableStart(verifier) &&
           VerifyOffset(verifier, VT_CREATION_DATE) &&
           verifier.VerifyString(CREATION_DATE()) &&
           VerifyField<double>(verifier, VT_CCSDS_OEM_VERS, 8) &&
           VerifyOffset(verifier, VT_EPHEMERIS_DATA_BLOCK) &&
           verifier.VerifyVector(EPHEMERIS_DATA_BLOCK()) &&
           verifier.VerifyVectorOfTables(EPHEMERIS_DATA_BLOCK()) &&
           verifier.EndTable();
  }
};

struct OPM FLATBUFFERS_FINAL_CLASS : private ::flatbuffers::Table {
  static constexpr ::flatbuffers::voffset_t VT_CCSDS_OPM_VERS = 4;
  static constexpr ::flatbuffers::voffset_t VT_CREATION_DATE = 6;
  static constexpr ::flatbuffers::voffset_t VT_ORIGINATOR = 8;
  static constexpr ::flatbuffers::voffset_t VT_OBJECT_NAME = 10;
  static constexpr ::flatbuffers::voffset_t VT_OBJECT_ID = 12;
  static constexpr ::flatbuffers::voffset_t VT_CENTER_NAME = 14;
  static constexpr ::flatbuffers::voffset_t VT_REF_FRAME = 16;
  static constexpr ::flatbuffers::voffset_t VT_TIME_SYSTEM = 18;
  static constexpr ::flatbuffers::voffset_t VT_EPOCH = 20;
  static constexpr ::flatbuffers::voffset_t VT_X = 22;
  static constexpr ::flatbuffers::voffset_t VT_Y = 24;
  static constexpr ::flatbuffers::voffset_t VT_Z = 26;
  static constexpr ::flatbuffers::voffset_t VT_X_DOT = 28;
  static constexpr ::flatbuffers::voffset_t VT_Y_DOT = 30;
  static constexpr ::flatbuffers::voffset_t VT_Z_DOT = 32;
  static constexpr ::flatbuffers::voffset_t VT_SEMI_MAJOR_AXIS = 34;
  static constexpr ::flatbuffers::voffset_t VT_ECCENTRICITY = 36;
  static constexpr ::flatbuffers::voffset_t VT_INCLINATION = 38;
  static constexpr ::flatbuffers::voffset_t VT_RA_OF_ASC_NODE = 40;
  static constexpr ::flatbuffers::voffset_t VT_ARG_OF_PERICENTER = 42;
  static constexpr ::flatbuffers::voffset_t VT_TRUE_ANOMALY = 44;
  static constexpr ::flatbuffers::voffset_t VT_MEAN_ANOMALY = 46;
  static constexpr ::flatbuffers::voffset_t VT_GM = 48;
  static constexpr ::flatbuffers::voffset_t VT_MASS = 50;
  static constexpr ::flatbuffers::voffset_t VT_SOLAR_RAD_AREA = 52;
  static constexpr ::flatbuffers::voffset_t VT_SOLAR_RAD_COEFF = 54;
  static constexpr ::flatbuffers::voffset_t VT_DRAG_AREA = 56;
  static constexpr ::flatbuffers::voffset_t VT_DRAG_COEFF = 58;

  const ::flatbuffers::String* CREATION_DATE() const {
    return GetPointer<const ::flatbuffers::String*>(VT_CREATION_DATE);
  }
  const ::flatbuffers::String* ORIGINATOR() const {
    return GetPointer<const ::flatbuffers::String*>(VT_ORIGINATOR);
  }
  const ::flatbuffers::String* OBJECT_NAME() const {
    return GetPointer<const ::flatbuffers::String*>(VT_OBJECT_NAME);
  }
  const ::flatbuffers::String* OBJECT_ID() const {
    return GetPointer<const ::flatbuffers::String*>(VT_OBJECT_ID);
  }
  const ::flatbuffers::String* CENTER_NAME() const {
    return GetPointer<const ::flatbuffers::String*>(VT_CENTER_NAME);
  }
  const ::flatbuffers::String* TIME_SYSTEM() const {
    return GetPointer<const ::flatbuffers::String*>(VT_TIME_SYSTEM);
  }
  const ::flatbuffers::String* EPOCH() const {
    return GetPointer<const ::flatbuffers::String*>(VT_EPOCH);
  }
  double X() const {
    return GetField<double>(VT_X, 0.0);
  }
  double Y() const {
    return GetField<double>(VT_Y, 0.0);
  }
  double Z() const {
    return GetField<double>(VT_Z, 0.0);
  }
  double X_DOT() const {
    return GetField<double>(VT_X_DOT, 0.0);
  }
  double Y_DOT() const {
    return GetField<double>(VT_Y_DOT, 0.0);
  }
  double Z_DOT() const {
    return GetField<double>(VT_Z_DOT, 0.0);
  }
  double SEMI_MAJOR_AXIS() const {
    return GetField<double>(VT_SEMI_MAJOR_AXIS, 0.0);
  }
  double ECCENTRICITY() const {
    return GetField<double>(VT_ECCENTRICITY, 0.0);
  }
  double INCLINATION() const {
    return GetField<double>(VT_INCLINATION, 0.0);
  }
  double RA_OF_ASC_NODE() const {
    return GetField<double>(VT_RA_OF_ASC_NODE, 0.0);
  }
  double ARG_OF_PERICENTER() const {
    return GetField<double>(VT_ARG_OF_PERICENTER, 0.0);
  }
  double TRUE_ANOMALY() const {
    return GetField<double>(VT_TRUE_ANOMALY, 0.0);
  }
  double MEAN_ANOMALY() const {
    return GetField<double>(VT_MEAN_ANOMALY, 0.0);
  }
  double GM() const {
    return GetField<double>(VT_GM, 0.0);
  }

  template <bool B = false>
  bool Verify(::flatbuffers::VerifierTemplate<B>& verifier) const {
    return VerifyTableStart(verifier) &&
           VerifyOffset(verifier, VT_CCSDS_OPM_VERS) &&
           verifier.VerifyString(GetPointer<const ::flatbuffers::String*>(VT_CCSDS_OPM_VERS)) &&
           VerifyOffset(verifier, VT_CREATION_DATE) &&
           verifier.VerifyString(CREATION_DATE()) &&
           VerifyOffset(verifier, VT_ORIGINATOR) &&
           verifier.VerifyString(ORIGINATOR()) &&
           VerifyOffset(verifier, VT_OBJECT_NAME) &&
           verifier.VerifyString(OBJECT_NAME()) &&
           VerifyOffset(verifier, VT_OBJECT_ID) &&
           verifier.VerifyString(OBJECT_ID()) &&
           VerifyOffset(verifier, VT_CENTER_NAME) &&
           verifier.VerifyString(CENTER_NAME()) &&
           VerifyOffset(verifier, VT_REF_FRAME) &&
           verifier.VerifyString(GetPointer<const ::flatbuffers::String*>(VT_REF_FRAME)) &&
           VerifyOffset(verifier, VT_TIME_SYSTEM) &&
           verifier.VerifyString(TIME_SYSTEM()) &&
           VerifyOffset(verifier, VT_EPOCH) &&
           verifier.VerifyString(EPOCH()) &&
           VerifyField<double>(verifier, VT_X, 8) &&
           VerifyField<double>(verifier, VT_Y, 8) &&
           VerifyField<double>(verifier, VT_Z, 8) &&
           VerifyField<double>(verifier, VT_X_DOT, 8) &&
           VerifyField<double>(verifier, VT_Y_DOT, 8) &&
           VerifyField<double>(verifier, VT_Z_DOT, 8) &&
           VerifyField<double>(verifier, VT_SEMI_MAJOR_AXIS, 8) &&
           VerifyField<double>(verifier, VT_ECCENTRICITY, 8) &&
           VerifyField<double>(verifier, VT_INCLINATION, 8) &&
           VerifyField<double>(verifier, VT_RA_OF_ASC_NODE, 8) &&
           VerifyField<double>(verifier, VT_ARG_OF_PERICENTER, 8) &&
           VerifyField<double>(verifier, VT_TRUE_ANOMALY, 8) &&
           VerifyField<double>(verifier, VT_MEAN_ANOMALY, 8) &&
           VerifyField<double>(verifier, VT_GM, 8) &&
           VerifyField<double>(verifier, VT_MASS, 8) &&
           VerifyField<double>(verifier, VT_SOLAR_RAD_AREA, 8) &&
           VerifyField<double>(verifier, VT_SOLAR_RAD_COEFF, 8) &&
           VerifyField<double>(verifier, VT_DRAG_AREA, 8) &&
           VerifyField<double>(verifier, VT_DRAG_COEFF, 8) &&
           verifier.EndTable();
  }
};

struct keplerianElements FLATBUFFERS_FINAL_CLASS : private ::flatbuffers::Table {
  static constexpr ::flatbuffers::voffset_t VT_SEMI_MAJOR_AXIS = 4;
  static constexpr ::flatbuffers::voffset_t VT_ECCENTRICITY = 6;
  static constexpr ::flatbuffers::voffset_t VT_INCLINATION = 8;
  static constexpr ::flatbuffers::voffset_t VT_RA_OF_ASC_NODE = 10;
  static constexpr ::flatbuffers::voffset_t VT_ARG_OF_PERICENTER = 12;
  static constexpr ::flatbuffers::voffset_t VT_ANOMALY_TYPE = 14;
  static constexpr ::flatbuffers::voffset_t VT_ANOMALY = 16;
  static constexpr ::flatbuffers::voffset_t VT_PERIAPSIS_RADIUS = 18;

  double SEMI_MAJOR_AXIS() const {
    return GetField<double>(VT_SEMI_MAJOR_AXIS, 0.0);
  }
  double ECCENTRICITY() const {
    return GetField<double>(VT_ECCENTRICITY, 0.0);
  }
  double INCLINATION() const {
    return GetField<double>(VT_INCLINATION, 0.0);
  }
  double RA_OF_ASC_NODE() const {
    return GetField<double>(VT_RA_OF_ASC_NODE, 0.0);
  }
  double ARG_OF_PERICENTER() const {
    return GetField<double>(VT_ARG_OF_PERICENTER, 0.0);
  }
  int8_t ANOMALY_TYPE() const {
    return GetField<int8_t>(VT_ANOMALY_TYPE, 0);
  }
  double ANOMALY() const {
    return GetField<double>(VT_ANOMALY, 0.0);
  }
  double PERIAPSIS_RADIUS() const {
    return GetField<double>(VT_PERIAPSIS_RADIUS, 0.0);
  }

  template <bool B = false>
  bool Verify(::flatbuffers::VerifierTemplate<B>& verifier) const {
    return VerifyTableStart(verifier) &&
           VerifyField<double>(verifier, VT_SEMI_MAJOR_AXIS, 8) &&
           VerifyField<double>(verifier, VT_ECCENTRICITY, 8) &&
           VerifyField<double>(verifier, VT_INCLINATION, 8) &&
           VerifyField<double>(verifier, VT_RA_OF_ASC_NODE, 8) &&
           VerifyField<double>(verifier, VT_ARG_OF_PERICENTER, 8) &&
           VerifyField<int8_t>(verifier, VT_ANOMALY_TYPE, 1) &&
           VerifyField<double>(verifier, VT_ANOMALY, 8) &&
           VerifyField<double>(verifier, VT_PERIAPSIS_RADIUS, 8) &&
           verifier.EndTable();
  }
};

struct equinoctialElements FLATBUFFERS_FINAL_CLASS : private ::flatbuffers::Table {
  static constexpr ::flatbuffers::voffset_t VT_AF = 4;
  static constexpr ::flatbuffers::voffset_t VT_AG = 6;
  static constexpr ::flatbuffers::voffset_t VT_L = 8;
  static constexpr ::flatbuffers::voffset_t VT_N = 10;
  static constexpr ::flatbuffers::voffset_t VT_CHI = 12;
  static constexpr ::flatbuffers::voffset_t VT_PSI = 14;

  double AF() const {
    return GetField<double>(VT_AF, 0.0);
  }
  double AG() const {
    return GetField<double>(VT_AG, 0.0);
  }
  double L() const {
    return GetField<double>(VT_L, 0.0);
  }
  double N() const {
    return GetField<double>(VT_N, 0.0);
  }
  double CHI() const {
    return GetField<double>(VT_CHI, 0.0);
  }
  double PSI() const {
    return GetField<double>(VT_PSI, 0.0);
  }

  template <bool B = false>
  bool Verify(::flatbuffers::VerifierTemplate<B>& verifier) const {
    return VerifyTableStart(verifier) &&
           VerifyField<double>(verifier, VT_AF, 8) &&
           VerifyField<double>(verifier, VT_AG, 8) &&
           VerifyField<double>(verifier, VT_L, 8) &&
           VerifyField<double>(verifier, VT_N, 8) &&
           VerifyField<double>(verifier, VT_CHI, 8) &&
           VerifyField<double>(verifier, VT_PSI, 8) &&
           verifier.EndTable();
  }
};

struct VCMStateVector FLATBUFFERS_FINAL_CLASS : private ::flatbuffers::Table {
  static constexpr ::flatbuffers::voffset_t VT_EPOCH = 4;
  static constexpr ::flatbuffers::voffset_t VT_X = 6;
  static constexpr ::flatbuffers::voffset_t VT_Y = 8;
  static constexpr ::flatbuffers::voffset_t VT_Z = 10;
  static constexpr ::flatbuffers::voffset_t VT_X_DOT = 12;
  static constexpr ::flatbuffers::voffset_t VT_Y_DOT = 14;
  static constexpr ::flatbuffers::voffset_t VT_Z_DOT = 16;

  const ::flatbuffers::String* EPOCH() const {
    return GetPointer<const ::flatbuffers::String*>(VT_EPOCH);
  }
  double X() const {
    return GetField<double>(VT_X, 0.0);
  }
  double Y() const {
    return GetField<double>(VT_Y, 0.0);
  }
  double Z() const {
    return GetField<double>(VT_Z, 0.0);
  }
  double X_DOT() const {
    return GetField<double>(VT_X_DOT, 0.0);
  }
  double Y_DOT() const {
    return GetField<double>(VT_Y_DOT, 0.0);
  }
  double Z_DOT() const {
    return GetField<double>(VT_Z_DOT, 0.0);
  }

  template <bool B = false>
  bool Verify(::flatbuffers::VerifierTemplate<B>& verifier) const {
    return VerifyTableStart(verifier) &&
           VerifyOffset(verifier, VT_EPOCH) &&
           verifier.VerifyString(EPOCH()) &&
           VerifyField<double>(verifier, VT_X, 8) &&
           VerifyField<double>(verifier, VT_Y, 8) &&
           VerifyField<double>(verifier, VT_Z, 8) &&
           VerifyField<double>(verifier, VT_X_DOT, 8) &&
           VerifyField<double>(verifier, VT_Y_DOT, 8) &&
           VerifyField<double>(verifier, VT_Z_DOT, 8) &&
           verifier.EndTable();
  }
};

struct VCM FLATBUFFERS_FINAL_CLASS : private ::flatbuffers::Table {
  static constexpr ::flatbuffers::voffset_t VT_CCSDS_OMM_VERS = 4;
  static constexpr ::flatbuffers::voffset_t VT_CREATION_DATE = 6;
  static constexpr ::flatbuffers::voffset_t VT_ORIGINATOR = 8;
  static constexpr ::flatbuffers::voffset_t VT_OBJECT_NAME = 10;
  static constexpr ::flatbuffers::voffset_t VT_OBJECT_ID = 12;
  static constexpr ::flatbuffers::voffset_t VT_CENTER_NAME = 14;
  static constexpr ::flatbuffers::voffset_t VT_REF_FRAME = 16;
  static constexpr ::flatbuffers::voffset_t VT_TIME_SYSTEM = 18;
  static constexpr ::flatbuffers::voffset_t VT_STATE_VECTOR = 20;
  static constexpr ::flatbuffers::voffset_t VT_KEPLERIAN_ELEMENTS = 22;
  static constexpr ::flatbuffers::voffset_t VT_EQUINOCTIAL_ELEMENTS = 24;
  static constexpr ::flatbuffers::voffset_t VT_GM = 26;
  static constexpr ::flatbuffers::voffset_t VT_MASS = 34;
  static constexpr ::flatbuffers::voffset_t VT_SOLAR_RAD_AREA = 36;
  static constexpr ::flatbuffers::voffset_t VT_SOLAR_RAD_COEFF = 38;

  double CCSDS_OMM_VERS() const {
    return GetField<double>(VT_CCSDS_OMM_VERS, 2.0);
  }
  const ::flatbuffers::String* CREATION_DATE() const {
    return GetPointer<const ::flatbuffers::String*>(VT_CREATION_DATE);
  }
  const ::flatbuffers::String* ORIGINATOR() const {
    return GetPointer<const ::flatbuffers::String*>(VT_ORIGINATOR);
  }
  const ::flatbuffers::String* OBJECT_NAME() const {
    return GetPointer<const ::flatbuffers::String*>(VT_OBJECT_NAME);
  }
  const ::flatbuffers::String* OBJECT_ID() const {
    return GetPointer<const ::flatbuffers::String*>(VT_OBJECT_ID);
  }
  const ::flatbuffers::String* CENTER_NAME() const {
    return GetPointer<const ::flatbuffers::String*>(VT_CENTER_NAME);
  }
  const ::flatbuffers::String* REF_FRAME() const {
    return GetPointer<const ::flatbuffers::String*>(VT_REF_FRAME);
  }
  const ::flatbuffers::String* TIME_SYSTEM() const {
    return GetPointer<const ::flatbuffers::String*>(VT_TIME_SYSTEM);
  }
  const VCMStateVector* STATE_VECTOR() const {
    return GetPointer<const VCMStateVector*>(VT_STATE_VECTOR);
  }
  const keplerianElements* KEPLERIAN_ELEMENTS() const {
    return GetPointer<const keplerianElements*>(VT_KEPLERIAN_ELEMENTS);
  }
  const equinoctialElements* EQUINOCTIAL_ELEMENTS() const {
    return GetPointer<const equinoctialElements*>(VT_EQUINOCTIAL_ELEMENTS);
  }
  double GM() const {
    return GetField<double>(VT_GM, 0.0);
  }
  double MASS() const {
    return GetField<double>(VT_MASS, 0.0);
  }
  double SOLAR_RAD_AREA() const {
    return GetField<double>(VT_SOLAR_RAD_AREA, 0.0);
  }
  double SOLAR_RAD_COEFF() const {
    return GetField<double>(VT_SOLAR_RAD_COEFF, 0.0);
  }

  template <bool B = false>
  bool Verify(::flatbuffers::VerifierTemplate<B>& verifier) const {
    return VerifyTableStart(verifier) &&
           VerifyField<double>(verifier, VT_CCSDS_OMM_VERS, 8) &&
           VerifyOffset(verifier, VT_CREATION_DATE) &&
           verifier.VerifyString(CREATION_DATE()) &&
           VerifyOffset(verifier, VT_ORIGINATOR) &&
           verifier.VerifyString(ORIGINATOR()) &&
           VerifyOffset(verifier, VT_OBJECT_NAME) &&
           verifier.VerifyString(OBJECT_NAME()) &&
           VerifyOffset(verifier, VT_OBJECT_ID) &&
           verifier.VerifyString(OBJECT_ID()) &&
           VerifyOffset(verifier, VT_CENTER_NAME) &&
           verifier.VerifyString(CENTER_NAME()) &&
           VerifyOffset(verifier, VT_REF_FRAME) &&
           verifier.VerifyString(REF_FRAME()) &&
           VerifyOffset(verifier, VT_TIME_SYSTEM) &&
           verifier.VerifyString(TIME_SYSTEM()) &&
           VerifyOffset(verifier, VT_STATE_VECTOR) &&
           verifier.VerifyTable(STATE_VECTOR()) &&
           VerifyOffset(verifier, VT_KEPLERIAN_ELEMENTS) &&
           verifier.VerifyTable(KEPLERIAN_ELEMENTS()) &&
           VerifyOffset(verifier, VT_EQUINOCTIAL_ELEMENTS) &&
           verifier.VerifyTable(EQUINOCTIAL_ELEMENTS()) &&
           VerifyField<double>(verifier, VT_GM, 8) &&
           VerifyField<double>(verifier, VT_MASS, 8) &&
           VerifyField<double>(verifier, VT_SOLAR_RAD_AREA, 8) &&
           VerifyField<double>(verifier, VT_SOLAR_RAD_COEFF, 8) &&
           verifier.EndTable();
  }
};

struct GRV FLATBUFFERS_FINAL_CLASS : private ::flatbuffers::Table {
  static constexpr ::flatbuffers::voffset_t VT_MODEL_TYPE = 4;
  static constexpr ::flatbuffers::voffset_t VT_MODEL_NAME = 6;
  static constexpr ::flatbuffers::voffset_t VT_CENTRAL_BODY = 8;
  static constexpr ::flatbuffers::voffset_t VT_MAX_DEGREE = 10;
  static constexpr ::flatbuffers::voffset_t VT_MAX_ORDER = 12;
  static constexpr ::flatbuffers::voffset_t VT_INCLUDE_SUN = 14;
  static constexpr ::flatbuffers::voffset_t VT_INCLUDE_MOON = 16;
  static constexpr ::flatbuffers::voffset_t VT_INCLUDE_PLANETS = 18;
  static constexpr ::flatbuffers::voffset_t VT_SOLID_TIDES = 20;
  static constexpr ::flatbuffers::voffset_t VT_OCEAN_TIDES = 22;
  static constexpr ::flatbuffers::voffset_t VT_POLE_TIDES = 24;
  static constexpr ::flatbuffers::voffset_t VT_EQUATORIAL_RADIUS = 26;
  static constexpr ::flatbuffers::voffset_t VT_J2 = 28;
  static constexpr ::flatbuffers::voffset_t VT_MU = 30;
  static constexpr ::flatbuffers::voffset_t VT_J3 = 32;
  static constexpr ::flatbuffers::voffset_t VT_J4 = 34;
  static constexpr ::flatbuffers::voffset_t VT_J5 = 36;
  static constexpr ::flatbuffers::voffset_t VT_J6 = 38;

  uint16_t MAX_DEGREE() const {
    return GetField<uint16_t>(VT_MAX_DEGREE, 70);
  }

  double EQUATORIAL_RADIUS() const {
    return GetField<double>(VT_EQUATORIAL_RADIUS, 0.0);
  }
  double MU() const {
    return GetField<double>(VT_MU, 0.0);
  }
  double J2() const {
    return GetField<double>(VT_J2, 0.0);
  }
  double J3() const {
    return GetField<double>(VT_J3, 0.0);
  }
  double J4() const {
    return GetField<double>(VT_J4, 0.0);
  }
  double J5() const {
    return GetField<double>(VT_J5, 0.0);
  }
  double J6() const {
    return GetField<double>(VT_J6, 0.0);
  }

  template <bool B = false>
  bool Verify(::flatbuffers::VerifierTemplate<B>& verifier) const {
    return VerifyTableStart(verifier) &&
           VerifyField<int8_t>(verifier, VT_MODEL_TYPE, 1) &&
           VerifyField<int8_t>(verifier, VT_MODEL_NAME, 1) &&
           VerifyField<int8_t>(verifier, VT_CENTRAL_BODY, 1) &&
           VerifyField<uint16_t>(verifier, VT_MAX_DEGREE, 2) &&
           VerifyField<uint16_t>(verifier, VT_MAX_ORDER, 2) &&
           VerifyField<uint8_t>(verifier, VT_INCLUDE_SUN, 1) &&
           VerifyField<uint8_t>(verifier, VT_INCLUDE_MOON, 1) &&
           VerifyField<uint8_t>(verifier, VT_INCLUDE_PLANETS, 1) &&
           VerifyField<uint8_t>(verifier, VT_SOLID_TIDES, 1) &&
           VerifyField<uint8_t>(verifier, VT_OCEAN_TIDES, 1) &&
           VerifyField<uint8_t>(verifier, VT_POLE_TIDES, 1) &&
           VerifyField<double>(verifier, VT_EQUATORIAL_RADIUS, 8) &&
           VerifyField<double>(verifier, VT_MU, 8) &&
           VerifyField<double>(verifier, VT_J2, 8) &&
           VerifyField<double>(verifier, VT_J3, 8) &&
           VerifyField<double>(verifier, VT_J4, 8) &&
           VerifyField<double>(verifier, VT_J5, 8) &&
           VerifyField<double>(verifier, VT_J6, 8) &&
           verifier.EndTable();
  }
};

struct CRD FLATBUFFERS_FINAL_CLASS : private ::flatbuffers::Table {
  static constexpr ::flatbuffers::voffset_t VT_X = 4;
  static constexpr ::flatbuffers::voffset_t VT_Y = 6;
  static constexpr ::flatbuffers::voffset_t VT_Z = 8;
  static constexpr ::flatbuffers::voffset_t VT_VX = 10;
  static constexpr ::flatbuffers::voffset_t VT_VY = 12;
  static constexpr ::flatbuffers::voffset_t VT_VZ = 14;
  static constexpr ::flatbuffers::voffset_t VT_FRAME = 16;
  static constexpr ::flatbuffers::voffset_t VT_ELLIPSOID = 18;
  static constexpr ::flatbuffers::voffset_t VT_RESERVED = 20;

  double X() const {
    return GetField<double>(VT_X, 0.0);
  }
  double Y() const {
    return GetField<double>(VT_Y, 0.0);
  }
  double Z() const {
    return GetField<double>(VT_Z, 0.0);
  }

  template <bool B = false>
  bool Verify(::flatbuffers::VerifierTemplate<B>& verifier) const {
    return VerifyTableStart(verifier) &&
           VerifyField<double>(verifier, VT_X, 8) &&
           VerifyField<double>(verifier, VT_Y, 8) &&
           VerifyField<double>(verifier, VT_Z, 8) &&
           VerifyField<double>(verifier, VT_VX, 8) &&
           VerifyField<double>(verifier, VT_VY, 8) &&
           VerifyField<double>(verifier, VT_VZ, 8) &&
           VerifyField<uint8_t>(verifier, VT_FRAME, 1) &&
           VerifyField<uint8_t>(verifier, VT_ELLIPSOID, 1) &&
           verifier.EndTable();
  }
};

struct CDM FLATBUFFERS_FINAL_CLASS : private ::flatbuffers::Table {
  static constexpr ::flatbuffers::voffset_t VT_CCSDS_CDM_VERS = 4;
  static constexpr ::flatbuffers::voffset_t VT_CREATION_DATE = 6;
  static constexpr ::flatbuffers::voffset_t VT_ORIGINATOR = 8;
  static constexpr ::flatbuffers::voffset_t VT_MESSAGE_FOR = 10;
  static constexpr ::flatbuffers::voffset_t VT_MESSAGE_ID = 12;
  static constexpr ::flatbuffers::voffset_t VT_TCA = 14;
  static constexpr ::flatbuffers::voffset_t VT_MISS_DISTANCE = 16;
  static constexpr ::flatbuffers::voffset_t VT_RELATIVE_SPEED = 18;
  static constexpr ::flatbuffers::voffset_t VT_RELATIVE_POSITION_R = 20;
  static constexpr ::flatbuffers::voffset_t VT_RELATIVE_POSITION_T = 22;
  static constexpr ::flatbuffers::voffset_t VT_RELATIVE_POSITION_N = 24;
  static constexpr ::flatbuffers::voffset_t VT_RELATIVE_VELOCITY_R = 26;
  static constexpr ::flatbuffers::voffset_t VT_RELATIVE_VELOCITY_T = 28;
  static constexpr ::flatbuffers::voffset_t VT_RELATIVE_VELOCITY_N = 30;

  const ::flatbuffers::String* CREATION_DATE() const {
    return GetPointer<const ::flatbuffers::String*>(VT_CREATION_DATE);
  }
  const ::flatbuffers::String* ORIGINATOR() const {
    return GetPointer<const ::flatbuffers::String*>(VT_ORIGINATOR);
  }
  const ::flatbuffers::String* MESSAGE_FOR() const {
    return GetPointer<const ::flatbuffers::String*>(VT_MESSAGE_FOR);
  }
  const ::flatbuffers::String* MESSAGE_ID() const {
    return GetPointer<const ::flatbuffers::String*>(VT_MESSAGE_ID);
  }
  const ::flatbuffers::String* TCA() const {
    return GetPointer<const ::flatbuffers::String*>(VT_TCA);
  }
  double MISS_DISTANCE() const {
    return GetField<double>(VT_MISS_DISTANCE, 0.0);
  }
  double RELATIVE_SPEED() const {
    return GetField<double>(VT_RELATIVE_SPEED, 0.0);
  }
  double RELATIVE_POSITION_R() const {
    return GetField<double>(VT_RELATIVE_POSITION_R, 0.0);
  }
  double RELATIVE_POSITION_T() const {
    return GetField<double>(VT_RELATIVE_POSITION_T, 0.0);
  }
  double RELATIVE_POSITION_N() const {
    return GetField<double>(VT_RELATIVE_POSITION_N, 0.0);
  }
  double RELATIVE_VELOCITY_R() const {
    return GetField<double>(VT_RELATIVE_VELOCITY_R, 0.0);
  }
  double RELATIVE_VELOCITY_T() const {
    return GetField<double>(VT_RELATIVE_VELOCITY_T, 0.0);
  }
  double RELATIVE_VELOCITY_N() const {
    return GetField<double>(VT_RELATIVE_VELOCITY_N, 0.0);
  }

  template <bool B = false>
  bool Verify(::flatbuffers::VerifierTemplate<B>& verifier) const {
    return VerifyTableStart(verifier) &&
           VerifyField<double>(verifier, VT_CCSDS_CDM_VERS, 8) &&
           VerifyOffset(verifier, VT_CREATION_DATE) &&
           verifier.VerifyString(CREATION_DATE()) &&
           VerifyOffset(verifier, VT_ORIGINATOR) &&
           verifier.VerifyString(ORIGINATOR()) &&
           VerifyOffset(verifier, VT_MESSAGE_FOR) &&
           verifier.VerifyString(MESSAGE_FOR()) &&
           VerifyOffset(verifier, VT_MESSAGE_ID) &&
           verifier.VerifyString(MESSAGE_ID()) &&
           VerifyOffset(verifier, VT_TCA) &&
           verifier.VerifyString(TCA()) &&
           VerifyField<double>(verifier, VT_MISS_DISTANCE, 8) &&
           VerifyField<double>(verifier, VT_RELATIVE_SPEED, 8) &&
           VerifyField<double>(verifier, VT_RELATIVE_POSITION_R, 8) &&
           VerifyField<double>(verifier, VT_RELATIVE_POSITION_T, 8) &&
           VerifyField<double>(verifier, VT_RELATIVE_POSITION_N, 8) &&
           VerifyField<double>(verifier, VT_RELATIVE_VELOCITY_R, 8) &&
           VerifyField<double>(verifier, VT_RELATIVE_VELOCITY_T, 8) &&
           VerifyField<double>(verifier, VT_RELATIVE_VELOCITY_N, 8) &&
           verifier.EndTable();
  }
};

const OMM* GetOMM(const void* buffer) {
  return ::flatbuffers::GetRoot<OMM>(buffer);
}

bool OMMBufferHasIdentifier(const void* buffer) {
  return ::flatbuffers::BufferHasIdentifier(buffer, "$OMM");
}

bool VerifyOMMBuffer(::flatbuffers::Verifier& verifier) {
  return verifier.VerifyBuffer<OMM>("$OMM");
}

const OEM* GetOEM(const void* buffer) {
  return ::flatbuffers::GetRoot<OEM>(buffer);
}

bool OEMBufferHasIdentifier(const void* buffer) {
  return ::flatbuffers::BufferHasIdentifier(buffer, "$OEM");
}

bool VerifyOEMBuffer(::flatbuffers::Verifier& verifier) {
  return verifier.VerifyBuffer<OEM>("$OEM");
}

const OPM* GetOPM(const void* buffer) {
  return ::flatbuffers::GetRoot<OPM>(buffer);
}

bool OPMBufferHasIdentifier(const void* buffer) {
  return ::flatbuffers::BufferHasIdentifier(buffer, "$OPM");
}

bool VerifyOPMBuffer(::flatbuffers::Verifier& verifier) {
  return verifier.VerifyBuffer<OPM>("$OPM");
}

const VCM* GetVCM(const void* buffer) {
  return ::flatbuffers::GetRoot<VCM>(buffer);
}

bool VerifyVCMBuffer(::flatbuffers::Verifier& verifier) {
  return verifier.VerifyBuffer<VCM>(nullptr);
}

const GRV* GetGRV(const void* buffer) {
  return ::flatbuffers::GetRoot<GRV>(buffer);
}

bool VerifyGRVBuffer(::flatbuffers::Verifier& verifier) {
  return verifier.VerifyBuffer<GRV>("$GRV");
}

const CRD* GetCRD(const void* buffer) {
  return ::flatbuffers::GetRoot<CRD>(buffer);
}

bool VerifyCRDBuffer(::flatbuffers::Verifier& verifier) {
  return verifier.VerifyBuffer<CRD>("$CRD");
}

const CDM* GetCDM(const void* buffer) {
  return ::flatbuffers::GetRoot<CDM>(buffer);
}

bool CDMBufferHasIdentifier(const void* buffer) {
  return ::flatbuffers::BufferHasIdentifier(buffer, "$CDM");
}

bool VerifyCDMBuffer(::flatbuffers::Verifier& verifier) {
  return verifier.VerifyBuffer<CDM>("$CDM");
}

double compute_omm_mean_motion_rev_per_day(double semi_major_axis, double gm) {
  if (!std::isfinite(semi_major_axis) || !std::isfinite(gm) ||
      semi_major_axis <= 0.0 || gm <= 0.0) {
    return 0.0;
  }
  return std::sqrt(gm / (semi_major_axis * semi_major_axis * semi_major_axis)) *
         kSecondsPerDay / kTwoPi;
}

::flatbuffers::Offset<OMM> CreateOMM(
    ::flatbuffers::FlatBufferBuilder& builder,
    ::flatbuffers::Offset<::flatbuffers::String> creation_date,
    ::flatbuffers::Offset<::flatbuffers::String> originator,
    ::flatbuffers::Offset<::flatbuffers::String> object_name,
    ::flatbuffers::Offset<::flatbuffers::String> object_id,
    ::flatbuffers::Offset<::flatbuffers::String> center_name,
    int8_t time_system,
    int8_t mean_element_theory,
    ::flatbuffers::Offset<::flatbuffers::String> comment,
    ::flatbuffers::Offset<::flatbuffers::String> epoch,
    double semi_major_axis,
    double eccentricity,
    double inclination,
    double raan,
    double arg_pericenter,
    double mean_anomaly,
    double gm) {
  const double mean_motion = compute_omm_mean_motion_rev_per_day(semi_major_axis, gm);
  const auto start = builder.StartTable();
  builder.AddElement<double>(OMM::VT_GM, gm, 0.0);
  builder.AddElement<double>(OMM::VT_MEAN_ANOMALY, mean_anomaly, 0.0);
  builder.AddElement<double>(OMM::VT_ARG_OF_PERICENTER, arg_pericenter, 0.0);
  builder.AddElement<double>(OMM::VT_RA_OF_ASC_NODE, raan, 0.0);
  builder.AddElement<double>(OMM::VT_INCLINATION, inclination, 0.0);
  builder.AddElement<double>(OMM::VT_ECCENTRICITY, eccentricity, 0.0);
  builder.AddElement<double>(OMM::VT_MEAN_MOTION, mean_motion, 0.0);
  builder.AddElement<double>(OMM::VT_SEMI_MAJOR_AXIS, semi_major_axis, 0.0);
  builder.AddOffset(OMM::VT_EPOCH, epoch);
  builder.AddOffset(OMM::VT_COMMENT, comment);
  builder.AddElement<int8_t>(OMM::VT_MEAN_ELEMENT_THEORY, mean_element_theory, 0);
  builder.AddElement<int8_t>(OMM::VT_TIME_SYSTEM, time_system, 11);
  builder.AddOffset(OMM::VT_CENTER_NAME, center_name);
  builder.AddOffset(OMM::VT_OBJECT_ID, object_id);
  builder.AddOffset(OMM::VT_OBJECT_NAME, object_name);
  builder.AddOffset(OMM::VT_ORIGINATOR, originator);
  builder.AddOffset(OMM::VT_CREATION_DATE, creation_date);
  builder.AddElement<double>(OMM::VT_CCSDS_OMM_VERS, 2.0, 0.0);
  return ::flatbuffers::Offset<OMM>(builder.EndTable(start));
}

::flatbuffers::Offset<ephemerisDataLine> CreateEphemerisDataLine(
    ::flatbuffers::FlatBufferBuilder& builder,
    ::flatbuffers::Offset<::flatbuffers::String> epoch,
    double x,
    double y,
    double z,
    double x_dot,
    double y_dot,
    double z_dot,
    double x_ddot = 0.0,
    double y_ddot = 0.0,
    double z_ddot = 0.0) {
  const auto start = builder.StartTable();
  builder.AddElement<double>(ephemerisDataLine::VT_Z_DDOT, z_ddot, 0.0);
  builder.AddElement<double>(ephemerisDataLine::VT_Y_DDOT, y_ddot, 0.0);
  builder.AddElement<double>(ephemerisDataLine::VT_X_DDOT, x_ddot, 0.0);
  builder.AddElement<double>(ephemerisDataLine::VT_Z_DOT, z_dot, 0.0);
  builder.AddElement<double>(ephemerisDataLine::VT_Y_DOT, y_dot, 0.0);
  builder.AddElement<double>(ephemerisDataLine::VT_X_DOT, x_dot, 0.0);
  builder.AddElement<double>(ephemerisDataLine::VT_Z, z, 0.0);
  builder.AddElement<double>(ephemerisDataLine::VT_Y, y, 0.0);
  builder.AddElement<double>(ephemerisDataLine::VT_X, x, 0.0);
  builder.AddOffset(ephemerisDataLine::VT_EPOCH, epoch);
  return ::flatbuffers::Offset<ephemerisDataLine>(builder.EndTable(start));
}

::flatbuffers::Offset<ephemerisDataBlock> CreateEphemerisDataBlock(
    ::flatbuffers::FlatBufferBuilder& builder,
    ::flatbuffers::Offset<::flatbuffers::String> comment,
    ::flatbuffers::Offset<::flatbuffers::String> center_name,
    int8_t time_system,
    ::flatbuffers::Offset<::flatbuffers::String> start_time,
    ::flatbuffers::Offset<::flatbuffers::String> stop_time,
    ::flatbuffers::Offset<::flatbuffers::Vector<::flatbuffers::Offset<ephemerisDataLine>>> lines,
    uint8_t state_vector_size = 6) {
  const auto start = builder.StartTable();
  builder.AddOffset(ephemerisDataBlock::VT_EPHEMERIS_DATA_LINES, lines);
  builder.AddElement<uint8_t>(ephemerisDataBlock::VT_STATE_VECTOR_SIZE, state_vector_size, 6);
  builder.AddElement<double>(ephemerisDataBlock::VT_STEP_SIZE, 0.0, 0.0);
  builder.AddOffset(ephemerisDataBlock::VT_STOP_TIME, stop_time);
  builder.AddOffset(ephemerisDataBlock::VT_START_TIME, start_time);
  builder.AddElement<int8_t>(ephemerisDataBlock::VT_TIME_SYSTEM, time_system, 0);
  builder.AddOffset(ephemerisDataBlock::VT_CENTER_NAME, center_name);
  builder.AddOffset(ephemerisDataBlock::VT_COMMENT, comment);
  return ::flatbuffers::Offset<ephemerisDataBlock>(builder.EndTable(start));
}

::flatbuffers::Offset<OEM> CreateOEM(
    ::flatbuffers::FlatBufferBuilder& builder,
    ::flatbuffers::Offset<::flatbuffers::String> classification,
    double version,
    ::flatbuffers::Offset<::flatbuffers::String> creation_date,
    ::flatbuffers::Offset<::flatbuffers::String> originator,
    ::flatbuffers::Offset<::flatbuffers::Vector<::flatbuffers::Offset<ephemerisDataBlock>>> blocks) {
  const auto start = builder.StartTable();
  builder.AddElement<double>(OEM::VT_CCSDS_OEM_VERS, version, 0.0);
  builder.AddOffset(OEM::VT_EPHEMERIS_DATA_BLOCK, blocks);
  builder.AddOffset(OEM::VT_ORIGINATOR, originator);
  builder.AddOffset(OEM::VT_CREATION_DATE, creation_date);
  builder.AddOffset(OEM::VT_CLASSIFICATION, classification);
  return ::flatbuffers::Offset<OEM>(builder.EndTable(start));
}

::flatbuffers::Offset<keplerianElements> CreateVcmKeplerianElements(
    ::flatbuffers::FlatBufferBuilder& builder,
    const keplerianElements* source) {
  const auto start = builder.StartTable();
  if (source != nullptr) {
    builder.AddElement<double>(
        keplerianElements::VT_ANOMALY,
        source->ANOMALY(),
        0.0);
    builder.AddElement<double>(
        keplerianElements::VT_PERIAPSIS_RADIUS,
        source->PERIAPSIS_RADIUS(),
        0.0);
    builder.AddElement<int8_t>(
        keplerianElements::VT_ANOMALY_TYPE,
        source->ANOMALY_TYPE(),
        0);
    builder.AddElement<double>(
        keplerianElements::VT_ARG_OF_PERICENTER,
        source->ARG_OF_PERICENTER(),
        0.0);
    builder.AddElement<double>(
        keplerianElements::VT_RA_OF_ASC_NODE,
        source->RA_OF_ASC_NODE(),
        0.0);
    builder.AddElement<double>(
        keplerianElements::VT_INCLINATION,
        source->INCLINATION(),
        0.0);
    builder.AddElement<double>(
        keplerianElements::VT_ECCENTRICITY,
        source->ECCENTRICITY(),
        0.0);
    builder.AddElement<double>(
        keplerianElements::VT_SEMI_MAJOR_AXIS,
        source->SEMI_MAJOR_AXIS(),
        0.0);
  }
  return ::flatbuffers::Offset<keplerianElements>(builder.EndTable(start));
}

::flatbuffers::Offset<keplerianElements> CreateVcmKeplerianElements(
    ::flatbuffers::FlatBufferBuilder& builder,
    double semi_major_axis,
    double eccentricity,
    double inclination,
    double raan,
    double arg_pericenter,
    int8_t anomaly_type,
    double anomaly,
    double periapsis_radius = 0.0) {
  const auto start = builder.StartTable();
  builder.AddElement<double>(keplerianElements::VT_ANOMALY, anomaly, 0.0);
  builder.AddElement<double>(keplerianElements::VT_PERIAPSIS_RADIUS, periapsis_radius, 0.0);
  builder.AddElement<int8_t>(keplerianElements::VT_ANOMALY_TYPE, anomaly_type, 0);
  builder.AddElement<double>(keplerianElements::VT_ARG_OF_PERICENTER, arg_pericenter, 0.0);
  builder.AddElement<double>(keplerianElements::VT_RA_OF_ASC_NODE, raan, 0.0);
  builder.AddElement<double>(keplerianElements::VT_INCLINATION, inclination, 0.0);
  builder.AddElement<double>(keplerianElements::VT_ECCENTRICITY, eccentricity, 0.0);
  builder.AddElement<double>(keplerianElements::VT_SEMI_MAJOR_AXIS, semi_major_axis, 0.0);
  return ::flatbuffers::Offset<keplerianElements>(builder.EndTable(start));
}

::flatbuffers::Offset<equinoctialElements> CreateEquinoctialElements(
    ::flatbuffers::FlatBufferBuilder& builder,
    double af,
    double ag,
    double true_longitude,
    double semi_major_axis,
    double chi,
    double psi) {
  const auto start = builder.StartTable();
  builder.AddElement<double>(equinoctialElements::VT_PSI, psi, 0.0);
  builder.AddElement<double>(equinoctialElements::VT_CHI, chi, 0.0);
  builder.AddElement<double>(equinoctialElements::VT_N, semi_major_axis, 0.0);
  builder.AddElement<double>(equinoctialElements::VT_L, true_longitude, 0.0);
  builder.AddElement<double>(equinoctialElements::VT_AG, ag, 0.0);
  builder.AddElement<double>(equinoctialElements::VT_AF, af, 0.0);
  return ::flatbuffers::Offset<equinoctialElements>(builder.EndTable(start));
}

::flatbuffers::Offset<equinoctialElements> CreateEquinoctialElements(
    ::flatbuffers::FlatBufferBuilder& builder,
    const equinoctialElements* source) {
  if (source == nullptr) {
    return 0;
  }
  return CreateEquinoctialElements(
      builder,
      source->AF(),
      source->AG(),
      source->L(),
      source->N(),
      source->CHI(),
      source->PSI());
}

::flatbuffers::Offset<VCMStateVector> CreateVCMStateVector(
    ::flatbuffers::FlatBufferBuilder& builder,
    ::flatbuffers::Offset<::flatbuffers::String> epoch,
    double x,
    double y,
    double z,
    double x_dot,
    double y_dot,
    double z_dot) {
  const auto start = builder.StartTable();
  builder.AddElement<double>(VCMStateVector::VT_Z_DOT, z_dot, 0.0);
  builder.AddElement<double>(VCMStateVector::VT_Y_DOT, y_dot, 0.0);
  builder.AddElement<double>(VCMStateVector::VT_X_DOT, x_dot, 0.0);
  builder.AddElement<double>(VCMStateVector::VT_Z, z, 0.0);
  builder.AddElement<double>(VCMStateVector::VT_Y, y, 0.0);
  builder.AddElement<double>(VCMStateVector::VT_X, x, 0.0);
  builder.AddOffset(VCMStateVector::VT_EPOCH, epoch);
  return ::flatbuffers::Offset<VCMStateVector>(builder.EndTable(start));
}

::flatbuffers::Offset<VCMStateVector> CreateVCMStateVector(
    ::flatbuffers::FlatBufferBuilder& builder,
    const VCMStateVector* source) {
  if (source == nullptr) {
    return 0;
  }
  return CreateVCMStateVector(
      builder,
      source->EPOCH() != nullptr ? builder.CreateString(source->EPOCH()->c_str()) : 0,
      source->X(),
      source->Y(),
      source->Z(),
      source->X_DOT(),
      source->Y_DOT(),
      source->Z_DOT());
}

::flatbuffers::Offset<VCM> CreateVCM(
    ::flatbuffers::FlatBufferBuilder& builder,
    double version,
    ::flatbuffers::Offset<::flatbuffers::String> creation_date,
    ::flatbuffers::Offset<::flatbuffers::String> originator,
    ::flatbuffers::Offset<::flatbuffers::String> object_name,
    ::flatbuffers::Offset<::flatbuffers::String> object_id,
    ::flatbuffers::Offset<::flatbuffers::String> center_name,
    ::flatbuffers::Offset<::flatbuffers::String> ref_frame,
    ::flatbuffers::Offset<::flatbuffers::String> time_system,
    ::flatbuffers::Offset<VCMStateVector> state_vector,
    ::flatbuffers::Offset<keplerianElements> keplerian_elements,
    ::flatbuffers::Offset<equinoctialElements> equinoctial_elements,
    double gm) {
  const auto start = builder.StartTable();
  builder.AddElement<double>(VCM::VT_GM, gm, 0.0);
  builder.AddOffset(VCM::VT_EQUINOCTIAL_ELEMENTS, equinoctial_elements);
  builder.AddOffset(VCM::VT_KEPLERIAN_ELEMENTS, keplerian_elements);
  builder.AddOffset(VCM::VT_STATE_VECTOR, state_vector);
  builder.AddOffset(VCM::VT_TIME_SYSTEM, time_system);
  builder.AddOffset(VCM::VT_REF_FRAME, ref_frame);
  builder.AddOffset(VCM::VT_CENTER_NAME, center_name);
  builder.AddOffset(VCM::VT_OBJECT_ID, object_id);
  builder.AddOffset(VCM::VT_OBJECT_NAME, object_name);
  builder.AddOffset(VCM::VT_ORIGINATOR, originator);
  builder.AddOffset(VCM::VT_CREATION_DATE, creation_date);
  builder.AddElement<double>(VCM::VT_CCSDS_OMM_VERS, version, 0.0);
  return ::flatbuffers::Offset<VCM>(builder.EndTable(start));
}

::flatbuffers::Offset<CDM> CreateCDMRelativeState(
    ::flatbuffers::FlatBufferBuilder& builder,
    ::flatbuffers::Offset<::flatbuffers::String> creation_date,
    ::flatbuffers::Offset<::flatbuffers::String> originator,
    ::flatbuffers::Offset<::flatbuffers::String> message_for,
    ::flatbuffers::Offset<::flatbuffers::String> message_id,
    ::flatbuffers::Offset<::flatbuffers::String> tca,
    double miss_distance,
    double relative_speed,
    double relative_position_r,
    double relative_position_t,
    double relative_position_n,
    double relative_velocity_r,
    double relative_velocity_t,
    double relative_velocity_n) {
  const auto start = builder.StartTable();
  builder.AddElement<double>(CDM::VT_RELATIVE_VELOCITY_N, relative_velocity_n, 0.0);
  builder.AddElement<double>(CDM::VT_RELATIVE_VELOCITY_T, relative_velocity_t, 0.0);
  builder.AddElement<double>(CDM::VT_RELATIVE_VELOCITY_R, relative_velocity_r, 0.0);
  builder.AddElement<double>(CDM::VT_RELATIVE_POSITION_N, relative_position_n, 0.0);
  builder.AddElement<double>(CDM::VT_RELATIVE_POSITION_T, relative_position_t, 0.0);
  builder.AddElement<double>(CDM::VT_RELATIVE_POSITION_R, relative_position_r, 0.0);
  builder.AddElement<double>(CDM::VT_RELATIVE_SPEED, relative_speed, 0.0);
  builder.AddElement<double>(CDM::VT_MISS_DISTANCE, miss_distance, 0.0);
  builder.AddOffset(CDM::VT_TCA, tca);
  builder.AddOffset(CDM::VT_MESSAGE_ID, message_id);
  builder.AddOffset(CDM::VT_MESSAGE_FOR, message_for);
  builder.AddOffset(CDM::VT_ORIGINATOR, originator);
  builder.AddOffset(CDM::VT_CREATION_DATE, creation_date);
  builder.AddElement<double>(CDM::VT_CCSDS_CDM_VERS, 2.0, 0.0);
  return ::flatbuffers::Offset<CDM>(builder.EndTable(start));
}

struct CartesianState {
  double x = 0.0;
  double y = 0.0;
  double z = 0.0;
  double x_dot = 0.0;
  double y_dot = 0.0;
  double z_dot = 0.0;
};

struct Vector3 {
  double x = 0.0;
  double y = 0.0;
  double z = 0.0;
};

struct KeplerianElements {
  double semi_major_axis = 0.0;
  double eccentricity = 0.0;
  double inclination = 0.0;
  double raan = 0.0;
  double arg_pericenter = 0.0;
  double mean_anomaly = 0.0;
  double gm = 0.0;
  double periapsis_radius = 0.0;
};

struct EquinoctialElements {
  double af = 0.0;
  double ag = 0.0;
  double true_longitude = 0.0;
  double semi_major_axis = 0.0;
  double chi = 0.0;
  double psi = 0.0;
};

struct VcmKeplerianElements {
  double semi_major_axis = 0.0;
  double eccentricity = 0.0;
  double inclination = 0.0;
  double raan = 0.0;
  double arg_pericenter = 0.0;
  double anomaly = 0.0;
  double periapsis_radius = 0.0;
  int8_t anomaly_type = 0;
};

struct OemMetadata {
  const char* epoch = nullptr;
  const char* center_name = nullptr;
  int8_t time_system = 11;
};

struct RelativeHillState {
  Vector3 position;
  Vector3 velocity;
  double miss_distance = 0.0;
  double relative_speed = 0.0;
};

bool solve_eccentric_anomaly(double mean_anomaly, double eccentricity, double* eccentric_anomaly) {
  if (eccentric_anomaly == nullptr || eccentricity < 0.0 || eccentricity >= 1.0) {
    return false;
  }

  double anomaly = std::fmod(mean_anomaly, 2.0 * kPi);
  if (anomaly > kPi) {
    anomaly -= 2.0 * kPi;
  } else if (anomaly < -kPi) {
    anomaly += 2.0 * kPi;
  }

  double estimate = eccentricity < 0.8 ? anomaly : (anomaly >= 0.0 ? kPi : -kPi);
  for (int iteration = 0; iteration < 50; ++iteration) {
    const double f = estimate - eccentricity * std::sin(estimate) - anomaly;
    const double fp = 1.0 - eccentricity * std::cos(estimate);
    if (fp == 0.0) {
      return false;
    }
    const double delta = f / fp;
    estimate -= delta;
    if (std::abs(delta) <= 1e-14) {
      *eccentric_anomaly = estimate;
      return true;
    }
  }

  *eccentric_anomaly = estimate;
  return std::abs(estimate - eccentricity * std::sin(estimate) - anomaly) <= 1e-12;
}

bool solve_hyperbolic_anomaly(double mean_anomaly, double eccentricity, double* hyperbolic_anomaly) {
  if (hyperbolic_anomaly == nullptr || eccentricity <= 1.0 || !finite(mean_anomaly)) {
    return false;
  }

  double estimate = std::asinh(mean_anomaly / eccentricity);
  for (int iteration = 0; iteration < 60; ++iteration) {
    const double f = eccentricity * std::sinh(estimate) - estimate - mean_anomaly;
    const double fp = eccentricity * std::cosh(estimate) - 1.0;
    if (fp == 0.0 || !finite(f) || !finite(fp)) {
      return false;
    }
    const double delta = f / fp;
    estimate -= delta;
    if (std::abs(delta) <= 1e-14) {
      *hyperbolic_anomaly = estimate;
      return true;
    }
  }

  *hyperbolic_anomaly = estimate;
  return std::abs(eccentricity * std::sinh(estimate) - estimate - mean_anomaly) <= 1e-12;
}

bool finite(double value) {
  return std::isfinite(value);
}

double dot(const Vector3& lhs, const Vector3& rhs) {
  return lhs.x * rhs.x + lhs.y * rhs.y + lhs.z * rhs.z;
}

Vector3 cross(const Vector3& lhs, const Vector3& rhs) {
  return {
      lhs.y * rhs.z - lhs.z * rhs.y,
      lhs.z * rhs.x - lhs.x * rhs.z,
      lhs.x * rhs.y - lhs.y * rhs.x,
  };
}

Vector3 scale(const Vector3& value, double factor) {
  return {value.x * factor, value.y * factor, value.z * factor};
}

Vector3 add(const Vector3& lhs, const Vector3& rhs) {
  return {lhs.x + rhs.x, lhs.y + rhs.y, lhs.z + rhs.z};
}

Vector3 subtract(const Vector3& lhs, const Vector3& rhs) {
  return {lhs.x - rhs.x, lhs.y - rhs.y, lhs.z - rhs.z};
}

double norm(const Vector3& value) {
  return std::sqrt(dot(value, value));
}

Vector3 position_vector(const CartesianState& state) {
  return {state.x, state.y, state.z};
}

Vector3 velocity_vector(const CartesianState& state) {
  return {state.x_dot, state.y_dot, state.z_dot};
}

bool compute_hill_relative_state(
    const CartesianState& chief,
    const CartesianState& deputy,
    RelativeHillState* relative) {
  if (relative == nullptr) {
    return false;
  }

  const Vector3 rc = position_vector(chief);
  const Vector3 vc = velocity_vector(chief);
  const Vector3 rd = position_vector(deputy);
  const Vector3 vd = velocity_vector(deputy);
  const double rc_norm = norm(rc);
  const Vector3 h = cross(rc, vc);
  const double h_norm = norm(h);
  if (!(rc_norm > kSmall) || !(h_norm > kSmall) ||
      !finite(rc_norm) || !finite(h_norm)) {
    return false;
  }

  const Vector3 radial = scale(rc, 1.0 / rc_norm);
  const Vector3 normal = scale(h, 1.0 / h_norm);
  const Vector3 transverse = cross(normal, radial);
  const Vector3 rho_inertial = subtract(rd, rc);
  const Vector3 rho_dot_inertial = subtract(vd, vc);
  const Vector3 rho_hill = {
      dot(radial, rho_inertial),
      dot(transverse, rho_inertial),
      dot(normal, rho_inertial),
  };
  const Vector3 rho_dot_hill = {
      dot(radial, rho_dot_inertial),
      dot(transverse, rho_dot_inertial),
      dot(normal, rho_dot_inertial),
  };
  const double true_anomaly_rate = h_norm / (rc_norm * rc_norm);
  const Vector3 omega_cross_rho = {
      -true_anomaly_rate * rho_hill.y,
      true_anomaly_rate * rho_hill.x,
      0.0,
  };

  relative->position = rho_hill;
  relative->velocity = subtract(rho_dot_hill, omega_cross_rho);
  relative->miss_distance = norm(relative->position);
  relative->relative_speed = norm(relative->velocity);

  return finite(relative->position.x) && finite(relative->position.y) &&
         finite(relative->position.z) && finite(relative->velocity.x) &&
         finite(relative->velocity.y) && finite(relative->velocity.z) &&
         finite(relative->miss_distance) && finite(relative->relative_speed);
}

Vector3 hill_to_inertial(
    const Vector3& radial,
    const Vector3& transverse,
    const Vector3& normal,
    const Vector3& hill_vector) {
  return add(
      add(scale(radial, hill_vector.x), scale(transverse, hill_vector.y)),
      scale(normal, hill_vector.z));
}

bool compute_deputy_from_hill_relative_state(
    const CartesianState& chief,
    const RelativeHillState& relative,
    CartesianState* deputy) {
  if (deputy == nullptr) {
    return false;
  }

  const Vector3 rc = position_vector(chief);
  const Vector3 vc = velocity_vector(chief);
  const double rc_norm = norm(rc);
  const Vector3 h = cross(rc, vc);
  const double h_norm = norm(h);
  if (!(rc_norm > kSmall) || !(h_norm > kSmall) ||
      !finite(rc_norm) || !finite(h_norm)) {
    return false;
  }

  const Vector3 radial = scale(rc, 1.0 / rc_norm);
  const Vector3 normal = scale(h, 1.0 / h_norm);
  const Vector3 transverse = cross(normal, radial);
  const double true_anomaly_rate = h_norm / (rc_norm * rc_norm);
  const Vector3 omega_cross_rho = {
      -true_anomaly_rate * relative.position.y,
      true_anomaly_rate * relative.position.x,
      0.0,
  };
  const Vector3 rho_dot_hill = add(relative.velocity, omega_cross_rho);
  const Vector3 rho_inertial = hill_to_inertial(radial, transverse, normal, relative.position);
  const Vector3 rho_dot_inertial = hill_to_inertial(radial, transverse, normal, rho_dot_hill);
  const Vector3 rd = add(rc, rho_inertial);
  const Vector3 vd = add(vc, rho_dot_inertial);

  deputy->x = rd.x;
  deputy->y = rd.y;
  deputy->z = rd.z;
  deputy->x_dot = vd.x;
  deputy->y_dot = vd.y;
  deputy->z_dot = vd.z;

  return finite(deputy->x) && finite(deputy->y) && finite(deputy->z) &&
         finite(deputy->x_dot) && finite(deputy->y_dot) && finite(deputy->z_dot);
}

double clamp_unit(double value) {
  if (value > 1.0) {
    return 1.0;
  }
  if (value < -1.0) {
    return -1.0;
  }
  return value;
}

double normalize_radians(double value) {
  double normalized = std::fmod(value, kTwoPi);
  if (normalized < 0.0) {
    normalized += kTwoPi;
  }
  return normalized;
}

double normalize_degrees(double radians) {
  double degrees = normalize_radians(radians) * kRadiansToDegrees;
  if (degrees >= 360.0) {
    degrees -= 360.0;
  }
  return degrees;
}

bool convert_rectilinear_anomaly_values_to_cartesian(
    double semi_major_axis,
    double eccentricity,
    double inclination,
    double raan,
    double arg_pericenter,
    double anomaly,
    double gm,
    CartesianState* state) {
  // Basilisk's e == 1 rectilinear elem2rv branch treats f as the source
  // eccentric/hyperbolic anomaly and constrains motion to the periapsis axis.
  if (state == nullptr || !finite(semi_major_axis) || !finite(eccentricity) ||
      !finite(inclination) || !finite(raan) || !finite(arg_pericenter) ||
      !finite(anomaly) || !finite(gm) || gm <= 0.0 ||
      std::abs(eccentricity - 1.0) > kSingularOrbitTolerance ||
      std::abs(semi_major_axis) <= kSmall) {
    return false;
  }

  const double radius = semi_major_axis > 0.0
                            ? semi_major_axis * (1.0 - eccentricity * std::cos(anomaly))
                            : semi_major_axis * (1.0 - eccentricity * std::cosh(anomaly));
  if (!(radius > 0.0) || !finite(radius)) {
    return false;
  }

  const double velocity_squared = 2.0 * gm / radius - gm / semi_major_axis;
  if (!(velocity_squared > 0.0) || !finite(velocity_squared)) {
    return false;
  }

  const double cos_raan = std::cos(raan);
  const double sin_raan = std::sin(raan);
  const double cos_i = std::cos(inclination);
  const double sin_i = std::sin(inclination);
  const double cos_argp = std::cos(arg_pericenter);
  const double sin_argp = std::sin(arg_pericenter);
  const Vector3 direction = {
      cos_raan * cos_argp - sin_raan * sin_argp * cos_i,
      sin_raan * cos_argp + cos_raan * sin_argp * cos_i,
      sin_argp * sin_i,
  };
  const double velocity_sign = std::sin(anomaly) > 0.0 ? 1.0 : -1.0;
  const double velocity_magnitude = std::sqrt(velocity_squared);

  state->x = radius * direction.x;
  state->y = radius * direction.y;
  state->z = radius * direction.z;
  state->x_dot = velocity_sign * velocity_magnitude * direction.x;
  state->y_dot = velocity_sign * velocity_magnitude * direction.y;
  state->z_dot = velocity_sign * velocity_magnitude * direction.z;

  return finite(state->x) && finite(state->y) && finite(state->z) &&
         finite(state->x_dot) && finite(state->y_dot) && finite(state->z_dot);
}

bool convert_parabolic_true_anomaly_values_to_cartesian(
    double periapsis_radius,
    double eccentricity,
    double inclination,
    double raan,
    double arg_pericenter,
    double true_anomaly,
    double gm,
    CartesianState* state) {
  if (state == nullptr || !finite(periapsis_radius) || !finite(eccentricity) ||
      !finite(inclination) || !finite(raan) || !finite(arg_pericenter) ||
      !finite(true_anomaly) || !finite(gm) || periapsis_radius <= 0.0 ||
      gm <= 0.0 || std::abs(eccentricity - 1.0) > kSingularOrbitTolerance) {
    return false;
  }

  const double parameter = 2.0 * periapsis_radius;
  const double cos_true_anomaly = std::cos(true_anomaly);
  const double sin_true_anomaly = std::sin(true_anomaly);
  const double denominator = 1.0 + cos_true_anomaly;
  if (!(parameter > 0.0) || !(denominator > kSmall)) {
    return false;
  }

  const double radius = parameter / denominator;
  const double velocity_factor = std::sqrt(gm / parameter);
  if (!(radius > 0.0) || !finite(radius) || !finite(velocity_factor)) {
    return false;
  }

  const double x_orbital = radius * cos_true_anomaly;
  const double y_orbital = radius * sin_true_anomaly;
  const double x_dot_orbital = -velocity_factor * sin_true_anomaly;
  const double y_dot_orbital = velocity_factor * (1.0 + cos_true_anomaly);

  const double cos_raan = std::cos(raan);
  const double sin_raan = std::sin(raan);
  const double cos_i = std::cos(inclination);
  const double sin_i = std::sin(inclination);
  const double cos_argp = std::cos(arg_pericenter);
  const double sin_argp = std::sin(arg_pericenter);

  const double m11 = cos_raan * cos_argp - sin_raan * sin_argp * cos_i;
  const double m12 = -cos_raan * sin_argp - sin_raan * cos_argp * cos_i;
  const double m21 = sin_raan * cos_argp + cos_raan * sin_argp * cos_i;
  const double m22 = -sin_raan * sin_argp + cos_raan * cos_argp * cos_i;
  const double m31 = sin_argp * sin_i;
  const double m32 = cos_argp * sin_i;

  state->x = m11 * x_orbital + m12 * y_orbital;
  state->y = m21 * x_orbital + m22 * y_orbital;
  state->z = m31 * x_orbital + m32 * y_orbital;
  state->x_dot = m11 * x_dot_orbital + m12 * y_dot_orbital;
  state->y_dot = m21 * x_dot_orbital + m22 * y_dot_orbital;
  state->z_dot = m31 * x_dot_orbital + m32 * y_dot_orbital;

  return finite(state->x) && finite(state->y) && finite(state->z) &&
         finite(state->x_dot) && finite(state->y_dot) && finite(state->z_dot);
}

bool convert_keplerian_values_to_cartesian(
    double semi_major_axis,
    double eccentricity,
    double inclination,
    double raan,
    double arg_pericenter,
    double mean_anomaly,
    double gm,
    CartesianState* state);

bool convert_keplerian_to_cartesian(const OMM* omm, CartesianState* state) {
  if (omm == nullptr) {
    return false;
  }
  return convert_keplerian_values_to_cartesian(
      omm->SEMI_MAJOR_AXIS(),
      omm->ECCENTRICITY(),
      omm->INCLINATION() * kDegreesToRadians,
      omm->RA_OF_ASC_NODE() * kDegreesToRadians,
      omm->ARG_OF_PERICENTER() * kDegreesToRadians,
      omm->MEAN_ANOMALY() * kDegreesToRadians,
      omm->GM(),
      state);
}

bool convert_keplerian_values_to_cartesian(
    double semi_major_axis,
    double eccentricity,
    double inclination,
    double raan,
    double arg_pericenter,
    double mean_anomaly,
    double gm,
    CartesianState* state) {
  if (state == nullptr) {
    return false;
  }
  if (!finite(semi_major_axis) || !finite(eccentricity) || !finite(inclination) ||
      !finite(raan) || !finite(arg_pericenter) || !finite(mean_anomaly) ||
      !finite(gm) || eccentricity < 0.0 || gm <= 0.0) {
    return false;
  }

  const bool elliptical = eccentricity < 1.0;
  const bool hyperbolic = eccentricity > 1.0;
  if ((!elliptical && !hyperbolic) ||
      (elliptical && !(semi_major_axis > 0.0)) ||
      (hyperbolic && !(semi_major_axis < 0.0))) {
    return false;
  }

  double x_orbital = 0.0;
  double y_orbital = 0.0;
  double x_dot_orbital = 0.0;
  double y_dot_orbital = 0.0;

  if (elliptical) {
    double eccentric_anomaly = 0.0;
    if (!solve_eccentric_anomaly(mean_anomaly, eccentricity, &eccentric_anomaly)) {
      return false;
    }

    const double cos_e = std::cos(eccentric_anomaly);
    const double sin_e = std::sin(eccentric_anomaly);
    const double beta = std::sqrt(1.0 - eccentricity * eccentricity);
    const double radius = semi_major_axis * (1.0 - eccentricity * cos_e);
    if (!(radius > 0.0)) {
      return false;
    }

    x_orbital = semi_major_axis * (cos_e - eccentricity);
    y_orbital = semi_major_axis * beta * sin_e;
    const double velocity_factor = std::sqrt(gm * semi_major_axis) / radius;
    x_dot_orbital = -velocity_factor * sin_e;
    y_dot_orbital = velocity_factor * beta * cos_e;
  } else {
    double hyperbolic_anomaly = 0.0;
    if (!solve_hyperbolic_anomaly(mean_anomaly, eccentricity, &hyperbolic_anomaly)) {
      return false;
    }

    const double cosh_h = std::cosh(hyperbolic_anomaly);
    const double sinh_h = std::sinh(hyperbolic_anomaly);
    const double beta = std::sqrt(eccentricity * eccentricity - 1.0);
    const double denominator = eccentricity * cosh_h - 1.0;
    if (!(denominator > 0.0)) {
      return false;
    }

    x_orbital = semi_major_axis * (cosh_h - eccentricity);
    y_orbital = -semi_major_axis * beta * sinh_h;
    const double velocity_factor = std::sqrt(gm / (-semi_major_axis)) / denominator;
    x_dot_orbital = -velocity_factor * sinh_h;
    y_dot_orbital = velocity_factor * beta * cosh_h;
  }

  const double cos_raan = std::cos(raan);
  const double sin_raan = std::sin(raan);
  const double cos_i = std::cos(inclination);
  const double sin_i = std::sin(inclination);
  const double cos_argp = std::cos(arg_pericenter);
  const double sin_argp = std::sin(arg_pericenter);

  const double m11 = cos_raan * cos_argp - sin_raan * sin_argp * cos_i;
  const double m12 = -cos_raan * sin_argp - sin_raan * cos_argp * cos_i;
  const double m21 = sin_raan * cos_argp + cos_raan * sin_argp * cos_i;
  const double m22 = -sin_raan * sin_argp + cos_raan * cos_argp * cos_i;
  const double m31 = sin_argp * sin_i;
  const double m32 = cos_argp * sin_i;

  state->x = m11 * x_orbital + m12 * y_orbital;
  state->y = m21 * x_orbital + m22 * y_orbital;
  state->z = m31 * x_orbital + m32 * y_orbital;
  state->x_dot = m11 * x_dot_orbital + m12 * y_dot_orbital;
  state->y_dot = m21 * x_dot_orbital + m22 * y_dot_orbital;
  state->z_dot = m31 * x_dot_orbital + m32 * y_dot_orbital;

  return finite(state->x) && finite(state->y) && finite(state->z) &&
         finite(state->x_dot) && finite(state->y_dot) && finite(state->z_dot);
}

bool mean_anomaly_from_true_anomaly(
    double true_anomaly,
    double eccentricity,
    double* mean_anomaly) {
  if (mean_anomaly == nullptr || !finite(true_anomaly) || !finite(eccentricity) ||
      eccentricity < 0.0) {
    return false;
  }

  if (eccentricity < 1.0) {
    const double eccentric_anomaly = 2.0 * std::atan2(
        std::sqrt(1.0 - eccentricity) * std::sin(true_anomaly / 2.0),
        std::sqrt(1.0 + eccentricity) * std::cos(true_anomaly / 2.0));
    *mean_anomaly = normalize_radians(eccentric_anomaly - eccentricity * std::sin(eccentric_anomaly));
    return finite(*mean_anomaly);
  }

  if (std::abs(eccentricity - 1.0) <= kSingularOrbitTolerance) {
    const double parabolic_parameter = std::tan(true_anomaly / 2.0);
    if (!finite(parabolic_parameter)) {
      return false;
    }
    *mean_anomaly =
        parabolic_parameter + parabolic_parameter * parabolic_parameter *
                                  parabolic_parameter / 3.0;
    return finite(*mean_anomaly);
  }

  if (eccentricity > 1.0) {
    const double tanh_half_h = std::sqrt((eccentricity - 1.0) / (eccentricity + 1.0)) *
                               std::tan(true_anomaly / 2.0);
    if (!finite(tanh_half_h) || std::abs(tanh_half_h) >= 1.0) {
      return false;
    }
    const double hyperbolic_anomaly = 2.0 * std::atanh(tanh_half_h);
    *mean_anomaly = eccentricity * std::sinh(hyperbolic_anomaly) - hyperbolic_anomaly;
    return finite(*mean_anomaly);
  }

  return false;
}

bool true_anomaly_from_parabolic_mean_anomaly(
    double mean_anomaly,
    double* true_anomaly) {
  if (true_anomaly == nullptr || !finite(mean_anomaly)) {
    return false;
  }

  const double scaled_mean = 1.5 * mean_anomaly;
  const double root = std::sqrt(scaled_mean * scaled_mean + 1.0);
  const double parabolic_parameter =
      std::cbrt(scaled_mean + root) + std::cbrt(scaled_mean - root);
  if (!finite(parabolic_parameter)) {
    return false;
  }

  *true_anomaly = 2.0 * std::atan(parabolic_parameter);
  return finite(*true_anomaly);
}

bool true_anomaly_from_mean_anomaly(
    double mean_anomaly,
    double eccentricity,
    double* true_anomaly) {
  if (true_anomaly == nullptr || !finite(mean_anomaly) || !finite(eccentricity) ||
      eccentricity < 0.0) {
    return false;
  }

  if (eccentricity < 1.0) {
    double eccentric_anomaly = 0.0;
    if (!solve_eccentric_anomaly(mean_anomaly, eccentricity, &eccentric_anomaly)) {
      return false;
    }
    *true_anomaly = normalize_radians(2.0 * std::atan2(
        std::sqrt(1.0 + eccentricity) * std::sin(eccentric_anomaly / 2.0),
        std::sqrt(1.0 - eccentricity) * std::cos(eccentric_anomaly / 2.0)));
    return finite(*true_anomaly);
  }

  if (std::abs(eccentricity - 1.0) <= kSingularOrbitTolerance) {
    return true_anomaly_from_parabolic_mean_anomaly(mean_anomaly, true_anomaly);
  }

  if (eccentricity > 1.0) {
    double hyperbolic_anomaly = 0.0;
    if (!solve_hyperbolic_anomaly(mean_anomaly, eccentricity, &hyperbolic_anomaly)) {
      return false;
    }
    *true_anomaly = 2.0 * std::atan(
        std::sqrt((eccentricity + 1.0) / (eccentricity - 1.0)) *
        std::tanh(hyperbolic_anomaly / 2.0));
    return finite(*true_anomaly);
  }

  return false;
}

bool convert_opm_keplerian_to_elements(const OPM* opm, KeplerianElements* elements) {
  if (opm == nullptr || elements == nullptr) {
    return false;
  }

  double mean_anomaly = 0.0;
  if (!mean_anomaly_from_true_anomaly(
          opm->TRUE_ANOMALY() * kDegreesToRadians,
          opm->ECCENTRICITY(),
          &mean_anomaly)) {
    return false;
  }

  elements->semi_major_axis = opm->SEMI_MAJOR_AXIS();
  elements->eccentricity = opm->ECCENTRICITY();
  elements->inclination = opm->INCLINATION();
  elements->raan = normalize_degrees(opm->RA_OF_ASC_NODE() * kDegreesToRadians);
  elements->arg_pericenter = normalize_degrees(opm->ARG_OF_PERICENTER() * kDegreesToRadians);
  elements->mean_anomaly = mean_anomaly * kRadiansToDegrees;
  elements->gm = opm->GM();

  return finite(elements->semi_major_axis) && finite(elements->eccentricity) &&
         finite(elements->inclination) && finite(elements->raan) &&
         finite(elements->arg_pericenter) && finite(elements->mean_anomaly) &&
         finite(elements->gm) && elements->eccentricity >= 0.0 && elements->gm > 0.0;
}

bool convert_opm_keplerian_to_cartesian(const OPM* opm, CartesianState* state) {
  KeplerianElements elements;
  if (!convert_opm_keplerian_to_elements(opm, &elements)) {
    return false;
  }

  return convert_keplerian_values_to_cartesian(
      elements.semi_major_axis,
      elements.eccentricity,
      elements.inclination * kDegreesToRadians,
      elements.raan * kDegreesToRadians,
      elements.arg_pericenter * kDegreesToRadians,
      elements.mean_anomaly * kDegreesToRadians,
      elements.gm,
      state);
}

bool convert_cartesian_to_keplerian(
    const CartesianState& state,
    double gm,
    KeplerianElements* elements,
    bool allow_parabolic = false) {
  if (elements == nullptr || !finite(gm) || gm <= 0.0) {
    return false;
  }

  const Vector3 position = {state.x, state.y, state.z};
  const Vector3 velocity = {state.x_dot, state.y_dot, state.z_dot};
  const double position_norm = norm(position);
  const double velocity_squared = dot(velocity, velocity);
  if (!(position_norm > 0.0) || !finite(position_norm) || !finite(velocity_squared)) {
    return false;
  }

  const Vector3 angular_momentum = cross(position, velocity);
  const double angular_momentum_norm = norm(angular_momentum);
  if (!(angular_momentum_norm > kSmall)) {
    return false;
  }

  const Vector3 node = {-angular_momentum.y, angular_momentum.x, 0.0};
  const double node_norm = norm(node);
  const Vector3 eccentricity_vector = subtract(
      scale(position, (velocity_squared - gm / position_norm) / gm),
      scale(velocity, dot(position, velocity) / gm));
  const double eccentricity = norm(eccentricity_vector);
  if (!finite(eccentricity)) {
    return false;
  }

  const double specific_energy = 0.5 * velocity_squared - gm / position_norm;
  const bool hyperbolic = eccentricity > 1.0 + kSingularOrbitTolerance;
  const bool parabolic = std::abs(eccentricity - 1.0) <= kSingularOrbitTolerance;
  if ((parabolic && !allow_parabolic) ||
      (hyperbolic && !(specific_energy > 0.0)) ||
      (!hyperbolic && !parabolic && !(specific_energy < 0.0))) {
    return false;
  }
  double semi_major_axis = 0.0;
  if (!parabolic) {
    semi_major_axis = -gm / (2.0 * specific_energy);
    if (!finite(semi_major_axis) ||
        (hyperbolic && !(semi_major_axis < 0.0)) ||
        (!hyperbolic && !(semi_major_axis > 0.0))) {
      return false;
    }
  }

  const double inclination = std::acos(clamp_unit(angular_momentum.z / angular_momentum_norm));
  const bool circular = !hyperbolic && eccentricity <= kSingularOrbitTolerance;
  const bool equatorial = node_norm <= kSingularOrbitTolerance;

  double raan = 0.0;
  double arg_pericenter = 0.0;
  double mean_anomaly = 0.0;

  if (!equatorial) {
    raan = normalize_radians(std::atan2(node.y, node.x));
  }

  if (!circular) {
    if (!equatorial) {
      const double arg_pericenter_cos =
          clamp_unit(dot(node, eccentricity_vector) / (node_norm * eccentricity));
      const double arg_pericenter_sin =
          dot(cross(node, eccentricity_vector), angular_momentum) /
          (node_norm * eccentricity * angular_momentum_norm);
      arg_pericenter = normalize_radians(std::atan2(arg_pericenter_sin, arg_pericenter_cos));
    } else {
      arg_pericenter = normalize_radians(std::atan2(eccentricity_vector.y, eccentricity_vector.x));
    }

    const double true_anomaly_cos =
        clamp_unit(dot(eccentricity_vector, position) / (eccentricity * position_norm));
    const double true_anomaly_sin =
        dot(cross(eccentricity_vector, position), angular_momentum) /
        (eccentricity * position_norm * angular_momentum_norm);
    const double true_anomaly = std::atan2(true_anomaly_sin, true_anomaly_cos);
    const double anomaly_denominator = 1.0 + eccentricity * std::cos(true_anomaly);
    if (std::abs(anomaly_denominator) <= kSmall) {
      return false;
    }
    if (parabolic) {
      mean_anomaly = true_anomaly;
    } else if (hyperbolic) {
      const double tanh_argument =
          std::sqrt(eccentricity * eccentricity - 1.0) * std::sin(true_anomaly) /
          (eccentricity + std::cos(true_anomaly));
      if (std::abs(tanh_argument) >= 1.0) {
        return false;
      }
      const double hyperbolic_anomaly = std::atanh(tanh_argument);
      mean_anomaly = eccentricity * std::sinh(hyperbolic_anomaly) - hyperbolic_anomaly;
    } else {
      const double normalized_true_anomaly = normalize_radians(true_anomaly);
      const double eccentric_anomaly = std::atan2(
          std::sqrt(1.0 - eccentricity * eccentricity) * std::sin(normalized_true_anomaly) / anomaly_denominator,
          (eccentricity + std::cos(normalized_true_anomaly)) / anomaly_denominator);
      mean_anomaly = normalize_radians(
          eccentric_anomaly - eccentricity * std::sin(eccentric_anomaly));
    }
  } else if (!equatorial) {
    const double argument_of_latitude_cos = clamp_unit(dot(node, position) / (node_norm * position_norm));
    const double argument_of_latitude_sin =
        dot(cross(node, position), angular_momentum) /
        (node_norm * position_norm * angular_momentum_norm);
    mean_anomaly = normalize_radians(std::atan2(argument_of_latitude_sin, argument_of_latitude_cos));
  } else {
    mean_anomaly = angular_momentum.z >= 0.0
                       ? normalize_radians(std::atan2(position.y, position.x))
                       : normalize_radians(std::atan2(-position.y, position.x));
  }

  elements->semi_major_axis = parabolic ? 0.0 : semi_major_axis;
  elements->eccentricity = parabolic ? 1.0 : (circular ? 0.0 : eccentricity);
  elements->inclination = normalize_degrees(inclination);
  elements->raan = normalize_degrees(raan);
  elements->arg_pericenter = normalize_degrees(arg_pericenter);
  elements->mean_anomaly =
      (hyperbolic || parabolic) ? mean_anomaly * kRadiansToDegrees : normalize_degrees(mean_anomaly);
  elements->gm = gm;
  elements->periapsis_radius =
      finite(angular_momentum_norm) && angular_momentum_norm > 0.0
          ? (angular_momentum_norm * angular_momentum_norm / gm) /
                (1.0 + elements->eccentricity)
          : 0.0;

  return finite(elements->semi_major_axis) && finite(elements->eccentricity) &&
         finite(elements->inclination) && finite(elements->raan) &&
         finite(elements->arg_pericenter) && finite(elements->mean_anomaly);
}

bool normalize_parabolic_recovered_elements_to_omm(KeplerianElements* elements) {
  if (elements == nullptr) {
    return false;
  }
  const bool parabolic =
      std::abs(elements->eccentricity - 1.0) <= kSingularOrbitTolerance &&
      std::abs(elements->semi_major_axis) <= kSingularOrbitTolerance;
  if (!parabolic) {
    return true;
  }

  double mean_anomaly = 0.0;
  if (!mean_anomaly_from_true_anomaly(
          elements->mean_anomaly * kDegreesToRadians,
          elements->eccentricity,
          &mean_anomaly)) {
    return false;
  }
  elements->semi_major_axis = 0.0;
  elements->eccentricity = 1.0;
  elements->mean_anomaly = mean_anomaly * kRadiansToDegrees;
  return finite(elements->mean_anomaly);
}

bool vcm_true_anomaly_from_anomaly(
    double anomaly,
    double eccentricity,
    int8_t anomaly_type,
    double* true_anomaly) {
  if (true_anomaly == nullptr || !finite(anomaly) || !finite(eccentricity)) {
    return false;
  }
  if (anomaly_type == 0) {
    *true_anomaly = anomaly;
    return true;
  }
  if (anomaly_type != 1 || eccentricity < 0.0 || eccentricity >= 1.0) {
    return false;
  }

  double eccentric_anomaly = 0.0;
  if (!solve_eccentric_anomaly(anomaly, eccentricity, &eccentric_anomaly)) {
    return false;
  }

  *true_anomaly = 2.0 * std::atan2(
      std::sqrt(1.0 + eccentricity) * std::sin(eccentric_anomaly / 2.0),
      std::sqrt(1.0 - eccentricity) * std::cos(eccentric_anomaly / 2.0));
  return finite(*true_anomaly);
}

bool vcm_mean_anomaly_from_anomaly(
    double anomaly,
    double eccentricity,
    int8_t anomaly_type,
    double* mean_anomaly) {
  if (mean_anomaly == nullptr || !finite(anomaly) || !finite(eccentricity) ||
      eccentricity < 0.0) {
    return false;
  }
  if (anomaly_type == 1) {
    *mean_anomaly = eccentricity < 1.0 ? normalize_radians(anomaly) : anomaly;
    return finite(*mean_anomaly);
  }
  if (anomaly_type != 0) {
    return false;
  }
  return mean_anomaly_from_true_anomaly(anomaly, eccentricity, mean_anomaly);
}

bool eccentric_anomaly_from_true_anomaly(
    double true_anomaly,
    double eccentricity,
    double* eccentric_anomaly) {
  if (eccentric_anomaly == nullptr || !finite(true_anomaly) || !finite(eccentricity) ||
      eccentricity < 0.0 || eccentricity >= 1.0) {
    return false;
  }
  *eccentric_anomaly = 2.0 * std::atan2(
      std::sqrt(1.0 - eccentricity) * std::sin(true_anomaly / 2.0),
      std::sqrt(1.0 + eccentricity) * std::cos(true_anomaly / 2.0));
  return finite(*eccentric_anomaly);
}

bool true_anomaly_from_eccentric_anomaly(
    double eccentric_anomaly,
    double eccentricity,
    double* true_anomaly) {
  if (true_anomaly == nullptr || !finite(eccentric_anomaly) || !finite(eccentricity) ||
      eccentricity < 0.0 || eccentricity >= 1.0) {
    return false;
  }
  *true_anomaly = 2.0 * std::atan2(
      std::sqrt(1.0 + eccentricity) * std::sin(eccentric_anomaly / 2.0),
      std::sqrt(1.0 - eccentricity) * std::cos(eccentric_anomaly / 2.0));
  return finite(*true_anomaly);
}

bool convert_vcm_keplerian_to_cartesian(const VCM* vcm, CartesianState* state) {
  if (vcm == nullptr || state == nullptr) {
    return false;
  }
  const keplerianElements* source = vcm->KEPLERIAN_ELEMENTS();
  if (source == nullptr) {
    return false;
  }

  const double semi_major_axis = source->SEMI_MAJOR_AXIS();
  const double eccentricity = source->ECCENTRICITY();
  const double inclination = source->INCLINATION() * kDegreesToRadians;
  const double raan = source->RA_OF_ASC_NODE() * kDegreesToRadians;
  const double arg_pericenter = source->ARG_OF_PERICENTER() * kDegreesToRadians;
  const double anomaly = source->ANOMALY() * kDegreesToRadians;
  const double periapsis_radius = source->PERIAPSIS_RADIUS();
  const double gm = vcm->GM();

  if (source->ANOMALY_TYPE() == 0 &&
      std::abs(eccentricity - 1.0) <= kSingularOrbitTolerance &&
      std::abs(semi_major_axis) > kSmall) {
    return convert_rectilinear_anomaly_values_to_cartesian(
        semi_major_axis,
        eccentricity,
        inclination,
        raan,
        arg_pericenter,
        anomaly,
        gm,
        state);
  }

  if (source->ANOMALY_TYPE() == 0 &&
      std::abs(eccentricity - 1.0) <= kSingularOrbitTolerance &&
      std::abs(semi_major_axis) <= kSmall) {
    return convert_parabolic_true_anomaly_values_to_cartesian(
        periapsis_radius,
        eccentricity,
        inclination,
        raan,
        arg_pericenter,
        anomaly,
        gm,
        state);
  }

  if (source->ANOMALY_TYPE() == 1 &&
      std::abs(eccentricity - 1.0) <= kSingularOrbitTolerance &&
      std::abs(semi_major_axis) <= kSmall) {
    double true_anomaly = 0.0;
    if (!true_anomaly_from_parabolic_mean_anomaly(anomaly, &true_anomaly)) {
      return false;
    }
    return convert_parabolic_true_anomaly_values_to_cartesian(
        periapsis_radius,
        eccentricity,
        inclination,
        raan,
        arg_pericenter,
        true_anomaly,
        gm,
        state);
  }

  double mean_anomaly = 0.0;
  if (!vcm_mean_anomaly_from_anomaly(
          anomaly,
          eccentricity,
          source->ANOMALY_TYPE(),
          &mean_anomaly)) {
    return false;
  }

  return convert_keplerian_values_to_cartesian(
      semi_major_axis,
      eccentricity,
      inclination,
      raan,
      arg_pericenter,
      mean_anomaly,
      gm,
      state);
}

bool convert_vcm_keplerian_values_to_equinoctial(
    const VcmKeplerianElements& source,
    EquinoctialElements* elements) {
  if (elements == nullptr) {
    return false;
  }

  const double semi_major_axis = source.semi_major_axis;
  const double eccentricity = source.eccentricity;
  const double inclination = source.inclination * kDegreesToRadians;
  const double raan = source.raan * kDegreesToRadians;
  const double arg_pericenter = source.arg_pericenter * kDegreesToRadians;
  const double anomaly = source.anomaly * kDegreesToRadians;
  const int8_t anomaly_type = source.anomaly_type;

  if (!finite(semi_major_axis) || !finite(eccentricity) || !finite(inclination) ||
      !finite(raan) || !finite(arg_pericenter) || !finite(anomaly) ||
      !(semi_major_axis > 0.0) || eccentricity < 0.0 || eccentricity >= 1.0) {
    return false;
  }

  double true_anomaly = 0.0;
  if (!vcm_true_anomaly_from_anomaly(anomaly, eccentricity, anomaly_type, &true_anomaly)) {
    return false;
  }

  const double node_pericenter_sum = raan + arg_pericenter;
  const double tan_half_inclination = std::tan(inclination / 2.0);
  elements->af = eccentricity * std::cos(node_pericenter_sum);
  elements->ag = eccentricity * std::sin(node_pericenter_sum);
  elements->true_longitude = normalize_degrees(node_pericenter_sum + true_anomaly);
  elements->semi_major_axis = semi_major_axis;
  elements->chi = tan_half_inclination * std::sin(raan);
  elements->psi = tan_half_inclination * std::cos(raan);

  return finite(elements->af) && finite(elements->ag) &&
         finite(elements->true_longitude) && finite(elements->semi_major_axis) &&
         finite(elements->chi) && finite(elements->psi);
}

bool convert_vcm_keplerian_to_equinoctial(
    const keplerianElements* source,
    EquinoctialElements* elements) {
  if (source == nullptr) {
    return false;
  }

  VcmKeplerianElements values;
  values.semi_major_axis = source->SEMI_MAJOR_AXIS();
  values.eccentricity = source->ECCENTRICITY();
  values.inclination = source->INCLINATION();
  values.raan = source->RA_OF_ASC_NODE();
  values.arg_pericenter = source->ARG_OF_PERICENTER();
  values.anomaly = source->ANOMALY();
  values.periapsis_radius = source->PERIAPSIS_RADIUS();
  values.anomaly_type = source->ANOMALY_TYPE();

  return convert_vcm_keplerian_values_to_equinoctial(values, elements);
}

bool convert_vcm_keplerian_mean_osc_map(
    const keplerianElements* source,
    const GRV* gravity,
    double direction_sign,
    VcmKeplerianElements* elements) {
  if (source == nullptr || gravity == nullptr || elements == nullptr) {
    return false;
  }
  if (direction_sign != 1.0 && direction_sign != -1.0) {
    return false;
  }

  const double a = source->SEMI_MAJOR_AXIS();
  const double e = source->ECCENTRICITY();
  const double i = source->INCLINATION() * kDegreesToRadians;
  const double Omega = source->RA_OF_ASC_NODE() * kDegreesToRadians;
  const double omega = source->ARG_OF_PERICENTER() * kDegreesToRadians;
  const double anomaly = source->ANOMALY() * kDegreesToRadians;
  const double req = gravity->EQUATORIAL_RADIUS();
  const double J2 = gravity->J2();

  if (!finite(a) || !finite(e) || !finite(i) || !finite(Omega) || !finite(omega) ||
      !finite(anomaly) || !finite(req) || !finite(J2) || !(a > 0.0) ||
      !(req > 0.0) || e < 0.0 || e >= 1.0) {
    return false;
  }

  double f = 0.0;
  if (!vcm_true_anomaly_from_anomaly(anomaly, e, source->ANOMALY_TYPE(), &f)) {
    return false;
  }

  double E = 0.0;
  if (!eccentric_anomaly_from_true_anomaly(f, e, &E)) {
    return false;
  }
  const double M = E - e * std::sin(E);

  const double cos_i = std::cos(i);
  const double sin_i = std::sin(i);
  const double tan_i = std::tan(i);
  const double cos_i2 = cos_i * cos_i;
  const double cos_i4 = cos_i2 * cos_i2;
  const double cos_i6 = cos_i4 * cos_i2;
  const double critical_denom = 1.0 - 5.0 * cos_i2;
  const double e2 = e * e;
  const double eta2 = 1.0 - e2;
  if (!(eta2 > 0.0) || std::abs(tan_i) <= kSmall ||
      std::abs(critical_denom) <= kSmall) {
    return false;
  }

  const double eta = std::sqrt(eta2);
  const double gamma2 = direction_sign * J2 / 2.0 * std::pow(req / a, 2.0);
  const double gamma2p = gamma2 / std::pow(eta, 4.0);
  const double cos_f = std::cos(f);
  const double sin_f = std::sin(f);
  const double a_r = (1.0 + e * cos_f) / eta2;
  const double a_r3 = std::pow(a_r, 3.0);
  const double eta3 = std::pow(eta, 3.0);
  const double eta6 = std::pow(eta, 6.0);
  const double two_omega = 2.0 * omega;
  const double two_omega_two_f = two_omega + 2.0 * f;
  const double two_omega_f = two_omega + f;
  const double two_omega_three_f = two_omega + 3.0 * f;
  const double sin_i2 = 1.0 - cos_i2;
  const double cos_2omega = std::cos(two_omega);
  const double sin_2omega = std::sin(two_omega);

  const double ap = a + a * gamma2 *
      ((3.0 * cos_i2 - 1.0) * (a_r3 - 1.0 / eta3) +
       3.0 * sin_i2 * a_r3 * std::cos(two_omega_two_f));

  const double de1 = gamma2p / 8.0 * e * eta2 *
      (1.0 - 11.0 * cos_i2 - 40.0 * cos_i4 / critical_denom) *
      cos_2omega;

  const double de = de1 + eta2 / 2.0 *
      (gamma2 *
           ((3.0 * cos_i2 - 1.0) / eta6 *
                (e * eta + e / (1.0 + eta) + 3.0 * cos_f +
                 3.0 * e * cos_f * cos_f + e2 * cos_f * cos_f * cos_f) +
            3.0 * sin_i2 / eta6 *
                (e + 3.0 * cos_f + 3.0 * e * cos_f * cos_f +
                 e2 * cos_f * cos_f * cos_f) *
                std::cos(two_omega_two_f)) -
       gamma2p * sin_i2 *
           (3.0 * std::cos(two_omega_f) + std::cos(two_omega_three_f)));

  const double di = -e * de1 / eta2 / tan_i +
      gamma2p / 2.0 * cos_i * sin_i *
          (3.0 * std::cos(two_omega_two_f) + 3.0 * e * std::cos(two_omega_f) +
           e * std::cos(two_omega_three_f));

  const double f_minus_m_plus_e_sin_f = f - M + e * sin_f;
  const double MpopOp = M + omega + Omega +
      gamma2p / 8.0 * eta3 *
          (1.0 - 11.0 * cos_i2 - 40.0 * cos_i4 / critical_denom) *
          sin_2omega -
      gamma2p / 16.0 *
          (2.0 + e2 - 11.0 * (2.0 + 3.0 * e2) * cos_i2 -
           40.0 * (2.0 + 5.0 * e2) * cos_i4 / critical_denom -
           400.0 * e2 * cos_i6 / (critical_denom * critical_denom)) *
          sin_2omega +
      gamma2p / 4.0 *
          (-6.0 * (1.0 - 5.0 * cos_i2) * f_minus_m_plus_e_sin_f +
           (3.0 - 5.0 * cos_i2) *
               (3.0 * std::sin(two_omega_two_f) +
                3.0 * e * std::sin(two_omega_f) +
                e * std::sin(two_omega_three_f))) -
      gamma2p / 8.0 * e2 * cos_i *
          (11.0 + 80.0 * cos_i2 / critical_denom +
           200.0 * cos_i4 / (critical_denom * critical_denom)) *
          sin_2omega -
      gamma2p / 2.0 * cos_i *
          (6.0 * f_minus_m_plus_e_sin_f -
           3.0 * std::sin(two_omega_two_f) -
           3.0 * e * std::sin(two_omega_f) -
           e * std::sin(two_omega_three_f));

  const double edM = gamma2p / 8.0 * e * eta3 *
          (1.0 - 11.0 * cos_i2 - 40.0 * cos_i4 / critical_denom) *
          sin_2omega -
      gamma2p / 4.0 * eta3 *
          (2.0 * (3.0 * cos_i2 - 1.0) *
               (std::pow(a_r * eta, 2.0) + a_r + 1.0) * sin_f +
           3.0 * sin_i2 *
               ((-std::pow(a_r * eta, 2.0) - a_r + 1.0) *
                    std::sin(two_omega_f) +
                (std::pow(a_r * eta, 2.0) + a_r + 1.0 / 3.0) *
                    std::sin(two_omega_three_f)));

  const double dOmega = -gamma2p / 8.0 * e2 * cos_i *
          (11.0 + 80.0 * cos_i2 / critical_denom +
           200.0 * cos_i4 / (critical_denom * critical_denom)) *
          sin_2omega -
      gamma2p / 2.0 * cos_i *
          (6.0 * f_minus_m_plus_e_sin_f -
           3.0 * std::sin(two_omega_two_f) -
           3.0 * e * std::sin(two_omega_f) -
           e * std::sin(two_omega_three_f));

  const double d1 = (e + de) * std::sin(M) + edM * std::cos(M);
  const double d2 = (e + de) * std::cos(M) - edM * std::sin(M);
  const double Mp = std::atan2(d1, d2);
  const double ep = std::sqrt(d1 * d1 + d2 * d2);
  if (!finite(ep) || ep < 0.0 || ep >= 1.0) {
    return false;
  }

  const double d3 = (std::sin(i / 2.0) + std::cos(i / 2.0) * di / 2.0) *
          std::sin(Omega) +
      std::sin(i / 2.0) * dOmega * std::cos(Omega);
  const double d4 = (std::sin(i / 2.0) + std::cos(i / 2.0) * di / 2.0) *
          std::cos(Omega) -
      std::sin(i / 2.0) * dOmega * std::sin(Omega);
  const double Omegap = std::atan2(d3, d4);
  const double ip = 2.0 * std::asin(clamp_unit(std::sqrt(d3 * d3 + d4 * d4)));
  const double omegap = MpopOp - Mp - Omegap;

  double Ep = 0.0;
  if (!solve_eccentric_anomaly(Mp, ep, &Ep)) {
    return false;
  }
  double fp = 0.0;
  if (!true_anomaly_from_eccentric_anomaly(Ep, ep, &fp)) {
    return false;
  }

  elements->semi_major_axis = ap;
  elements->eccentricity = ep;
  elements->inclination = normalize_degrees(ip);
  elements->raan = normalize_degrees(Omegap);
  elements->arg_pericenter = normalize_degrees(omegap);
  elements->anomaly = normalize_degrees(fp);
  elements->periapsis_radius = 0.0;
  elements->anomaly_type = 0;

  return finite(elements->semi_major_axis) && finite(elements->eccentricity) &&
         finite(elements->inclination) && finite(elements->raan) &&
         finite(elements->arg_pericenter) && finite(elements->anomaly);
}

bool convert_vcm_keplerian_mean_to_osculating(
    const keplerianElements* source,
    const GRV* gravity,
    VcmKeplerianElements* elements) {
  return convert_vcm_keplerian_mean_osc_map(source, gravity, 1.0, elements);
}

bool convert_vcm_keplerian_osculating_to_mean(
    const keplerianElements* source,
    const GRV* gravity,
    VcmKeplerianElements* elements) {
  return convert_vcm_keplerian_mean_osc_map(source, gravity, -1.0, elements);
}

bool compute_j_zonal_perturbation_acceleration(
    const CartesianState& state,
    const GRV* gravity,
    Vector3* acceleration) {
  if (gravity == nullptr || acceleration == nullptr) {
    return false;
  }

  const int declared_degree = static_cast<int>(gravity->MAX_DEGREE());
  const int order = declared_degree > 6 ? 6 : declared_degree;
  const double mu = gravity->MU();
  const double req = gravity->EQUATORIAL_RADIUS();
  const double j2 = gravity->J2();
  const double j3 = gravity->J3();
  const double j4 = gravity->J4();
  const double j5 = gravity->J5();
  const double j6 = gravity->J6();

  if (order < 2 || !finite(state.x) || !finite(state.y) || !finite(state.z) ||
      !finite(mu) || !finite(req) || !finite(j2) ||
      (order >= 3 && !finite(j3)) || (order >= 4 && !finite(j4)) ||
      (order >= 5 && !finite(j5)) || (order >= 6 && !finite(j6)) ||
      !(mu > 0.0) || !(req > 0.0)) {
    return false;
  }

  const double r = std::sqrt(state.x * state.x + state.y * state.y + state.z * state.z);
  if (!finite(r) || !(r > kSmall)) {
    return false;
  }

  const double inv_r = 1.0 / r;
  const double xr = state.x * inv_r;
  const double yr = state.y * inv_r;
  const double zr = state.z * inv_r;
  const double z2 = zr * zr;
  const double z3 = z2 * zr;
  const double z4 = z2 * z2;
  const double z5 = z4 * zr;
  const double z6 = z3 * z3;
  const double req_r = req * inv_r;
  const double mu_r2 = mu / (r * r);
  Vector3 total;

  if (order >= 2) {
    const double scale = -1.5 * j2 * mu_r2 * std::pow(req_r, 2.0);
    total.x += scale * (1.0 - 5.0 * z2) * xr;
    total.y += scale * (1.0 - 5.0 * z2) * yr;
    total.z += scale * (3.0 - 5.0 * z2) * zr;
  }
  if (order >= 3) {
    const double scale = 0.5 * j3 * mu_r2 * std::pow(req_r, 3.0);
    total.x += scale * 5.0 * (7.0 * z3 - 3.0 * zr) * xr;
    total.y += scale * 5.0 * (7.0 * z3 - 3.0 * zr) * yr;
    total.z += scale * -3.0 * (10.0 * z2 - (35.0 / 3.0) * z4 - 1.0);
  }
  if (order >= 4) {
    const double scale = 5.0 / 8.0 * j4 * mu_r2 * std::pow(req_r, 4.0);
    total.x += scale * (3.0 - 42.0 * z2 + 63.0 * z4) * xr;
    total.y += scale * (3.0 - 42.0 * z2 + 63.0 * z4) * yr;
    total.z += scale * (15.0 - 70.0 * z2 + 63.0 * z4) * zr;
  }
  if (order >= 5) {
    const double scale = 1.0 / 8.0 * j5 * mu_r2 * std::pow(req_r, 5.0);
    total.x += scale * 3.0 * (35.0 * zr - 210.0 * z3 + 231.0 * z5) * xr;
    total.y += scale * 3.0 * (35.0 * zr - 210.0 * z3 + 231.0 * z5) * yr;
    total.z += scale * -(15.0 - 315.0 * z2 + 945.0 * z4 - 693.0 * z6);
  }
  if (order >= 6) {
    const double scale = -1.0 / 16.0 * j6 * mu_r2 * std::pow(req_r, 6.0);
    total.x += scale * (35.0 - 945.0 * z2 + 3465.0 * z4 - 3003.0 * z6) * xr;
    total.y += scale * (35.0 - 945.0 * z2 + 3465.0 * z4 - 3003.0 * z6) * yr;
    total.z += scale * -(3003.0 * z6 - 4851.0 * z4 + 2205.0 * z2 - 245.0) * zr;
  }

  if (!finite(total.x) || !finite(total.y) || !finite(total.z)) {
    return false;
  }

  *acceleration = total;
  return true;
}

bool compute_solar_radiation_pressure_acceleration(
    const VCM* vcm,
    const CRD* sun_vector,
    Vector3* acceleration) {
  if (vcm == nullptr || sun_vector == nullptr || acceleration == nullptr) {
    return false;
  }

  const double area = vcm->SOLAR_RAD_AREA();
  const double mass = vcm->MASS();
  const double coefficient = vcm->SOLAR_RAD_COEFF();
  const Vector3 sun = {
      sun_vector->X(),
      sun_vector->Y(),
      sun_vector->Z(),
  };
  const double sun_distance = norm(sun);

  if (!finite(area) || !finite(mass) || !finite(coefficient) ||
      !finite(sun.x) || !finite(sun.y) || !finite(sun.z) ||
      !(area > 0.0) || !(mass > 0.0) || !(coefficient > 0.0) ||
      !finite(sun_distance) || !(sun_distance > kSmall)) {
    return false;
  }

  const double acceleration_scale =
      (-coefficient * area * kBasiliskSolarFlux) /
      (mass * kSpeedOfLightMetersPerSecond * std::pow(sun_distance, 3.0)) /
      1000.0;

  *acceleration = scale(sun, acceleration_scale);
  return finite(acceleration->x) && finite(acceleration->y) &&
         finite(acceleration->z);
}

bool convert_vcm_equinoctial_to_keplerian(
    const equinoctialElements* source,
    VcmKeplerianElements* elements) {
  if (source == nullptr || elements == nullptr) {
    return false;
  }

  const double af = source->AF();
  const double ag = source->AG();
  const double true_longitude = source->L() * kDegreesToRadians;
  const double semi_major_axis = source->N();
  const double chi = source->CHI();
  const double psi = source->PSI();

  if (!finite(af) || !finite(ag) || !finite(true_longitude) ||
      !finite(semi_major_axis) || !finite(chi) || !finite(psi) ||
      !(semi_major_axis > 0.0)) {
    return false;
  }

  const double eccentricity = std::hypot(af, ag);
  if (!finite(eccentricity) || eccentricity >= 1.0) {
    return false;
  }

  const double tan_half_inclination = std::hypot(chi, psi);
  const double inclination = 2.0 * std::atan(tan_half_inclination);
  const double raan = tan_half_inclination <= kSingularOrbitTolerance
                          ? 0.0
                          : normalize_radians(std::atan2(chi, psi));
  double arg_pericenter = 0.0;
  double true_anomaly = 0.0;

  if (eccentricity <= kSingularOrbitTolerance) {
    true_anomaly = normalize_radians(true_longitude - raan);
  } else {
    const double node_pericenter_sum = normalize_radians(std::atan2(ag, af));
    arg_pericenter = normalize_radians(node_pericenter_sum - raan);
    true_anomaly = normalize_radians(true_longitude - node_pericenter_sum);
  }

  elements->semi_major_axis = semi_major_axis;
  elements->eccentricity = eccentricity <= kSingularOrbitTolerance ? 0.0 : eccentricity;
  elements->inclination = normalize_degrees(inclination);
  elements->raan = normalize_degrees(raan);
  elements->arg_pericenter = normalize_degrees(arg_pericenter);
  elements->anomaly = normalize_degrees(true_anomaly);
  elements->anomaly_type = 0;

  return finite(elements->semi_major_axis) && finite(elements->eccentricity) &&
         finite(elements->inclination) && finite(elements->raan) &&
         finite(elements->arg_pericenter) && finite(elements->anomaly);
}

bool read_vcm_keplerian_elements(
    const keplerianElements* source,
    VcmKeplerianElements* elements) {
  if (source == nullptr || elements == nullptr) {
    return false;
  }

  elements->semi_major_axis = source->SEMI_MAJOR_AXIS();
  elements->eccentricity = source->ECCENTRICITY();
  elements->inclination = source->INCLINATION();
  elements->raan = source->RA_OF_ASC_NODE();
  elements->arg_pericenter = source->ARG_OF_PERICENTER();
  elements->anomaly = source->ANOMALY();
  elements->periapsis_radius = source->PERIAPSIS_RADIUS();
  elements->anomaly_type = source->ANOMALY_TYPE();

  return finite(elements->semi_major_axis) && finite(elements->eccentricity) &&
         finite(elements->inclination) && finite(elements->raan) &&
         finite(elements->arg_pericenter) && finite(elements->anomaly) &&
         finite(elements->periapsis_radius) &&
         (elements->anomaly_type == 0 || elements->anomaly_type == 1);
}

bool vcm_keplerian_shape_supports_anomaly_conversion(
    const VcmKeplerianElements& source) {
  return (source.semi_major_axis > 0.0 &&
          source.eccentricity >= 0.0 &&
          source.eccentricity < 1.0) ||
         (source.semi_major_axis < 0.0 &&
          source.eccentricity > 1.0) ||
         (std::abs(source.semi_major_axis) <= kSmall &&
          std::abs(source.eccentricity - 1.0) <= kSingularOrbitTolerance &&
          source.periapsis_radius > 0.0);
}

bool normalize_vcm_keplerian_to_mean_anomaly(
    const VcmKeplerianElements& source,
    VcmKeplerianElements* elements) {
  if (elements == nullptr || !vcm_keplerian_shape_supports_anomaly_conversion(source)) {
    return false;
  }

  double mean_anomaly = 0.0;
  if (!vcm_mean_anomaly_from_anomaly(
          source.anomaly * kDegreesToRadians,
          source.eccentricity,
          source.anomaly_type,
          &mean_anomaly)) {
    return false;
  }

  *elements = source;
  elements->anomaly_type = 1;
  elements->anomaly = source.eccentricity < 1.0
                          ? normalize_degrees(mean_anomaly)
                          : mean_anomaly * kRadiansToDegrees;
  return finite(elements->anomaly);
}

bool normalize_vcm_keplerian_to_true_anomaly(
    const VcmKeplerianElements& source,
    VcmKeplerianElements* elements) {
  if (elements == nullptr || !vcm_keplerian_shape_supports_anomaly_conversion(source)) {
    return false;
  }

  double true_anomaly = 0.0;
  if (source.anomaly_type == 0) {
    true_anomaly = source.anomaly * kDegreesToRadians;
  } else if (source.anomaly_type == 1) {
    if (!true_anomaly_from_mean_anomaly(
            source.anomaly * kDegreesToRadians,
            source.eccentricity,
            &true_anomaly)) {
      return false;
    }
  } else {
    return false;
  }

  *elements = source;
  elements->anomaly_type = 0;
  elements->anomaly = source.eccentricity < 1.0
                          ? normalize_degrees(true_anomaly)
                          : true_anomaly * kRadiansToDegrees;
  return finite(elements->anomaly);
}

bool convert_vcm_keplerian_elements_to_omm(
    const VcmKeplerianElements& source,
    double gm,
    KeplerianElements* elements) {
  if (elements == nullptr || !finite(gm) || gm <= 0.0) {
    return false;
  }
  const bool parabolic =
      std::abs(source.semi_major_axis) <= kSmall &&
      std::abs(source.eccentricity - 1.0) <= kSingularOrbitTolerance &&
      source.periapsis_radius > 0.0;

  double mean_anomaly = 0.0;
  if (!vcm_mean_anomaly_from_anomaly(
          source.anomaly * kDegreesToRadians,
          source.eccentricity,
          source.anomaly_type,
          &mean_anomaly)) {
    return false;
  }

  elements->semi_major_axis = parabolic ? 0.0 : source.semi_major_axis;
  elements->eccentricity = parabolic ? 1.0 : source.eccentricity;
  elements->inclination = source.inclination;
  elements->raan = normalize_degrees(source.raan * kDegreesToRadians);
  elements->arg_pericenter = normalize_degrees(source.arg_pericenter * kDegreesToRadians);
  elements->mean_anomaly = mean_anomaly * kRadiansToDegrees;
  elements->gm = gm;

  return finite(elements->semi_major_axis) && finite(elements->eccentricity) &&
         finite(elements->inclination) && finite(elements->raan) &&
         finite(elements->arg_pericenter) && finite(elements->mean_anomaly) &&
         finite(elements->gm) &&
         ((elements->semi_major_axis > 0.0 &&
           elements->eccentricity >= 0.0 &&
           elements->eccentricity < 1.0) ||
          (elements->semi_major_axis < 0.0 &&
           elements->eccentricity > 1.0) ||
          parabolic);
}

bool convert_vcm_keplerian_elements_to_omm(
    const keplerianElements* source,
    double gm,
    KeplerianElements* elements) {
  if (source == nullptr) {
    return false;
  }

  VcmKeplerianElements normalized;
  normalized.semi_major_axis = source->SEMI_MAJOR_AXIS();
  normalized.eccentricity = source->ECCENTRICITY();
  normalized.inclination = source->INCLINATION();
  normalized.raan = source->RA_OF_ASC_NODE();
  normalized.arg_pericenter = source->ARG_OF_PERICENTER();
  normalized.anomaly = source->ANOMALY();
  normalized.periapsis_radius = source->PERIAPSIS_RADIUS();
  normalized.anomaly_type = source->ANOMALY_TYPE();
  return convert_vcm_keplerian_elements_to_omm(normalized, gm, elements);
}

bool convert_vcm_keplerian_elements_to_cartesian(
    const VcmKeplerianElements& source,
    double gm,
    CartesianState* state) {
  if (state == nullptr || !finite(gm) || gm <= 0.0) {
    return false;
  }

  if (source.anomaly_type == 0 &&
      std::abs(source.eccentricity - 1.0) <= kSingularOrbitTolerance &&
      std::abs(source.semi_major_axis) > kSmall) {
    return convert_rectilinear_anomaly_values_to_cartesian(
        source.semi_major_axis,
        source.eccentricity,
        source.inclination * kDegreesToRadians,
        source.raan * kDegreesToRadians,
        source.arg_pericenter * kDegreesToRadians,
        source.anomaly * kDegreesToRadians,
        gm,
        state);
  }

  if (source.anomaly_type == 0 &&
      std::abs(source.eccentricity - 1.0) <= kSingularOrbitTolerance &&
      std::abs(source.semi_major_axis) <= kSmall) {
    return convert_parabolic_true_anomaly_values_to_cartesian(
        source.periapsis_radius,
        source.eccentricity,
        source.inclination * kDegreesToRadians,
        source.raan * kDegreesToRadians,
        source.arg_pericenter * kDegreesToRadians,
        source.anomaly * kDegreesToRadians,
        gm,
        state);
  }

  if (source.anomaly_type == 1 &&
      std::abs(source.eccentricity - 1.0) <= kSingularOrbitTolerance &&
      std::abs(source.semi_major_axis) <= kSmall) {
    double true_anomaly = 0.0;
    if (!true_anomaly_from_parabolic_mean_anomaly(
            source.anomaly * kDegreesToRadians,
            &true_anomaly)) {
      return false;
    }
    return convert_parabolic_true_anomaly_values_to_cartesian(
        source.periapsis_radius,
        source.eccentricity,
        source.inclination * kDegreesToRadians,
        source.raan * kDegreesToRadians,
        source.arg_pericenter * kDegreesToRadians,
        true_anomaly,
        gm,
        state);
  }

  double mean_anomaly = 0.0;
  if (!vcm_mean_anomaly_from_anomaly(
          source.anomaly * kDegreesToRadians,
          source.eccentricity,
          source.anomaly_type,
          &mean_anomaly)) {
    return false;
  }

  return convert_keplerian_values_to_cartesian(
      source.semi_major_axis,
      source.eccentricity,
      source.inclination * kDegreesToRadians,
      source.raan * kDegreesToRadians,
      source.arg_pericenter * kDegreesToRadians,
      mean_anomaly,
      gm,
      state);
}

const plugin_input_frame_t* find_input_frame(const char* port_id) {
  const uint32_t input_count = plugin_get_input_count();
  for (uint32_t index = 0; index < input_count; ++index) {
    const plugin_input_frame_t* frame = plugin_get_input_frame(index);
    if (frame != nullptr && frame->port_id != nullptr && std::strcmp(frame->port_id, port_id) == 0) {
      return frame;
    }
  }
  return nullptr;
}

const char* flatbuffer_string_or_null(const ::flatbuffers::String* value) {
  return value == nullptr ? nullptr : value->c_str();
}

::flatbuffers::Offset<::flatbuffers::String> create_optional_string(
    ::flatbuffers::FlatBufferBuilder& builder,
    const char* value) {
  return value == nullptr ? 0 : builder.CreateString(value);
}

int8_t timing_standard_from_string(const char* value) {
  if (value == nullptr || std::strcmp(value, "UTC") == 0) {
    return 11;
  }
  if (std::strcmp(value, "GPS") == 0) {
    return 1;
  }
  if (std::strcmp(value, "TAI") == 0) {
    return 5;
  }
  if (std::strcmp(value, "TT") == 0) {
    return 9;
  }
  if (std::strcmp(value, "UT1") == 0) {
    return 10;
  }
  if (std::strcmp(value, "TDB") == 0) {
    return 7;
  }
  if (std::strcmp(value, "TCB") == 0) {
    return 6;
  }
  if (std::strcmp(value, "TCG") == 0) {
    return 8;
  }
  if (std::strcmp(value, "GMST") == 0) {
    return 0;
  }
  if (std::strcmp(value, "MET") == 0) {
    return 2;
  }
  if (std::strcmp(value, "MRT") == 0) {
    return 3;
  }
  if (std::strcmp(value, "SCLK") == 0) {
    return 4;
  }
  return 11;
}

int emit_oem(const OMM* omm, const CartesianState& state) {
  ::flatbuffers::FlatBufferBuilder builder(1024);

  const char* epoch = flatbuffer_string_or_null(omm->EPOCH());
  const char* center = flatbuffer_string_or_null(omm->CENTER_NAME());
  const char* creation_date = flatbuffer_string_or_null(omm->CREATION_DATE());

  const auto epoch_offset = create_optional_string(builder, epoch);
  const auto center_offset = create_optional_string(builder, center != nullptr ? center : "EARTH");
  const auto line = CreateEphemerisDataLine(
      builder,
      epoch_offset,
      state.x,
      state.y,
      state.z,
      state.x_dot,
      state.y_dot,
      state.z_dot);
  const std::vector<::flatbuffers::Offset<ephemerisDataLine>> line_entries = {line};
  const auto line_vector = builder.CreateVector(line_entries);
  const auto block_comment = builder.CreateString("Generated from SDS OMM Keplerian mean elements.");
  const auto block = CreateEphemerisDataBlock(
      builder,
      block_comment,
      center_offset,
      omm->TIME_SYSTEM(),
      epoch_offset,
      epoch_offset,
      line_vector);
  const std::vector<::flatbuffers::Offset<ephemerisDataBlock>> block_entries = {block};
  const auto block_vector = builder.CreateVector(block_entries);
  const auto classification = builder.CreateString("U");
  const auto creation_offset = create_optional_string(
      builder,
      creation_date != nullptr ? creation_date : "2026-05-24T00:00:00Z");
  const auto originator = builder.CreateString("DigitalArsenal foundation/orbits");
  const auto oem = CreateOEM(builder, classification, 2.0, creation_offset, originator, block_vector);
  builder.Finish(oem, "$OEM");

  if (plugin_push_output(
          "cartesian_state",
          "OEM.fbs",
          "$OEM",
          builder.GetBufferPointer(),
          static_cast<uint32_t>(builder.GetSize())) < 0) {
    plugin_set_error("emit-failed", "Failed to emit OEM Cartesian state.");
    return 1;
  }
  return 0;
}

int emit_oem_from_opm(const OPM* opm, const CartesianState& state) {
  if (opm == nullptr) {
    plugin_set_error("missing-opm", "No OPM input was provided.");
    return 3;
  }

  ::flatbuffers::FlatBufferBuilder builder(1024);

  const char* epoch = flatbuffer_string_or_null(opm->EPOCH());
  const char* center = flatbuffer_string_or_null(opm->CENTER_NAME());
  const char* creation_date = flatbuffer_string_or_null(opm->CREATION_DATE());
  const int8_t time_system = timing_standard_from_string(flatbuffer_string_or_null(opm->TIME_SYSTEM()));

  const auto epoch_offset = create_optional_string(builder, epoch);
  const auto center_offset = create_optional_string(builder, center != nullptr ? center : "EARTH");
  const auto line = CreateEphemerisDataLine(
      builder,
      epoch_offset,
      state.x,
      state.y,
      state.z,
      state.x_dot,
      state.y_dot,
      state.z_dot);
  const std::vector<::flatbuffers::Offset<ephemerisDataLine>> line_entries = {line};
  const auto line_vector = builder.CreateVector(line_entries);
  const auto block_comment = builder.CreateString("Generated from SDS OPM Cartesian state.");
  const auto block = CreateEphemerisDataBlock(
      builder,
      block_comment,
      center_offset,
      time_system,
      epoch_offset,
      epoch_offset,
      line_vector);
  const std::vector<::flatbuffers::Offset<ephemerisDataBlock>> block_entries = {block};
  const auto block_vector = builder.CreateVector(block_entries);
  const auto classification = builder.CreateString("U");
  const auto creation_offset = create_optional_string(
      builder,
      creation_date != nullptr ? creation_date : "2026-05-24T00:00:00Z");
  const auto originator = builder.CreateString("DigitalArsenal foundation/orbits");
  const auto oem = CreateOEM(builder, classification, 2.0, creation_offset, originator, block_vector);
  builder.Finish(oem, "$OEM");

  if (plugin_push_output(
          "cartesian_state",
          "OEM.fbs",
          "$OEM",
          builder.GetBufferPointer(),
          static_cast<uint32_t>(builder.GetSize())) < 0) {
    plugin_set_error("emit-failed", "Failed to emit OEM Cartesian state.");
    return 1;
  }
  return 0;
}

int emit_oem_from_vcm(
    const VCM* vcm,
    const CartesianState& state,
    const char* block_comment_text,
    const Vector3* acceleration = nullptr) {
  if (vcm == nullptr) {
    plugin_set_error("missing-vcm", "No VCM input was provided.");
    return 3;
  }

  const VCMStateVector* state_vector = vcm->STATE_VECTOR();
  const char* epoch = state_vector != nullptr ? flatbuffer_string_or_null(state_vector->EPOCH()) : nullptr;
  if (epoch == nullptr) {
    plugin_set_error("missing-state-vector-epoch", "VCM STATE_VECTOR.EPOCH is required for OEM output.");
    return 3;
  }

  ::flatbuffers::FlatBufferBuilder builder(1024);

  const char* center = flatbuffer_string_or_null(vcm->CENTER_NAME());
  const char* creation_date = flatbuffer_string_or_null(vcm->CREATION_DATE());
  const int8_t time_system = timing_standard_from_string(flatbuffer_string_or_null(vcm->TIME_SYSTEM()));

  const auto epoch_offset = create_optional_string(builder, epoch);
  const auto center_offset = create_optional_string(builder, center != nullptr ? center : "EARTH");
  const auto line = CreateEphemerisDataLine(
      builder,
      epoch_offset,
      state.x,
      state.y,
      state.z,
      state.x_dot,
      state.y_dot,
      state.z_dot,
      acceleration != nullptr ? acceleration->x : 0.0,
      acceleration != nullptr ? acceleration->y : 0.0,
      acceleration != nullptr ? acceleration->z : 0.0);
  const std::vector<::flatbuffers::Offset<ephemerisDataLine>> line_entries = {line};
  const auto line_vector = builder.CreateVector(line_entries);
  const auto block_comment = builder.CreateString(
      block_comment_text != nullptr ? block_comment_text : "Generated from SDS VCM state.");
  const auto block = CreateEphemerisDataBlock(
      builder,
      block_comment,
      center_offset,
      time_system,
      epoch_offset,
      epoch_offset,
      line_vector,
      acceleration != nullptr ? 9 : 6);
  const std::vector<::flatbuffers::Offset<ephemerisDataBlock>> block_entries = {block};
  const auto block_vector = builder.CreateVector(block_entries);
  const auto classification = builder.CreateString("U");
  const auto creation_offset = create_optional_string(
      builder,
      creation_date != nullptr ? creation_date : "2026-05-24T00:00:00Z");
  const auto originator = builder.CreateString("DigitalArsenal foundation/orbits");
  const auto oem = CreateOEM(builder, classification, 2.0, creation_offset, originator, block_vector);
  builder.Finish(oem, "$OEM");

  if (plugin_push_output(
          "cartesian_state",
          "OEM.fbs",
          "$OEM",
          builder.GetBufferPointer(),
          static_cast<uint32_t>(builder.GetSize())) < 0) {
    plugin_set_error("emit-failed", "Failed to emit OEM Cartesian state.");
    return 1;
  }
  return 0;
}

bool extract_vcm_metadata(const VCM* vcm, OemMetadata* metadata) {
  if (vcm == nullptr || metadata == nullptr) {
    return false;
  }
  const VCMStateVector* state_vector = vcm->STATE_VECTOR();
  if (state_vector == nullptr) {
    return false;
  }

  metadata->epoch = flatbuffer_string_or_null(state_vector->EPOCH());
  metadata->center_name = flatbuffer_string_or_null(vcm->CENTER_NAME());
  metadata->time_system = timing_standard_from_string(flatbuffer_string_or_null(vcm->TIME_SYSTEM()));
  return metadata->epoch != nullptr;
}

bool extract_vcm_state(const VCM* vcm, CartesianState* state, OemMetadata* metadata) {
  if (vcm == nullptr || state == nullptr || metadata == nullptr) {
    return false;
  }
  const VCMStateVector* state_vector = vcm->STATE_VECTOR();
  if (state_vector == nullptr) {
    return false;
  }

  state->x = state_vector->X();
  state->y = state_vector->Y();
  state->z = state_vector->Z();
  state->x_dot = state_vector->X_DOT();
  state->y_dot = state_vector->Y_DOT();
  state->z_dot = state_vector->Z_DOT();
  if (!finite(state->x) || !finite(state->y) || !finite(state->z) ||
      !finite(state->x_dot) || !finite(state->y_dot) || !finite(state->z_dot)) {
    return false;
  }

  return extract_vcm_metadata(vcm, metadata);
}

bool extract_cdm_relative_state(const CDM* cdm, RelativeHillState* relative) {
  if (cdm == nullptr || relative == nullptr) {
    return false;
  }

  relative->position = {
      cdm->RELATIVE_POSITION_R(),
      cdm->RELATIVE_POSITION_T(),
      cdm->RELATIVE_POSITION_N(),
  };
  relative->velocity = {
      cdm->RELATIVE_VELOCITY_R(),
      cdm->RELATIVE_VELOCITY_T(),
      cdm->RELATIVE_VELOCITY_N(),
  };
  relative->miss_distance = cdm->MISS_DISTANCE();
  relative->relative_speed = cdm->RELATIVE_SPEED();

  return finite(relative->position.x) && finite(relative->position.y) &&
         finite(relative->position.z) && finite(relative->velocity.x) &&
         finite(relative->velocity.y) && finite(relative->velocity.z) &&
         finite(relative->miss_distance) && finite(relative->relative_speed);
}

bool extract_oem_state(const OEM* oem, CartesianState* state, OemMetadata* metadata) {
  if (oem == nullptr || state == nullptr || metadata == nullptr) {
    return false;
  }
  const auto blocks = oem->EPHEMERIS_DATA_BLOCK();
  if (blocks == nullptr || blocks->size() == 0) {
    return false;
  }
  const ephemerisDataBlock* block = blocks->Get(0);
  if (block == nullptr) {
    return false;
  }
  const auto lines = block->EPHEMERIS_DATA_LINES();
  if (lines == nullptr || lines->size() == 0) {
    return false;
  }
  const ephemerisDataLine* line = lines->Get(0);
  if (line == nullptr) {
    return false;
  }

  state->x = line->X();
  state->y = line->Y();
  state->z = line->Z();
  state->x_dot = line->X_DOT();
  state->y_dot = line->Y_DOT();
  state->z_dot = line->Z_DOT();
  if (!finite(state->x) || !finite(state->y) || !finite(state->z) ||
      !finite(state->x_dot) || !finite(state->y_dot) || !finite(state->z_dot)) {
    return false;
  }

  metadata->epoch = flatbuffer_string_or_null(line->EPOCH());
  if (metadata->epoch == nullptr) {
    metadata->epoch = flatbuffer_string_or_null(block->START_TIME());
  }
  metadata->center_name = flatbuffer_string_or_null(block->CENTER_NAME());
  metadata->time_system = block->TIME_SYSTEM();
  return true;
}

bool extract_opm_metadata(const OPM* opm, OemMetadata* metadata) {
  if (opm == nullptr || metadata == nullptr) {
    return false;
  }

  metadata->epoch = flatbuffer_string_or_null(opm->EPOCH());
  metadata->center_name = flatbuffer_string_or_null(opm->CENTER_NAME());
  metadata->time_system = timing_standard_from_string(flatbuffer_string_or_null(opm->TIME_SYSTEM()));
  return true;
}

bool extract_opm_state(const OPM* opm, CartesianState* state, OemMetadata* metadata) {
  if (opm == nullptr || state == nullptr || metadata == nullptr) {
    return false;
  }

  state->x = opm->X();
  state->y = opm->Y();
  state->z = opm->Z();
  state->x_dot = opm->X_DOT();
  state->y_dot = opm->Y_DOT();
  state->z_dot = opm->Z_DOT();
  if (!finite(state->x) || !finite(state->y) || !finite(state->z) ||
      !finite(state->x_dot) || !finite(state->y_dot) || !finite(state->z_dot)) {
    return false;
  }

  return extract_opm_metadata(opm, metadata);
}

int emit_omm(
    const OMM* context,
    const OemMetadata& metadata,
    const KeplerianElements& elements) {
  ::flatbuffers::FlatBufferBuilder builder(1024);

  const char* context_center = context ? flatbuffer_string_or_null(context->CENTER_NAME()) : nullptr;
  const char* center = metadata.center_name != nullptr ? metadata.center_name : context_center;
  const char* epoch = metadata.epoch != nullptr
                          ? metadata.epoch
                          : (context ? flatbuffer_string_or_null(context->EPOCH()) : nullptr);
  const int8_t time_system = metadata.time_system != 0
                                 ? metadata.time_system
                                 : (context ? context->TIME_SYSTEM() : static_cast<int8_t>(11));

  const auto creation_date = create_optional_string(
      builder,
      context && context->CREATION_DATE() ? context->CREATION_DATE()->c_str() : "2026-05-24T00:00:00Z");
  const auto originator = builder.CreateString("DigitalArsenal foundation/orbits");
  const auto object_name = create_optional_string(
      builder,
      context ? flatbuffer_string_or_null(context->OBJECT_NAME()) : nullptr);
  const auto object_id = create_optional_string(
      builder,
      context ? flatbuffer_string_or_null(context->OBJECT_ID()) : nullptr);
  const auto center_name = create_optional_string(builder, center != nullptr ? center : "EARTH");
  const auto comment = builder.CreateString("Generated from SDS OEM Cartesian state and SDS OMM gravity context.");
  const auto epoch_offset = create_optional_string(builder, epoch);

  const auto omm = CreateOMM(
      builder,
      creation_date,
      originator,
      object_name,
      object_id,
      center_name,
      time_system,
      context ? context->MEAN_ELEMENT_THEORY() : static_cast<int8_t>(2),
      comment,
      epoch_offset,
      elements.semi_major_axis,
      elements.eccentricity,
      elements.inclination,
      elements.raan,
      elements.arg_pericenter,
      elements.mean_anomaly,
      elements.gm);
  builder.Finish(omm, "$OMM");

  if (plugin_push_output(
          "mean_elements",
          "OMM.fbs",
          "$OMM",
          builder.GetBufferPointer(),
          static_cast<uint32_t>(builder.GetSize())) < 0) {
    plugin_set_error("emit-failed", "Failed to emit OMM mean elements.");
    return 1;
  }
  return 0;
}

int emit_omm_from_opm(
    const OPM* opm,
    const OemMetadata& metadata,
    const KeplerianElements& elements) {
  if (opm == nullptr) {
    plugin_set_error("missing-opm", "No OPM input was provided.");
    return 3;
  }

  ::flatbuffers::FlatBufferBuilder builder(1024);

  const char* center = metadata.center_name != nullptr ? metadata.center_name : "EARTH";
  const char* epoch = metadata.epoch != nullptr ? metadata.epoch : flatbuffer_string_or_null(opm->EPOCH());

  const auto creation_date = create_optional_string(
      builder,
      opm->CREATION_DATE() ? opm->CREATION_DATE()->c_str() : "2026-05-24T00:00:00Z");
  const auto originator = builder.CreateString("DigitalArsenal foundation/orbits");
  const auto object_name = create_optional_string(builder, flatbuffer_string_or_null(opm->OBJECT_NAME()));
  const auto object_id = create_optional_string(builder, flatbuffer_string_or_null(opm->OBJECT_ID()));
  const auto center_name = create_optional_string(builder, center);
  const auto comment = builder.CreateString("Generated from SDS OPM Cartesian state.");
  const auto epoch_offset = create_optional_string(builder, epoch);

  const auto omm = CreateOMM(
      builder,
      creation_date,
      originator,
      object_name,
      object_id,
      center_name,
      metadata.time_system,
      2,
      comment,
      epoch_offset,
      elements.semi_major_axis,
      elements.eccentricity,
      elements.inclination,
      elements.raan,
      elements.arg_pericenter,
      elements.mean_anomaly,
      elements.gm);
  builder.Finish(omm, "$OMM");

  if (plugin_push_output(
          "mean_elements",
          "OMM.fbs",
          "$OMM",
          builder.GetBufferPointer(),
          static_cast<uint32_t>(builder.GetSize())) < 0) {
    plugin_set_error("emit-failed", "Failed to emit OMM mean elements.");
    return 1;
  }
  return 0;
}

int emit_omm_from_vcm(
    const VCM* vcm,
    const OemMetadata& metadata,
    const KeplerianElements& elements) {
  if (vcm == nullptr) {
    plugin_set_error("missing-vcm", "No VCM input was provided.");
    return 3;
  }

  ::flatbuffers::FlatBufferBuilder builder(1024);

  const char* center = metadata.center_name != nullptr ? metadata.center_name : "EARTH";
  const char* epoch = metadata.epoch;

  const auto creation_date = create_optional_string(
      builder,
      vcm->CREATION_DATE() ? vcm->CREATION_DATE()->c_str() : "2026-05-24T00:00:00Z");
  const auto originator = builder.CreateString("DigitalArsenal foundation/orbits");
  const auto object_name = create_optional_string(builder, flatbuffer_string_or_null(vcm->OBJECT_NAME()));
  const auto object_id = create_optional_string(builder, flatbuffer_string_or_null(vcm->OBJECT_ID()));
  const auto center_name = create_optional_string(builder, center);
  const auto comment = builder.CreateString("Generated from SDS VCM state.");
  const auto epoch_offset = create_optional_string(builder, epoch);

  const auto omm = CreateOMM(
      builder,
      creation_date,
      originator,
      object_name,
      object_id,
      center_name,
      metadata.time_system,
      2,
      comment,
      epoch_offset,
      elements.semi_major_axis,
      elements.eccentricity,
      elements.inclination,
      elements.raan,
      elements.arg_pericenter,
      elements.mean_anomaly,
      elements.gm);
  builder.Finish(omm, "$OMM");

  if (plugin_push_output(
          "mean_elements",
          "OMM.fbs",
          "$OMM",
          builder.GetBufferPointer(),
          static_cast<uint32_t>(builder.GetSize())) < 0) {
    plugin_set_error("emit-failed", "Failed to emit OMM mean elements.");
    return 1;
  }
  return 0;
}

int emit_vcm_equinoctial(
    const VCM* input,
    const EquinoctialElements& elements) {
  if (input == nullptr) {
    plugin_set_error("missing-vcm", "No VCM input was provided.");
    return 3;
  }

  ::flatbuffers::FlatBufferBuilder builder(1024);

  const auto creation_date = create_optional_string(
      builder,
      flatbuffer_string_or_null(input->CREATION_DATE()));
  const auto originator = create_optional_string(
      builder,
      flatbuffer_string_or_null(input->ORIGINATOR()));
  const auto object_name = create_optional_string(
      builder,
      flatbuffer_string_or_null(input->OBJECT_NAME()));
  const auto object_id = create_optional_string(
      builder,
      flatbuffer_string_or_null(input->OBJECT_ID()));
  const auto center_name = create_optional_string(
      builder,
      flatbuffer_string_or_null(input->CENTER_NAME()));
  const auto ref_frame = create_optional_string(
      builder,
      flatbuffer_string_or_null(input->REF_FRAME()));
  const auto time_system = create_optional_string(
      builder,
      flatbuffer_string_or_null(input->TIME_SYSTEM()));
  const auto state_vector = CreateVCMStateVector(
      builder,
      input->STATE_VECTOR());
  const auto keplerian_elements = CreateVcmKeplerianElements(
      builder,
      input->KEPLERIAN_ELEMENTS());
  const auto equinoctial_elements = CreateEquinoctialElements(
      builder,
      elements.af,
      elements.ag,
      elements.true_longitude,
      elements.semi_major_axis,
      elements.chi,
      elements.psi);
  const auto vcm = CreateVCM(
      builder,
      input->CCSDS_OMM_VERS(),
      creation_date,
      originator,
      object_name,
      object_id,
      center_name,
      ref_frame,
      time_system,
      state_vector,
      keplerian_elements,
      equinoctial_elements,
      input->GM());
  builder.Finish(vcm);

  if (plugin_push_output_ex(
          "equinoctial_state",
          "VCM.fbs",
          nullptr,
          PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER,
          "VCM",
          0,
          0,
          builder.GetBufferPointer(),
          static_cast<uint32_t>(builder.GetSize())) < 0) {
    plugin_set_error("emit-failed", "Failed to emit VCM equinoctial state.");
    return 1;
  }
  return 0;
}

int emit_vcm_keplerian(
    const VCM* input,
    const VcmKeplerianElements& elements) {
  if (input == nullptr) {
    plugin_set_error("missing-vcm", "No VCM input was provided.");
    return 3;
  }

  ::flatbuffers::FlatBufferBuilder builder(1024);

  const auto creation_date = create_optional_string(
      builder,
      flatbuffer_string_or_null(input->CREATION_DATE()));
  const auto originator = create_optional_string(
      builder,
      flatbuffer_string_or_null(input->ORIGINATOR()));
  const auto object_name = create_optional_string(
      builder,
      flatbuffer_string_or_null(input->OBJECT_NAME()));
  const auto object_id = create_optional_string(
      builder,
      flatbuffer_string_or_null(input->OBJECT_ID()));
  const auto center_name = create_optional_string(
      builder,
      flatbuffer_string_or_null(input->CENTER_NAME()));
  const auto ref_frame = create_optional_string(
      builder,
      flatbuffer_string_or_null(input->REF_FRAME()));
  const auto time_system = create_optional_string(
      builder,
      flatbuffer_string_or_null(input->TIME_SYSTEM()));
  const auto state_vector = CreateVCMStateVector(
      builder,
      input->STATE_VECTOR());
  const auto keplerian_elements = CreateVcmKeplerianElements(
      builder,
      elements.semi_major_axis,
      elements.eccentricity,
      elements.inclination,
      elements.raan,
      elements.arg_pericenter,
      elements.anomaly_type,
      elements.anomaly,
      elements.periapsis_radius);
  const auto equinoctial_elements = CreateEquinoctialElements(
      builder,
      input->EQUINOCTIAL_ELEMENTS());
  const auto vcm = CreateVCM(
      builder,
      input->CCSDS_OMM_VERS(),
      creation_date,
      originator,
      object_name,
      object_id,
      center_name,
      ref_frame,
      time_system,
      state_vector,
      keplerian_elements,
      equinoctial_elements,
      input->GM());
  builder.Finish(vcm);

  if (plugin_push_output_ex(
          "keplerian_state",
          "VCM.fbs",
          nullptr,
          PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER,
          "VCM",
          0,
          0,
          builder.GetBufferPointer(),
          static_cast<uint32_t>(builder.GetSize())) < 0) {
    plugin_set_error("emit-failed", "Failed to emit VCM Keplerian state.");
    return 1;
  }
  return 0;
}

int emit_vcm_state_vector(
    const VCM* input,
    const CartesianState& state) {
  if (input == nullptr) {
    plugin_set_error("missing-vcm", "No VCM input was provided.");
    return 3;
  }
  const VCMStateVector* source_state = input->STATE_VECTOR();
  const char* epoch = source_state != nullptr
                          ? flatbuffer_string_or_null(source_state->EPOCH())
                          : nullptr;
  if (epoch == nullptr) {
    plugin_set_error("missing-state-vector-epoch", "VCM STATE_VECTOR.EPOCH is required for VCM state output.");
    return 3;
  }

  ::flatbuffers::FlatBufferBuilder builder(1024);

  const auto creation_date = create_optional_string(
      builder,
      flatbuffer_string_or_null(input->CREATION_DATE()));
  const auto originator = create_optional_string(
      builder,
      flatbuffer_string_or_null(input->ORIGINATOR()));
  const auto object_name = create_optional_string(
      builder,
      flatbuffer_string_or_null(input->OBJECT_NAME()));
  const auto object_id = create_optional_string(
      builder,
      flatbuffer_string_or_null(input->OBJECT_ID()));
  const auto center_name = create_optional_string(
      builder,
      flatbuffer_string_or_null(input->CENTER_NAME()));
  const auto ref_frame = create_optional_string(
      builder,
      flatbuffer_string_or_null(input->REF_FRAME()));
  const auto time_system = create_optional_string(
      builder,
      flatbuffer_string_or_null(input->TIME_SYSTEM()));
  const auto epoch_offset = create_optional_string(builder, epoch);
  const auto state_vector = CreateVCMStateVector(
      builder,
      epoch_offset,
      state.x,
      state.y,
      state.z,
      state.x_dot,
      state.y_dot,
      state.z_dot);
  const auto keplerian_elements = CreateVcmKeplerianElements(
      builder,
      input->KEPLERIAN_ELEMENTS());
  const auto equinoctial_elements = CreateEquinoctialElements(
      builder,
      input->EQUINOCTIAL_ELEMENTS());
  const auto vcm = CreateVCM(
      builder,
      input->CCSDS_OMM_VERS(),
      creation_date,
      originator,
      object_name,
      object_id,
      center_name,
      ref_frame,
      time_system,
      state_vector,
      keplerian_elements,
      equinoctial_elements,
      input->GM());
  builder.Finish(vcm);

  if (plugin_push_output_ex(
          "vector_state",
          "VCM.fbs",
          nullptr,
          PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER,
          "VCM",
          0,
          0,
          builder.GetBufferPointer(),
          static_cast<uint32_t>(builder.GetSize())) < 0) {
    plugin_set_error("emit-failed", "Failed to emit VCM Cartesian state.");
    return 1;
  }
  return 0;
}

int emit_vcm_deputy_state(
    const VCM* chief,
    const CDM* relative_cdm,
    const CartesianState& state) {
  if (chief == nullptr || relative_cdm == nullptr) {
    plugin_set_error("missing-input", "Both chief VCM and relative CDM inputs are required.");
    return 3;
  }
  const VCMStateVector* source_state = chief->STATE_VECTOR();
  const char* chief_epoch = source_state != nullptr
                                ? flatbuffer_string_or_null(source_state->EPOCH())
                                : nullptr;
  const char* relative_epoch = flatbuffer_string_or_null(relative_cdm->TCA());
  const char* epoch = relative_epoch != nullptr ? relative_epoch : chief_epoch;
  if (epoch == nullptr) {
    plugin_set_error("missing-state-vector-epoch", "CDM TCA or VCM chief STATE_VECTOR.EPOCH is required for VCM deputy output.");
    return 3;
  }

  ::flatbuffers::FlatBufferBuilder builder(1024);

  const char* message_id = flatbuffer_string_or_null(relative_cdm->MESSAGE_ID());
  const auto creation_date = create_optional_string(
      builder,
      flatbuffer_string_or_null(chief->CREATION_DATE()));
  const auto originator = create_optional_string(
      builder,
      flatbuffer_string_or_null(chief->ORIGINATOR()));
  const auto object_name = create_optional_string(
      builder,
      message_id != nullptr ? message_id : "Basilisk Hill deputy state");
  const auto object_id = create_optional_string(
      builder,
      message_id != nullptr ? message_id : flatbuffer_string_or_null(chief->OBJECT_ID()));
  const auto center_name = create_optional_string(
      builder,
      flatbuffer_string_or_null(chief->CENTER_NAME()));
  const auto ref_frame = create_optional_string(
      builder,
      flatbuffer_string_or_null(chief->REF_FRAME()));
  const auto time_system = create_optional_string(
      builder,
      flatbuffer_string_or_null(chief->TIME_SYSTEM()));
  const auto epoch_offset = create_optional_string(builder, epoch);
  const auto state_vector = CreateVCMStateVector(
      builder,
      epoch_offset,
      state.x,
      state.y,
      state.z,
      state.x_dot,
      state.y_dot,
      state.z_dot);
  const auto vcm = CreateVCM(
      builder,
      chief->CCSDS_OMM_VERS(),
      creation_date,
      originator,
      object_name,
      object_id,
      center_name,
      ref_frame,
      time_system,
      state_vector,
      0,
      0,
      chief->GM());
  builder.Finish(vcm);

  if (plugin_push_output_ex(
          "deputy_state",
          "VCM.fbs",
          nullptr,
          PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER,
          "VCM",
          0,
          0,
          builder.GetBufferPointer(),
          static_cast<uint32_t>(builder.GetSize())) < 0) {
    plugin_set_error("emit-failed", "Failed to emit VCM deputy Cartesian state.");
    return 1;
  }
  return 0;
}

int emit_cdm_relative_hill(
    const VCM* chief,
    const VCM* deputy,
    const OemMetadata& metadata,
    const RelativeHillState& relative) {
  if (chief == nullptr || deputy == nullptr) {
    plugin_set_error("missing-vcm", "Both chief and deputy VCM inputs are required.");
    return 3;
  }

  const char* chief_id = flatbuffer_string_or_null(chief->OBJECT_ID());
  const char* deputy_id = flatbuffer_string_or_null(deputy->OBJECT_ID());
  std::string message_id = "foundation-orbits-hill-relative";
  if (chief_id != nullptr || deputy_id != nullptr) {
    message_id = std::string(chief_id != nullptr ? chief_id : "chief") +
                 "-to-" +
                 (deputy_id != nullptr ? deputy_id : "deputy");
  }

  ::flatbuffers::FlatBufferBuilder builder(1024);
  const auto creation_date = create_optional_string(
      builder,
      flatbuffer_string_or_null(chief->CREATION_DATE()) != nullptr
          ? flatbuffer_string_or_null(chief->CREATION_DATE())
          : "2026-05-25T00:00:00Z");
  const auto originator = builder.CreateString("DigitalArsenal foundation/orbits");
  const auto message_for = builder.CreateString("Basilisk Hill relative state");
  const auto message_id_offset = builder.CreateString(message_id);
  const auto tca = create_optional_string(builder, metadata.epoch);

  const auto cdm = CreateCDMRelativeState(
      builder,
      creation_date,
      originator,
      message_for,
      message_id_offset,
      tca,
      relative.miss_distance,
      relative.relative_speed,
      relative.position.x,
      relative.position.y,
      relative.position.z,
      relative.velocity.x,
      relative.velocity.y,
      relative.velocity.z);
  builder.Finish(cdm, "$CDM");

  if (plugin_push_output(
          "relative_state",
          "CDM.fbs",
          "$CDM",
          builder.GetBufferPointer(),
          static_cast<uint32_t>(builder.GetSize())) < 0) {
    plugin_set_error("emit-failed", "Failed to emit CDM relative Hill state.");
    return 1;
  }
  return 0;
}

int emit_normalized_vcm_keplerian_anomaly(bool output_true_anomaly) {
  plugin_reset_output_state();

  const plugin_input_frame_t* frame = find_input_frame("keplerian_state");
  if (frame == nullptr || frame->payload == nullptr || frame->payload_length < 8) {
    plugin_set_error("missing-keplerian-state", "No VCM keplerian_state frame was provided.");
    return 3;
  }

  ::flatbuffers::Verifier verifier(frame->payload, frame->payload_length);
  if (!VerifyVCMBuffer(verifier)) {
    plugin_set_error("invalid-vcm-buffer", "Input keplerian_state is not a valid SDS VCM FlatBuffer.");
    return 3;
  }

  const VCM* vcm = GetVCM(frame->payload);
  const keplerianElements* source = vcm ? vcm->KEPLERIAN_ELEMENTS() : nullptr;
  VcmKeplerianElements input;
  if (!read_vcm_keplerian_elements(source, &input)) {
    plugin_set_error("missing-keplerian-elements", "VCM must contain finite KEPLERIAN_ELEMENTS.");
    return 3;
  }

  VcmKeplerianElements output;
  const bool converted = output_true_anomaly
                             ? normalize_vcm_keplerian_to_true_anomaly(input, &output)
                             : normalize_vcm_keplerian_to_mean_anomaly(input, &output);
  if (!converted) {
    plugin_set_error(
        "unsupported-orbit",
        "VCM KEPLERIAN_ELEMENTS must describe a finite elliptical, hyperbolic, or parabolic orbit with TRUE_ANOMALY or MEAN_ANOMALY.");
    return 3;
  }

  return emit_vcm_keplerian(vcm, output);
}

}  // namespace

extern "C" int keplerian_to_cartesian(void) {
  plugin_reset_output_state();

  const plugin_input_frame_t* frame = find_input_frame("mean_elements");
  if (frame == nullptr || frame->payload == nullptr || frame->payload_length < 8) {
    plugin_set_error("missing-mean-elements", "No OMM mean-elements frame was provided.");
    return 3;
  }
  if (!OMMBufferHasIdentifier(frame->payload)) {
    plugin_set_error("invalid-omm-buffer", "Input is not an SDS OMM FlatBuffer.");
    return 3;
  }

  ::flatbuffers::Verifier verifier(frame->payload, frame->payload_length);
  if (!VerifyOMMBuffer(verifier)) {
    plugin_set_error("invalid-omm-buffer", "Input is not a valid SDS OMM FlatBuffer.");
    return 3;
  }

  const OMM* omm = GetOMM(frame->payload);
  CartesianState state;
  if (!convert_keplerian_to_cartesian(omm, &state)) {
    plugin_set_error(
        "unsupported-orbit",
        "OMM must contain finite elliptical Keplerian elements with SEMI_MAJOR_AXIS > 0, 0 <= ECCENTRICITY < 1, and GM > 0.");
    return 3;
  }

  return emit_oem(omm, state);
}

extern "C" int cartesian_to_keplerian(void) {
  plugin_reset_output_state();

  const plugin_input_frame_t* cartesian_frame = find_input_frame("cartesian_state");
  if (cartesian_frame == nullptr || cartesian_frame->payload == nullptr || cartesian_frame->payload_length < 8) {
    plugin_set_error("missing-cartesian-state", "No OEM Cartesian state frame was provided.");
    return 3;
  }
  if (!OEMBufferHasIdentifier(cartesian_frame->payload)) {
    plugin_set_error("invalid-oem-buffer", "Input cartesian_state is not an SDS OEM FlatBuffer.");
    return 3;
  }
  ::flatbuffers::Verifier oem_verifier(cartesian_frame->payload, cartesian_frame->payload_length);
  if (!VerifyOEMBuffer(oem_verifier)) {
    plugin_set_error("invalid-oem-buffer", "Input cartesian_state is not a valid SDS OEM FlatBuffer.");
    return 3;
  }

  const plugin_input_frame_t* context_frame = find_input_frame("gravity_context");
  if (context_frame == nullptr || context_frame->payload == nullptr || context_frame->payload_length < 8) {
    plugin_set_error("missing-gravity-context", "No OMM gravity_context frame was provided.");
    return 3;
  }
  if (!OMMBufferHasIdentifier(context_frame->payload)) {
    plugin_set_error("invalid-context-buffer", "Input gravity_context is not an SDS OMM FlatBuffer.");
    return 3;
  }
  ::flatbuffers::Verifier context_verifier(context_frame->payload, context_frame->payload_length);
  if (!VerifyOMMBuffer(context_verifier)) {
    plugin_set_error("invalid-context-buffer", "Input gravity_context is not a valid SDS OMM FlatBuffer.");
    return 3;
  }

  CartesianState state;
  OemMetadata metadata;
  if (!extract_oem_state(GetOEM(cartesian_frame->payload), &state, &metadata)) {
    plugin_set_error("missing-state-vector", "OEM must contain at least one explicit ephemerisDataLine state vector.");
    return 3;
  }

  const OMM* context = GetOMM(context_frame->payload);
  KeplerianElements elements;
  if (!convert_cartesian_to_keplerian(
          state,
          context ? context->GM() : 0.0,
          &elements,
          true) ||
      !normalize_parabolic_recovered_elements_to_omm(&elements)) {
    plugin_set_error(
        "unsupported-orbit",
        "OEM state and gravity_context.GM must describe a finite elliptical, hyperbolic, or parabolic orbit.");
    return 3;
  }

  return emit_omm(context, metadata, elements);
}

extern "C" int opm_to_oem(void) {
  plugin_reset_output_state();

  const plugin_input_frame_t* frame = find_input_frame("orbit_parameters");
  if (frame == nullptr || frame->payload == nullptr || frame->payload_length < 8) {
    plugin_set_error("missing-orbit-parameters", "No OPM orbit_parameters frame was provided.");
    return 3;
  }
  if (!OPMBufferHasIdentifier(frame->payload)) {
    plugin_set_error("invalid-opm-buffer", "Input orbit_parameters is not an SDS OPM FlatBuffer.");
    return 3;
  }

  ::flatbuffers::Verifier verifier(frame->payload, frame->payload_length);
  if (!VerifyOPMBuffer(verifier)) {
    plugin_set_error("invalid-opm-buffer", "Input orbit_parameters is not a valid SDS OPM FlatBuffer.");
    return 3;
  }

  CartesianState state;
  OemMetadata metadata;
  const OPM* opm = GetOPM(frame->payload);
  if (!extract_opm_state(opm, &state, &metadata)) {
    plugin_set_error("missing-state-vector", "OPM must contain a finite Cartesian state vector.");
    return 3;
  }

  return emit_oem_from_opm(opm, state);
}

extern "C" int opm_keplerian_to_oem(void) {
  plugin_reset_output_state();

  const plugin_input_frame_t* frame = find_input_frame("orbit_parameters");
  if (frame == nullptr || frame->payload == nullptr || frame->payload_length < 8) {
    plugin_set_error("missing-orbit-parameters", "No OPM orbit_parameters frame was provided.");
    return 3;
  }
  if (!OPMBufferHasIdentifier(frame->payload)) {
    plugin_set_error("invalid-opm-buffer", "Input orbit_parameters is not an SDS OPM FlatBuffer.");
    return 3;
  }

  ::flatbuffers::Verifier verifier(frame->payload, frame->payload_length);
  if (!VerifyOPMBuffer(verifier)) {
    plugin_set_error("invalid-opm-buffer", "Input orbit_parameters is not a valid SDS OPM FlatBuffer.");
    return 3;
  }

  CartesianState state;
  const OPM* opm = GetOPM(frame->payload);
  if (!convert_opm_keplerian_to_cartesian(opm, &state)) {
    plugin_set_error(
        "unsupported-orbit",
        "OPM must contain finite elliptical or hyperbolic Keplerian elements with TRUE_ANOMALY and GM > 0.");
    return 3;
  }

  return emit_oem_from_opm(opm, state);
}

extern "C" int opm_keplerian_to_omm(void) {
  plugin_reset_output_state();

  const plugin_input_frame_t* frame = find_input_frame("orbit_parameters");
  if (frame == nullptr || frame->payload == nullptr || frame->payload_length < 8) {
    plugin_set_error("missing-orbit-parameters", "No OPM orbit_parameters frame was provided.");
    return 3;
  }
  if (!OPMBufferHasIdentifier(frame->payload)) {
    plugin_set_error("invalid-opm-buffer", "Input orbit_parameters is not an SDS OPM FlatBuffer.");
    return 3;
  }

  ::flatbuffers::Verifier verifier(frame->payload, frame->payload_length);
  if (!VerifyOPMBuffer(verifier)) {
    plugin_set_error("invalid-opm-buffer", "Input orbit_parameters is not a valid SDS OPM FlatBuffer.");
    return 3;
  }

  const OPM* opm = GetOPM(frame->payload);
  OemMetadata metadata;
  if (!extract_opm_metadata(opm, &metadata)) {
    plugin_set_error("missing-orbit-parameters", "OPM metadata could not be read.");
    return 3;
  }

  KeplerianElements elements;
  if (!convert_opm_keplerian_to_elements(opm, &elements)) {
    plugin_set_error(
        "unsupported-orbit",
        "OPM must contain finite elliptical or hyperbolic Keplerian elements with TRUE_ANOMALY and GM > 0.");
    return 3;
  }

  return emit_omm_from_opm(opm, metadata, elements);
}

extern "C" int opm_to_omm(void) {
  plugin_reset_output_state();

  const plugin_input_frame_t* frame = find_input_frame("orbit_parameters");
  if (frame == nullptr || frame->payload == nullptr || frame->payload_length < 8) {
    plugin_set_error("missing-orbit-parameters", "No OPM orbit_parameters frame was provided.");
    return 3;
  }
  if (!OPMBufferHasIdentifier(frame->payload)) {
    plugin_set_error("invalid-opm-buffer", "Input orbit_parameters is not an SDS OPM FlatBuffer.");
    return 3;
  }

  ::flatbuffers::Verifier verifier(frame->payload, frame->payload_length);
  if (!VerifyOPMBuffer(verifier)) {
    plugin_set_error("invalid-opm-buffer", "Input orbit_parameters is not a valid SDS OPM FlatBuffer.");
    return 3;
  }

  CartesianState state;
  OemMetadata metadata;
  const OPM* opm = GetOPM(frame->payload);
  if (!extract_opm_state(opm, &state, &metadata)) {
    plugin_set_error("missing-state-vector", "OPM must contain a finite Cartesian state vector.");
    return 3;
  }

  KeplerianElements elements;
  if (!convert_cartesian_to_keplerian(
          state,
          opm ? opm->GM() : 0.0,
          &elements,
          true) ||
      !normalize_parabolic_recovered_elements_to_omm(&elements)) {
    plugin_set_error(
        "unsupported-orbit",
        "OPM Cartesian state and GM must describe a finite elliptical, hyperbolic, or parabolic orbit.");
    return 3;
  }

  return emit_omm_from_opm(opm, metadata, elements);
}

extern "C" int vcm_keplerian_to_oem(void) {
  plugin_reset_output_state();

  const plugin_input_frame_t* frame = find_input_frame("keplerian_state");
  if (frame == nullptr || frame->payload == nullptr || frame->payload_length < 8) {
    plugin_set_error("missing-keplerian-state", "No VCM keplerian_state frame was provided.");
    return 3;
  }

  ::flatbuffers::Verifier verifier(frame->payload, frame->payload_length);
  if (!VerifyVCMBuffer(verifier)) {
    plugin_set_error("invalid-vcm-buffer", "Input keplerian_state is not a valid SDS VCM FlatBuffer.");
    return 3;
  }

  const VCM* vcm = GetVCM(frame->payload);
  CartesianState state;
  if (!convert_vcm_keplerian_to_cartesian(vcm, &state)) {
    plugin_set_error(
        "unsupported-orbit",
        "VCM KEPLERIAN_ELEMENTS and GM must describe a finite elliptical, hyperbolic, or Basilisk rectilinear orbit with supported anomaly semantics.");
    return 3;
  }

  return emit_oem_from_vcm(vcm, state, "Generated from SDS VCM Keplerian elements.");
}

extern "C" int vcm_keplerian_to_state(void) {
  plugin_reset_output_state();

  const plugin_input_frame_t* frame = find_input_frame("keplerian_state");
  if (frame == nullptr || frame->payload == nullptr || frame->payload_length < 8) {
    plugin_set_error("missing-keplerian-state", "No VCM keplerian_state frame was provided.");
    return 3;
  }

  ::flatbuffers::Verifier verifier(frame->payload, frame->payload_length);
  if (!VerifyVCMBuffer(verifier)) {
    plugin_set_error("invalid-vcm-buffer", "Input keplerian_state is not a valid SDS VCM FlatBuffer.");
    return 3;
  }

  const VCM* vcm = GetVCM(frame->payload);
  CartesianState state;
  if (!convert_vcm_keplerian_to_cartesian(vcm, &state)) {
    plugin_set_error(
        "unsupported-orbit",
        "VCM KEPLERIAN_ELEMENTS and GM must describe a finite elliptical, hyperbolic, or Basilisk rectilinear orbit with supported anomaly semantics.");
    return 3;
  }

  return emit_vcm_state_vector(vcm, state);
}

extern "C" int vcm_state_to_oem(void) {
  plugin_reset_output_state();

  const plugin_input_frame_t* frame = find_input_frame("vector_state");
  if (frame == nullptr || frame->payload == nullptr || frame->payload_length < 8) {
    plugin_set_error("missing-vector-state", "No VCM vector_state frame was provided.");
    return 3;
  }

  ::flatbuffers::Verifier verifier(frame->payload, frame->payload_length);
  if (!VerifyVCMBuffer(verifier)) {
    plugin_set_error("invalid-vcm-buffer", "Input vector_state is not a valid SDS VCM FlatBuffer.");
    return 3;
  }

  const VCM* vcm = GetVCM(frame->payload);
  CartesianState state;
  OemMetadata metadata;
  if (!extract_vcm_state(vcm, &state, &metadata)) {
    plugin_set_error("missing-state-vector", "VCM must contain a finite STATE_VECTOR with EPOCH.");
    return 3;
  }

  return emit_oem_from_vcm(vcm, state, "Generated from SDS VCM Cartesian state vector.");
}

extern "C" int vcm_state_to_j_zonal_acceleration_oem(void) {
  plugin_reset_output_state();

  const plugin_input_frame_t* state_frame = find_input_frame("vector_state");
  if (state_frame == nullptr || state_frame->payload == nullptr ||
      state_frame->payload_length < 8) {
    plugin_set_error("missing-vector-state", "No VCM vector_state frame was provided.");
    return 3;
  }

  const plugin_input_frame_t* gravity_frame = find_input_frame("gravity_context");
  if (gravity_frame == nullptr || gravity_frame->payload == nullptr ||
      gravity_frame->payload_length < 8) {
    plugin_set_error("missing-gravity-context", "No GRV gravity_context frame was provided.");
    return 3;
  }

  ::flatbuffers::Verifier vcm_verifier(
      state_frame->payload,
      state_frame->payload_length);
  if (!VerifyVCMBuffer(vcm_verifier)) {
    plugin_set_error("invalid-vcm-buffer", "Input vector_state is not a valid SDS VCM FlatBuffer.");
    return 3;
  }

  ::flatbuffers::Verifier grv_verifier(
      gravity_frame->payload,
      gravity_frame->payload_length);
  if (!VerifyGRVBuffer(grv_verifier)) {
    plugin_set_error("invalid-grv-buffer", "Input gravity_context is not a valid SDS GRV FlatBuffer.");
    return 3;
  }

  const VCM* vcm = GetVCM(state_frame->payload);
  CartesianState state;
  OemMetadata metadata;
  if (!extract_vcm_state(vcm, &state, &metadata)) {
    plugin_set_error("missing-state-vector", "VCM must contain a finite STATE_VECTOR with EPOCH.");
    return 3;
  }

  const GRV* gravity = GetGRV(gravity_frame->payload);
  Vector3 acceleration;
  if (!compute_j_zonal_perturbation_acceleration(state, gravity, &acceleration)) {
    plugin_set_error(
        "unsupported-gravity-context",
        "VCM STATE_VECTOR and GRV MU/EQUATORIAL_RADIUS/J2-J6 must describe a finite Basilisk J2-J6 zonal perturbation request.");
    return 3;
  }

  return emit_oem_from_vcm(
      vcm,
      state,
      "Generated from SDS VCM Cartesian state vector and GRV J-zonal gravity context.",
      &acceleration);
}

extern "C" int vcm_state_to_srp_acceleration_oem(void) {
  plugin_reset_output_state();

  const plugin_input_frame_t* state_frame = find_input_frame("vector_state");
  if (state_frame == nullptr || state_frame->payload == nullptr ||
      state_frame->payload_length < 8) {
    plugin_set_error("missing-vector-state", "No VCM vector_state frame was provided.");
    return 3;
  }

  const plugin_input_frame_t* sun_frame = find_input_frame("sun_vector");
  if (sun_frame == nullptr || sun_frame->payload == nullptr ||
      sun_frame->payload_length < 8) {
    plugin_set_error("missing-sun-vector", "No CRD sun_vector frame was provided.");
    return 3;
  }

  ::flatbuffers::Verifier vcm_verifier(
      state_frame->payload,
      state_frame->payload_length);
  if (!VerifyVCMBuffer(vcm_verifier)) {
    plugin_set_error("invalid-vcm-buffer", "Input vector_state is not a valid SDS VCM FlatBuffer.");
    return 3;
  }

  ::flatbuffers::Verifier crd_verifier(
      sun_frame->payload,
      sun_frame->payload_length);
  if (!VerifyCRDBuffer(crd_verifier)) {
    plugin_set_error("invalid-crd-buffer", "Input sun_vector is not a valid SDS CRD FlatBuffer.");
    return 3;
  }

  const VCM* vcm = GetVCM(state_frame->payload);
  CartesianState state;
  OemMetadata metadata;
  if (!extract_vcm_state(vcm, &state, &metadata)) {
    plugin_set_error("missing-state-vector", "VCM must contain a finite STATE_VECTOR with EPOCH.");
    return 3;
  }

  const CRD* sun_vector = GetCRD(sun_frame->payload);
  Vector3 acceleration;
  if (!compute_solar_radiation_pressure_acceleration(vcm, sun_vector, &acceleration)) {
    plugin_set_error(
        "unsupported-srp-context",
        "VCM MASS/SOLAR_RAD_AREA/SOLAR_RAD_COEFF and CRD X/Y/Z must describe a finite Basilisk solar radiation pressure request.");
    return 3;
  }

  return emit_oem_from_vcm(
      vcm,
      state,
      "Generated from SDS VCM spacecraft parameters and CRD Sun vector using the Basilisk solarRad convention.",
      &acceleration);
}

extern "C" int vcm_state_to_omm(void) {
  plugin_reset_output_state();

  const plugin_input_frame_t* frame = find_input_frame("vector_state");
  if (frame == nullptr || frame->payload == nullptr || frame->payload_length < 8) {
    plugin_set_error("missing-vector-state", "No VCM vector_state frame was provided.");
    return 3;
  }

  ::flatbuffers::Verifier verifier(frame->payload, frame->payload_length);
  if (!VerifyVCMBuffer(verifier)) {
    plugin_set_error("invalid-vcm-buffer", "Input vector_state is not a valid SDS VCM FlatBuffer.");
    return 3;
  }

  const VCM* vcm = GetVCM(frame->payload);
  CartesianState state;
  OemMetadata metadata;
  if (!extract_vcm_state(vcm, &state, &metadata)) {
    plugin_set_error("missing-state-vector", "VCM must contain a finite STATE_VECTOR with EPOCH.");
    return 3;
  }

  KeplerianElements elements;
  if (!convert_cartesian_to_keplerian(state, vcm ? vcm->GM() : 0.0, &elements, true)) {
    plugin_set_error(
        "unsupported-orbit",
        "VCM STATE_VECTOR and GM must describe a finite elliptical, hyperbolic, or parabolic orbit.");
    return 3;
  }
  if (!normalize_parabolic_recovered_elements_to_omm(&elements)) {
    plugin_set_error(
        "unsupported-orbit",
        "VCM STATE_VECTOR and GM must describe a finite parabolic orbit with a Barker mean anomaly.");
    return 3;
  }

  return emit_omm_from_vcm(vcm, metadata, elements);
}

extern "C" int vcm_state_to_keplerian(void) {
  plugin_reset_output_state();

  const plugin_input_frame_t* frame = find_input_frame("vector_state");
  if (frame == nullptr || frame->payload == nullptr || frame->payload_length < 8) {
    plugin_set_error("missing-vector-state", "No VCM vector_state frame was provided.");
    return 3;
  }

  ::flatbuffers::Verifier verifier(frame->payload, frame->payload_length);
  if (!VerifyVCMBuffer(verifier)) {
    plugin_set_error("invalid-vcm-buffer", "Input vector_state is not a valid SDS VCM FlatBuffer.");
    return 3;
  }

  const VCM* vcm = GetVCM(frame->payload);
  CartesianState state;
  OemMetadata metadata;
  if (!extract_vcm_state(vcm, &state, &metadata)) {
    plugin_set_error("missing-state-vector", "VCM must contain a finite STATE_VECTOR with EPOCH.");
    return 3;
  }

  KeplerianElements elements;
  if (!convert_cartesian_to_keplerian(state, vcm ? vcm->GM() : 0.0, &elements, true)) {
    plugin_set_error(
        "unsupported-orbit",
        "VCM STATE_VECTOR and GM must describe a finite elliptical, hyperbolic, or parabolic orbit.");
    return 3;
  }

  const bool parabolic =
      std::abs(elements.eccentricity - 1.0) <= kSingularOrbitTolerance &&
      std::abs(elements.semi_major_axis) <= kSingularOrbitTolerance;
  VcmKeplerianElements vcm_elements;
  vcm_elements.semi_major_axis = elements.semi_major_axis;
  vcm_elements.eccentricity = elements.eccentricity;
  vcm_elements.inclination = elements.inclination;
  vcm_elements.raan = elements.raan;
  vcm_elements.arg_pericenter = elements.arg_pericenter;
  vcm_elements.anomaly = elements.mean_anomaly;
  vcm_elements.periapsis_radius = parabolic ? elements.periapsis_radius : 0.0;
  vcm_elements.anomaly_type = parabolic ? 0 : 1;

  return emit_vcm_keplerian(vcm, vcm_elements);
}

extern "C" int vcm_state_to_equinoctial(void) {
  plugin_reset_output_state();

  const plugin_input_frame_t* frame = find_input_frame("vector_state");
  if (frame == nullptr || frame->payload == nullptr || frame->payload_length < 8) {
    plugin_set_error("missing-vector-state", "No VCM vector_state frame was provided.");
    return 3;
  }

  ::flatbuffers::Verifier verifier(frame->payload, frame->payload_length);
  if (!VerifyVCMBuffer(verifier)) {
    plugin_set_error("invalid-vcm-buffer", "Input vector_state is not a valid SDS VCM FlatBuffer.");
    return 3;
  }

  const VCM* vcm = GetVCM(frame->payload);
  CartesianState state;
  OemMetadata metadata;
  if (!extract_vcm_state(vcm, &state, &metadata)) {
    plugin_set_error("missing-state-vector", "VCM must contain a finite STATE_VECTOR with EPOCH.");
    return 3;
  }

  KeplerianElements elements;
  if (!convert_cartesian_to_keplerian(state, vcm ? vcm->GM() : 0.0, &elements)) {
    plugin_set_error(
        "unsupported-orbit",
        "VCM STATE_VECTOR and GM must describe a finite elliptical or hyperbolic orbit.");
    return 3;
  }

  VcmKeplerianElements vcm_elements;
  vcm_elements.semi_major_axis = elements.semi_major_axis;
  vcm_elements.eccentricity = elements.eccentricity;
  vcm_elements.inclination = elements.inclination;
  vcm_elements.raan = elements.raan;
  vcm_elements.arg_pericenter = elements.arg_pericenter;
  vcm_elements.anomaly = elements.mean_anomaly;
  vcm_elements.anomaly_type = 1;

  EquinoctialElements equinoctial;
  if (!convert_vcm_keplerian_values_to_equinoctial(vcm_elements, &equinoctial)) {
    plugin_set_error(
        "unsupported-orbit",
        "VCM STATE_VECTOR and GM must describe a finite elliptical orbit for equinoctial output.");
    return 3;
  }

  return emit_vcm_equinoctial(vcm, equinoctial);
}

extern "C" int vcm_keplerian_to_omm(void) {
  plugin_reset_output_state();

  const plugin_input_frame_t* frame = find_input_frame("keplerian_state");
  if (frame == nullptr || frame->payload == nullptr || frame->payload_length < 8) {
    plugin_set_error("missing-keplerian-state", "No VCM keplerian_state frame was provided.");
    return 3;
  }

  ::flatbuffers::Verifier verifier(frame->payload, frame->payload_length);
  if (!VerifyVCMBuffer(verifier)) {
    plugin_set_error("invalid-vcm-buffer", "Input keplerian_state is not a valid SDS VCM FlatBuffer.");
    return 3;
  }

  const VCM* vcm = GetVCM(frame->payload);
  const keplerianElements* source = vcm ? vcm->KEPLERIAN_ELEMENTS() : nullptr;
  if (source == nullptr) {
    plugin_set_error("missing-keplerian-elements", "VCM must contain KEPLERIAN_ELEMENTS.");
    return 3;
  }

  OemMetadata metadata;
  if (!extract_vcm_metadata(vcm, &metadata)) {
    plugin_set_error("missing-state-vector-epoch", "VCM STATE_VECTOR.EPOCH is required for OMM output.");
    return 3;
  }

  KeplerianElements elements;
  if (!convert_vcm_keplerian_elements_to_omm(source, vcm ? vcm->GM() : 0.0, &elements)) {
    plugin_set_error(
        "unsupported-orbit",
        "VCM KEPLERIAN_ELEMENTS and GM must describe a finite elliptical, hyperbolic, or parabolic orbit with TRUE_ANOMALY or MEAN_ANOMALY.");
    return 3;
  }

  return emit_omm_from_vcm(vcm, metadata, elements);
}

extern "C" int vcm_keplerian_to_true_anomaly(void) {
  return emit_normalized_vcm_keplerian_anomaly(true);
}

extern "C" int vcm_keplerian_to_mean_anomaly(void) {
  return emit_normalized_vcm_keplerian_anomaly(false);
}

extern "C" int vcm_keplerian_mean_to_osculating(void) {
  plugin_reset_output_state();

  const plugin_input_frame_t* keplerian_frame = find_input_frame("keplerian_state");
  if (keplerian_frame == nullptr || keplerian_frame->payload == nullptr ||
      keplerian_frame->payload_length < 8) {
    plugin_set_error("missing-keplerian-state", "No VCM keplerian_state frame was provided.");
    return 3;
  }

  const plugin_input_frame_t* gravity_frame = find_input_frame("gravity_context");
  if (gravity_frame == nullptr || gravity_frame->payload == nullptr ||
      gravity_frame->payload_length < 8) {
    plugin_set_error("missing-gravity-context", "No GRV gravity_context frame was provided.");
    return 3;
  }

  ::flatbuffers::Verifier vcm_verifier(
      keplerian_frame->payload,
      keplerian_frame->payload_length);
  if (!VerifyVCMBuffer(vcm_verifier)) {
    plugin_set_error("invalid-vcm-buffer", "Input keplerian_state is not a valid SDS VCM FlatBuffer.");
    return 3;
  }

  ::flatbuffers::Verifier grv_verifier(
      gravity_frame->payload,
      gravity_frame->payload_length);
  if (!VerifyGRVBuffer(grv_verifier)) {
    plugin_set_error("invalid-grv-buffer", "Input gravity_context is not a valid SDS GRV FlatBuffer.");
    return 3;
  }

  const VCM* vcm = GetVCM(keplerian_frame->payload);
  const keplerianElements* source = vcm ? vcm->KEPLERIAN_ELEMENTS() : nullptr;
  if (source == nullptr) {
    plugin_set_error("missing-keplerian-elements", "VCM must contain KEPLERIAN_ELEMENTS.");
    return 3;
  }

  const GRV* gravity = GetGRV(gravity_frame->payload);
  VcmKeplerianElements elements;
  if (!convert_vcm_keplerian_mean_to_osculating(source, gravity, &elements)) {
    plugin_set_error(
        "unsupported-orbit",
        "VCM KEPLERIAN_ELEMENTS and GRV EQUATORIAL_RADIUS/J2 must describe a finite elliptical first-order J2 mean-to-osculating map.");
    return 3;
  }

  return emit_vcm_keplerian(vcm, elements);
}

extern "C" int vcm_keplerian_osculating_to_mean(void) {
  plugin_reset_output_state();

  const plugin_input_frame_t* keplerian_frame = find_input_frame("keplerian_state");
  if (keplerian_frame == nullptr || keplerian_frame->payload == nullptr ||
      keplerian_frame->payload_length < 8) {
    plugin_set_error("missing-keplerian-state", "No VCM keplerian_state frame was provided.");
    return 3;
  }

  const plugin_input_frame_t* gravity_frame = find_input_frame("gravity_context");
  if (gravity_frame == nullptr || gravity_frame->payload == nullptr ||
      gravity_frame->payload_length < 8) {
    plugin_set_error("missing-gravity-context", "No GRV gravity_context frame was provided.");
    return 3;
  }

  ::flatbuffers::Verifier vcm_verifier(
      keplerian_frame->payload,
      keplerian_frame->payload_length);
  if (!VerifyVCMBuffer(vcm_verifier)) {
    plugin_set_error("invalid-vcm-buffer", "Input keplerian_state is not a valid SDS VCM FlatBuffer.");
    return 3;
  }

  ::flatbuffers::Verifier grv_verifier(
      gravity_frame->payload,
      gravity_frame->payload_length);
  if (!VerifyGRVBuffer(grv_verifier)) {
    plugin_set_error("invalid-grv-buffer", "Input gravity_context is not a valid SDS GRV FlatBuffer.");
    return 3;
  }

  const VCM* vcm = GetVCM(keplerian_frame->payload);
  const keplerianElements* source = vcm ? vcm->KEPLERIAN_ELEMENTS() : nullptr;
  if (source == nullptr) {
    plugin_set_error("missing-keplerian-elements", "VCM must contain KEPLERIAN_ELEMENTS.");
    return 3;
  }

  const GRV* gravity = GetGRV(gravity_frame->payload);
  VcmKeplerianElements elements;
  if (!convert_vcm_keplerian_osculating_to_mean(source, gravity, &elements)) {
    plugin_set_error(
        "unsupported-orbit",
        "VCM KEPLERIAN_ELEMENTS and GRV EQUATORIAL_RADIUS/J2 must describe a finite elliptical first-order J2 osculating-to-mean map.");
    return 3;
  }

  return emit_vcm_keplerian(vcm, elements);
}

extern "C" int keplerian_to_equinoctial(void) {
  plugin_reset_output_state();

  const plugin_input_frame_t* frame = find_input_frame("keplerian_state");
  if (frame == nullptr || frame->payload == nullptr || frame->payload_length < 8) {
    plugin_set_error("missing-keplerian-state", "No VCM keplerian_state frame was provided.");
    return 3;
  }

  ::flatbuffers::Verifier verifier(frame->payload, frame->payload_length);
  if (!VerifyVCMBuffer(verifier)) {
    plugin_set_error("invalid-vcm-buffer", "Input keplerian_state is not a valid SDS VCM FlatBuffer.");
    return 3;
  }

  const VCM* vcm = GetVCM(frame->payload);
  const keplerianElements* source = vcm ? vcm->KEPLERIAN_ELEMENTS() : nullptr;
  if (source == nullptr) {
    plugin_set_error("missing-keplerian-elements", "VCM must contain KEPLERIAN_ELEMENTS.");
    return 3;
  }

  EquinoctialElements elements;
  if (!convert_vcm_keplerian_to_equinoctial(source, &elements)) {
    plugin_set_error(
        "unsupported-orbit",
        "VCM KEPLERIAN_ELEMENTS must describe a finite elliptical orbit with SEMI_MAJOR_AXIS > 0, 0 <= ECCENTRICITY < 1, and TRUE_ANOMALY or MEAN_ANOMALY.");
    return 3;
  }

  return emit_vcm_equinoctial(vcm, elements);
}

extern "C" int equinoctial_to_keplerian(void) {
  plugin_reset_output_state();

  const plugin_input_frame_t* frame = find_input_frame("equinoctial_state");
  if (frame == nullptr || frame->payload == nullptr || frame->payload_length < 8) {
    plugin_set_error("missing-equinoctial-state", "No VCM equinoctial_state frame was provided.");
    return 3;
  }

  ::flatbuffers::Verifier verifier(frame->payload, frame->payload_length);
  if (!VerifyVCMBuffer(verifier)) {
    plugin_set_error("invalid-vcm-buffer", "Input equinoctial_state is not a valid SDS VCM FlatBuffer.");
    return 3;
  }

  const VCM* vcm = GetVCM(frame->payload);
  const equinoctialElements* source = vcm ? vcm->EQUINOCTIAL_ELEMENTS() : nullptr;
  if (source == nullptr) {
    plugin_set_error("missing-equinoctial-elements", "VCM must contain EQUINOCTIAL_ELEMENTS.");
    return 3;
  }

  VcmKeplerianElements elements;
  if (!convert_vcm_equinoctial_to_keplerian(source, &elements)) {
    plugin_set_error(
        "unsupported-orbit",
        "VCM EQUINOCTIAL_ELEMENTS must describe a finite elliptical orbit with N > 0 and 0 <= eccentricity < 1.");
    return 3;
  }

  return emit_vcm_keplerian(vcm, elements);
}

extern "C" int vcm_equinoctial_to_omm(void) {
  plugin_reset_output_state();

  const plugin_input_frame_t* frame = find_input_frame("equinoctial_state");
  if (frame == nullptr || frame->payload == nullptr || frame->payload_length < 8) {
    plugin_set_error("missing-equinoctial-state", "No VCM equinoctial_state frame was provided.");
    return 3;
  }

  ::flatbuffers::Verifier verifier(frame->payload, frame->payload_length);
  if (!VerifyVCMBuffer(verifier)) {
    plugin_set_error("invalid-vcm-buffer", "Input equinoctial_state is not a valid SDS VCM FlatBuffer.");
    return 3;
  }

  const VCM* vcm = GetVCM(frame->payload);
  const equinoctialElements* source = vcm ? vcm->EQUINOCTIAL_ELEMENTS() : nullptr;
  if (source == nullptr) {
    plugin_set_error("missing-equinoctial-elements", "VCM must contain EQUINOCTIAL_ELEMENTS.");
    return 3;
  }

  OemMetadata metadata;
  if (!extract_vcm_metadata(vcm, &metadata)) {
    plugin_set_error("missing-state-vector-epoch", "VCM STATE_VECTOR.EPOCH is required for OMM output.");
    return 3;
  }

  VcmKeplerianElements vcm_elements;
  if (!convert_vcm_equinoctial_to_keplerian(source, &vcm_elements)) {
    plugin_set_error(
        "unsupported-orbit",
        "VCM EQUINOCTIAL_ELEMENTS must describe a finite elliptical orbit with N > 0 and 0 <= eccentricity < 1.");
    return 3;
  }

  KeplerianElements elements;
  if (!convert_vcm_keplerian_elements_to_omm(vcm_elements, vcm ? vcm->GM() : 0.0, &elements)) {
    plugin_set_error(
        "unsupported-orbit",
        "VCM EQUINOCTIAL_ELEMENTS and GM must describe a finite elliptical orbit.");
    return 3;
  }

  return emit_omm_from_vcm(vcm, metadata, elements);
}

extern "C" int vcm_equinoctial_to_oem(void) {
  plugin_reset_output_state();

  const plugin_input_frame_t* frame = find_input_frame("equinoctial_state");
  if (frame == nullptr || frame->payload == nullptr || frame->payload_length < 8) {
    plugin_set_error("missing-equinoctial-state", "No VCM equinoctial_state frame was provided.");
    return 3;
  }

  ::flatbuffers::Verifier verifier(frame->payload, frame->payload_length);
  if (!VerifyVCMBuffer(verifier)) {
    plugin_set_error("invalid-vcm-buffer", "Input equinoctial_state is not a valid SDS VCM FlatBuffer.");
    return 3;
  }

  const VCM* vcm = GetVCM(frame->payload);
  const equinoctialElements* source = vcm ? vcm->EQUINOCTIAL_ELEMENTS() : nullptr;
  if (source == nullptr) {
    plugin_set_error("missing-equinoctial-elements", "VCM must contain EQUINOCTIAL_ELEMENTS.");
    return 3;
  }

  VcmKeplerianElements elements;
  if (!convert_vcm_equinoctial_to_keplerian(source, &elements)) {
    plugin_set_error(
        "unsupported-orbit",
        "VCM EQUINOCTIAL_ELEMENTS must describe a finite elliptical orbit with N > 0 and 0 <= eccentricity < 1.");
    return 3;
  }

  CartesianState state;
  if (!convert_vcm_keplerian_elements_to_cartesian(elements, vcm ? vcm->GM() : 0.0, &state)) {
    plugin_set_error(
        "unsupported-orbit",
        "VCM EQUINOCTIAL_ELEMENTS and GM must describe a finite elliptical orbit.");
    return 3;
  }

  return emit_oem_from_vcm(vcm, state, "Generated from SDS VCM equinoctial elements.");
}

extern "C" int vcm_equinoctial_to_state(void) {
  plugin_reset_output_state();

  const plugin_input_frame_t* frame = find_input_frame("equinoctial_state");
  if (frame == nullptr || frame->payload == nullptr || frame->payload_length < 8) {
    plugin_set_error("missing-equinoctial-state", "No VCM equinoctial_state frame was provided.");
    return 3;
  }

  ::flatbuffers::Verifier verifier(frame->payload, frame->payload_length);
  if (!VerifyVCMBuffer(verifier)) {
    plugin_set_error("invalid-vcm-buffer", "Input equinoctial_state is not a valid SDS VCM FlatBuffer.");
    return 3;
  }

  const VCM* vcm = GetVCM(frame->payload);
  const equinoctialElements* source = vcm ? vcm->EQUINOCTIAL_ELEMENTS() : nullptr;
  VcmKeplerianElements elements;
  if (!convert_vcm_equinoctial_to_keplerian(source, &elements)) {
    plugin_set_error(
        "unsupported-orbit",
        "VCM EQUINOCTIAL_ELEMENTS must describe a finite elliptical orbit.");
    return 3;
  }

  CartesianState state;
  if (!convert_vcm_keplerian_elements_to_cartesian(elements, vcm ? vcm->GM() : 0.0, &state)) {
    plugin_set_error(
        "unsupported-orbit",
        "Recovered VCM equinoctial Keplerian elements and GM must describe a finite elliptical orbit.");
    return 3;
  }

  return emit_vcm_state_vector(vcm, state);
}

extern "C" int vcm_pair_to_cdm_relative_hill(void) {
  plugin_reset_output_state();

  const plugin_input_frame_t* chief_frame = find_input_frame("chief_state");
  if (chief_frame == nullptr || chief_frame->payload == nullptr || chief_frame->payload_length < 8) {
    plugin_set_error("missing-chief-state", "No VCM chief_state frame was provided.");
    return 3;
  }

  const plugin_input_frame_t* deputy_frame = find_input_frame("deputy_state");
  if (deputy_frame == nullptr || deputy_frame->payload == nullptr || deputy_frame->payload_length < 8) {
    plugin_set_error("missing-deputy-state", "No VCM deputy_state frame was provided.");
    return 3;
  }

  ::flatbuffers::Verifier chief_verifier(chief_frame->payload, chief_frame->payload_length);
  if (!VerifyVCMBuffer(chief_verifier)) {
    plugin_set_error("invalid-vcm-buffer", "Input chief_state is not a valid SDS VCM FlatBuffer.");
    return 3;
  }

  ::flatbuffers::Verifier deputy_verifier(deputy_frame->payload, deputy_frame->payload_length);
  if (!VerifyVCMBuffer(deputy_verifier)) {
    plugin_set_error("invalid-vcm-buffer", "Input deputy_state is not a valid SDS VCM FlatBuffer.");
    return 3;
  }

  const VCM* chief_vcm = GetVCM(chief_frame->payload);
  const VCM* deputy_vcm = GetVCM(deputy_frame->payload);
  CartesianState chief_state;
  CartesianState deputy_state;
  OemMetadata chief_metadata;
  OemMetadata deputy_metadata;
  if (!extract_vcm_state(chief_vcm, &chief_state, &chief_metadata)) {
    plugin_set_error("missing-chief-state-vector", "VCM chief_state must contain a finite STATE_VECTOR.");
    return 3;
  }
  if (!extract_vcm_state(deputy_vcm, &deputy_state, &deputy_metadata)) {
    plugin_set_error("missing-deputy-state-vector", "VCM deputy_state must contain a finite STATE_VECTOR.");
    return 3;
  }

  RelativeHillState relative;
  if (!compute_hill_relative_state(chief_state, deputy_state, &relative)) {
    plugin_set_error(
        "unsupported-state",
        "Chief and deputy VCM STATE_VECTOR values must be finite and chief angular momentum must be non-zero.");
    return 3;
  }

  return emit_cdm_relative_hill(chief_vcm, deputy_vcm, chief_metadata, relative);
}

extern "C" int cdm_relative_hill_to_vcm_deputy_state(void) {
  plugin_reset_output_state();

  const plugin_input_frame_t* chief_frame = find_input_frame("chief_state");
  if (chief_frame == nullptr || chief_frame->payload == nullptr || chief_frame->payload_length < 8) {
    plugin_set_error("missing-chief-state", "No VCM chief_state frame was provided.");
    return 3;
  }

  const plugin_input_frame_t* relative_frame = find_input_frame("relative_state");
  if (relative_frame == nullptr || relative_frame->payload == nullptr || relative_frame->payload_length < 8) {
    plugin_set_error("missing-relative-state", "No CDM relative_state frame was provided.");
    return 3;
  }

  ::flatbuffers::Verifier chief_verifier(chief_frame->payload, chief_frame->payload_length);
  if (!VerifyVCMBuffer(chief_verifier)) {
    plugin_set_error("invalid-vcm-buffer", "Input chief_state is not a valid SDS VCM FlatBuffer.");
    return 3;
  }

  if (!CDMBufferHasIdentifier(relative_frame->payload)) {
    plugin_set_error("invalid-cdm-buffer", "Input relative_state is not an SDS CDM FlatBuffer.");
    return 3;
  }
  ::flatbuffers::Verifier relative_verifier(relative_frame->payload, relative_frame->payload_length);
  if (!VerifyCDMBuffer(relative_verifier)) {
    plugin_set_error("invalid-cdm-buffer", "Input relative_state is not a valid SDS CDM FlatBuffer.");
    return 3;
  }

  const VCM* chief_vcm = GetVCM(chief_frame->payload);
  const CDM* relative_cdm = GetCDM(relative_frame->payload);
  CartesianState chief_state;
  OemMetadata chief_metadata;
  if (!extract_vcm_state(chief_vcm, &chief_state, &chief_metadata)) {
    plugin_set_error("missing-chief-state-vector", "VCM chief_state must contain a finite STATE_VECTOR.");
    return 3;
  }

  RelativeHillState relative;
  if (!extract_cdm_relative_state(relative_cdm, &relative)) {
    plugin_set_error("missing-relative-fields", "CDM relative_state must contain finite RTN/Hill relative position and velocity fields.");
    return 3;
  }

  CartesianState deputy_state;
  if (!compute_deputy_from_hill_relative_state(chief_state, relative, &deputy_state)) {
    plugin_set_error(
        "unsupported-state",
        "Chief VCM STATE_VECTOR and CDM relative_state values must be finite and chief angular momentum must be non-zero.");
    return 3;
  }

  return emit_vcm_deputy_state(chief_vcm, relative_cdm, deputy_state);
}
