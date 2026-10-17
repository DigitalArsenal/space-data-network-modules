import * as flatbuffers from 'flatbuffers';
import { TIMInstant, TIMInstantT } from './TIMInstant.js';
export class PRWWindowQuery {
    bb = null;
    bb_pos = 0;
    __init(i, bb) {
        this.bb_pos = i;
        this.bb = bb;
        return this;
    }
    static getRootAsPRWWindowQuery(bb, obj) {
        return (obj || new PRWWindowQuery()).__init(bb.readInt32(bb.position()) + bb.position(), bb);
    }
    static getSizePrefixedRootAsPRWWindowQuery(bb, obj) {
        bb.setPosition(bb.position() + flatbuffers.SIZE_PREFIX_LENGTH);
        return (obj || new PRWWindowQuery()).__init(bb.readInt32(bb.position()) + bb.position(), bb);
    }
    SEQUENCE() {
        const offset = this.bb.__offset(this.bb_pos, 4);
        return offset ? this.bb.readUint32(this.bb_pos + offset) : 0;
    }
    SET_INDEX() {
        const offset = this.bb.__offset(this.bb_pos, 6);
        return offset ? this.bb.readUint32(this.bb_pos + offset) : 0;
    }
    ENTITY_HANDLE() {
        const offset = this.bb.__offset(this.bb_pos, 8);
        return offset ? this.bb.readUint32(this.bb_pos + offset) : 0;
    }
    OBJECT_KEY(optionalEncoding) {
        const offset = this.bb.__offset(this.bb_pos, 10);
        return offset ? this.bb.__string(this.bb_pos + offset, optionalEncoding) : null;
    }
    NORAD_CAT_ID() {
        const offset = this.bb.__offset(this.bb_pos, 12);
        return offset ? this.bb.readUint32(this.bb_pos + offset) : 0;
    }
    OBJECT_ID(optionalEncoding) {
        const offset = this.bb.__offset(this.bb_pos, 14);
        return offset ? this.bb.__string(this.bb_pos + offset, optionalEncoding) : null;
    }
    SOURCE_EPOCH(obj) {
        const offset = this.bb.__offset(this.bb_pos, 16);
        return offset ? (obj || new TIMInstant()).__init(this.bb.__indirect(this.bb_pos + offset), this.bb) : null;
    }
    START(obj) {
        const offset = this.bb.__offset(this.bb_pos, 18);
        return offset ? (obj || new TIMInstant()).__init(this.bb.__indirect(this.bb_pos + offset), this.bb) : null;
    }
    STOP(obj) {
        const offset = this.bb.__offset(this.bb_pos, 20);
        return offset ? (obj || new TIMInstant()).__init(this.bb.__indirect(this.bb_pos + offset), this.bb) : null;
    }
    STEP_SECONDS() {
        const offset = this.bb.__offset(this.bb_pos, 22);
        return offset ? this.bb.readFloat64(this.bb_pos + offset) : 0.0;
    }
    static startPRWWindowQuery(builder) {
        builder.startObject(10);
    }
    static addSequence(builder, SEQUENCE) {
        builder.addFieldInt32(0, SEQUENCE, 0);
    }
    static addSetIndex(builder, SET_INDEX) {
        builder.addFieldInt32(1, SET_INDEX, 0);
    }
    static addEntityHandle(builder, ENTITY_HANDLE) {
        builder.addFieldInt32(2, ENTITY_HANDLE, 0);
    }
    static addObjectKey(builder, OBJECT_KEYOffset) {
        builder.addFieldOffset(3, OBJECT_KEYOffset, 0);
    }
    static addNoradCatId(builder, NORAD_CAT_ID) {
        builder.addFieldInt32(4, NORAD_CAT_ID, 0);
    }
    static addObjectId(builder, OBJECT_IDOffset) {
        builder.addFieldOffset(5, OBJECT_IDOffset, 0);
    }
    static addSourceEpoch(builder, SOURCE_EPOCHOffset) {
        builder.addFieldOffset(6, SOURCE_EPOCHOffset, 0);
    }
    static addStart(builder, STARTOffset) {
        builder.addFieldOffset(7, STARTOffset, 0);
    }
    static addStop(builder, STOPOffset) {
        builder.addFieldOffset(8, STOPOffset, 0);
    }
    static addStepSeconds(builder, STEP_SECONDS) {
        builder.addFieldFloat64(9, STEP_SECONDS, 0.0);
    }
    static endPRWWindowQuery(builder) {
        const offset = builder.endObject();
        builder.requiredField(offset, 18);
        builder.requiredField(offset, 20);
        return offset;
    }
    unpack() {
        return new PRWWindowQueryT(this.SEQUENCE(), this.SET_INDEX(), this.ENTITY_HANDLE(), this.OBJECT_KEY(), this.NORAD_CAT_ID(), this.OBJECT_ID(), this.SOURCE_EPOCH() !== null ? this.SOURCE_EPOCH().unpack() : null, this.START() !== null ? this.START().unpack() : null, this.STOP() !== null ? this.STOP().unpack() : null, this.STEP_SECONDS());
    }
    unpackTo(_o) {
        _o.SEQUENCE = this.SEQUENCE();
        _o.SET_INDEX = this.SET_INDEX();
        _o.ENTITY_HANDLE = this.ENTITY_HANDLE();
        _o.OBJECT_KEY = this.OBJECT_KEY();
        _o.NORAD_CAT_ID = this.NORAD_CAT_ID();
        _o.OBJECT_ID = this.OBJECT_ID();
        _o.SOURCE_EPOCH = this.SOURCE_EPOCH() !== null ? this.SOURCE_EPOCH().unpack() : null;
        _o.START = this.START() !== null ? this.START().unpack() : null;
        _o.STOP = this.STOP() !== null ? this.STOP().unpack() : null;
        _o.STEP_SECONDS = this.STEP_SECONDS();
    }
}
export class PRWWindowQueryT {
    SEQUENCE;
    SET_INDEX;
    ENTITY_HANDLE;
    OBJECT_KEY;
    NORAD_CAT_ID;
    OBJECT_ID;
    SOURCE_EPOCH;
    START;
    STOP;
    STEP_SECONDS;
    constructor(SEQUENCE = 0, SET_INDEX = 0, ENTITY_HANDLE = 0, OBJECT_KEY = null, NORAD_CAT_ID = 0, OBJECT_ID = null, SOURCE_EPOCH = null, START = null, STOP = null, STEP_SECONDS = 0.0){
        this.SEQUENCE = SEQUENCE;
        this.SET_INDEX = SET_INDEX;
        this.ENTITY_HANDLE = ENTITY_HANDLE;
        this.OBJECT_KEY = OBJECT_KEY;
        this.NORAD_CAT_ID = NORAD_CAT_ID;
        this.OBJECT_ID = OBJECT_ID;
        this.SOURCE_EPOCH = SOURCE_EPOCH;
        this.START = START;
        this.STOP = STOP;
        this.STEP_SECONDS = STEP_SECONDS;
    }
    pack(builder) {
        const OBJECT_KEY = this.OBJECT_KEY !== null ? builder.createString(this.OBJECT_KEY) : 0;
        const OBJECT_ID = this.OBJECT_ID !== null ? builder.createString(this.OBJECT_ID) : 0;
        const SOURCE_EPOCH = this.SOURCE_EPOCH !== null ? this.SOURCE_EPOCH.pack(builder) : 0;
        const START = this.START !== null ? this.START.pack(builder) : 0;
        const STOP = this.STOP !== null ? this.STOP.pack(builder) : 0;
        PRWWindowQuery.startPRWWindowQuery(builder);
        PRWWindowQuery.addSequence(builder, this.SEQUENCE);
        PRWWindowQuery.addSetIndex(builder, this.SET_INDEX);
        PRWWindowQuery.addEntityHandle(builder, this.ENTITY_HANDLE);
        PRWWindowQuery.addObjectKey(builder, OBJECT_KEY);
        PRWWindowQuery.addNoradCatId(builder, this.NORAD_CAT_ID);
        PRWWindowQuery.addObjectId(builder, OBJECT_ID);
        PRWWindowQuery.addSourceEpoch(builder, SOURCE_EPOCH);
        PRWWindowQuery.addStart(builder, START);
        PRWWindowQuery.addStop(builder, STOP);
        PRWWindowQuery.addStepSeconds(builder, this.STEP_SECONDS);
        return PRWWindowQuery.endPRWWindowQuery(builder);
    }
}
