import * as flatbuffers from 'flatbuffers';
import { RFMCoordinateSystem, RFMCoordinateSystemT } from './RFMCoordinateSystem.js';
export class RFMCoordinateSystemWrapper {
    bb = null;
    bb_pos = 0;
    __init(i, bb) {
        this.bb_pos = i;
        this.bb = bb;
        return this;
    }
    static getRootAsRFMCoordinateSystemWrapper(bb, obj) {
        return (obj || new RFMCoordinateSystemWrapper()).__init(bb.readInt32(bb.position()) + bb.position(), bb);
    }
    static getSizePrefixedRootAsRFMCoordinateSystemWrapper(bb, obj) {
        bb.setPosition(bb.position() + flatbuffers.SIZE_PREFIX_LENGTH);
        return (obj || new RFMCoordinateSystemWrapper()).__init(bb.readInt32(bb.position()) + bb.position(), bb);
    }
    COORDINATE_SYSTEM(obj) {
        const offset = this.bb.__offset(this.bb_pos, 4);
        return offset ? (obj || new RFMCoordinateSystem()).__init(this.bb.__indirect(this.bb_pos + offset), this.bb) : null;
    }
    static startRFMCoordinateSystemWrapper(builder) {
        builder.startObject(1);
    }
    static addCoordinateSystem(builder, COORDINATE_SYSTEMOffset) {
        builder.addFieldOffset(0, COORDINATE_SYSTEMOffset, 0);
    }
    static endRFMCoordinateSystemWrapper(builder) {
        const offset = builder.endObject();
        return offset;
    }
    static createRFMCoordinateSystemWrapper(builder, COORDINATE_SYSTEMOffset) {
        RFMCoordinateSystemWrapper.startRFMCoordinateSystemWrapper(builder);
        RFMCoordinateSystemWrapper.addCoordinateSystem(builder, COORDINATE_SYSTEMOffset);
        return RFMCoordinateSystemWrapper.endRFMCoordinateSystemWrapper(builder);
    }
    unpack() {
        return new RFMCoordinateSystemWrapperT(this.COORDINATE_SYSTEM() !== null ? this.COORDINATE_SYSTEM().unpack() : null);
    }
    unpackTo(_o) {
        _o.COORDINATE_SYSTEM = this.COORDINATE_SYSTEM() !== null ? this.COORDINATE_SYSTEM().unpack() : null;
    }
}
export class RFMCoordinateSystemWrapperT {
    COORDINATE_SYSTEM;
    constructor(COORDINATE_SYSTEM = null){
        this.COORDINATE_SYSTEM = COORDINATE_SYSTEM;
    }
    pack(builder) {
        const COORDINATE_SYSTEM = this.COORDINATE_SYSTEM !== null ? this.COORDINATE_SYSTEM.pack(builder) : 0;
        return RFMCoordinateSystemWrapper.createRFMCoordinateSystemWrapper(builder, COORDINATE_SYSTEM);
    }
}
