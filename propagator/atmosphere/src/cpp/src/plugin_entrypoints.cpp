#include "atmosphere/plugin_runtime.h"

#include "atmosphere/models.h"
#include "plugin_manifest_bytes.h"
#include "space_data_module_invoke.h"

#include "flatbuffers/flatbuffers.h"

#include <cstdint>
#include <cstring>
#include <cmath>
#include <vector>
#include <string>
#include <string_view>

#ifdef __EMSCRIPTEN__
#include <emscripten/emscripten.h>
#else
#define EMSCRIPTEN_KEEPALIVE
#endif

namespace {

namespace sds_hfc {

constexpr int8_t kAtmosphericModelFamilyNrlmsis00e = 14;
constexpr int8_t kAtmosphericModelFamilyUssaXx = 16;
constexpr int8_t kHfcAtmosphereCouplingBatchQuery = 2;

struct ATM FLATBUFFERS_FINAL_CLASS : private ::flatbuffers::Table {
    static constexpr ::flatbuffers::voffset_t VT_MODEL = 4;
    static constexpr ::flatbuffers::voffset_t VT_YEAR = 6;

    int8_t MODEL() const {
        return GetField<int8_t>(VT_MODEL, 0);
    }

    int32_t YEAR() const {
        return GetField<int32_t>(VT_YEAR, 0);
    }

    template <bool B = false>
    bool Verify(::flatbuffers::VerifierTemplate<B>& verifier) const {
        return VerifyTableStart(verifier) &&
               VerifyField<int8_t>(verifier, VT_MODEL, 1) &&
               VerifyField<int32_t>(verifier, VT_YEAR, 4) &&
               verifier.EndTable();
    }
};

struct HFC FLATBUFFERS_FINAL_CLASS : private ::flatbuffers::Table {
    static constexpr ::flatbuffers::voffset_t VT_MESSAGE_ID = 4;
    static constexpr ::flatbuffers::voffset_t VT_CREATION_DATE = 6;
    static constexpr ::flatbuffers::voffset_t VT_ORIGINATOR = 8;
    static constexpr ::flatbuffers::voffset_t VT_OBJECT_NAME = 10;
    static constexpr ::flatbuffers::voffset_t VT_TIME_SYSTEM = 12;
    static constexpr ::flatbuffers::voffset_t VT_REF_FRAME = 14;
    static constexpr ::flatbuffers::voffset_t VT_START_TIME = 16;
    static constexpr ::flatbuffers::voffset_t VT_STOP_TIME = 18;
    static constexpr ::flatbuffers::voffset_t VT_STEP_SIZE = 20;
    static constexpr ::flatbuffers::voffset_t VT_ATMOSPHERE = 26;
    static constexpr ::flatbuffers::voffset_t VT_ATMOSPHERE_PROVIDER = 28;
    static constexpr ::flatbuffers::voffset_t VT_ATMOSPHERE_MODEL_REVISION = 30;
    static constexpr ::flatbuffers::voffset_t VT_ATMOSPHERE_COUPLING = 32;
    static constexpr ::flatbuffers::voffset_t VT_STATE_VECTOR_SIZE = 40;
    static constexpr ::flatbuffers::voffset_t VT_SAMPLE_EPOCHS = 44;
    static constexpr ::flatbuffers::voffset_t VT_LATITUDE_DEG = 46;
    static constexpr ::flatbuffers::voffset_t VT_LONGITUDE_DEG = 48;
    static constexpr ::flatbuffers::voffset_t VT_ALTITUDE_M = 50;
    static constexpr ::flatbuffers::voffset_t VT_SPEED_M_PER_S = 52;
    static constexpr ::flatbuffers::voffset_t VT_MACH = 54;
    static constexpr ::flatbuffers::voffset_t VT_DYNAMIC_PRESSURE_PA = 56;
    static constexpr ::flatbuffers::voffset_t VT_DENSITY_KG_PER_M3 = 58;
    static constexpr ::flatbuffers::voffset_t VT_TEMPERATURE_K = 60;
    static constexpr ::flatbuffers::voffset_t VT_PRESSURE_PA = 62;
    static constexpr ::flatbuffers::voffset_t VT_SPEED_OF_SOUND_M_PER_S = 64;
    static constexpr ::flatbuffers::voffset_t VT_COMMENT = 96;

