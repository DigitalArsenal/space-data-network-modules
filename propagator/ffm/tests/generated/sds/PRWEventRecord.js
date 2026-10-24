import * as flatbuffers from 'flatbuffers';
import { PRWResidentState, PRWResidentStateT } from './PRWResidentState.js';
import { TIMInstant, TIMInstantT } from './TIMInstant.js';
import { pcfEventDirection } from './pcfEventDirection.js';
import { pcfEventKind } from './pcfEventKind.js';
export class PRWEventRecord {
    bb = null;
    bb_pos = 0;
    __init(i, bb) {
        this.bb_pos = i;
        this.bb = bb;
        return this;
    }
    static getRootAsPRWEventRecord(bb, obj) {
        return (obj || new PRWEventRecord()).__init(bb.readInt32(bb.position()) + bb.position(), bb);
    }
    static getSizePrefixedRootAsPRWEventRecord(bb, obj) {
        bb.setPosition(bb.position() + flatbuffers.SIZE_PREFIX_LENGTH);
        return (obj || new PRWEventRecord()).__init(bb.readInt32(bb.position()) + bb.position(), bb);
    }
    EVENT_INDEX() {
        const offset = this.bb.__offset(this.bb_pos, 4);
        return offset ? this.bb.readUint32(this.bb_pos + offset) : 0;
    }
    KIND() {
        const offset = this.bb.__offset(this.bb_pos, 6);
        return offset ? this.bb.readUint8(this.bb_pos + offset) : pcfEventKind.UNSPECIFIED;
    }
    DIRECTION() {
        const offset = this.bb.__offset(this.bb_pos, 8);
        return offset ? this.bb.readUint8(this.bb_pos + offset) : pcfEventDirection.ANY;
    }
    EPOCH(obj) {
        const offset = this.bb.__offset(this.bb_pos, 10);
        return offset ? (obj || new TIMInstant()).__init(this.bb.__indirect(this.bb_pos + offset), this.bb) : null;
    }
    ELAPSED_SECONDS() {
        const offset = this.bb.__offset(this.bb_pos, 12);
        return offset ? this.bb.readFloat64(this.bb_pos + offset) : 0.0;
    }
    STATE(obj) {
        const offset = this.bb.__offset(this.bb_pos, 14);
        return offset ? (obj || new PRWResidentState()).__init(this.bb.__indirect(this.bb_pos + offset), this.bb) : null;
    }
    RESIDUAL() {
        const offset = this.bb.__offset(this.bb_pos, 16);
        return offset ? this.bb.readFloat64(this.bb_pos + offset) : 0.0;
    }
    ITERATIONS() {
        const offset = this.bb.__offset(this.bb_pos, 18);
        return offset ? this.bb.readUint32(this.bb_pos + offset) : 0;
    }
    static startPRWEventRecord(builder) {
        builder.startObject(8);
    }
    static addEventIndex(builder, EVENT_INDEX) {
        builder.addFieldInt32(0, EVENT_INDEX, 0);
    }
    static addKind(builder, KIND) {
        builder.addFieldInt8(1, KIND, pcfEventKind.UNSPECIFIED);
    }
    static addDirection(builder, DIRECTION) {
        builder.addFieldInt8(2, DIRECTION, pcfEventDirection.ANY);
    }
    static addEpoch(builder, EPOCHOffset) {
        builder.addFieldOffset(3, EPOCHOffset, 0);
    }
    static addElapsedSeconds(builder, ELAPSED_SECONDS) {
        builder.addFieldFloat64(4, ELAPSED_SECONDS, 0.0);
    }
    static addState(builder, STATEOffset) {
        builder.addFieldOffset(5, STATEOffset, 0);
    }
    static addResidual(builder, RESIDUAL) {
        builder.addFieldFloat64(6, RESIDUAL, 0.0);
    }
    static addIterations(builder, ITERATIONS) {
        builder.addFieldInt32(7, ITERATIONS, 0);
    }
    static endPRWEventRecord(builder) {
        const offset = builder.endObject();
        builder.requiredField(offset, 10);
        builder.requiredField(offset, 14);
        return offset;
    }
    unpack() {
        return new PRWEventRecordT(this.EVENT_INDEX(), this.KIND(), this.DIRECTION(), this.EPOCH() !== null ? this.EPOCH().unpack() : null, this.ELAPSED_SECONDS(), this.STATE() !== null ? this.STATE().unpack() : null, this.RESIDUAL(), this.ITERATIONS());
    }
    unpackTo(_o) {
        _o.EVENT_INDEX = this.EVENT_INDEX();
        _o.KIND = this.KIND();
        _o.DIRECTION = this.DIRECTION();
        _o.EPOCH = this.EPOCH() !== null ? this.EPOCH().unpack() : null;
        _o.ELAPSED_SECONDS = this.ELAPSED_SECONDS();
        _o.STATE = this.STATE() !== null ? this.STATE().unpack() : null;
        _o.RESIDUAL = this.RESIDUAL();
        _o.ITERATIONS = this.ITERATIONS();
    }
}
export class PRWEventRecordT {
    EVENT_INDEX;
    KIND;
    DIRECTION;
    EPOCH;
    ELAPSED_SECONDS;
    STATE;
    RESIDUAL;
    ITERATIONS;
    constructor(EVENT_INDEX = 0, KIND = pcfEventKind.UNSPECIFIED, DIRECTION = pcfEventDirection.ANY, EPOCH = null, ELAPSED_SECONDS = 0.0, STATE = null, RESIDUAL = 0.0, ITERATIONS = 0){
        this.EVENT_INDEX = EVENT_INDEX;
        this.KIND = KIND;
        this.DIRECTION = DIRECTION;
        this.EPOCH = EPOCH;
        this.ELAPSED_SECONDS = ELAPSED_SECONDS;
        this.STATE = STATE;
        this.RESIDUAL = RESIDUAL;
        this.ITERATIONS = ITERATIONS;
    }
    pack(builder) {
        const EPOCH = this.EPOCH !== null ? this.EPOCH.pack(builder) : 0;
        const STATE = this.STATE !== null ? this.STATE.pack(builder) : 0;
        PRWEventRecord.startPRWEventRecord(builder);
        PRWEventRecord.addEventIndex(builder, this.EVENT_INDEX);
        PRWEventRecord.addKind(builder, this.KIND);
        PRWEventRecord.addDirection(builder, this.DIRECTION);
        PRWEventRecord.addEpoch(builder, EPOCH);
        PRWEventRecord.addElapsedSeconds(builder, this.ELAPSED_SECONDS);
        PRWEventRecord.addState(builder, STATE);
        PRWEventRecord.addResidual(builder, this.RESIDUAL);
        PRWEventRecord.addIterations(builder, this.ITERATIONS);
        return PRWEventRecord.endPRWEventRecord(builder);
    }
}
