import * as flatbuffers from 'flatbuffers';
import { TIMCcsdsTimeCode, TIMCcsdsTimeCodeT } from './TIMCcsdsTimeCode.js';
import { timEpochRepresentation } from './timEpochRepresentation.js';
import { timingStandard } from './timingStandard.js';
export class TIMInstant {
    bb = null;
    bb_pos = 0;
    __init(i, bb) {
        this.bb_pos = i;
        this.bb = bb;
        return this;
    }
    static getRootAsTIMInstant(bb, obj) {
        return (obj || new TIMInstant()).__init(bb.readInt32(bb.position()) + bb.position(), bb);
    }
    static getSizePrefixedRootAsTIMInstant(bb, obj) {
        bb.setPosition(bb.position() + flatbuffers.SIZE_PREFIX_LENGTH);
        return (obj || new TIMInstant()).__init(bb.readInt32(bb.position()) + bb.position(), bb);
    }
    TIME_SYSTEM() {
        const offset = this.bb.__offset(this.bb_pos, 4);
        return offset ? this.bb.readInt8(this.bb_pos + offset) : timingStandard.GMST;
    }
    EPOCH_FORMAT() {
        const offset = this.bb.__offset(this.bb_pos, 6);
        return offset ? this.bb.readInt8(this.bb_pos + offset) : timEpochRepresentation.JULIAN_DATE;
    }
    JULIAN_DATE() {
        const offset = this.bb.__offset(this.bb_pos, 8);
        return offset ? this.bb.readFloat64(this.bb_pos + offset) : 0.0;
    }
    SECONDS() {
        const offset = this.bb.__offset(this.bb_pos, 10);
        return offset ? this.bb.readFloat64(this.bb_pos + offset) : 0.0;
    }
    ISO8601(optionalEncoding) {
        const offset = this.bb.__offset(this.bb_pos, 12);
        return offset ? this.bb.__string(this.bb_pos + offset, optionalEncoding) : null;
    }
    SUBSECOND_NANOS() {
        const offset = this.bb.__offset(this.bb_pos, 14);
        return offset ? this.bb.readInt32(this.bb_pos + offset) : 0;
    }
    EPOCH_LABEL(optionalEncoding) {
        const offset = this.bb.__offset(this.bb_pos, 16);
        return offset ? this.bb.__string(this.bb_pos + offset, optionalEncoding) : null;
    }
    GNSS_WEEK() {
        const offset = this.bb.__offset(this.bb_pos, 18);
        return offset ? this.bb.readInt32(this.bb_pos + offset) : 0;
    }
    HAS_GNSS_ROLLOVER_REFERENCE() {
        const offset = this.bb.__offset(this.bb_pos, 20);
        return offset ? !!this.bb.readInt8(this.bb_pos + offset) : false;
    }
    GNSS_ROLLOVER_REFERENCE_ISO8601(optionalEncoding) {
        const offset = this.bb.__offset(this.bb_pos, 22);
        return offset ? this.bb.__string(this.bb_pos + offset, optionalEncoding) : null;
    }
    CCSDS_TIME_CODE(obj) {
        const offset = this.bb.__offset(this.bb_pos, 24);
        return offset ? (obj || new TIMCcsdsTimeCode()).__init(this.bb.__indirect(this.bb_pos + offset), this.bb) : null;
    }
    static startTIMInstant(builder) {
        builder.startObject(11);
    }
    static addTimeSystem(builder, TIME_SYSTEM) {
        builder.addFieldInt8(0, TIME_SYSTEM, timingStandard.GMST);
    }
    static addEpochFormat(builder, EPOCH_FORMAT) {
        builder.addFieldInt8(1, EPOCH_FORMAT, timEpochRepresentation.JULIAN_DATE);
    }
    static addJulianDate(builder, JULIAN_DATE) {
        builder.addFieldFloat64(2, JULIAN_DATE, 0.0);
    }
    static addSeconds(builder, SECONDS) {
        builder.addFieldFloat64(3, SECONDS, 0.0);
    }
    static addIso8601(builder, ISO8601Offset) {
        builder.addFieldOffset(4, ISO8601Offset, 0);
    }
    static addSubsecondNanos(builder, SUBSECOND_NANOS) {
        builder.addFieldInt32(5, SUBSECOND_NANOS, 0);
    }
    static addEpochLabel(builder, EPOCH_LABELOffset) {
        builder.addFieldOffset(6, EPOCH_LABELOffset, 0);
    }
    static addGnssWeek(builder, GNSS_WEEK) {
        builder.addFieldInt32(7, GNSS_WEEK, 0);
    }
    static addHasGnssRolloverReference(builder, HAS_GNSS_ROLLOVER_REFERENCE) {
        builder.addFieldInt8(8, +HAS_GNSS_ROLLOVER_REFERENCE, +false);
    }
    static addGnssRolloverReferenceIso8601(builder, GNSS_ROLLOVER_REFERENCE_ISO8601Offset) {
        builder.addFieldOffset(9, GNSS_ROLLOVER_REFERENCE_ISO8601Offset, 0);
    }
    static addCcsdsTimeCode(builder, CCSDS_TIME_CODEOffset) {
        builder.addFieldOffset(10, CCSDS_TIME_CODEOffset, 0);
    }
    static endTIMInstant(builder) {
        const offset = builder.endObject();
        return offset;
    }
    unpack() {
        return new TIMInstantT(this.TIME_SYSTEM(), this.EPOCH_FORMAT(), this.JULIAN_DATE(), this.SECONDS(), this.ISO8601(), this.SUBSECOND_NANOS(), this.EPOCH_LABEL(), this.GNSS_WEEK(), this.HAS_GNSS_ROLLOVER_REFERENCE(), this.GNSS_ROLLOVER_REFERENCE_ISO8601(), this.CCSDS_TIME_CODE() !== null ? this.CCSDS_TIME_CODE().unpack() : null);
    }
    unpackTo(_o) {
        _o.TIME_SYSTEM = this.TIME_SYSTEM();
        _o.EPOCH_FORMAT = this.EPOCH_FORMAT();
        _o.JULIAN_DATE = this.JULIAN_DATE();
        _o.SECONDS = this.SECONDS();
        _o.ISO8601 = this.ISO8601();
        _o.SUBSECOND_NANOS = this.SUBSECOND_NANOS();
        _o.EPOCH_LABEL = this.EPOCH_LABEL();
        _o.GNSS_WEEK = this.GNSS_WEEK();
        _o.HAS_GNSS_ROLLOVER_REFERENCE = this.HAS_GNSS_ROLLOVER_REFERENCE();
        _o.GNSS_ROLLOVER_REFERENCE_ISO8601 = this.GNSS_ROLLOVER_REFERENCE_ISO8601();
        _o.CCSDS_TIME_CODE = this.CCSDS_TIME_CODE() !== null ? this.CCSDS_TIME_CODE().unpack() : null;
    }
}
export class TIMInstantT {
    TIME_SYSTEM;
    EPOCH_FORMAT;
    JULIAN_DATE;
    SECONDS;
    ISO8601;
    SUBSECOND_NANOS;
    EPOCH_LABEL;
    GNSS_WEEK;
    HAS_GNSS_ROLLOVER_REFERENCE;
    GNSS_ROLLOVER_REFERENCE_ISO8601;
    CCSDS_TIME_CODE;
    constructor(TIME_SYSTEM = timingStandard.GMST, EPOCH_FORMAT = timEpochRepresentation.JULIAN_DATE, JULIAN_DATE = 0.0, SECONDS = 0.0, ISO8601 = null, SUBSECOND_NANOS = 0, EPOCH_LABEL = null, GNSS_WEEK = 0, HAS_GNSS_ROLLOVER_REFERENCE = false, GNSS_ROLLOVER_REFERENCE_ISO8601 = null, CCSDS_TIME_CODE = null){
        this.TIME_SYSTEM = TIME_SYSTEM;
        this.EPOCH_FORMAT = EPOCH_FORMAT;
        this.JULIAN_DATE = JULIAN_DATE;
        this.SECONDS = SECONDS;
        this.ISO8601 = ISO8601;
        this.SUBSECOND_NANOS = SUBSECOND_NANOS;
        this.EPOCH_LABEL = EPOCH_LABEL;
        this.GNSS_WEEK = GNSS_WEEK;
        this.HAS_GNSS_ROLLOVER_REFERENCE = HAS_GNSS_ROLLOVER_REFERENCE;
        this.GNSS_ROLLOVER_REFERENCE_ISO8601 = GNSS_ROLLOVER_REFERENCE_ISO8601;
        this.CCSDS_TIME_CODE = CCSDS_TIME_CODE;
    }
    pack(builder) {
        const ISO8601 = this.ISO8601 !== null ? builder.createString(this.ISO8601) : 0;
        const EPOCH_LABEL = this.EPOCH_LABEL !== null ? builder.createString(this.EPOCH_LABEL) : 0;
        const GNSS_ROLLOVER_REFERENCE_ISO8601 = this.GNSS_ROLLOVER_REFERENCE_ISO8601 !== null ? builder.createString(this.GNSS_ROLLOVER_REFERENCE_ISO8601) : 0;
        const CCSDS_TIME_CODE = this.CCSDS_TIME_CODE !== null ? this.CCSDS_TIME_CODE.pack(builder) : 0;
        TIMInstant.startTIMInstant(builder);
        TIMInstant.addTimeSystem(builder, this.TIME_SYSTEM);
        TIMInstant.addEpochFormat(builder, this.EPOCH_FORMAT);
        TIMInstant.addJulianDate(builder, this.JULIAN_DATE);
        TIMInstant.addSeconds(builder, this.SECONDS);
        TIMInstant.addIso8601(builder, ISO8601);
        TIMInstant.addSubsecondNanos(builder, this.SUBSECOND_NANOS);
        TIMInstant.addEpochLabel(builder, EPOCH_LABEL);
        TIMInstant.addGnssWeek(builder, this.GNSS_WEEK);
        TIMInstant.addHasGnssRolloverReference(builder, this.HAS_GNSS_ROLLOVER_REFERENCE);
        TIMInstant.addGnssRolloverReferenceIso8601(builder, GNSS_ROLLOVER_REFERENCE_ISO8601);
        TIMInstant.addCcsdsTimeCode(builder, CCSDS_TIME_CODE);
        return TIMInstant.endTIMInstant(builder);
    }
}