    const ::flatbuffers::String* MESSAGE_ID() const {
        return GetPointer<const ::flatbuffers::String*>(VT_MESSAGE_ID);
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

    const ::flatbuffers::String* TIME_SYSTEM() const {
        return GetPointer<const ::flatbuffers::String*>(VT_TIME_SYSTEM);
    }

    const ::flatbuffers::String* REF_FRAME() const {
        return GetPointer<const ::flatbuffers::String*>(VT_REF_FRAME);
    }

    const ::flatbuffers::String* START_TIME() const {
        return GetPointer<const ::flatbuffers::String*>(VT_START_TIME);
    }

    const ::flatbuffers::String* STOP_TIME() const {
        return GetPointer<const ::flatbuffers::String*>(VT_STOP_TIME);
    }

    double STEP_SIZE() const {
        return GetField<double>(VT_STEP_SIZE, 0.0);
    }

    const ATM* ATMOSPHERE() const {
        return GetPointer<const ATM*>(VT_ATMOSPHERE);
    }

    const ::flatbuffers::Vector<double>* ALTITUDE_M() const {
        return GetPointer<const ::flatbuffers::Vector<double>*>(VT_ALTITUDE_M);
    }

    const ::flatbuffers::Vector<::flatbuffers::Offset<::flatbuffers::String>>* SAMPLE_EPOCHS() const {
        return GetPointer<const ::flatbuffers::Vector<::flatbuffers::Offset<::flatbuffers::String>>*>(
            VT_SAMPLE_EPOCHS);
    }

    const ::flatbuffers::Vector<double>* LATITUDE_DEG() const {
        return GetPointer<const ::flatbuffers::Vector<double>*>(VT_LATITUDE_DEG);
    }

    const ::flatbuffers::Vector<double>* LONGITUDE_DEG() const {
        return GetPointer<const ::flatbuffers::Vector<double>*>(VT_LONGITUDE_DEG);
    }

    const ::flatbuffers::Vector<double>* SPEED_M_PER_S() const {
        return GetPointer<const ::flatbuffers::Vector<double>*>(VT_SPEED_M_PER_S);
    }

    template <bool B = false>
    bool Verify(::flatbuffers::VerifierTemplate<B>& verifier) const {
        return VerifyTableStart(verifier) &&
               VerifyOffset(verifier, VT_MESSAGE_ID) &&
               verifier.VerifyString(MESSAGE_ID()) &&
               VerifyOffset(verifier, VT_CREATION_DATE) &&
               verifier.VerifyString(CREATION_DATE()) &&
               VerifyOffset(verifier, VT_ORIGINATOR) &&
               verifier.VerifyString(ORIGINATOR()) &&
               VerifyOffset(verifier, VT_OBJECT_NAME) &&
               verifier.VerifyString(OBJECT_NAME()) &&
               VerifyOffset(verifier, VT_TIME_SYSTEM) &&
               verifier.VerifyString(TIME_SYSTEM()) &&
               VerifyOffset(verifier, VT_REF_FRAME) &&
               verifier.VerifyString(REF_FRAME()) &&
               VerifyOffset(verifier, VT_START_TIME) &&
               verifier.VerifyString(START_TIME()) &&
               VerifyOffset(verifier, VT_STOP_TIME) &&
               verifier.VerifyString(STOP_TIME()) &&
               VerifyField<double>(verifier, VT_STEP_SIZE, 8) &&
               VerifyOffset(verifier, VT_ATMOSPHERE) &&
               verifier.VerifyTable(ATMOSPHERE()) &&
               VerifyOffset(verifier, VT_SAMPLE_EPOCHS) &&
               verifier.VerifyVectorOfStrings(SAMPLE_EPOCHS()) &&
               VerifyOffset(verifier, VT_LATITUDE_DEG) &&
               verifier.VerifyVector(LATITUDE_DEG()) &&
               VerifyOffset(verifier, VT_LONGITUDE_DEG) &&
               verifier.VerifyVector(LONGITUDE_DEG()) &&
               VerifyOffset(verifier, VT_ALTITUDE_M) &&
               verifier.VerifyVector(ALTITUDE_M()) &&
               VerifyOffset(verifier, VT_SPEED_M_PER_S) &&
               verifier.VerifyVector(SPEED_M_PER_S()) &&
               verifier.EndTable();
    }
};

const HFC* GetHFC(const void* buffer) {
    return ::flatbuffers::GetRoot<HFC>(buffer);
}

bool HFCBufferHasIdentifier(const void* buffer) {
    return ::flatbuffers::BufferHasIdentifier(buffer, "$HFC");
}

bool VerifyHFCBuffer(::flatbuffers::Verifier& verifier) {
    return verifier.VerifyBuffer<HFC>("$HFC");
}

::flatbuffers::Offset<ATM> CreateATM(
        ::flatbuffers::FlatBufferBuilder& builder,
        int8_t model,
        int32_t year) {
    const auto start = builder.StartTable();
    builder.AddElement<int32_t>(ATM::VT_YEAR, year, 0);
    builder.AddElement<int8_t>(ATM::VT_MODEL, model, 0);
    return ::flatbuffers::Offset<ATM>(builder.EndTable(start));
}

::flatbuffers::Offset<HFC> CreateHFC(
        ::flatbuffers::FlatBufferBuilder& builder,
        ::flatbuffers::Offset<::flatbuffers::String> message_id,
        ::flatbuffers::Offset<::flatbuffers::String> creation_date,
        ::flatbuffers::Offset<::flatbuffers::String> originator,
        ::flatbuffers::Offset<::flatbuffers::String> object_name,
        ::flatbuffers::Offset<::flatbuffers::String> time_system,
        ::flatbuffers::Offset<::flatbuffers::String> ref_frame,
        ::flatbuffers::Offset<::flatbuffers::String> start_time,
        ::flatbuffers::Offset<::flatbuffers::String> stop_time,
        double step_size,
        ::flatbuffers::Offset<ATM> atmosphere,
        ::flatbuffers::Offset<::flatbuffers::String> provider,
        ::flatbuffers::Offset<::flatbuffers::String> model_revision,
        ::flatbuffers::Offset<::flatbuffers::Vector<::flatbuffers::Offset<::flatbuffers::String>>> sample_epochs,
        ::flatbuffers::Offset<::flatbuffers::Vector<double>> latitude_deg,
        ::flatbuffers::Offset<::flatbuffers::Vector<double>> longitude_deg,
        ::flatbuffers::Offset<::flatbuffers::Vector<double>> altitude_m,
        ::flatbuffers::Offset<::flatbuffers::Vector<double>> speed_m_per_s,
        ::flatbuffers::Offset<::flatbuffers::Vector<double>> mach,
        ::flatbuffers::Offset<::flatbuffers::Vector<double>> dynamic_pressure,
        ::flatbuffers::Offset<::flatbuffers::Vector<double>> density,
        ::flatbuffers::Offset<::flatbuffers::Vector<double>> temperature,
        ::flatbuffers::Offset<::flatbuffers::Vector<double>> pressure,
        ::flatbuffers::Offset<::flatbuffers::Vector<double>> sound_speed,
        ::flatbuffers::Offset<::flatbuffers::String> comment) {
    const auto start = builder.StartTable();
    builder.AddOffset(HFC::VT_COMMENT, comment);
    builder.AddOffset(HFC::VT_SPEED_OF_SOUND_M_PER_S, sound_speed);
    builder.AddOffset(HFC::VT_PRESSURE_PA, pressure);
    builder.AddOffset(HFC::VT_TEMPERATURE_K, temperature);
    builder.AddOffset(HFC::VT_DENSITY_KG_PER_M3, density);
    builder.AddOffset(HFC::VT_DYNAMIC_PRESSURE_PA, dynamic_pressure);
    builder.AddOffset(HFC::VT_MACH, mach);
    builder.AddOffset(HFC::VT_SPEED_M_PER_S, speed_m_per_s);
    builder.AddOffset(HFC::VT_ALTITUDE_M, altitude_m);
    builder.AddOffset(HFC::VT_LONGITUDE_DEG, longitude_deg);
    builder.AddOffset(HFC::VT_LATITUDE_DEG, latitude_deg);
    builder.AddOffset(HFC::VT_SAMPLE_EPOCHS, sample_epochs);
    builder.AddElement<uint32_t>(HFC::VT_STATE_VECTOR_SIZE, 0, 6);
    builder.AddElement<int8_t>(
        HFC::VT_ATMOSPHERE_COUPLING,
        kHfcAtmosphereCouplingBatchQuery,
        0);
    builder.AddOffset(HFC::VT_ATMOSPHERE_MODEL_REVISION, model_revision);
    builder.AddOffset(HFC::VT_ATMOSPHERE_PROVIDER, provider);
    builder.AddOffset(HFC::VT_ATMOSPHERE, atmosphere);
    builder.AddElement<double>(HFC::VT_STEP_SIZE, step_size, 0.0);
    builder.AddOffset(HFC::VT_STOP_TIME, stop_time);
    builder.AddOffset(HFC::VT_START_TIME, start_time);
    builder.AddOffset(HFC::VT_REF_FRAME, ref_frame);
    builder.AddOffset(HFC::VT_TIME_SYSTEM, time_system);
    builder.AddOffset(HFC::VT_OBJECT_NAME, object_name);
    builder.AddOffset(HFC::VT_ORIGINATOR, originator);
    builder.AddOffset(HFC::VT_CREATION_DATE, creation_date);
    builder.AddOffset(HFC::VT_MESSAGE_ID, message_id);
    return ::flatbuffers::Offset<HFC>(builder.EndTable(start));
}

}  // namespace sds_hfc

namespace sds_spw {

struct SPW FLATBUFFERS_FINAL_CLASS : private ::flatbuffers::Table {
    static constexpr ::flatbuffers::voffset_t VT_DATE = 4;
    static constexpr ::flatbuffers::voffset_t VT_AP1 = 28;
    static constexpr ::flatbuffers::voffset_t VT_AP2 = 30;
    static constexpr ::flatbuffers::voffset_t VT_AP3 = 32;
    static constexpr ::flatbuffers::voffset_t VT_AP4 = 34;
    static constexpr ::flatbuffers::voffset_t VT_AP5 = 36;
    static constexpr ::flatbuffers::voffset_t VT_AP6 = 38;
    static constexpr ::flatbuffers::voffset_t VT_AP7 = 40;
    static constexpr ::flatbuffers::voffset_t VT_AP_AVG = 44;
    static constexpr ::flatbuffers::voffset_t VT_F107_OBS = 52;
    static constexpr ::flatbuffers::voffset_t VT_F107_ADJ = 54;
    static constexpr ::flatbuffers::voffset_t VT_F107_OBS_CENTER81 = 58;
    static constexpr ::flatbuffers::voffset_t VT_F107_ADJ_CENTER81 = 62;

