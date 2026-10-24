import * as flatbuffers from 'flatbuffers';
import { pcfInnovationCorrelation } from './pcfInnovationCorrelation.js';
export class PCFManeuverDetection {
    bb = null;
    bb_pos = 0;
    __init(i, bb) {
        this.bb_pos = i;
        this.bb = bb;
        return this;
    }
    static getRootAsPCFManeuverDetection(bb, obj) {
        return (obj || new PCFManeuverDetection()).__init(bb.readInt32(bb.position()) + bb.position(), bb);
    }
    static getSizePrefixedRootAsPCFManeuverDetection(bb, obj) {
        bb.setPosition(bb.position() + flatbuffers.SIZE_PREFIX_LENGTH);
        return (obj || new PCFManeuverDetection()).__init(bb.readInt32(bb.position()) + bb.position(), bb);
    }
    FALSE_ALARMS_PER_OBJECT_YEAR() {
        const offset = this.bb.__offset(this.bb_pos, 4);
        return offset ? this.bb.readFloat64(this.bb_pos + offset) : 1.0;
    }
    CORRELATION_MODEL() {
        const offset = this.bb.__offset(this.bb_pos, 6);
        return offset ? this.bb.readUint8(this.bb_pos + offset) : pcfInnovationCorrelation.ONE_SAMPLE_PER_REVOLUTION;
    }
    THRESHOLD() {
        const offset = this.bb.__offset(this.bb_pos, 8);
        return offset ? this.bb.readFloat64(this.bb_pos + offset) : 20.0;
    }
    MARGIN_STATES() {
        const offset = this.bb.__offset(this.bb_pos, 10);
        return offset ? this.bb.readUint32(this.bb_pos + offset) : 12;
    }
    REFINE_WINDOW_HOURS() {
        const offset = this.bb.__offset(this.bb_pos, 12);
        return offset ? this.bb.readFloat64(this.bb_pos + offset) : 2.0;
    }
    MINIMUM_STATES() {
        const offset = this.bb.__offset(this.bb_pos, 14);
        return offset ? this.bb.readUint32(this.bb_pos + offset) : 48;
    }
    static startPCFManeuverDetection(builder) {
        builder.startObject(6);
    }
    static addFalseAlarmsPerObjectYear(builder, FALSE_ALARMS_PER_OBJECT_YEAR) {
        builder.addFieldFloat64(0, FALSE_ALARMS_PER_OBJECT_YEAR, 1.0);
    }
    static addCorrelationModel(builder, CORRELATION_MODEL) {
        builder.addFieldInt8(1, CORRELATION_MODEL, pcfInnovationCorrelation.ONE_SAMPLE_PER_REVOLUTION);
    }
    static addThreshold(builder, THRESHOLD) {
        builder.addFieldFloat64(2, THRESHOLD, 20.0);
    }
    static addMarginStates(builder, MARGIN_STATES) {
        builder.addFieldInt32(3, MARGIN_STATES, 12);
    }
    static addRefineWindowHours(builder, REFINE_WINDOW_HOURS) {
        builder.addFieldFloat64(4, REFINE_WINDOW_HOURS, 2.0);
    }
    static addMinimumStates(builder, MINIMUM_STATES) {
        builder.addFieldInt32(5, MINIMUM_STATES, 48);
    }
    static endPCFManeuverDetection(builder) {
        const offset = builder.endObject();
        return offset;
    }
    static createPCFManeuverDetection(builder, FALSE_ALARMS_PER_OBJECT_YEAR, CORRELATION_MODEL, THRESHOLD, MARGIN_STATES, REFINE_WINDOW_HOURS, MINIMUM_STATES) {
        PCFManeuverDetection.startPCFManeuverDetection(builder);
        PCFManeuverDetection.addFalseAlarmsPerObjectYear(builder, FALSE_ALARMS_PER_OBJECT_YEAR);
        PCFManeuverDetection.addCorrelationModel(builder, CORRELATION_MODEL);
        PCFManeuverDetection.addThreshold(builder, THRESHOLD);
        PCFManeuverDetection.addMarginStates(builder, MARGIN_STATES);
        PCFManeuverDetection.addRefineWindowHours(builder, REFINE_WINDOW_HOURS);
        PCFManeuverDetection.addMinimumStates(builder, MINIMUM_STATES);
        return PCFManeuverDetection.endPCFManeuverDetection(builder);
    }
    unpack() {
        return new PCFManeuverDetectionT(this.FALSE_ALARMS_PER_OBJECT_YEAR(), this.CORRELATION_MODEL(), this.THRESHOLD(), this.MARGIN_STATES(), this.REFINE_WINDOW_HOURS(), this.MINIMUM_STATES());
    }
    unpackTo(_o) {
        _o.FALSE_ALARMS_PER_OBJECT_YEAR = this.FALSE_ALARMS_PER_OBJECT_YEAR();
        _o.CORRELATION_MODEL = this.CORRELATION_MODEL();
        _o.THRESHOLD = this.THRESHOLD();
        _o.MARGIN_STATES = this.MARGIN_STATES();
        _o.REFINE_WINDOW_HOURS = this.REFINE_WINDOW_HOURS();
        _o.MINIMUM_STATES = this.MINIMUM_STATES();
    }
}
export class PCFManeuverDetectionT {
    FALSE_ALARMS_PER_OBJECT_YEAR;
    CORRELATION_MODEL;
    THRESHOLD;
    MARGIN_STATES;
    REFINE_WINDOW_HOURS;
    MINIMUM_STATES;
    constructor(FALSE_ALARMS_PER_OBJECT_YEAR = 1.0, CORRELATION_MODEL = pcfInnovationCorrelation.ONE_SAMPLE_PER_REVOLUTION, THRESHOLD = 20.0, MARGIN_STATES = 12, REFINE_WINDOW_HOURS = 2.0, MINIMUM_STATES = 48){
        this.FALSE_ALARMS_PER_OBJECT_YEAR = FALSE_ALARMS_PER_OBJECT_YEAR;
        this.CORRELATION_MODEL = CORRELATION_MODEL;
        this.THRESHOLD = THRESHOLD;
        this.MARGIN_STATES = MARGIN_STATES;
        this.REFINE_WINDOW_HOURS = REFINE_WINDOW_HOURS;
        this.MINIMUM_STATES = MINIMUM_STATES;
    }
    pack(builder) {
        return PCFManeuverDetection.createPCFManeuverDetection(builder, this.FALSE_ALARMS_PER_OBJECT_YEAR, this.CORRELATION_MODEL, this.THRESHOLD, this.MARGIN_STATES, this.REFINE_WINDOW_HOURS, this.MINIMUM_STATES);
    }
}
