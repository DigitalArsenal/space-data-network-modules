import * as flatbuffers from 'flatbuffers';
import { pcfReentryWindowMethod } from './pcfReentryWindowMethod.js';
export class PCFReentry {
    bb = null;
    bb_pos = 0;
    __init(i, bb) {
        this.bb_pos = i;
        this.bb = bb;
        return this;
    }
    static getRootAsPCFReentry(bb, obj) {
        return (obj || new PCFReentry()).__init(bb.readInt32(bb.position()) + bb.position(), bb);
    }
    static getSizePrefixedRootAsPCFReentry(bb, obj) {
        bb.setPosition(bb.position() + flatbuffers.SIZE_PREFIX_LENGTH);
        return (obj || new PCFReentry()).__init(bb.readInt32(bb.position()) + bb.position(), bb);
    }
    ALTITUDE_KM() {
        const offset = this.bb.__offset(this.bb_pos, 4);
        return offset ? this.bb.readFloat64(this.bb_pos + offset) : 80.0;
    }
    HANDOFF_PERIGEE_ALTITUDE_KM() {
        const offset = this.bb.__offset(this.bb_pos, 6);
        return offset ? this.bb.readFloat64(this.bb_pos + offset) : 180.0;
    }
    HANDOFF_DECAY_RATIO() {
        const offset = this.bb.__offset(this.bb_pos, 8);
        return offset ? this.bb.readFloat64(this.bb_pos + offset) : 0.05;
    }
    HANDOFF_ECCENTRICITY_COLLAPSE() {
        const offset = this.bb.__offset(this.bb_pos, 10);
        return offset ? this.bb.readFloat64(this.bb_pos + offset) : 0.01;
    }
    HANDOFF_MINIMUM_ECCENTRICITY() {
        const offset = this.bb.__offset(this.bb_pos, 12);
        return offset ? this.bb.readFloat64(this.bb_pos + offset) : 0.01;
    }
    NODE_STEP_MINUTES() {
        const offset = this.bb.__offset(this.bb_pos, 14);
        return offset ? this.bb.readFloat64(this.bb_pos + offset) : 30.0;
    }
    HORIZON_DAYS() {
        const offset = this.bb.__offset(this.bb_pos, 16);
        return offset ? this.bb.readFloat64(this.bb_pos + offset) : 120.0;
    }
    WINDOW_METHOD() {
        const offset = this.bb.__offset(this.bb_pos, 18);
        return offset ? this.bb.readUint8(this.bb_pos + offset) : pcfReentryWindowMethod.LINEAR;
    }
    WINDOW_DENSITY_SIGMA() {
        const offset = this.bb.__offset(this.bb_pos, 20);
        return offset ? this.bb.readFloat64(this.bb_pos + offset) : 0.15;
    }
    WINDOW_CORRELATION_DAYS() {
        const offset = this.bb.__offset(this.bb_pos, 22);
        return offset ? this.bb.readFloat64(this.bb_pos + offset) : 2.0;
    }
    WINDOW_BALLISTIC_SIGMA() {
        const offset = this.bb.__offset(this.bb_pos, 24);
        return offset ? this.bb.readFloat64(this.bb_pos + offset) : 0.05;
    }
    OSCULATING_STEP_SECONDS() {
        const offset = this.bb.__offset(this.bb_pos, 26);
        return offset ? this.bb.readFloat64(this.bb_pos + offset) : 10.0;
    }
    static startPCFReentry(builder) {
        builder.startObject(12);
    }
    static addAltitudeKm(builder, ALTITUDE_KM) {
        builder.addFieldFloat64(0, ALTITUDE_KM, 80.0);
    }
    static addHandoffPerigeeAltitudeKm(builder, HANDOFF_PERIGEE_ALTITUDE_KM) {
        builder.addFieldFloat64(1, HANDOFF_PERIGEE_ALTITUDE_KM, 180.0);
    }
    static addHandoffDecayRatio(builder, HANDOFF_DECAY_RATIO) {
        builder.addFieldFloat64(2, HANDOFF_DECAY_RATIO, 0.05);
    }
    static addHandoffEccentricityCollapse(builder, HANDOFF_ECCENTRICITY_COLLAPSE) {
        builder.addFieldFloat64(3, HANDOFF_ECCENTRICITY_COLLAPSE, 0.01);
    }
    static addHandoffMinimumEccentricity(builder, HANDOFF_MINIMUM_ECCENTRICITY) {
        builder.addFieldFloat64(4, HANDOFF_MINIMUM_ECCENTRICITY, 0.01);
    }
    static addNodeStepMinutes(builder, NODE_STEP_MINUTES) {
        builder.addFieldFloat64(5, NODE_STEP_MINUTES, 30.0);
    }
    static addHorizonDays(builder, HORIZON_DAYS) {
        builder.addFieldFloat64(6, HORIZON_DAYS, 120.0);
    }
    static addWindowMethod(builder, WINDOW_METHOD) {
        builder.addFieldInt8(7, WINDOW_METHOD, pcfReentryWindowMethod.LINEAR);
    }
    static addWindowDensitySigma(builder, WINDOW_DENSITY_SIGMA) {
        builder.addFieldFloat64(8, WINDOW_DENSITY_SIGMA, 0.15);
    }
    static addWindowCorrelationDays(builder, WINDOW_CORRELATION_DAYS) {
        builder.addFieldFloat64(9, WINDOW_CORRELATION_DAYS, 2.0);
    }
    static addWindowBallisticSigma(builder, WINDOW_BALLISTIC_SIGMA) {
        builder.addFieldFloat64(10, WINDOW_BALLISTIC_SIGMA, 0.05);
    }
    static addOsculatingStepSeconds(builder, OSCULATING_STEP_SECONDS) {
        builder.addFieldFloat64(11, OSCULATING_STEP_SECONDS, 10.0);
    }
    static endPCFReentry(builder) {
        const offset = builder.endObject();
        return offset;
    }
    static createPCFReentry(builder, ALTITUDE_KM, HANDOFF_PERIGEE_ALTITUDE_KM, HANDOFF_DECAY_RATIO, HANDOFF_ECCENTRICITY_COLLAPSE, HANDOFF_MINIMUM_ECCENTRICITY, NODE_STEP_MINUTES, HORIZON_DAYS, WINDOW_METHOD, WINDOW_DENSITY_SIGMA, WINDOW_CORRELATION_DAYS, WINDOW_BALLISTIC_SIGMA, OSCULATING_STEP_SECONDS) {
        PCFReentry.startPCFReentry(builder);
        PCFReentry.addAltitudeKm(builder, ALTITUDE_KM);
        PCFReentry.addHandoffPerigeeAltitudeKm(builder, HANDOFF_PERIGEE_ALTITUDE_KM);
        PCFReentry.addHandoffDecayRatio(builder, HANDOFF_DECAY_RATIO);
        PCFReentry.addHandoffEccentricityCollapse(builder, HANDOFF_ECCENTRICITY_COLLAPSE);
        PCFReentry.addHandoffMinimumEccentricity(builder, HANDOFF_MINIMUM_ECCENTRICITY);
        PCFReentry.addNodeStepMinutes(builder, NODE_STEP_MINUTES);
        PCFReentry.addHorizonDays(builder, HORIZON_DAYS);
        PCFReentry.addWindowMethod(builder, WINDOW_METHOD);
        PCFReentry.addWindowDensitySigma(builder, WINDOW_DENSITY_SIGMA);
        PCFReentry.addWindowCorrelationDays(builder, WINDOW_CORRELATION_DAYS);
        PCFReentry.addWindowBallisticSigma(builder, WINDOW_BALLISTIC_SIGMA);
        PCFReentry.addOsculatingStepSeconds(builder, OSCULATING_STEP_SECONDS);
        return PCFReentry.endPCFReentry(builder);
    }
    unpack() {
        return new PCFReentryT(this.ALTITUDE_KM(), this.HANDOFF_PERIGEE_ALTITUDE_KM(), this.HANDOFF_DECAY_RATIO(), this.HANDOFF_ECCENTRICITY_COLLAPSE(), this.HANDOFF_MINIMUM_ECCENTRICITY(), this.NODE_STEP_MINUTES(), this.HORIZON_DAYS(), this.WINDOW_METHOD(), this.WINDOW_DENSITY_SIGMA(), this.WINDOW_CORRELATION_DAYS(), this.WINDOW_BALLISTIC_SIGMA(), this.OSCULATING_STEP_SECONDS());
    }
    unpackTo(_o) {
        _o.ALTITUDE_KM = this.ALTITUDE_KM();
        _o.HANDOFF_PERIGEE_ALTITUDE_KM = this.HANDOFF_PERIGEE_ALTITUDE_KM();
        _o.HANDOFF_DECAY_RATIO = this.HANDOFF_DECAY_RATIO();
        _o.HANDOFF_ECCENTRICITY_COLLAPSE = this.HANDOFF_ECCENTRICITY_COLLAPSE();
        _o.HANDOFF_MINIMUM_ECCENTRICITY = this.HANDOFF_MINIMUM_ECCENTRICITY();
        _o.NODE_STEP_MINUTES = this.NODE_STEP_MINUTES();
        _o.HORIZON_DAYS = this.HORIZON_DAYS();
        _o.WINDOW_METHOD = this.WINDOW_METHOD();
        _o.WINDOW_DENSITY_SIGMA = this.WINDOW_DENSITY_SIGMA();
        _o.WINDOW_CORRELATION_DAYS = this.WINDOW_CORRELATION_DAYS();
        _o.WINDOW_BALLISTIC_SIGMA = this.WINDOW_BALLISTIC_SIGMA();
        _o.OSCULATING_STEP_SECONDS = this.OSCULATING_STEP_SECONDS();
    }
}
export class PCFReentryT {
    ALTITUDE_KM;
    HANDOFF_PERIGEE_ALTITUDE_KM;
    HANDOFF_DECAY_RATIO;
    HANDOFF_ECCENTRICITY_COLLAPSE;
    HANDOFF_MINIMUM_ECCENTRICITY;
    NODE_STEP_MINUTES;
    HORIZON_DAYS;
    WINDOW_METHOD;
    WINDOW_DENSITY_SIGMA;
    WINDOW_CORRELATION_DAYS;
    WINDOW_BALLISTIC_SIGMA;
    OSCULATING_STEP_SECONDS;
    constructor(ALTITUDE_KM = 80.0, HANDOFF_PERIGEE_ALTITUDE_KM = 180.0, HANDOFF_DECAY_RATIO = 0.05, HANDOFF_ECCENTRICITY_COLLAPSE = 0.01, HANDOFF_MINIMUM_ECCENTRICITY = 0.01, NODE_STEP_MINUTES = 30.0, HORIZON_DAYS = 120.0, WINDOW_METHOD = pcfReentryWindowMethod.LINEAR, WINDOW_DENSITY_SIGMA = 0.15, WINDOW_CORRELATION_DAYS = 2.0, WINDOW_BALLISTIC_SIGMA = 0.05, OSCULATING_STEP_SECONDS = 10.0){
        this.ALTITUDE_KM = ALTITUDE_KM;
        this.HANDOFF_PERIGEE_ALTITUDE_KM = HANDOFF_PERIGEE_ALTITUDE_KM;
        this.HANDOFF_DECAY_RATIO = HANDOFF_DECAY_RATIO;
        this.HANDOFF_ECCENTRICITY_COLLAPSE = HANDOFF_ECCENTRICITY_COLLAPSE;
        this.HANDOFF_MINIMUM_ECCENTRICITY = HANDOFF_MINIMUM_ECCENTRICITY;
        this.NODE_STEP_MINUTES = NODE_STEP_MINUTES;
        this.HORIZON_DAYS = HORIZON_DAYS;
        this.WINDOW_METHOD = WINDOW_METHOD;
        this.WINDOW_DENSITY_SIGMA = WINDOW_DENSITY_SIGMA;
        this.WINDOW_CORRELATION_DAYS = WINDOW_CORRELATION_DAYS;
        this.WINDOW_BALLISTIC_SIGMA = WINDOW_BALLISTIC_SIGMA;
        this.OSCULATING_STEP_SECONDS = OSCULATING_STEP_SECONDS;
    }
    pack(builder) {
        return PCFReentry.createPCFReentry(builder, this.ALTITUDE_KM, this.HANDOFF_PERIGEE_ALTITUDE_KM, this.HANDOFF_DECAY_RATIO, this.HANDOFF_ECCENTRICITY_COLLAPSE, this.HANDOFF_MINIMUM_ECCENTRICITY, this.NODE_STEP_MINUTES, this.HORIZON_DAYS, this.WINDOW_METHOD, this.WINDOW_DENSITY_SIGMA, this.WINDOW_CORRELATION_DAYS, this.WINDOW_BALLISTIC_SIGMA, this.OSCULATING_STEP_SECONDS);
    }
}
