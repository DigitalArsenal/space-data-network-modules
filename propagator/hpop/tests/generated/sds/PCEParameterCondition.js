import * as flatbuffers from 'flatbuffers';
import { PCEParameterRef, PCEParameterRefT } from './PCEParameterRef.js';
import { pceConditionDirection } from './pceConditionDirection.js';
export class PCEParameterCondition {
    bb = null;
    bb_pos = 0;
    __init(i, bb) {
        this.bb_pos = i;
        this.bb = bb;
        return this;
    }
    static getRootAsPCEParameterCondition(bb, obj) {
        return (obj || new PCEParameterCondition()).__init(bb.readInt32(bb.position()) + bb.position(), bb);
    }
    static getSizePrefixedRootAsPCEParameterCondition(bb, obj) {
        bb.setPosition(bb.position() + flatbuffers.SIZE_PREFIX_LENGTH);
        return (obj || new PCEParameterCondition()).__init(bb.readInt32(bb.position()) + bb.position(), bb);
    }
    PARAMETER(obj) {
        const offset = this.bb.__offset(this.bb_pos, 4);
        return offset ? (obj || new PCEParameterRef()).__init(this.bb.__indirect(this.bb_pos + offset), this.bb) : null;
    }
    GOAL_VALUE() {
        const offset = this.bb.__offset(this.bb_pos, 6);
        return offset ? this.bb.readFloat64(this.bb_pos + offset) : 0.0;
    }
    DIRECTION() {
        const offset = this.bb.__offset(this.bb_pos, 8);
        return offset ? this.bb.readUint8(this.bb_pos + offset) : pceConditionDirection.UNSPECIFIED;
    }
    GOAL_TOLERANCE() {
        const offset = this.bb.__offset(this.bb_pos, 10);
        return offset ? this.bb.readFloat64(this.bb_pos + offset) : 0.0;
    }
    OCCURRENCE() {
        const offset = this.bb.__offset(this.bb_pos, 12);
        return offset ? this.bb.readUint32(this.bb_pos + offset) : 1;
    }
    static startPCEParameterCondition(builder) {
        builder.startObject(5);
    }
    static addParameter(builder, PARAMETEROffset) {
        builder.addFieldOffset(0, PARAMETEROffset, 0);
    }
    static addGoalValue(builder, GOAL_VALUE) {
        builder.addFieldFloat64(1, GOAL_VALUE, 0.0);
    }
    static addDirection(builder, DIRECTION) {
        builder.addFieldInt8(2, DIRECTION, pceConditionDirection.UNSPECIFIED);
    }
    static addGoalTolerance(builder, GOAL_TOLERANCE) {
        builder.addFieldFloat64(3, GOAL_TOLERANCE, 0.0);
    }
    static addOccurrence(builder, OCCURRENCE) {
        builder.addFieldInt32(4, OCCURRENCE, 1);
    }
    static endPCEParameterCondition(builder) {
        const offset = builder.endObject();
        return offset;
    }
    static createPCEParameterCondition(builder, PARAMETEROffset, GOAL_VALUE, DIRECTION, GOAL_TOLERANCE, OCCURRENCE) {
        PCEParameterCondition.startPCEParameterCondition(builder);
        PCEParameterCondition.addParameter(builder, PARAMETEROffset);
        PCEParameterCondition.addGoalValue(builder, GOAL_VALUE);
        PCEParameterCondition.addDirection(builder, DIRECTION);
        PCEParameterCondition.addGoalTolerance(builder, GOAL_TOLERANCE);
        PCEParameterCondition.addOccurrence(builder, OCCURRENCE);
        return PCEParameterCondition.endPCEParameterCondition(builder);
    }
    unpack() {
        return new PCEParameterConditionT(this.PARAMETER() !== null ? this.PARAMETER().unpack() : null, this.GOAL_VALUE(), this.DIRECTION(), this.GOAL_TOLERANCE(), this.OCCURRENCE());
    }
    unpackTo(_o) {
        _o.PARAMETER = this.PARAMETER() !== null ? this.PARAMETER().unpack() : null;
        _o.GOAL_VALUE = this.GOAL_VALUE();
        _o.DIRECTION = this.DIRECTION();
        _o.GOAL_TOLERANCE = this.GOAL_TOLERANCE();
        _o.OCCURRENCE = this.OCCURRENCE();
    }
}
export class PCEParameterConditionT {
    PARAMETER;
    GOAL_VALUE;
    DIRECTION;
    GOAL_TOLERANCE;
    OCCURRENCE;
    constructor(PARAMETER = null, GOAL_VALUE = 0.0, DIRECTION = pceConditionDirection.UNSPECIFIED, GOAL_TOLERANCE = 0.0, OCCURRENCE = 1){
        this.PARAMETER = PARAMETER;
        this.GOAL_VALUE = GOAL_VALUE;
        this.DIRECTION = DIRECTION;
        this.GOAL_TOLERANCE = GOAL_TOLERANCE;
        this.OCCURRENCE = OCCURRENCE;
    }
    pack(builder) {
        const PARAMETER = this.PARAMETER !== null ? this.PARAMETER.pack(builder) : 0;
        return PCEParameterCondition.createPCEParameterCondition(builder, PARAMETER, this.GOAL_VALUE, this.DIRECTION, this.GOAL_TOLERANCE, this.OCCURRENCE);
    }
}