    const ::flatbuffers::String* DATE() const {
        return GetPointer<const ::flatbuffers::String*>(VT_DATE);
    }

    int32_t AP1() const {
        return GetField<int32_t>(VT_AP1, 0);
    }

    int32_t AP2() const {
        return GetField<int32_t>(VT_AP2, 0);
    }

    int32_t AP3() const {
        return GetField<int32_t>(VT_AP3, 0);
    }

    int32_t AP4() const {
        return GetField<int32_t>(VT_AP4, 0);
    }

    int32_t AP5() const {
        return GetField<int32_t>(VT_AP5, 0);
    }

    int32_t AP6() const {
        return GetField<int32_t>(VT_AP6, 0);
    }

    int32_t AP7() const {
        return GetField<int32_t>(VT_AP7, 0);
    }

    int32_t AP_AVG() const {
        return GetField<int32_t>(VT_AP_AVG, 0);
    }

    float F107_OBS() const {
        return GetField<float>(VT_F107_OBS, 0.0f);
    }

    float F107_ADJ() const {
        return GetField<float>(VT_F107_ADJ, 0.0f);
    }

    float F107_OBS_CENTER81() const {
        return GetField<float>(VT_F107_OBS_CENTER81, 0.0f);
    }

    float F107_ADJ_CENTER81() const {
        return GetField<float>(VT_F107_ADJ_CENTER81, 0.0f);
    }

    template <bool B = false>
    bool Verify(::flatbuffers::VerifierTemplate<B>& verifier) const {
        return VerifyTableStart(verifier) &&
               VerifyOffset(verifier, VT_DATE) &&
               verifier.VerifyString(DATE()) &&
               VerifyField<int32_t>(verifier, VT_AP1, 4) &&
               VerifyField<int32_t>(verifier, VT_AP2, 4) &&
               VerifyField<int32_t>(verifier, VT_AP3, 4) &&
               VerifyField<int32_t>(verifier, VT_AP4, 4) &&
               VerifyField<int32_t>(verifier, VT_AP5, 4) &&
               VerifyField<int32_t>(verifier, VT_AP6, 4) &&
               VerifyField<int32_t>(verifier, VT_AP7, 4) &&
               VerifyField<int32_t>(verifier, VT_AP_AVG, 4) &&
               VerifyField<float>(verifier, VT_F107_OBS, 4) &&
               VerifyField<float>(verifier, VT_F107_ADJ, 4) &&
               VerifyField<float>(verifier, VT_F107_OBS_CENTER81, 4) &&
               VerifyField<float>(verifier, VT_F107_ADJ_CENTER81, 4) &&
               verifier.EndTable();
    }
};

const SPW* GetSPW(const void* buffer) {
    return ::flatbuffers::GetRoot<SPW>(buffer);
}

bool SPWBufferHasIdentifier(const void* buffer) {
    return ::flatbuffers::BufferHasIdentifier(buffer, "$SPW");
}

bool VerifySPWBuffer(::flatbuffers::Verifier& verifier) {
    return verifier.VerifyBuffer<SPW>("$SPW");
}

}  // namespace sds_spw

namespace sds_vcm {

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
    static constexpr ::flatbuffers::voffset_t VT_CREATION_DATE = 6;
    static constexpr ::flatbuffers::voffset_t VT_ORIGINATOR = 8;
    static constexpr ::flatbuffers::voffset_t VT_OBJECT_NAME = 10;
    static constexpr ::flatbuffers::voffset_t VT_OBJECT_ID = 12;
    static constexpr ::flatbuffers::voffset_t VT_CENTER_NAME = 14;
    static constexpr ::flatbuffers::voffset_t VT_REF_FRAME = 16;
    static constexpr ::flatbuffers::voffset_t VT_TIME_SYSTEM = 18;
    static constexpr ::flatbuffers::voffset_t VT_STATE_VECTOR = 20;
    static constexpr ::flatbuffers::voffset_t VT_MASS = 34;
    static constexpr ::flatbuffers::voffset_t VT_DRAG_AREA = 40;
    static constexpr ::flatbuffers::voffset_t VT_DRAG_COEFF = 42;

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

