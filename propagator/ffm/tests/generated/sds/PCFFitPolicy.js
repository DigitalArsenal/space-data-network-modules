import * as flatbuffers from 'flatbuffers';
import { PCFGaussianPrior, PCFGaussianPriorT } from './PCFGaussianPrior.js';
export class PCFFitPolicy {
    bb = null;
    bb_pos = 0;
    __init(i, bb) {
        this.bb_pos = i;
        this.bb = bb;
        return this;
    }
    static getRootAsPCFFitPolicy(bb, obj) {
        return (obj || new PCFFitPolicy()).__init(bb.readInt32(bb.position()) + bb.position(), bb);
    }
    static getSizePrefixedRootAsPCFFitPolicy(bb, obj) {
        bb.setPosition(bb.position() + flatbuffers.SIZE_PREFIX_LENGTH);
        return (obj || new PCFFitPolicy()).__init(bb.readInt32(bb.position()) + bb.position(), bb);
    }
    DEFAULT_SPAN_HOURS() {
        const offset = this.bb.__offset(this.bb_pos, 4);
        return offset ? this.bb.readFloat64(this.bb_pos + offset) : 48.0;
    }
    MINIMUM_SPAN_HOURS() {
        const offset = this.bb.__offset(this.bb_pos, 6);
        return offset ? this.bb.readFloat64(this.bb_pos + offset) : 24.0;
    }
    MAXIMUM_SPAN_HOURS() {
        const offset = this.bb.__offset(this.bb_pos, 8);
        return offset ? this.bb.readFloat64(this.bb_pos + offset) : 120.0;
    }
    CANDIDATE_SPANS_HOURS(index) {
        const offset = this.bb.__offset(this.bb_pos, 10);
        return offset ? this.bb.readFloat64(this.bb.__vector(this.bb_pos + offset) + index * 8) : 0;
    }
    candidateSpansHoursLength() {
        const offset = this.bb.__offset(this.bb_pos, 10);
        return offset ? this.bb.__vector_len(this.bb_pos + offset) : 0;
    }
    candidateSpansHoursArray() {
        const offset = this.bb.__offset(this.bb_pos, 10);
        return offset ? new Float64Array(this.bb.bytes().buffer, this.bb.bytes().byteOffset + this.bb.__vector(this.bb_pos + offset), this.bb.__vector_len(this.bb_pos + offset)) : null;
    }
    TAIL_HOURS() {
        const offset = this.bb.__offset(this.bb_pos, 12);
        return offset ? this.bb.readFloat64(this.bb_pos + offset) : 24.0;
    }
    EXTENSION_MARGIN() {
        const offset = this.bb.__offset(this.bb_pos, 14);
        return offset ? this.bb.readFloat64(this.bb_pos + offset) : 0.9;
    }
    HOLDOUT_HOURS() {
        const offset = this.bb.__offset(this.bb_pos, 16);
        return offset ? this.bb.readFloat64(this.bb_pos + offset) : 0.0;
    }
    HAS_HOLDOUT_HOURS() {
        const offset = this.bb.__offset(this.bb_pos, 18);
        return offset ? !!this.bb.readInt8(this.bb_pos + offset) : false;
    }
    ECCENTRICITY_THRESHOLD() {
        const offset = this.bb.__offset(this.bb_pos, 20);
        return offset ? this.bb.readFloat64(this.bb_pos + offset) : 0.5;
    }
    ECCENTRIC_DEFAULT_SPAN_HOURS() {
        const offset = this.bb.__offset(this.bb_pos, 22);
        return offset ? this.bb.readFloat64(this.bb_pos + offset) : 24.0;
    }
    ECCENTRIC_EXTENSION_MARGIN() {
        const offset = this.bb.__offset(this.bb_pos, 24);
        return offset ? this.bb.readFloat64(this.bb_pos + offset) : 0.7;
    }
    ECCENTRIC_MAXIMUM_PERIOD_HOURS() {
        const offset = this.bb.__offset(this.bb_pos, 26);
        return offset ? this.bb.readFloat64(this.bb_pos + offset) : 36.0;
    }
    IMPLAUSIBLE_RMS_KM() {
        const offset = this.bb.__offset(this.bb_pos, 28);
        return offset ? this.bb.readFloat64(this.bb_pos + offset) : 100.0;
    }
    DRAG_PRIOR(obj) {
        const offset = this.bb.__offset(this.bb_pos, 30);
        return offset ? (obj || new PCFGaussianPrior()).__init(this.bb.__indirect(this.bb_pos + offset), this.bb) : null;
    }
    SRP_PRIOR(obj) {
        const offset = this.bb.__offset(this.bb_pos, 32);
        return offset ? (obj || new PCFGaussianPrior()).__init(this.bb.__indirect(this.bb_pos + offset), this.bb) : null;
    }
    static startPCFFitPolicy(builder) {
        builder.startObject(15);
    }
    static addDefaultSpanHours(builder, DEFAULT_SPAN_HOURS) {
        builder.addFieldFloat64(0, DEFAULT_SPAN_HOURS, 48.0);
    }
    static addMinimumSpanHours(builder, MINIMUM_SPAN_HOURS) {
        builder.addFieldFloat64(1, MINIMUM_SPAN_HOURS, 24.0);
    }
    static addMaximumSpanHours(builder, MAXIMUM_SPAN_HOURS) {
        builder.addFieldFloat64(2, MAXIMUM_SPAN_HOURS, 120.0);
    }
    static addCandidateSpansHours(builder, CANDIDATE_SPANS_HOURSOffset) {
        builder.addFieldOffset(3, CANDIDATE_SPANS_HOURSOffset, 0);
    }
    static createCandidateSpansHoursVector(builder, data) {
        builder.startVector(8, data.length, 8);
        for(let i = data.length - 1; i >= 0; i--){
            builder.addFloat64(data[i]);
        }
        return builder.endVector();
    }
    static startCandidateSpansHoursVector(builder, numElems) {
        builder.startVector(8, numElems, 8);
    }
    static addTailHours(builder, TAIL_HOURS) {
        builder.addFieldFloat64(4, TAIL_HOURS, 24.0);
    }
    static addExtensionMargin(builder, EXTENSION_MARGIN) {
        builder.addFieldFloat64(5, EXTENSION_MARGIN, 0.9);
    }
    static addHoldoutHours(builder, HOLDOUT_HOURS) {
        builder.addFieldFloat64(6, HOLDOUT_HOURS, 0.0);
    }
    static addHasHoldoutHours(builder, HAS_HOLDOUT_HOURS) {
        builder.addFieldInt8(7, +HAS_HOLDOUT_HOURS, +false);
    }
    static addEccentricityThreshold(builder, ECCENTRICITY_THRESHOLD) {
        builder.addFieldFloat64(8, ECCENTRICITY_THRESHOLD, 0.5);
    }
    static addEccentricDefaultSpanHours(builder, ECCENTRIC_DEFAULT_SPAN_HOURS) {
        builder.addFieldFloat64(9, ECCENTRIC_DEFAULT_SPAN_HOURS, 24.0);
    }
    static addEccentricExtensionMargin(builder, ECCENTRIC_EXTENSION_MARGIN) {
        builder.addFieldFloat64(10, ECCENTRIC_EXTENSION_MARGIN, 0.7);
    }
    static addEccentricMaximumPeriodHours(builder, ECCENTRIC_MAXIMUM_PERIOD_HOURS) {
        builder.addFieldFloat64(11, ECCENTRIC_MAXIMUM_PERIOD_HOURS, 36.0);
    }
    static addImplausibleRmsKm(builder, IMPLAUSIBLE_RMS_KM) {
        builder.addFieldFloat64(12, IMPLAUSIBLE_RMS_KM, 100.0);
    }
    static addDragPrior(builder, DRAG_PRIOROffset) {
        builder.addFieldOffset(13, DRAG_PRIOROffset, 0);
    }
    static addSrpPrior(builder, SRP_PRIOROffset) {
        builder.addFieldOffset(14, SRP_PRIOROffset, 0);
    }
    static endPCFFitPolicy(builder) {
        const offset = builder.endObject();
        return offset;
    }
    unpack() {
        return new PCFFitPolicyT(this.DEFAULT_SPAN_HOURS(), this.MINIMUM_SPAN_HOURS(), this.MAXIMUM_SPAN_HOURS(), this.bb.createScalarList(this.CANDIDATE_SPANS_HOURS.bind(this), this.candidateSpansHoursLength()), this.TAIL_HOURS(), this.EXTENSION_MARGIN(), this.HOLDOUT_HOURS(), this.HAS_HOLDOUT_HOURS(), this.ECCENTRICITY_THRESHOLD(), this.ECCENTRIC_DEFAULT_SPAN_HOURS(), this.ECCENTRIC_EXTENSION_MARGIN(), this.ECCENTRIC_MAXIMUM_PERIOD_HOURS(), this.IMPLAUSIBLE_RMS_KM(), this.DRAG_PRIOR() !== null ? this.DRAG_PRIOR().unpack() : null, this.SRP_PRIOR() !== null ? this.SRP_PRIOR().unpack() : null);
    }
    unpackTo(_o) {
        _o.DEFAULT_SPAN_HOURS = this.DEFAULT_SPAN_HOURS();
        _o.MINIMUM_SPAN_HOURS = this.MINIMUM_SPAN_HOURS();
        _o.MAXIMUM_SPAN_HOURS = this.MAXIMUM_SPAN_HOURS();
        _o.CANDIDATE_SPANS_HOURS = this.bb.createScalarList(this.CANDIDATE_SPANS_HOURS.bind(this), this.candidateSpansHoursLength());
        _o.TAIL_HOURS = this.TAIL_HOURS();
        _o.EXTENSION_MARGIN = this.EXTENSION_MARGIN();
        _o.HOLDOUT_HOURS = this.HOLDOUT_HOURS();
        _o.HAS_HOLDOUT_HOURS = this.HAS_HOLDOUT_HOURS();
        _o.ECCENTRICITY_THRESHOLD = this.ECCENTRICITY_THRESHOLD();
        _o.ECCENTRIC_DEFAULT_SPAN_HOURS = this.ECCENTRIC_DEFAULT_SPAN_HOURS();
        _o.ECCENTRIC_EXTENSION_MARGIN = this.ECCENTRIC_EXTENSION_MARGIN();
        _o.ECCENTRIC_MAXIMUM_PERIOD_HOURS = this.ECCENTRIC_MAXIMUM_PERIOD_HOURS();
        _o.IMPLAUSIBLE_RMS_KM = this.IMPLAUSIBLE_RMS_KM();
        _o.DRAG_PRIOR = this.DRAG_PRIOR() !== null ? this.DRAG_PRIOR().unpack() : null;
        _o.SRP_PRIOR = this.SRP_PRIOR() !== null ? this.SRP_PRIOR().unpack() : null;
    }
}
export class PCFFitPolicyT {
    DEFAULT_SPAN_HOURS;
    MINIMUM_SPAN_HOURS;
    MAXIMUM_SPAN_HOURS;
    CANDIDATE_SPANS_HOURS;
    TAIL_HOURS;
    EXTENSION_MARGIN;
    HOLDOUT_HOURS;
    HAS_HOLDOUT_HOURS;
    ECCENTRICITY_THRESHOLD;
    ECCENTRIC_DEFAULT_SPAN_HOURS;
    ECCENTRIC_EXTENSION_MARGIN;
    ECCENTRIC_MAXIMUM_PERIOD_HOURS;
    IMPLAUSIBLE_RMS_KM;
    DRAG_PRIOR;
    SRP_PRIOR;
    constructor(DEFAULT_SPAN_HOURS = 48.0, MINIMUM_SPAN_HOURS = 24.0, MAXIMUM_SPAN_HOURS = 120.0, CANDIDATE_SPANS_HOURS = [], TAIL_HOURS = 24.0, EXTENSION_MARGIN = 0.9, HOLDOUT_HOURS = 0.0, HAS_HOLDOUT_HOURS = false, ECCENTRICITY_THRESHOLD = 0.5, ECCENTRIC_DEFAULT_SPAN_HOURS = 24.0, ECCENTRIC_EXTENSION_MARGIN = 0.7, ECCENTRIC_MAXIMUM_PERIOD_HOURS = 36.0, IMPLAUSIBLE_RMS_KM = 100.0, DRAG_PRIOR = null, SRP_PRIOR = null){
        this.DEFAULT_SPAN_HOURS = DEFAULT_SPAN_HOURS;
        this.MINIMUM_SPAN_HOURS = MINIMUM_SPAN_HOURS;
        this.MAXIMUM_SPAN_HOURS = MAXIMUM_SPAN_HOURS;
        this.CANDIDATE_SPANS_HOURS = CANDIDATE_SPANS_HOURS;
        this.TAIL_HOURS = TAIL_HOURS;
        this.EXTENSION_MARGIN = EXTENSION_MARGIN;
        this.HOLDOUT_HOURS = HOLDOUT_HOURS;
        this.HAS_HOLDOUT_HOURS = HAS_HOLDOUT_HOURS;
        this.ECCENTRICITY_THRESHOLD = ECCENTRICITY_THRESHOLD;
        this.ECCENTRIC_DEFAULT_SPAN_HOURS = ECCENTRIC_DEFAULT_SPAN_HOURS;
        this.ECCENTRIC_EXTENSION_MARGIN = ECCENTRIC_EXTENSION_MARGIN;
        this.ECCENTRIC_MAXIMUM_PERIOD_HOURS = ECCENTRIC_MAXIMUM_PERIOD_HOURS;
        this.IMPLAUSIBLE_RMS_KM = IMPLAUSIBLE_RMS_KM;
        this.DRAG_PRIOR = DRAG_PRIOR;
        this.SRP_PRIOR = SRP_PRIOR;
    }
    pack(builder) {
        const CANDIDATE_SPANS_HOURS = PCFFitPolicy.createCandidateSpansHoursVector(builder, this.CANDIDATE_SPANS_HOURS);
        const DRAG_PRIOR = this.DRAG_PRIOR !== null ? this.DRAG_PRIOR.pack(builder) : 0;
        const SRP_PRIOR = this.SRP_PRIOR !== null ? this.SRP_PRIOR.pack(builder) : 0;
        PCFFitPolicy.startPCFFitPolicy(builder);
        PCFFitPolicy.addDefaultSpanHours(builder, this.DEFAULT_SPAN_HOURS);
        PCFFitPolicy.addMinimumSpanHours(builder, this.MINIMUM_SPAN_HOURS);
        PCFFitPolicy.addMaximumSpanHours(builder, this.MAXIMUM_SPAN_HOURS);
        PCFFitPolicy.addCandidateSpansHours(builder, CANDIDATE_SPANS_HOURS);
        PCFFitPolicy.addTailHours(builder, this.TAIL_HOURS);
        PCFFitPolicy.addExtensionMargin(builder, this.EXTENSION_MARGIN);
        PCFFitPolicy.addHoldoutHours(builder, this.HOLDOUT_HOURS);
        PCFFitPolicy.addHasHoldoutHours(builder, this.HAS_HOLDOUT_HOURS);
        PCFFitPolicy.addEccentricityThreshold(builder, this.ECCENTRICITY_THRESHOLD);
        PCFFitPolicy.addEccentricDefaultSpanHours(builder, this.ECCENTRIC_DEFAULT_SPAN_HOURS);
        PCFFitPolicy.addEccentricExtensionMargin(builder, this.ECCENTRIC_EXTENSION_MARGIN);
        PCFFitPolicy.addEccentricMaximumPeriodHours(builder, this.ECCENTRIC_MAXIMUM_PERIOD_HOURS);
        PCFFitPolicy.addImplausibleRmsKm(builder, this.IMPLAUSIBLE_RMS_KM);
        PCFFitPolicy.addDragPrior(builder, DRAG_PRIOR);
        PCFFitPolicy.addSrpPrior(builder, SRP_PRIOR);
        return PCFFitPolicy.endPCFFitPolicy(builder);
    }
}
