import * as flatbuffers from 'flatbuffers';
import { TIMInstant, TIMInstantT } from './TIMInstant.js';
export class PRWEphemerisRequest {
    bb = null;
    bb_pos = 0;
    __init(i, bb) {
        this.bb_pos = i;
        this.bb = bb;
        return this;
    }
    static getRootAsPRWEphemerisRequest(bb, obj) {
        return (obj || new PRWEphemerisRequest()).__init(bb.readInt32(bb.position()) + bb.position(), bb);
    }
    static getSizePrefixedRootAsPRWEphemerisRequest(bb, obj) {
        bb.setPosition(bb.position() + flatbuffers.SIZE_PREFIX_LENGTH);
        return (obj || new PRWEphemerisRequest()).__init(bb.readInt32(bb.position()) + bb.position(), bb);
    }
    EPOCH(obj) {
        const offset = this.bb.__offset(this.bb_pos, 4);
        return offset ? (obj || new TIMInstant()).__init(this.bb.__indirect(this.bb_pos + offset), this.bb) : null;
    }
    TARGET_NAIF_ID() {
        const offset = this.bb.__offset(this.bb_pos, 6);
        return offset ? this.bb.readInt32(this.bb_pos + offset) : 0;
    }
    CENTER_NAIF_ID() {
        const offset = this.bb.__offset(this.bb_pos, 8);
        return offset ? this.bb.readInt32(this.bb_pos + offset) : 399;
    }
    static startPRWEphemerisRequest(builder) {
        builder.startObject(3);
    }
    static addEpoch(builder, EPOCHOffset) {
        builder.addFieldOffset(0, EPOCHOffset, 0);
    }
    static addTargetNaifId(builder, TARGET_NAIF_ID) {
        builder.addFieldInt32(1, TARGET_NAIF_ID, 0);
    }
    static addCenterNaifId(builder, CENTER_NAIF_ID) {
        builder.addFieldInt32(2, CENTER_NAIF_ID, 399);
    }
    static endPRWEphemerisRequest(builder) {
        const offset = builder.endObject();
        builder.requiredField(offset, 4);
        return offset;
    }
    static createPRWEphemerisRequest(builder, EPOCHOffset, TARGET_NAIF_ID, CENTER_NAIF_ID) {
        PRWEphemerisRequest.startPRWEphemerisRequest(builder);
        PRWEphemerisRequest.addEpoch(builder, EPOCHOffset);
        PRWEphemerisRequest.addTargetNaifId(builder, TARGET_NAIF_ID);
        PRWEphemerisRequest.addCenterNaifId(builder, CENTER_NAIF_ID);
        return PRWEphemerisRequest.endPRWEphemerisRequest(builder);
    }
    unpack() {
        return new PRWEphemerisRequestT(this.EPOCH() !== null ? this.EPOCH().unpack() : null, this.TARGET_NAIF_ID(), this.CENTER_NAIF_ID());
    }
    unpackTo(_o) {
        _o.EPOCH = this.EPOCH() !== null ? this.EPOCH().unpack() : null;
        _o.TARGET_NAIF_ID = this.TARGET_NAIF_ID();
        _o.CENTER_NAIF_ID = this.CENTER_NAIF_ID();
    }
}
export class PRWEphemerisRequestT {
    EPOCH;
    TARGET_NAIF_ID;
    CENTER_NAIF_ID;
    constructor(EPOCH = null, TARGET_NAIF_ID = 0, CENTER_NAIF_ID = 399){
        this.EPOCH = EPOCH;
        this.TARGET_NAIF_ID = TARGET_NAIF_ID;
        this.CENTER_NAIF_ID = CENTER_NAIF_ID;
    }
    pack(builder) {
        const EPOCH = this.EPOCH !== null ? this.EPOCH.pack(builder) : 0;
        return PRWEphemerisRequest.createPRWEphemerisRequest(builder, EPOCH, this.TARGET_NAIF_ID, this.CENTER_NAIF_ID);
    }
}
