import * as flatbuffers from 'flatbuffers';
import { PCFEcom2, PCFEcom2T } from './PCFEcom2.js';
import { PCFSpaceWeather, PCFSpaceWeatherT } from './PCFSpaceWeather.js';
import { evlShadowModel } from './evlShadowModel.js';
import { pcfAtmosphereFamily } from './pcfAtmosphereFamily.js';
import { pcfDensityCorrection } from './pcfDensityCorrection.js';
import { pcfEarthRadiationModel } from './pcfEarthRadiationModel.js';
import { pcfEphemerisKind } from './pcfEphemerisKind.js';
import { pcfGnssSpacecraftBlock } from './pcfGnssSpacecraftBlock.js';
import { pcfGravitySelection } from './pcfGravitySelection.js';
import { pcfNeutralWind } from './pcfNeutralWind.js';
import { pcfOceanTideModel } from './pcfOceanTideModel.js';
import { pcfRadiationPressureFamily } from './pcfRadiationPressureFamily.js';
import { pcfRelativityTerms } from './pcfRelativityTerms.js';
import { pcfSolidTideModel } from './pcfSolidTideModel.js';
import { pcfWeatherExtension } from './pcfWeatherExtension.js';
import { pcfWeatherSource } from './pcfWeatherSource.js';
export class PCFForceModel {
    bb = null;
    bb_pos = 0;
    __init(i, bb) {
        this.bb_pos = i;
        this.bb = bb;
        return this;
    }
    static getRootAsPCFForceModel(bb, obj) {
        return (obj || new PCFForceModel()).__init(bb.readInt32(bb.position()) + bb.position(), bb);
    }
    static getSizePrefixedRootAsPCFForceModel(bb, obj) {
        bb.setPosition(bb.position() + flatbuffers.SIZE_PREFIX_LENGTH);
        return (obj || new PCFForceModel()).__init(bb.readInt32(bb.position()) + bb.position(), bb);
    }
    GRAVITY_CHOICE() {
        const offset = this.bb.__offset(this.bb_pos, 4);
        return offset ? this.bb.readUint8(this.bb_pos + offset) : pcfGravitySelection.INFER_FLAGS;
    }
    ENABLE_POINT_MASS() {
        const offset = this.bb.__offset(this.bb_pos, 6);
        return offset ? !!this.bb.readInt8(this.bb_pos + offset) : true;
    }
    GRAVITATIONAL_PARAMETER() {
        const offset = this.bb.__offset(this.bb_pos, 8);
        return offset ? this.bb.readFloat64(this.bb_pos + offset) : 0.0;
    }
    ENABLE_J2() {
        const offset = this.bb.__offset(this.bb_pos, 10);
        return offset ? !!this.bb.readInt8(this.bb_pos + offset) : true;
    }
    ENABLE_J3() {
        const offset = this.bb.__offset(this.bb_pos, 12);
        return offset ? !!this.bb.readInt8(this.bb_pos + offset) : false;
    }
    ENABLE_J4() {
        const offset = this.bb.__offset(this.bb_pos, 14);
        return offset ? !!this.bb.readInt8(this.bb_pos + offset) : false;
    }
    ENABLE_HIGHER_ZONALS() {
        const offset = this.bb.__offset(this.bb_pos, 16);
        return offset ? !!this.bb.readInt8(this.bb_pos + offset) : false;
    }
    MAXIMUM_DEGREE() {
        const offset = this.bb.__offset(this.bb_pos, 18);
        return offset ? this.bb.readUint16(this.bb_pos + offset) : 0;
    }
    HAS_MAXIMUM_DEGREE() {
        const offset = this.bb.__offset(this.bb_pos, 20);
        return offset ? !!this.bb.readInt8(this.bb_pos + offset) : false;
    }
    MAXIMUM_ORDER() {
        const offset = this.bb.__offset(this.bb_pos, 22);
        return offset ? this.bb.readUint16(this.bb_pos + offset) : 0;
    }
    HAS_MAXIMUM_ORDER() {
        const offset = this.bb.__offset(this.bb_pos, 24);
        return offset ? !!this.bb.readInt8(this.bb_pos + offset) : false;
    }
    ENABLE_THIRD_BODY() {
        const offset = this.bb.__offset(this.bb_pos, 26);
        return offset ? !!this.bb.readInt8(this.bb_pos + offset) : false;
    }
    THIRD_BODY_IDS(index) {
        const offset = this.bb.__offset(this.bb_pos, 28);
        return offset ? this.bb.readInt32(this.bb.__vector(this.bb_pos + offset) + index * 4) : 0;
    }
    thirdBodyIdsLength() {
        const offset = this.bb.__offset(this.bb_pos, 28);
        return offset ? this.bb.__vector_len(this.bb_pos + offset) : 0;
    }
    thirdBodyIdsArray() {
        const offset = this.bb.__offset(this.bb_pos, 28);
        return offset ? new Int32Array(this.bb.bytes().buffer, this.bb.bytes().byteOffset + this.bb.__vector(this.bb_pos + offset), this.bb.__vector_len(this.bb_pos + offset)) : null;
    }
    ENABLE_SRP() {
        const offset = this.bb.__offset(this.bb_pos, 30);
        return offset ? !!this.bb.readInt8(this.bb_pos + offset) : false;
    }
    ENABLE_DRAG() {
        const offset = this.bb.__offset(this.bb_pos, 32);
        return offset ? !!this.bb.readInt8(this.bb_pos + offset) : false;
    }
    INITIAL_MASS_KG() {
        const offset = this.bb.__offset(this.bb_pos, 34);
        return offset ? this.bb.readFloat64(this.bb_pos + offset) : 1000.0;
    }
    AREA_M2() {
        const offset = this.bb.__offset(this.bb_pos, 36);
        return offset ? this.bb.readFloat64(this.bb_pos + offset) : 10.0;
    }
    REFLECTIVITY_COEFFICIENT() {
        const offset = this.bb.__offset(this.bb_pos, 38);
        return offset ? this.bb.readFloat64(this.bb_pos + offset) : 1.5;
    }
    DRAG_COEFFICIENT() {
        const offset = this.bb.__offset(this.bb_pos, 40);
        return offset ? this.bb.readFloat64(this.bb_pos + offset) : 2.2;
    }
    ATMOSPHERE_MODEL() {
        const offset = this.bb.__offset(this.bb_pos, 42);
        return offset ? this.bb.readUint8(this.bb_pos + offset) : pcfAtmosphereFamily.NRLMSISE00;
    }
    WEATHER(obj) {
        const offset = this.bb.__offset(this.bb_pos, 44);
        return offset ? (obj || new PCFSpaceWeather()).__init(this.bb.__indirect(this.bb_pos + offset), this.bb) : null;
    }
    EPHEMERIS_SOURCE(optionalEncoding) {
        const offset = this.bb.__offset(this.bb_pos, 46);
        return this.bb.__string(this.bb_pos + offset, optionalEncoding);
    }
    SOLID_TIDES() {
        const offset = this.bb.__offset(this.bb_pos, 48);
        return offset ? this.bb.readUint8(this.bb_pos + offset) : pcfSolidTideModel.NONE;
    }
    RELATIVITY() {
        const offset = this.bb.__offset(this.bb_pos, 50);
        return offset ? this.bb.readUint8(this.bb_pos + offset) : pcfRelativityTerms.NONE;
    }
    IN_TRACK_ACCELERATION_M_S2() {
        const offset = this.bb.__offset(this.bb_pos, 52);
        return offset ? this.bb.readFloat64(this.bb_pos + offset) : 0.0;
    }
    HAS_IN_TRACK_ACCELERATION_M_S2() {
        const offset = this.bb.__offset(this.bb_pos, 54);
        return offset ? !!this.bb.readInt8(this.bb_pos + offset) : false;
    }
    DRAG_AREA_OVER_MASS_RATE_M2_KG_S() {
        const offset = this.bb.__offset(this.bb_pos, 56);
        return offset ? this.bb.readFloat64(this.bb_pos + offset) : 0.0;
    }
    HAS_DRAG_AREA_OVER_MASS_RATE_M2_KG_S() {
        const offset = this.bb.__offset(this.bb_pos, 58);
        return offset ? !!this.bb.readInt8(this.bb_pos + offset) : false;
    }
    MAXIMUM_TESSERAL_DEGREE() {
        const offset = this.bb.__offset(this.bb_pos, 60);
        return offset ? this.bb.readUint16(this.bb_pos + offset) : 0;
    }
    HAS_MAXIMUM_TESSERAL_DEGREE() {
        const offset = this.bb.__offset(this.bb_pos, 62);
        return offset ? !!this.bb.readInt8(this.bb_pos + offset) : false;
    }
    RADIATION_PRESSURE_MODEL() {
        const offset = this.bb.__offset(this.bb_pos, 64);
        return offset ? this.bb.readUint8(this.bb_pos + offset) : pcfRadiationPressureFamily.CANNONBALL;
    }
    GNSS_BLOCK() {
        const offset = this.bb.__offset(this.bb_pos, 66);
        return offset ? this.bb.readUint8(this.bb_pos + offset) : pcfGnssSpacecraftBlock.UNSPECIFIED;
    }
    ECOM2(obj) {
        const offset = this.bb.__offset(this.bb_pos, 68);
        return offset ? (obj || new PCFEcom2()).__init(this.bb.__indirect(this.bb_pos + offset), this.bb) : null;
    }
    EARTH_RADIATION() {
        const offset = this.bb.__offset(this.bb_pos, 70);
        return offset ? this.bb.readUint8(this.bb_pos + offset) : pcfEarthRadiationModel.NONE;
    }
    EARTH_RADIATION_RESOLUTION_DEG() {
        const offset = this.bb.__offset(this.bb_pos, 72);
        return offset ? this.bb.readFloat64(this.bb_pos + offset) : 15.0;
    }
    EARTH_RADIATION_AREA_OVER_MASS_M2_KG() {
        const offset = this.bb.__offset(this.bb_pos, 74);
        return offset ? this.bb.readFloat64(this.bb_pos + offset) : 0.0;
    }
    HAS_EARTH_RADIATION_AREA_OVER_MASS_M2_KG() {
        const offset = this.bb.__offset(this.bb_pos, 76);
        return offset ? !!this.bb.readInt8(this.bb_pos + offset) : false;
    }
    OCEAN_TIDES() {
        const offset = this.bb.__offset(this.bb_pos, 78);
        return offset ? this.bb.readUint8(this.bb_pos + offset) : pcfOceanTideModel.NONE;
    }
    OCEAN_TIDE_MAXIMUM_DEGREE() {
        const offset = this.bb.__offset(this.bb_pos, 80);
        return offset ? this.bb.readUint16(this.bb_pos + offset) : 30;
    }
    OCEAN_TIDE_MAXIMUM_ORDER() {
        const offset = this.bb.__offset(this.bb_pos, 82);
        return offset ? this.bb.readUint16(this.bb_pos + offset) : 30;
    }
    CENTRAL_BODY_NAIF_ID() {
        const offset = this.bb.__offset(this.bb_pos, 84);
        return offset ? this.bb.readInt32(this.bb_pos + offset) : 399;
    }
    EPHEMERIS_KIND() {
        const offset = this.bb.__offset(this.bb_pos, 86);
        return offset ? this.bb.readUint8(this.bb_pos + offset) : pcfEphemerisKind.UNSPECIFIED;
    }
    SHADOW_MODEL() {
        const offset = this.bb.__offset(this.bb_pos, 88);
        return offset ? this.bb.readUint8(this.bb_pos + offset) : evlShadowModel.UNSPECIFIED;
    }
    WEATHER_SOURCE() {
        const offset = this.bb.__offset(this.bb_pos, 90);
        return offset ? this.bb.readUint8(this.bb_pos + offset) : pcfWeatherSource.UNSPECIFIED;
    }
    WEATHER_EXTENSION() {
        const offset = this.bb.__offset(this.bb_pos, 92);
        return offset ? this.bb.readUint8(this.bb_pos + offset) : pcfWeatherExtension.UNSPECIFIED;
    }
    DENSITY_CORRECTION() {
        const offset = this.bb.__offset(this.bb_pos, 94);
        return offset ? this.bb.readUint8(this.bb_pos + offset) : pcfDensityCorrection.NONE;
    }
    DENSITY_CORRECTION_RELAXATION_HOURS() {
        const offset = this.bb.__offset(this.bb_pos, 96);
        return offset ? this.bb.readFloat64(this.bb_pos + offset) : 0.0;
    }
    HAS_DENSITY_CORRECTION_RELAXATION_HOURS() {
        const offset = this.bb.__offset(this.bb_pos, 98);
        return offset ? !!this.bb.readInt8(this.bb_pos + offset) : false;
    }
    NEUTRAL_WIND() {
        const offset = this.bb.__offset(this.bb_pos, 100);
        return offset ? this.bb.readUint8(this.bb_pos + offset) : pcfNeutralWind.NONE;
    }
    THIRD_BODY_MAXIMUM_DEGREE() {
        const offset = this.bb.__offset(this.bb_pos, 102);
        return offset ? this.bb.readUint16(this.bb_pos + offset) : 0;
    }
    THIRD_BODY_MAXIMUM_ORDER() {
        const offset = this.bb.__offset(this.bb_pos, 104);
        return offset ? this.bb.readUint16(this.bb_pos + offset) : 0;
    }
    static startPCFForceModel(builder) {
        builder.startObject(51);
    }
    static addGravityChoice(builder, GRAVITY_CHOICE) {
        builder.addFieldInt8(0, GRAVITY_CHOICE, pcfGravitySelection.INFER_FLAGS);
    }
    static addEnablePointMass(builder, ENABLE_POINT_MASS) {
        builder.addFieldInt8(1, +ENABLE_POINT_MASS, +true);
    }
    static addGravitationalParameter(builder, GRAVITATIONAL_PARAMETER) {
        builder.addFieldFloat64(2, GRAVITATIONAL_PARAMETER, 0.0);
    }
    static addEnableJ2(builder, ENABLE_J2) {
        builder.addFieldInt8(3, +ENABLE_J2, +true);
    }
    static addEnableJ3(builder, ENABLE_J3) {
        builder.addFieldInt8(4, +ENABLE_J3, +false);
    }
    static addEnableJ4(builder, ENABLE_J4) {
        builder.addFieldInt8(5, +ENABLE_J4, +false);
    }
    static addEnableHigherZonals(builder, ENABLE_HIGHER_ZONALS) {
        builder.addFieldInt8(6, +ENABLE_HIGHER_ZONALS, +false);
    }
    static addMaximumDegree(builder, MAXIMUM_DEGREE) {
        builder.addFieldInt16(7, MAXIMUM_DEGREE, 0);
    }
    static addHasMaximumDegree(builder, HAS_MAXIMUM_DEGREE) {
        builder.addFieldInt8(8, +HAS_MAXIMUM_DEGREE, +false);
    }
    static addMaximumOrder(builder, MAXIMUM_ORDER) {
        builder.addFieldInt16(9, MAXIMUM_ORDER, 0);
    }
    static addHasMaximumOrder(builder, HAS_MAXIMUM_ORDER) {
        builder.addFieldInt8(10, +HAS_MAXIMUM_ORDER, +false);
    }
    static addEnableThirdBody(builder, ENABLE_THIRD_BODY) {
        builder.addFieldInt8(11, +ENABLE_THIRD_BODY, +false);
    }
    static addThirdBodyIds(builder, THIRD_BODY_IDSOffset) {
        builder.addFieldOffset(12, THIRD_BODY_IDSOffset, 0);
    }
    static createThirdBodyIdsVector(builder, data) {
        builder.startVector(4, data.length, 4);
        for(let i = data.length - 1; i >= 0; i--){
            builder.addInt32(data[i]);
        }
        return builder.endVector();
    }
    static startThirdBodyIdsVector(builder, numElems) {
        builder.startVector(4, numElems, 4);
    }
    static addEnableSrp(builder, ENABLE_SRP) {
        builder.addFieldInt8(13, +ENABLE_SRP, +false);
    }
    static addEnableDrag(builder, ENABLE_DRAG) {
        builder.addFieldInt8(14, +ENABLE_DRAG, +false);
    }
    static addInitialMassKg(builder, INITIAL_MASS_KG) {
        builder.addFieldFloat64(15, INITIAL_MASS_KG, 1000.0);
    }
    static addAreaM2(builder, AREA_M2) {
        builder.addFieldFloat64(16, AREA_M2, 10.0);
    }
    static addReflectivityCoefficient(builder, REFLECTIVITY_COEFFICIENT) {
        builder.addFieldFloat64(17, REFLECTIVITY_COEFFICIENT, 1.5);
    }
    static addDragCoefficient(builder, DRAG_COEFFICIENT) {
        builder.addFieldFloat64(18, DRAG_COEFFICIENT, 2.2);
    }
    static addAtmosphereModel(builder, ATMOSPHERE_MODEL) {
        builder.addFieldInt8(19, ATMOSPHERE_MODEL, pcfAtmosphereFamily.NRLMSISE00);
    }
    static addWeather(builder, WEATHEROffset) {
        builder.addFieldOffset(20, WEATHEROffset, 0);
    }
    static addEphemerisSource(builder, EPHEMERIS_SOURCEOffset) {
        builder.addFieldOffset(21, EPHEMERIS_SOURCEOffset, 0);
    }
    static addSolidTides(builder, SOLID_TIDES) {
        builder.addFieldInt8(22, SOLID_TIDES, pcfSolidTideModel.NONE);
    }
    static addRelativity(builder, RELATIVITY) {
        builder.addFieldInt8(23, RELATIVITY, pcfRelativityTerms.NONE);
    }
    static addInTrackAccelerationMS2(builder, IN_TRACK_ACCELERATION_M_S2) {
        builder.addFieldFloat64(24, IN_TRACK_ACCELERATION_M_S2, 0.0);
    }
    static addHasInTrackAccelerationMS2(builder, HAS_IN_TRACK_ACCELERATION_M_S2) {
        builder.addFieldInt8(25, +HAS_IN_TRACK_ACCELERATION_M_S2, +false);
    }
    static addDragAreaOverMassRateM2KgS(builder, DRAG_AREA_OVER_MASS_RATE_M2_KG_S) {
        builder.addFieldFloat64(26, DRAG_AREA_OVER_MASS_RATE_M2_KG_S, 0.0);
    }
    static addHasDragAreaOverMassRateM2KgS(builder, HAS_DRAG_AREA_OVER_MASS_RATE_M2_KG_S) {
        builder.addFieldInt8(27, +HAS_DRAG_AREA_OVER_MASS_RATE_M2_KG_S, +false);
    }
    static addMaximumTesseralDegree(builder, MAXIMUM_TESSERAL_DEGREE) {
        builder.addFieldInt16(28, MAXIMUM_TESSERAL_DEGREE, 0);
    }
    static addHasMaximumTesseralDegree(builder, HAS_MAXIMUM_TESSERAL_DEGREE) {
        builder.addFieldInt8(29, +HAS_MAXIMUM_TESSERAL_DEGREE, +false);
    }
    static addRadiationPressureModel(builder, RADIATION_PRESSURE_MODEL) {
        builder.addFieldInt8(30, RADIATION_PRESSURE_MODEL, pcfRadiationPressureFamily.CANNONBALL);
    }
    static addGnssBlock(builder, GNSS_BLOCK) {
        builder.addFieldInt8(31, GNSS_BLOCK, pcfGnssSpacecraftBlock.UNSPECIFIED);
    }
    static addEcom2(builder, ECOM2Offset) {
        builder.addFieldOffset(32, ECOM2Offset, 0);
    }
    static addEarthRadiation(builder, EARTH_RADIATION) {
        builder.addFieldInt8(33, EARTH_RADIATION, pcfEarthRadiationModel.NONE);
    }
    static addEarthRadiationResolutionDeg(builder, EARTH_RADIATION_RESOLUTION_DEG) {
        builder.addFieldFloat64(34, EARTH_RADIATION_RESOLUTION_DEG, 15.0);
    }
    static addEarthRadiationAreaOverMassM2Kg(builder, EARTH_RADIATION_AREA_OVER_MASS_M2_KG) {
        builder.addFieldFloat64(35, EARTH_RADIATION_AREA_OVER_MASS_M2_KG, 0.0);
    }
    static addHasEarthRadiationAreaOverMassM2Kg(builder, HAS_EARTH_RADIATION_AREA_OVER_MASS_M2_KG) {
        builder.addFieldInt8(36, +HAS_EARTH_RADIATION_AREA_OVER_MASS_M2_KG, +false);
    }
    static addOceanTides(builder, OCEAN_TIDES) {
        builder.addFieldInt8(37, OCEAN_TIDES, pcfOceanTideModel.NONE);
    }
    static addOceanTideMaximumDegree(builder, OCEAN_TIDE_MAXIMUM_DEGREE) {
        builder.addFieldInt16(38, OCEAN_TIDE_MAXIMUM_DEGREE, 30);
    }
    static addOceanTideMaximumOrder(builder, OCEAN_TIDE_MAXIMUM_ORDER) {
        builder.addFieldInt16(39, OCEAN_TIDE_MAXIMUM_ORDER, 30);
    }
    static addCentralBodyNaifId(builder, CENTRAL_BODY_NAIF_ID) {
        builder.addFieldInt32(40, CENTRAL_BODY_NAIF_ID, 399);
    }
    static addEphemerisKind(builder, EPHEMERIS_KIND) {
        builder.addFieldInt8(41, EPHEMERIS_KIND, pcfEphemerisKind.UNSPECIFIED);
    }
    static addShadowModel(builder, SHADOW_MODEL) {
        builder.addFieldInt8(42, SHADOW_MODEL, evlShadowModel.UNSPECIFIED);
    }
    static addWeatherSource(builder, WEATHER_SOURCE) {
        builder.addFieldInt8(43, WEATHER_SOURCE, pcfWeatherSource.UNSPECIFIED);
    }
    static addWeatherExtension(builder, WEATHER_EXTENSION) {
        builder.addFieldInt8(44, WEATHER_EXTENSION, pcfWeatherExtension.UNSPECIFIED);
    }
    static addDensityCorrection(builder, DENSITY_CORRECTION) {
        builder.addFieldInt8(45, DENSITY_CORRECTION, pcfDensityCorrection.NONE);
    }
    static addDensityCorrectionRelaxationHours(builder, DENSITY_CORRECTION_RELAXATION_HOURS) {
        builder.addFieldFloat64(46, DENSITY_CORRECTION_RELAXATION_HOURS, 0.0);
    }
    static addHasDensityCorrectionRelaxationHours(builder, HAS_DENSITY_CORRECTION_RELAXATION_HOURS) {
        builder.addFieldInt8(47, +HAS_DENSITY_CORRECTION_RELAXATION_HOURS, +false);
    }
    static addNeutralWind(builder, NEUTRAL_WIND) {
        builder.addFieldInt8(48, NEUTRAL_WIND, pcfNeutralWind.NONE);
    }
    static addThirdBodyMaximumDegree(builder, THIRD_BODY_MAXIMUM_DEGREE) {
        builder.addFieldInt16(49, THIRD_BODY_MAXIMUM_DEGREE, 0);
    }
    static addThirdBodyMaximumOrder(builder, THIRD_BODY_MAXIMUM_ORDER) {
        builder.addFieldInt16(50, THIRD_BODY_MAXIMUM_ORDER, 0);
    }
    static endPCFForceModel(builder) {
        const offset = builder.endObject();
        builder.requiredField(offset, 46);
        return offset;
    }
    unpack() {
        return new PCFForceModelT(this.GRAVITY_CHOICE(), this.ENABLE_POINT_MASS(), this.GRAVITATIONAL_PARAMETER(), this.ENABLE_J2(), this.ENABLE_J3(), this.ENABLE_J4(), this.ENABLE_HIGHER_ZONALS(), this.MAXIMUM_DEGREE(), this.HAS_MAXIMUM_DEGREE(), this.MAXIMUM_ORDER(), this.HAS_MAXIMUM_ORDER(), this.ENABLE_THIRD_BODY(), this.bb.createScalarList(this.THIRD_BODY_IDS.bind(this), this.thirdBodyIdsLength()), this.ENABLE_SRP(), this.ENABLE_DRAG(), this.INITIAL_MASS_KG(), this.AREA_M2(), this.REFLECTIVITY_COEFFICIENT(), this.DRAG_COEFFICIENT(), this.ATMOSPHERE_MODEL(), this.WEATHER() !== null ? this.WEATHER().unpack() : null, this.EPHEMERIS_SOURCE(), this.SOLID_TIDES(), this.RELATIVITY(), this.IN_TRACK_ACCELERATION_M_S2(), this.HAS_IN_TRACK_ACCELERATION_M_S2(), this.DRAG_AREA_OVER_MASS_RATE_M2_KG_S(), this.HAS_DRAG_AREA_OVER_MASS_RATE_M2_KG_S(), this.MAXIMUM_TESSERAL_DEGREE(), this.HAS_MAXIMUM_TESSERAL_DEGREE(), this.RADIATION_PRESSURE_MODEL(), this.GNSS_BLOCK(), this.ECOM2() !== null ? this.ECOM2().unpack() : null, this.EARTH_RADIATION(), this.EARTH_RADIATION_RESOLUTION_DEG(), this.EARTH_RADIATION_AREA_OVER_MASS_M2_KG(), this.HAS_EARTH_RADIATION_AREA_OVER_MASS_M2_KG(), this.OCEAN_TIDES(), this.OCEAN_TIDE_MAXIMUM_DEGREE(), this.OCEAN_TIDE_MAXIMUM_ORDER(), this.CENTRAL_BODY_NAIF_ID(), this.EPHEMERIS_KIND(), this.SHADOW_MODEL(), this.WEATHER_SOURCE(), this.WEATHER_EXTENSION(), this.DENSITY_CORRECTION(), this.DENSITY_CORRECTION_RELAXATION_HOURS(), this.HAS_DENSITY_CORRECTION_RELAXATION_HOURS(), this.NEUTRAL_WIND(), this.THIRD_BODY_MAXIMUM_DEGREE(), this.THIRD_BODY_MAXIMUM_ORDER());
    }
    unpackTo(_o) {
        _o.GRAVITY_CHOICE = this.GRAVITY_CHOICE();
        _o.ENABLE_POINT_MASS = this.ENABLE_POINT_MASS();
        _o.GRAVITATIONAL_PARAMETER = this.GRAVITATIONAL_PARAMETER();
        _o.ENABLE_J2 = this.ENABLE_J2();
        _o.ENABLE_J3 = this.ENABLE_J3();
        _o.ENABLE_J4 = this.ENABLE_J4();
        _o.ENABLE_HIGHER_ZONALS = this.ENABLE_HIGHER_ZONALS();
        _o.MAXIMUM_DEGREE = this.MAXIMUM_DEGREE();
        _o.HAS_MAXIMUM_DEGREE = this.HAS_MAXIMUM_DEGREE();
        _o.MAXIMUM_ORDER = this.MAXIMUM_ORDER();
        _o.HAS_MAXIMUM_ORDER = this.HAS_MAXIMUM_ORDER();
        _o.ENABLE_THIRD_BODY = this.ENABLE_THIRD_BODY();
        _o.THIRD_BODY_IDS = this.bb.createScalarList(this.THIRD_BODY_IDS.bind(this), this.thirdBodyIdsLength());
        _o.ENABLE_SRP = this.ENABLE_SRP();
        _o.ENABLE_DRAG = this.ENABLE_DRAG();
        _o.INITIAL_MASS_KG = this.INITIAL_MASS_KG();
        _o.AREA_M2 = this.AREA_M2();
        _o.REFLECTIVITY_COEFFICIENT = this.REFLECTIVITY_COEFFICIENT();
        _o.DRAG_COEFFICIENT = this.DRAG_COEFFICIENT();
        _o.ATMOSPHERE_MODEL = this.ATMOSPHERE_MODEL();
        _o.WEATHER = this.WEATHER() !== null ? this.WEATHER().unpack() : null;
        _o.EPHEMERIS_SOURCE = this.EPHEMERIS_SOURCE();
        _o.SOLID_TIDES = this.SOLID_TIDES();
        _o.RELATIVITY = this.RELATIVITY();
        _o.IN_TRACK_ACCELERATION_M_S2 = this.IN_TRACK_ACCELERATION_M_S2();
        _o.HAS_IN_TRACK_ACCELERATION_M_S2 = this.HAS_IN_TRACK_ACCELERATION_M_S2();
        _o.DRAG_AREA_OVER_MASS_RATE_M2_KG_S = this.DRAG_AREA_OVER_MASS_RATE_M2_KG_S();
        _o.HAS_DRAG_AREA_OVER_MASS_RATE_M2_KG_S = this.HAS_DRAG_AREA_OVER_MASS_RATE_M2_KG_S();
        _o.MAXIMUM_TESSERAL_DEGREE = this.MAXIMUM_TESSERAL_DEGREE();
        _o.HAS_MAXIMUM_TESSERAL_DEGREE = this.HAS_MAXIMUM_TESSERAL_DEGREE();
        _o.RADIATION_PRESSURE_MODEL = this.RADIATION_PRESSURE_MODEL();
        _o.GNSS_BLOCK = this.GNSS_BLOCK();
        _o.ECOM2 = this.ECOM2() !== null ? this.ECOM2().unpack() : null;
        _o.EARTH_RADIATION = this.EARTH_RADIATION();
        _o.EARTH_RADIATION_RESOLUTION_DEG = this.EARTH_RADIATION_RESOLUTION_DEG();
        _o.EARTH_RADIATION_AREA_OVER_MASS_M2_KG = this.EARTH_RADIATION_AREA_OVER_MASS_M2_KG();
        _o.HAS_EARTH_RADIATION_AREA_OVER_MASS_M2_KG = this.HAS_EARTH_RADIATION_AREA_OVER_MASS_M2_KG();
        _o.OCEAN_TIDES = this.OCEAN_TIDES();
        _o.OCEAN_TIDE_MAXIMUM_DEGREE = this.OCEAN_TIDE_MAXIMUM_DEGREE();
        _o.OCEAN_TIDE_MAXIMUM_ORDER = this.OCEAN_TIDE_MAXIMUM_ORDER();
        _o.CENTRAL_BODY_NAIF_ID = this.CENTRAL_BODY_NAIF_ID();
        _o.EPHEMERIS_KIND = this.EPHEMERIS_KIND();
        _o.SHADOW_MODEL = this.SHADOW_MODEL();
        _o.WEATHER_SOURCE = this.WEATHER_SOURCE();
        _o.WEATHER_EXTENSION = this.WEATHER_EXTENSION();
        _o.DENSITY_CORRECTION = this.DENSITY_CORRECTION();
        _o.DENSITY_CORRECTION_RELAXATION_HOURS = this.DENSITY_CORRECTION_RELAXATION_HOURS();
        _o.HAS_DENSITY_CORRECTION_RELAXATION_HOURS = this.HAS_DENSITY_CORRECTION_RELAXATION_HOURS();
        _o.NEUTRAL_WIND = this.NEUTRAL_WIND();
        _o.THIRD_BODY_MAXIMUM_DEGREE = this.THIRD_BODY_MAXIMUM_DEGREE();
        _o.THIRD_BODY_MAXIMUM_ORDER = this.THIRD_BODY_MAXIMUM_ORDER();
    }
}
export class PCFForceModelT {
    GRAVITY_CHOICE;
    ENABLE_POINT_MASS;
    GRAVITATIONAL_PARAMETER;
    ENABLE_J2;
    ENABLE_J3;
    ENABLE_J4;
    ENABLE_HIGHER_ZONALS;
    MAXIMUM_DEGREE;
    HAS_MAXIMUM_DEGREE;
    MAXIMUM_ORDER;
    HAS_MAXIMUM_ORDER;
    ENABLE_THIRD_BODY;
    THIRD_BODY_IDS;
    ENABLE_SRP;
    ENABLE_DRAG;
    INITIAL_MASS_KG;
    AREA_M2;
    REFLECTIVITY_COEFFICIENT;
    DRAG_COEFFICIENT;
    ATMOSPHERE_MODEL;
    WEATHER;
    EPHEMERIS_SOURCE;
    SOLID_TIDES;
    RELATIVITY;
    IN_TRACK_ACCELERATION_M_S2;
    HAS_IN_TRACK_ACCELERATION_M_S2;
    DRAG_AREA_OVER_MASS_RATE_M2_KG_S;
    HAS_DRAG_AREA_OVER_MASS_RATE_M2_KG_S;
    MAXIMUM_TESSERAL_DEGREE;
    HAS_MAXIMUM_TESSERAL_DEGREE;
    RADIATION_PRESSURE_MODEL;
    GNSS_BLOCK;
    ECOM2;
    EARTH_RADIATION;
    EARTH_RADIATION_RESOLUTION_DEG;
    EARTH_RADIATION_AREA_OVER_MASS_M2_KG;
    HAS_EARTH_RADIATION_AREA_OVER_MASS_M2_KG;
    OCEAN_TIDES;
    OCEAN_TIDE_MAXIMUM_DEGREE;
    OCEAN_TIDE_MAXIMUM_ORDER;
    CENTRAL_BODY_NAIF_ID;
    EPHEMERIS_KIND;
    SHADOW_MODEL;
    WEATHER_SOURCE;
    WEATHER_EXTENSION;
    DENSITY_CORRECTION;
    DENSITY_CORRECTION_RELAXATION_HOURS;
    HAS_DENSITY_CORRECTION_RELAXATION_HOURS;
    NEUTRAL_WIND;
    THIRD_BODY_MAXIMUM_DEGREE;
    THIRD_BODY_MAXIMUM_ORDER;
    constructor(GRAVITY_CHOICE = pcfGravitySelection.INFER_FLAGS, ENABLE_POINT_MASS = true, GRAVITATIONAL_PARAMETER = 0.0, ENABLE_J2 = true, ENABLE_J3 = false, ENABLE_J4 = false, ENABLE_HIGHER_ZONALS = false, MAXIMUM_DEGREE = 0, HAS_MAXIMUM_DEGREE = false, MAXIMUM_ORDER = 0, HAS_MAXIMUM_ORDER = false, ENABLE_THIRD_BODY = false, THIRD_BODY_IDS = [], ENABLE_SRP = false, ENABLE_DRAG = false, INITIAL_MASS_KG = 1000.0, AREA_M2 = 10.0, REFLECTIVITY_COEFFICIENT = 1.5, DRAG_COEFFICIENT = 2.2, ATMOSPHERE_MODEL = pcfAtmosphereFamily.NRLMSISE00, WEATHER = null, EPHEMERIS_SOURCE = null, SOLID_TIDES = pcfSolidTideModel.NONE, RELATIVITY = pcfRelativityTerms.NONE, IN_TRACK_ACCELERATION_M_S2 = 0.0, HAS_IN_TRACK_ACCELERATION_M_S2 = false, DRAG_AREA_OVER_MASS_RATE_M2_KG_S = 0.0, HAS_DRAG_AREA_OVER_MASS_RATE_M2_KG_S = false, MAXIMUM_TESSERAL_DEGREE = 0, HAS_MAXIMUM_TESSERAL_DEGREE = false, RADIATION_PRESSURE_MODEL = pcfRadiationPressureFamily.CANNONBALL, GNSS_BLOCK = pcfGnssSpacecraftBlock.UNSPECIFIED, ECOM2 = null, EARTH_RADIATION = pcfEarthRadiationModel.NONE, EARTH_RADIATION_RESOLUTION_DEG = 15.0, EARTH_RADIATION_AREA_OVER_MASS_M2_KG = 0.0, HAS_EARTH_RADIATION_AREA_OVER_MASS_M2_KG = false, OCEAN_TIDES = pcfOceanTideModel.NONE, OCEAN_TIDE_MAXIMUM_DEGREE = 30, OCEAN_TIDE_MAXIMUM_ORDER = 30, CENTRAL_BODY_NAIF_ID = 399, EPHEMERIS_KIND = pcfEphemerisKind.UNSPECIFIED, SHADOW_MODEL = evlShadowModel.UNSPECIFIED, WEATHER_SOURCE = pcfWeatherSource.UNSPECIFIED, WEATHER_EXTENSION = pcfWeatherExtension.UNSPECIFIED, DENSITY_CORRECTION = pcfDensityCorrection.NONE, DENSITY_CORRECTION_RELAXATION_HOURS = 0.0, HAS_DENSITY_CORRECTION_RELAXATION_HOURS = false, NEUTRAL_WIND = pcfNeutralWind.NONE, THIRD_BODY_MAXIMUM_DEGREE = 0, THIRD_BODY_MAXIMUM_ORDER = 0){
        this.GRAVITY_CHOICE = GRAVITY_CHOICE;
        this.ENABLE_POINT_MASS = ENABLE_POINT_MASS;
        this.GRAVITATIONAL_PARAMETER = GRAVITATIONAL_PARAMETER;
        this.ENABLE_J2 = ENABLE_J2;
        this.ENABLE_J3 = ENABLE_J3;
        this.ENABLE_J4 = ENABLE_J4;
        this.ENABLE_HIGHER_ZONALS = ENABLE_HIGHER_ZONALS;
        this.MAXIMUM_DEGREE = MAXIMUM_DEGREE;
        this.HAS_MAXIMUM_DEGREE = HAS_MAXIMUM_DEGREE;
        this.MAXIMUM_ORDER = MAXIMUM_ORDER;
        this.HAS_MAXIMUM_ORDER = HAS_MAXIMUM_ORDER;
        this.ENABLE_THIRD_BODY = ENABLE_THIRD_BODY;
        this.THIRD_BODY_IDS = THIRD_BODY_IDS;
        this.ENABLE_SRP = ENABLE_SRP;
        this.ENABLE_DRAG = ENABLE_DRAG;
        this.INITIAL_MASS_KG = INITIAL_MASS_KG;
        this.AREA_M2 = AREA_M2;
        this.REFLECTIVITY_COEFFICIENT = REFLECTIVITY_COEFFICIENT;
        this.DRAG_COEFFICIENT = DRAG_COEFFICIENT;
        this.ATMOSPHERE_MODEL = ATMOSPHERE_MODEL;
        this.WEATHER = WEATHER;
        this.EPHEMERIS_SOURCE = EPHEMERIS_SOURCE;
        this.SOLID_TIDES = SOLID_TIDES;
        this.RELATIVITY = RELATIVITY;
        this.IN_TRACK_ACCELERATION_M_S2 = IN_TRACK_ACCELERATION_M_S2;
        this.HAS_IN_TRACK_ACCELERATION_M_S2 = HAS_IN_TRACK_ACCELERATION_M_S2;
        this.DRAG_AREA_OVER_MASS_RATE_M2_KG_S = DRAG_AREA_OVER_MASS_RATE_M2_KG_S;
        this.HAS_DRAG_AREA_OVER_MASS_RATE_M2_KG_S = HAS_DRAG_AREA_OVER_MASS_RATE_M2_KG_S;
        this.MAXIMUM_TESSERAL_DEGREE = MAXIMUM_TESSERAL_DEGREE;
        this.HAS_MAXIMUM_TESSERAL_DEGREE = HAS_MAXIMUM_TESSERAL_DEGREE;
        this.RADIATION_PRESSURE_MODEL = RADIATION_PRESSURE_MODEL;
        this.GNSS_BLOCK = GNSS_BLOCK;
        this.ECOM2 = ECOM2;
        this.EARTH_RADIATION = EARTH_RADIATION;
        this.EARTH_RADIATION_RESOLUTION_DEG = EARTH_RADIATION_RESOLUTION_DEG;
        this.EARTH_RADIATION_AREA_OVER_MASS_M2_KG = EARTH_RADIATION_AREA_OVER_MASS_M2_KG;
        this.HAS_EARTH_RADIATION_AREA_OVER_MASS_M2_KG = HAS_EARTH_RADIATION_AREA_OVER_MASS_M2_KG;
        this.OCEAN_TIDES = OCEAN_TIDES;
        this.OCEAN_TIDE_MAXIMUM_DEGREE = OCEAN_TIDE_MAXIMUM_DEGREE;
        this.OCEAN_TIDE_MAXIMUM_ORDER = OCEAN_TIDE_MAXIMUM_ORDER;
        this.CENTRAL_BODY_NAIF_ID = CENTRAL_BODY_NAIF_ID;
        this.EPHEMERIS_KIND = EPHEMERIS_KIND;
        this.SHADOW_MODEL = SHADOW_MODEL;
        this.WEATHER_SOURCE = WEATHER_SOURCE;
        this.WEATHER_EXTENSION = WEATHER_EXTENSION;
        this.DENSITY_CORRECTION = DENSITY_CORRECTION;
        this.DENSITY_CORRECTION_RELAXATION_HOURS = DENSITY_CORRECTION_RELAXATION_HOURS;
        this.HAS_DENSITY_CORRECTION_RELAXATION_HOURS = HAS_DENSITY_CORRECTION_RELAXATION_HOURS;
        this.NEUTRAL_WIND = NEUTRAL_WIND;
        this.THIRD_BODY_MAXIMUM_DEGREE = THIRD_BODY_MAXIMUM_DEGREE;
        this.THIRD_BODY_MAXIMUM_ORDER = THIRD_BODY_MAXIMUM_ORDER;
    }
    pack(builder) {
        const THIRD_BODY_IDS = PCFForceModel.createThirdBodyIdsVector(builder, this.THIRD_BODY_IDS);
        const WEATHER = this.WEATHER !== null ? this.WEATHER.pack(builder) : 0;
        const EPHEMERIS_SOURCE = this.EPHEMERIS_SOURCE !== null ? builder.createString(this.EPHEMERIS_SOURCE) : 0;
        const ECOM2 = this.ECOM2 !== null ? this.ECOM2.pack(builder) : 0;
        PCFForceModel.startPCFForceModel(builder);
        PCFForceModel.addGravityChoice(builder, this.GRAVITY_CHOICE);
        PCFForceModel.addEnablePointMass(builder, this.ENABLE_POINT_MASS);
        PCFForceModel.addGravitationalParameter(builder, this.GRAVITATIONAL_PARAMETER);
        PCFForceModel.addEnableJ2(builder, this.ENABLE_J2);
        PCFForceModel.addEnableJ3(builder, this.ENABLE_J3);
        PCFForceModel.addEnableJ4(builder, this.ENABLE_J4);
        PCFForceModel.addEnableHigherZonals(builder, this.ENABLE_HIGHER_ZONALS);
        PCFForceModel.addMaximumDegree(builder, this.MAXIMUM_DEGREE);
        PCFForceModel.addHasMaximumDegree(builder, this.HAS_MAXIMUM_DEGREE);
        PCFForceModel.addMaximumOrder(builder, this.MAXIMUM_ORDER);
        PCFForceModel.addHasMaximumOrder(builder, this.HAS_MAXIMUM_ORDER);
        PCFForceModel.addEnableThirdBody(builder, this.ENABLE_THIRD_BODY);
        PCFForceModel.addThirdBodyIds(builder, THIRD_BODY_IDS);
        PCFForceModel.addEnableSrp(builder, this.ENABLE_SRP);
        PCFForceModel.addEnableDrag(builder, this.ENABLE_DRAG);
        PCFForceModel.addInitialMassKg(builder, this.INITIAL_MASS_KG);
        PCFForceModel.addAreaM2(builder, this.AREA_M2);
        PCFForceModel.addReflectivityCoefficient(builder, this.REFLECTIVITY_COEFFICIENT);
        PCFForceModel.addDragCoefficient(builder, this.DRAG_COEFFICIENT);
        PCFForceModel.addAtmosphereModel(builder, this.ATMOSPHERE_MODEL);
        PCFForceModel.addWeather(builder, WEATHER);
        PCFForceModel.addEphemerisSource(builder, EPHEMERIS_SOURCE);
        PCFForceModel.addSolidTides(builder, this.SOLID_TIDES);
        PCFForceModel.addRelativity(builder, this.RELATIVITY);
        PCFForceModel.addInTrackAccelerationMS2(builder, this.IN_TRACK_ACCELERATION_M_S2);
        PCFForceModel.addHasInTrackAccelerationMS2(builder, this.HAS_IN_TRACK_ACCELERATION_M_S2);
        PCFForceModel.addDragAreaOverMassRateM2KgS(builder, this.DRAG_AREA_OVER_MASS_RATE_M2_KG_S);
        PCFForceModel.addHasDragAreaOverMassRateM2KgS(builder, this.HAS_DRAG_AREA_OVER_MASS_RATE_M2_KG_S);
        PCFForceModel.addMaximumTesseralDegree(builder, this.MAXIMUM_TESSERAL_DEGREE);
        PCFForceModel.addHasMaximumTesseralDegree(builder, this.HAS_MAXIMUM_TESSERAL_DEGREE);
        PCFForceModel.addRadiationPressureModel(builder, this.RADIATION_PRESSURE_MODEL);
        PCFForceModel.addGnssBlock(builder, this.GNSS_BLOCK);
        PCFForceModel.addEcom2(builder, ECOM2);
        PCFForceModel.addEarthRadiation(builder, this.EARTH_RADIATION);
        PCFForceModel.addEarthRadiationResolutionDeg(builder, this.EARTH_RADIATION_RESOLUTION_DEG);
        PCFForceModel.addEarthRadiationAreaOverMassM2Kg(builder, this.EARTH_RADIATION_AREA_OVER_MASS_M2_KG);
        PCFForceModel.addHasEarthRadiationAreaOverMassM2Kg(builder, this.HAS_EARTH_RADIATION_AREA_OVER_MASS_M2_KG);
        PCFForceModel.addOceanTides(builder, this.OCEAN_TIDES);
        PCFForceModel.addOceanTideMaximumDegree(builder, this.OCEAN_TIDE_MAXIMUM_DEGREE);
        PCFForceModel.addOceanTideMaximumOrder(builder, this.OCEAN_TIDE_MAXIMUM_ORDER);
        PCFForceModel.addCentralBodyNaifId(builder, this.CENTRAL_BODY_NAIF_ID);
        PCFForceModel.addEphemerisKind(builder, this.EPHEMERIS_KIND);
        PCFForceModel.addShadowModel(builder, this.SHADOW_MODEL);
        PCFForceModel.addWeatherSource(builder, this.WEATHER_SOURCE);
        PCFForceModel.addWeatherExtension(builder, this.WEATHER_EXTENSION);
        PCFForceModel.addDensityCorrection(builder, this.DENSITY_CORRECTION);
        PCFForceModel.addDensityCorrectionRelaxationHours(builder, this.DENSITY_CORRECTION_RELAXATION_HOURS);
        PCFForceModel.addHasDensityCorrectionRelaxationHours(builder, this.HAS_DENSITY_CORRECTION_RELAXATION_HOURS);
        PCFForceModel.addNeutralWind(builder, this.NEUTRAL_WIND);
        PCFForceModel.addThirdBodyMaximumDegree(builder, this.THIRD_BODY_MAXIMUM_DEGREE);
        PCFForceModel.addThirdBodyMaximumOrder(builder, this.THIRD_BODY_MAXIMUM_ORDER);
        return PCFForceModel.endPCFForceModel(builder);
    }
}