    double MASS() const {
        return GetField<double>(VT_MASS, 0.0);
    }

    double DRAG_AREA() const {
        return GetField<double>(VT_DRAG_AREA, 0.0);
    }

    double DRAG_COEFF() const {
        return GetField<double>(VT_DRAG_COEFF, 0.0);
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
               VerifyOffset(verifier, VT_REF_FRAME) &&
               verifier.VerifyString(REF_FRAME()) &&
               VerifyOffset(verifier, VT_TIME_SYSTEM) &&
               verifier.VerifyString(TIME_SYSTEM()) &&
               VerifyOffset(verifier, VT_STATE_VECTOR) &&
               verifier.VerifyTable(STATE_VECTOR()) &&
               VerifyField<double>(verifier, VT_MASS, 8) &&
               VerifyField<double>(verifier, VT_DRAG_AREA, 8) &&
               VerifyField<double>(verifier, VT_DRAG_COEFF, 8) &&
               verifier.EndTable();
    }
};

const VCM* GetVCM(const void* buffer) {
    return ::flatbuffers::GetRoot<VCM>(buffer);
}

bool VerifyVCMBuffer(::flatbuffers::Verifier& verifier) {
    return verifier.VerifyBuffer<VCM>(nullptr);
}

}  // namespace sds_vcm

namespace sds_oem {

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
};

struct ephemerisDataBlock FLATBUFFERS_FINAL_CLASS : private ::flatbuffers::Table {
    static constexpr ::flatbuffers::voffset_t VT_COMMENT = 4;
    static constexpr ::flatbuffers::voffset_t VT_CENTER_NAME = 8;
    static constexpr ::flatbuffers::voffset_t VT_TIME_SYSTEM = 16;
    static constexpr ::flatbuffers::voffset_t VT_START_TIME = 18;
    static constexpr ::flatbuffers::voffset_t VT_STOP_TIME = 24;
    static constexpr ::flatbuffers::voffset_t VT_STATE_VECTOR_SIZE = 32;
    static constexpr ::flatbuffers::voffset_t VT_EPHEMERIS_DATA_LINES = 36;
};

struct OEM FLATBUFFERS_FINAL_CLASS : private ::flatbuffers::Table {
    static constexpr ::flatbuffers::voffset_t VT_CLASSIFICATION = 4;
    static constexpr ::flatbuffers::voffset_t VT_CCSDS_OEM_VERS = 6;
    static constexpr ::flatbuffers::voffset_t VT_CREATION_DATE = 8;
    static constexpr ::flatbuffers::voffset_t VT_ORIGINATOR = 10;
    static constexpr ::flatbuffers::voffset_t VT_EPHEMERIS_DATA_BLOCK = 12;
};

::flatbuffers::Offset<ephemerisDataLine> CreateEphemerisDataLine(
        ::flatbuffers::FlatBufferBuilder& builder,
        ::flatbuffers::Offset<::flatbuffers::String> epoch,
        double x,
        double y,
        double z,
        double x_dot,
        double y_dot,
        double z_dot,
        double x_ddot,
        double y_ddot,
        double z_ddot) {
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
        uint8_t state_vector_size) {
    const auto start = builder.StartTable();
    builder.AddOffset(ephemerisDataBlock::VT_EPHEMERIS_DATA_LINES, lines);
    builder.AddElement<uint8_t>(ephemerisDataBlock::VT_STATE_VECTOR_SIZE, state_vector_size, 6);
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
    builder.AddOffset(OEM::VT_EPHEMERIS_DATA_BLOCK, blocks);
    builder.AddOffset(OEM::VT_ORIGINATOR, originator);
    builder.AddOffset(OEM::VT_CREATION_DATE, creation_date);
    builder.AddElement<double>(OEM::VT_CCSDS_OEM_VERS, version, 0.0);
    builder.AddOffset(OEM::VT_CLASSIFICATION, classification);
    return ::flatbuffers::Offset<OEM>(builder.EndTable(start));
}

}  // namespace sds_oem

constexpr double kDegreesToRadians = 3.141592653589793238462643383279502884 / 180.0;
constexpr double kKilometersToMeters = 1000.0;
constexpr double kMetersPerSecondToKilometersPerSecond = 0.001;

struct HfcModelSelection {
    atmosphere::Model model = atmosphere::Model::US76;
    int8_t family = sds_hfc::kAtmosphericModelFamilyUssaXx;
    int32_t year = 1976;
    const char* revision = "US76";
};

bool parse_digits(std::string_view value, size_t offset, size_t count, int32_t& output) {
    if (value.size() < offset + count) {
        return false;
    }

    int32_t parsed = 0;
    for (size_t index = 0; index < count; ++index) {
        const char ch = value[offset + index];
        if (ch < '0' || ch > '9') {
            return false;
        }
        parsed = parsed * 10 + static_cast<int32_t>(ch - '0');
    }
    output = parsed;
    return true;
}

bool is_leap_year(int32_t year) {
    return (year % 4 == 0 && year % 100 != 0) || (year % 400 == 0);
}

int32_t days_in_month(int32_t year, int32_t month) {
    switch (month) {
        case 1:
        case 3:
        case 5:
        case 7:
        case 8:
        case 10:
        case 12:
            return 31;
        case 4:
        case 6:
        case 9:
        case 11:
            return 30;
        case 2:
            return is_leap_year(year) ? 29 : 28;
        default:
            return 0;
    }
}

