import * as flatbuffers from 'flatbuffers';
import { TIMConversionRequest, TIMConversionRequestT } from './TIMConversionRequest.js';
import { TIMConversionResult, TIMConversionResultT } from './TIMConversionResult.js';
import { TIMInstant, TIMInstantT } from './TIMInstant.js';
import { timingStandard } from './timingStandard.js';
export class TIM {
    bb = null;
    bb_pos = 0;
    __init(i, bb) {
        this.bb_pos = i;
        this.bb = bb;
        return this;
    }
    static getRootAsTIM(bb, obj) {
        return (obj || new TIM()).__init(bb.readInt32(bb.position()) + bb.position(), bb);
    }
    static getSizePrefixedRootAsTIM(bb, obj) {
        bb.setPosition(bb.position() + flatbuffers.SIZE_PREFIX_LENGTH);
        return (obj || new TIM()).__init(bb.readInt32(bb.position()) + bb.position(), bb);
    }
    TIME_SYSTEM() {
        const offset = this.bb.__offset(this.bb_pos, 4);
        return offset ? this.bb.readInt8(this.bb_pos + offset) : timingStandard.GMST;
    }
    INSTANT(obj) {
        const offset = this.bb.__offset(this.bb_pos, 6);
        return offset ? (obj || new TIMInstant()).__init(this.bb.__indirect(this.bb_pos + offset), this.bb) : null;
    }
    CONVERSION_REQUEST(obj) {
        const offset = this.bb.__offset(this.bb_pos, 8);
        return offset ? (obj || new TIMConversionRequest()).__init(this.bb.__indirect(this.bb_pos + offset), this.bb) : null;
    }
    CONVERSION_RESULT(obj) {
        const offset = this.bb.__offset(this.bb_pos, 10);
        return offset ? (obj || new TIMConversionResult()).__init(this.bb.__indirect(this.bb_pos + offset), this.bb) : null;
    }
    static startTIM(builder) {
        builder.startObject(4);
    }
    static addTimeSystem(builder, TIME_SYSTEM) {
        builder.addFieldInt8(0, TIME_SYSTEM, timingStandard.GMST);
    }
    static addInstant(builder, INSTANTOffset) {
        builder.addFieldOffset(1, INSTANTOffset, 0);
    }
    static addConversionRequest(builder, CONVERSION_REQUESTOffset) {
        builder.addFieldOffset(2, CONVERSION_REQUESTOffset, 0);
    }
    static addConversionResult(builder, CONVERSION_RESULTOffset) {
        builder.addFieldOffset(3, CONVERSION_RESULTOffset, 0);
    }
    static endTIM(builder) {
        const offset = builder.endObject();
        return offset;
    }
    unpack() {
        return new TIMT(this.TIME_SYSTEM(), this.INSTANT() !== null ? this.INSTANT().unpack() : null, this.CONVERSION_REQUEST() !== null ? this.CONVERSION_REQUEST().unpack() : null, this.CONVERSION_RESULT() !== null ? this.CONVERSION_RESULT().unpack() : null);
    }
    unpackTo(_o) {
        _o.TIME_SYSTEM = this.TIME_SYSTEM();
        _o.INSTANT = this.INSTANT() !== null ? this.INSTANT().unpack() : null;
        _o.CONVERSION_REQUEST = this.CONVERSION_REQUEST() !== null ? this.CONVERSION_REQUEST().unpack() : null;
        _o.CONVERSION_RESULT = this.CONVERSION_RESULT() !== null ? this.CONVERSION_RESULT().unpack() : null;
    }
}
export class TIMT {
    TIME_SYSTEM;
    INSTANT;
    CONVERSION_REQUEST;
    CONVERSION_RESULT;
    constructor(TIME_SYSTEM = timingStandard.GMST, INSTANT = null, CONVERSION_REQUEST = null, CONVERSION_RESULT = null){
        this.TIME_SYSTEM = TIME_SYSTEM;
        this.INSTANT = INSTANT;
        this.CONVERSION_REQUEST = CONVERSION_REQUEST;
        this.CONVERSION_RESULT = CONVERSION_RESULT;
    }
    pack(builder) {
        const INSTANT = this.INSTANT !== null ? this.INSTANT.pack(builder) : 0;
        const CONVERSION_REQUEST = this.CONVERSION_REQUEST !== null ? this.CONVERSION_REQUEST.pack(builder) : 0;
        const CONVERSION_RESULT = this.CONVERSION_RESULT !== null ? this.CONVERSION_RESULT.pack(builder) : 0;
        TIM.startTIM(builder);
        TIM.addTimeSystem(builder, this.TIME_SYSTEM);
        TIM.addInstant(builder, INSTANT);
        TIM.addConversionRequest(builder, CONVERSION_REQUEST);
        TIM.addConversionResult(builder, CONVERSION_RESULT);
        return TIM.endTIM(builder);
    }
}