int32_t day_of_year(int32_t year, int32_t month, int32_t day) {
    int32_t doy = day;
    for (int32_t current_month = 1; current_month < month; ++current_month) {
        doy += days_in_month(year, current_month);
    }
    return doy;
}

bool parse_hfc_sample_epoch(const ::flatbuffers::String* value, atmosphere::Epoch& epoch) {
    if (!value) {
        return false;
    }

    const std::string_view text(value->c_str(), value->size());
    if (text.size() < 20 ||
        text[4] != '-' ||
        text[7] != '-' ||
        text[10] != 'T' ||
        text[13] != ':' ||
        text[16] != ':') {
        return false;
    }

    int32_t year = 0;
    int32_t month = 0;
    int32_t day = 0;
    int32_t hour = 0;
    int32_t minute = 0;
    int32_t second = 0;
    if (!parse_digits(text, 0, 4, year) ||
        !parse_digits(text, 5, 2, month) ||
        !parse_digits(text, 8, 2, day) ||
        !parse_digits(text, 11, 2, hour) ||
        !parse_digits(text, 14, 2, minute) ||
        !parse_digits(text, 17, 2, second)) {
        return false;
    }

    double fractional_seconds = 0.0;
    size_t cursor = 19;
    if (cursor < text.size() && text[cursor] == '.') {
        ++cursor;
        double place = 0.1;
        if (cursor >= text.size() || text[cursor] < '0' || text[cursor] > '9') {
            return false;
        }
        while (cursor < text.size() && text[cursor] >= '0' && text[cursor] <= '9') {
            fractional_seconds += static_cast<double>(text[cursor] - '0') * place;
            place *= 0.1;
            ++cursor;
        }
    }

    if (cursor >= text.size() || text[cursor] != 'Z' || cursor + 1 != text.size()) {
        return false;
    }

    const int32_t month_days = days_in_month(year, month);
    if (month_days == 0 ||
        day < 1 ||
        day > month_days ||
        hour < 0 ||
        hour > 23 ||
        minute < 0 ||
        minute > 59 ||
        second < 0 ||
        second > 60) {
        return false;
    }

    epoch.year = year;
    epoch.dayOfYear = day_of_year(year, month, day);
    epoch.secondOfDay = static_cast<double>(hour * 3600 + minute * 60 + second) + fractional_seconds;
    return true;
}

atmosphere::SolarActivity solar_activity_from_spw(const sds_spw::SPW* record) {
    atmosphere::SolarActivity solar{};
    if (!record) {
        return solar;
    }

    const double f107 = record->F107_ADJ() > 0.0f ? record->F107_ADJ() : record->F107_OBS();
    if (f107 > 0.0) {
        solar.F107 = f107;
    }

    const double f107a = record->F107_ADJ_CENTER81() > 0.0f
        ? record->F107_ADJ_CENTER81()
        : record->F107_OBS_CENTER81();
    if (f107a > 0.0) {
        solar.F107A = f107a;
    } else if (f107 > 0.0) {
        solar.F107A = f107;
    }

    const int32_t ap = record->AP_AVG() != 0 ? record->AP_AVG() : record->AP1();
    solar.Ap[0] = static_cast<double>(ap);
    solar.Ap[1] = static_cast<double>(record->AP1());
    solar.Ap[2] = static_cast<double>(record->AP2());
    solar.Ap[3] = static_cast<double>(record->AP3());
    solar.Ap[4] = static_cast<double>(record->AP4());
    solar.Ap[5] = static_cast<double>(record->AP5());
    solar.Ap[6] = static_cast<double>(record->AP6());
    return solar;
}

const plugin_input_frame_t* find_frame(const char* port_id) {
    const auto count = plugin_get_input_count();
    for (uint32_t index = 0; index < count; ++index) {
        const auto* frame = plugin_get_input_frame(index);
        if (frame && frame->port_id && std::string(frame->port_id) == port_id) {
            return frame;
        }
    }
    return nullptr;
}

const plugin_input_frame_t* find_request_frame() {
    return find_frame("request");
}

::flatbuffers::Offset<::flatbuffers::String> copy_optional_string(
        ::flatbuffers::FlatBufferBuilder& builder,
        const ::flatbuffers::String* value) {
    return value ? builder.CreateString(value->c_str(), value->size()) : 0;
}

const char* flatbuffer_string_or_null(const ::flatbuffers::String* value) {
    return value ? value->c_str() : nullptr;
}

bool finite3(double x, double y, double z) {
    return std::isfinite(x) && std::isfinite(y) && std::isfinite(z);
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

::flatbuffers::Offset<::flatbuffers::Vector<::flatbuffers::Offset<::flatbuffers::String>>>
copy_optional_string_vector(
        ::flatbuffers::FlatBufferBuilder& builder,
        const ::flatbuffers::Vector<::flatbuffers::Offset<::flatbuffers::String>>* values) {
    if (!values || values->size() == 0) {
        return 0;
    }

    std::vector<::flatbuffers::Offset<::flatbuffers::String>> offsets;
    offsets.reserve(values->size());
    for (uint32_t index = 0; index < values->size(); ++index) {
        const auto* value = values->Get(index);
        offsets.push_back(value ? builder.CreateString(value->c_str(), value->size()) : 0);
    }
    return builder.CreateVector(offsets);
}

HfcModelSelection select_hfc_model(const sds_hfc::ATM* atmosphere) {
    HfcModelSelection selection{};
    if (!atmosphere) {
        return selection;
    }

    selection.family = atmosphere->MODEL();
    selection.year = atmosphere->YEAR();
    if (selection.family == sds_hfc::kAtmosphericModelFamilyNrlmsis00e) {
        selection.model = atmosphere::Model::NRLMSISE00;
        selection.year = selection.year > 0 ? selection.year : 2000;
        selection.revision = "NRLMSISE00";
        return selection;
    }

    selection.family = sds_hfc::kAtmosphericModelFamilyUssaXx;
    selection.year = selection.year > 0 ? selection.year : 1976;
    selection.revision = "US76";
    return selection;
}

int emit_json_response(const char* port_id, const atmosphere::PluginInvokeResult& result) {
    if (!result.ok) {
        plugin_set_error(result.error_code.c_str(), result.error_message.c_str());
        return 1;
    }

    const auto* payload = reinterpret_cast<const uint8_t*>(result.json.data());
    if (plugin_push_output(port_id, nullptr, nullptr, payload,
                           static_cast<uint32_t>(result.json.size())) < 0) {
        plugin_set_error("emit-failed", "Failed to emit response frame.");
        return 1;
    }

    return 0;
}

int emit_drag_oem(
        const sds_vcm::VCM* vcm,
        const sds_vcm::VCMStateVector* state_vector,
        const double acceleration_km_per_s2[3]) {
    const char* epoch = flatbuffer_string_or_null(state_vector->EPOCH());
    if (epoch == nullptr) {
        plugin_set_error("missing-state-vector-epoch", "VCM STATE_VECTOR.EPOCH is required for OEM output.");
        return 1;
    }

    ::flatbuffers::FlatBufferBuilder builder(1024);
    const auto epoch_offset = builder.CreateString(epoch);
    const auto center_name = builder.CreateString(
        flatbuffer_string_or_null(vcm->CENTER_NAME()) != nullptr
            ? flatbuffer_string_or_null(vcm->CENTER_NAME())
            : "EARTH");
    const auto comment = builder.CreateString(
        "Basilisk orbitalMotion.c atmosphericDrag acceleration from SDS VCM spacecraft state.");
    const auto line = sds_oem::CreateEphemerisDataLine(
        builder,
        epoch_offset,
        state_vector->X(),
        state_vector->Y(),
        state_vector->Z(),
        state_vector->X_DOT(),
        state_vector->Y_DOT(),
        state_vector->Z_DOT(),
        acceleration_km_per_s2[0],
        acceleration_km_per_s2[1],
        acceleration_km_per_s2[2]);
    const std::vector<::flatbuffers::Offset<sds_oem::ephemerisDataLine>> line_entries = {line};
    const auto line_vector = builder.CreateVector(line_entries);
    const auto block = sds_oem::CreateEphemerisDataBlock(
        builder,
        comment,
        center_name,
        timing_standard_from_string(flatbuffer_string_or_null(vcm->TIME_SYSTEM())),
        epoch_offset,
        epoch_offset,
        line_vector,
        9);
    const std::vector<::flatbuffers::Offset<sds_oem::ephemerisDataBlock>> block_entries = {block};
    const auto block_vector = builder.CreateVector(block_entries);
    const auto classification = builder.CreateString("U");
    const auto creation_date = builder.CreateString(
        flatbuffer_string_or_null(vcm->CREATION_DATE()) != nullptr
            ? flatbuffer_string_or_null(vcm->CREATION_DATE())
            : "2026-05-26T00:00:00Z");
    const auto originator = builder.CreateString("DigitalArsenal propagator/atmosphere");
    const auto oem = sds_oem::CreateOEM(
        builder,
        classification,
        2.0,
        creation_date,
        originator,
        block_vector);
    builder.Finish(oem, "$OEM");

    if (plugin_push_output_typed(
            "drag_acceleration",
            "OEM.fbs",
            "$OEM",
            PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER,
            "OEM",
            0,
            static_cast<uint32_t>(builder.GetSize()),
            8,
            builder.GetBufferPointer(),
            static_cast<uint32_t>(builder.GetSize())) < 0) {
        plugin_set_error("emit-failed", "Failed to emit OEM drag acceleration.");
        return 1;
    }

    return 0;
}

int vcm_state_to_drag_acceleration_oem_impl(const plugin_input_frame_t* frame) {
    if (frame->payload_length < 8) {
        plugin_set_error("invalid-vcm-buffer", "Input vector_state frame is too small to be a VCM FlatBuffer.");
        return 1;
    }

    ::flatbuffers::Verifier verifier(frame->payload, frame->payload_length);
    if (!sds_vcm::VerifyVCMBuffer(verifier)) {
        plugin_set_error("invalid-vcm-buffer", "Input vector_state frame is not a valid SDS VCM FlatBuffer.");
        return 1;
    }

    const auto* vcm = sds_vcm::GetVCM(frame->payload);
    const auto* state_vector = vcm ? vcm->STATE_VECTOR() : nullptr;
    if (state_vector == nullptr) {
        plugin_set_error("missing-vcm-state-vector", "VCM STATE_VECTOR is required for atmospheric drag.");
        return 1;
    }

    if (!finite3(state_vector->X(), state_vector->Y(), state_vector->Z()) ||
        !finite3(state_vector->X_DOT(), state_vector->Y_DOT(), state_vector->Z_DOT())) {
        plugin_set_error("invalid-vcm-state-vector", "VCM STATE_VECTOR position and velocity must be finite.");
        return 1;
    }

    const double mass_kg = vcm->MASS();
    const double drag_area_m2 = vcm->DRAG_AREA();
    const double drag_coefficient = vcm->DRAG_COEFF();
    if (!std::isfinite(mass_kg) || !std::isfinite(drag_area_m2) ||
        !std::isfinite(drag_coefficient) || mass_kg <= 0.0 ||
        drag_area_m2 < 0.0 || drag_coefficient < 0.0) {
        plugin_set_error(
            "invalid-drag-parameters",
            "VCM MASS, DRAG_AREA, and DRAG_COEFF must be finite non-negative values with positive MASS.");
        return 1;
    }

    const double position_m[3] = {
        state_vector->X() * kKilometersToMeters,
        state_vector->Y() * kKilometersToMeters,
        state_vector->Z() * kKilometersToMeters};
    const double velocity_m_per_s[3] = {
        state_vector->X_DOT() * kKilometersToMeters,
        state_vector->Y_DOT() * kKilometersToMeters,
        state_vector->Z_DOT() * kKilometersToMeters};
    double acceleration_m_per_s2[3] = {0.0, 0.0, 0.0};
    atmosphere::basiliskAtmosphericDragAcceleration(
        drag_coefficient,
        drag_area_m2,
        mass_kg,
        position_m,
        velocity_m_per_s,
        acceleration_m_per_s2);
    if (!finite3(acceleration_m_per_s2[0], acceleration_m_per_s2[1], acceleration_m_per_s2[2])) {
        plugin_set_error("invalid-drag-state", "Atmospheric drag computation produced a non-finite acceleration.");
        return 1;
    }

    const double acceleration_km_per_s2[3] = {
        acceleration_m_per_s2[0] * kMetersPerSecondToKilometersPerSecond,
        acceleration_m_per_s2[1] * kMetersPerSecondToKilometersPerSecond,
        acceleration_m_per_s2[2] * kMetersPerSecondToKilometersPerSecond};
    return emit_drag_oem(vcm, state_vector, acceleration_km_per_s2);
}

int query_atmosphere_state_batch_hfc(const plugin_input_frame_t* frame) {
    if (frame->payload_length < 8 || !sds_hfc::HFCBufferHasIdentifier(frame->payload)) {
        return -1;
    }

    ::flatbuffers::Verifier verifier(frame->payload, frame->payload_length);
    if (!sds_hfc::VerifyHFCBuffer(verifier)) {
        plugin_set_error("invalid-hfc-buffer", "Input atmosphere frame is not a valid SDS HFC FlatBuffer.");
        return 1;
    }

    const auto* request = sds_hfc::GetHFC(frame->payload);
    const auto* altitudes = request ? request->ALTITUDE_M() : nullptr;
    const auto* sample_epochs = request ? request->SAMPLE_EPOCHS() : nullptr;
    const auto* latitudes = request ? request->LATITUDE_DEG() : nullptr;
    const auto* longitudes = request ? request->LONGITUDE_DEG() : nullptr;
    const auto* speeds = request ? request->SPEED_M_PER_S() : nullptr;
    if (!altitudes || altitudes->size() == 0) {
        plugin_set_error("missing-altitude-samples", "HFC atmosphere query requires ALTITUDE_M samples.");
        return 1;
    }
    if (sample_epochs && sample_epochs->size() > 0 && sample_epochs->size() != altitudes->size()) {
        plugin_set_error(
            "mismatched-sample-epochs",
            "HFC SAMPLE_EPOCHS must be empty or match ALTITUDE_M sample count.");
        return 1;
    }
    if (latitudes && latitudes->size() > 0 && latitudes->size() != altitudes->size()) {
        plugin_set_error(
            "mismatched-latitude-samples",
            "HFC LATITUDE_DEG must be empty or match ALTITUDE_M sample count.");
        return 1;
    }
    if (longitudes && longitudes->size() > 0 && longitudes->size() != altitudes->size()) {
        plugin_set_error(
            "mismatched-longitude-samples",
            "HFC LONGITUDE_DEG must be empty or match ALTITUDE_M sample count.");
        return 1;
    }
    if (speeds && speeds->size() > 0 && speeds->size() != altitudes->size()) {
        plugin_set_error(
            "mismatched-speed-samples",
            "HFC SPEED_M_PER_S must be empty or match ALTITUDE_M sample count.");
        return 1;
    }

    const auto selection = select_hfc_model(request->ATMOSPHERE());
    const sds_spw::SPW* space_weather = nullptr;
    const auto* space_weather_frame = find_frame("space_weather");
    if (space_weather_frame && space_weather_frame->payload) {
        if (space_weather_frame->payload_length < 8 ||
            !sds_spw::SPWBufferHasIdentifier(space_weather_frame->payload)) {
            plugin_set_error("invalid-spw-buffer", "Input space_weather frame is not an SDS SPW FlatBuffer.");
            return 1;
        }

        ::flatbuffers::Verifier space_weather_verifier(
            space_weather_frame->payload,
            space_weather_frame->payload_length);
        if (!sds_spw::VerifySPWBuffer(space_weather_verifier)) {
            plugin_set_error("invalid-spw-buffer", "Input space_weather frame is not a valid SDS SPW FlatBuffer.");
            return 1;
        }
        space_weather = sds_spw::GetSPW(space_weather_frame->payload);
    }

    const auto solar_activity = solar_activity_from_spw(space_weather);
    std::vector<double> altitude_values;
    std::vector<double> latitude_values;
    std::vector<double> longitude_values;
    std::vector<double> speed_values;
    std::vector<double> mach_values;
    std::vector<double> dynamic_pressure_values;
    std::vector<double> density_values;
    std::vector<double> temperature_values;
    std::vector<double> pressure_values;
    std::vector<double> sound_speed_values;
    altitude_values.reserve(altitudes->size());
    density_values.reserve(altitudes->size());
    temperature_values.reserve(altitudes->size());
    pressure_values.reserve(altitudes->size());
    sound_speed_values.reserve(altitudes->size());
    if (latitudes && latitudes->size() > 0) {
        latitude_values.reserve(latitudes->size());
    }
    if (longitudes && longitudes->size() > 0) {
        longitude_values.reserve(longitudes->size());
    }
    if (speeds && speeds->size() > 0) {
        speed_values.reserve(speeds->size());
        mach_values.reserve(speeds->size());
        dynamic_pressure_values.reserve(speeds->size());
    }

    for (uint32_t index = 0; index < altitudes->size(); ++index) {
        const double altitude_m = altitudes->Get(index);
        atmosphere::State state{};
        if (selection.model == atmosphere::Model::NRLMSISE00) {
            atmosphere::GeoPos position{};
            position.alt_m = altitude_m;
            if (latitudes && latitudes->size() > 0) {
                position.lat_rad = latitudes->Get(index) * kDegreesToRadians;
            }
            if (longitudes && longitudes->size() > 0) {
                position.lon_rad = longitudes->Get(index) * kDegreesToRadians;
            }

            atmosphere::Epoch epoch{};
            if (sample_epochs && sample_epochs->size() > 0 &&
                !parse_hfc_sample_epoch(sample_epochs->Get(index), epoch)) {
                const std::string message =
                    "HFC SAMPLE_EPOCHS[" + std::to_string(index) +
                    "] must be an ISO-8601 UTC timestamp like YYYY-MM-DDTHH:MM:SSZ.";
                plugin_set_error("invalid-sample-epoch", message.c_str());
                return 1;
            }

            state = atmosphere::getAtmosphere(position, epoch, solar_activity, selection.model);
        } else {
            state = atmosphere::getAtmosphere(altitude_m, selection.model);
            if (altitude_m >= 100000.0) {
                state.density = atmosphere::standardAtmosphere1976OrbitalDensity(altitude_m);
            }
        }
        altitude_values.push_back(altitude_m);
        density_values.push_back(state.density);
        temperature_values.push_back(state.temperature);
        pressure_values.push_back(state.pressure);
        sound_speed_values.push_back(state.soundSpeed);
        if (latitudes && latitudes->size() > 0) {
            latitude_values.push_back(latitudes->Get(index));
        }
        if (longitudes && longitudes->size() > 0) {
            longitude_values.push_back(longitudes->Get(index));
        }
        if (speeds && speeds->size() > 0) {
            const double speed_m_per_s = speeds->Get(index);
            speed_values.push_back(speed_m_per_s);
            dynamic_pressure_values.push_back(
                atmosphere::dynamicPressure(state.density, speed_m_per_s));
            mach_values.push_back(
                atmosphere::machNumber(speed_m_per_s, state.soundSpeed));
        }
    }

    ::flatbuffers::FlatBufferBuilder builder(1024 + altitude_values.size() * 64);
    const auto message_id = copy_optional_string(builder, request->MESSAGE_ID());
    const auto creation_date = copy_optional_string(builder, request->CREATION_DATE());
    const auto originator = copy_optional_string(builder, request->ORIGINATOR());
    const auto object_name = copy_optional_string(builder, request->OBJECT_NAME());
    const auto time_system = copy_optional_string(builder, request->TIME_SYSTEM());
    const auto ref_frame = copy_optional_string(builder, request->REF_FRAME());
    const auto start_time = copy_optional_string(builder, request->START_TIME());
    const auto stop_time = copy_optional_string(builder, request->STOP_TIME());
    const auto provider = builder.CreateString("atmosphere-model");
    const auto model_revision = builder.CreateString(selection.revision);
    const auto comment = builder.CreateString("Atmosphere state batch computed from an SDS HFC ALTITUDE_M query.");
    const auto atmosphere = sds_hfc::CreateATM(builder, selection.family, selection.year);
    const auto sample_epochs_vector = copy_optional_string_vector(builder, sample_epochs);
    ::flatbuffers::Offset<::flatbuffers::Vector<double>> latitude_vector = 0;
    if (!latitude_values.empty()) {
        latitude_vector = builder.CreateVector(latitude_values);
    }
    ::flatbuffers::Offset<::flatbuffers::Vector<double>> longitude_vector = 0;
    if (!longitude_values.empty()) {
        longitude_vector = builder.CreateVector(longitude_values);
    }
    const auto altitude_vector = builder.CreateVector(altitude_values);
    const auto speed_vector = speed_values.empty() ? 0 : builder.CreateVector(speed_values);
    const auto mach_vector = mach_values.empty() ? 0 : builder.CreateVector(mach_values);
    const auto dynamic_pressure_vector = dynamic_pressure_values.empty()
        ? 0
        : builder.CreateVector(dynamic_pressure_values);
    const auto density_vector = builder.CreateVector(density_values);
    const auto temperature_vector = builder.CreateVector(temperature_values);
    const auto pressure_vector = builder.CreateVector(pressure_values);
    const auto sound_speed_vector = builder.CreateVector(sound_speed_values);
    const auto hfc = sds_hfc::CreateHFC(
        builder,
        message_id,
        creation_date,
        originator,
        object_name,
        time_system,
        ref_frame,
        start_time,
        stop_time,
        request->STEP_SIZE(),
        atmosphere,
        provider,
        model_revision,
        sample_epochs_vector,
        latitude_vector,
        longitude_vector,
        altitude_vector,
        speed_vector,
        mach_vector,
        dynamic_pressure_vector,
        density_vector,
        temperature_vector,
        pressure_vector,
        sound_speed_vector,
        comment);
    builder.Finish(hfc, "$HFC");

    if (plugin_push_output_typed(
            "states",
            "HFC.fbs",
            "$HFC",
            PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER,
            "HFC",
            0,
            static_cast<uint32_t>(builder.GetSize()),
            8,
            builder.GetBufferPointer(),
            static_cast<uint32_t>(builder.GetSize())) < 0) {
        plugin_set_error("emit-failed", "Failed to emit HFC atmosphere states.");
        return 1;
    }

    return 0;
}

}  // namespace

extern "C" {

EMSCRIPTEN_KEEPALIVE
const uint8_t* plugin_get_manifest_flatbuffer(void) {
    return atmosphere_plugin_manifest_bytes;
}

EMSCRIPTEN_KEEPALIVE
uint32_t plugin_get_manifest_flatbuffer_size(void) {
    return atmosphere_plugin_manifest_bytes_len;
}

EMSCRIPTEN_KEEPALIVE
int invoke(void) {
    plugin_reset_output_state();

    const auto* frame = find_request_frame();
    if (!frame || !frame->payload) {
        plugin_set_error("missing-request-input", "Input port \"request\" is required.");
        return 1;
    }

    const auto result = atmosphere::invoke_json_request(
        std::string_view(
            reinterpret_cast<const char*>(frame->payload),
            frame->payload_length));

    return emit_json_response("response", result);
}

EMSCRIPTEN_KEEPALIVE
int query_atmosphere_state_batch(void) {
    plugin_reset_output_state();

    const auto* frame = find_frame("atmosphere");
    if (!frame || !frame->payload) {
        plugin_set_error("missing-atmosphere-input", "Input port \"atmosphere\" is required.");
        return 1;
    }

    const int hfc_result = query_atmosphere_state_batch_hfc(frame);
    if (hfc_result >= 0) {
        return hfc_result;
    }

    const std::string request =
        std::string("{\"operation\":\"queryAtmosphereStateBatch\",\"params\":") +
        std::string(reinterpret_cast<const char*>(frame->payload), frame->payload_length) +
        "}";
    const auto result = atmosphere::invoke_json_request(request);

    return emit_json_response("states", result);
}

EMSCRIPTEN_KEEPALIVE
int vcm_state_to_drag_acceleration_oem(void) {
    plugin_reset_output_state();

    const auto* frame = find_frame("vector_state");
    if (!frame || !frame->payload) {
        plugin_set_error("missing-vector-state-input", "Input port \"vector_state\" is required.");
        return 1;
    }

    return vcm_state_to_drag_acceleration_oem_impl(frame);
}

}  // extern "C"
