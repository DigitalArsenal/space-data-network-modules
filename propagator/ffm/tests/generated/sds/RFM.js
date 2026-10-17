import * as flatbuffers from 'flatbuffers';
import { CelestialFrameWrapper, CelestialFrameWrapperT } from './CelestialFrameWrapper.js';
import { CustomFrameWrapper, CustomFrameWrapperT } from './CustomFrameWrapper.js';
import { OrbitFrameWrapper, OrbitFrameWrapperT } from './OrbitFrameWrapper.js';
import { RFMCoordinateSystemWrapper, RFMCoordinateSystemWrapperT } from './RFMCoordinateSystemWrapper.js';
import { RFMUnion, unionToRfmunion, unionListToRfmunion } from './RFMUnion.js';
import { SpacecraftFrameWrapper, SpacecraftFrameWrapperT } from './SpacecraftFrameWrapper.js';
export class RFM {
    bb = null;
    bb_pos = 0;
    __init(i, bb) {
        this.bb_pos = i;
        this.bb = bb;
        return this;
    }
    static getRootAsRFM(bb, obj) {
        return (obj || new RFM()).__init(bb.readInt32(bb.position()) + bb.position(), bb);
    }
    static getSizePrefixedRootAsRFM(bb, obj) {
        bb.setPosition(bb.position() + flatbuffers.SIZE_PREFIX_LENGTH);
        return (obj || new RFM()).__init(bb.readInt32(bb.position()) + bb.position(), bb);
    }
    REFERENCE_FRAME_type() {
        const offset = this.bb.__offset(this.bb_pos, 4);
        return offset ? this.bb.readUint8(this.bb_pos + offset) : RFMUnion.NONE;
    }
    REFERENCE_FRAME(obj) {
        const offset = this.bb.__offset(this.bb_pos, 6);
        return offset ? this.bb.__union(obj, this.bb_pos + offset) : null;
    }
    INDEX() {
        const offset = this.bb.__offset(this.bb_pos, 8);
        return offset ? this.bb.readInt32(this.bb_pos + offset) : 0;
    }
    NAME(optionalEncoding) {
        const offset = this.bb.__offset(this.bb_pos, 10);
        return offset ? this.bb.__string(this.bb_pos + offset, optionalEncoding) : null;
    }
    static startRFM(builder) {
        builder.startObject(4);
    }
    static addReferenceFrameType(builder, REFERENCE_FRAME_type) {
        builder.addFieldInt8(0, REFERENCE_FRAME_type, RFMUnion.NONE);
    }
    static addReferenceFrame(builder, REFERENCE_FRAMEOffset) {
        builder.addFieldOffset(1, REFERENCE_FRAMEOffset, 0);
    }
    static addIndex(builder, INDEX) {
        builder.addFieldInt32(2, INDEX, 0);
    }
    static addName(builder, NAMEOffset) {
        builder.addFieldOffset(3, NAMEOffset, 0);
    }
    static endRFM(builder) {
        const offset = builder.endObject();
        return offset;
    }
    static createRFM(builder, REFERENCE_FRAME_type, REFERENCE_FRAMEOffset, INDEX, NAMEOffset) {
        RFM.startRFM(builder);
        RFM.addReferenceFrameType(builder, REFERENCE_FRAME_type);
        RFM.addReferenceFrame(builder, REFERENCE_FRAMEOffset);
        RFM.addIndex(builder, INDEX);
        RFM.addName(builder, NAMEOffset);
        return RFM.endRFM(builder);
    }
    unpack() {
        return new RFMT(this.REFERENCE_FRAME_type(), (()=>{
            const temp = unionToRfmunion(this.REFERENCE_FRAME_type(), this.REFERENCE_FRAME.bind(this));
            if (temp === null) {
                return null;
            }
            return temp.unpack();
        })(), this.INDEX(), this.NAME());
    }
    unpackTo(_o) {
        _o.REFERENCE_FRAME_type = this.REFERENCE_FRAME_type();
        _o.REFERENCE_FRAME = (()=>{
            const temp = unionToRfmunion(this.REFERENCE_FRAME_type(), this.REFERENCE_FRAME.bind(this));
            if (temp === null) {
                return null;
            }
            return temp.unpack();
        })();
        _o.INDEX = this.INDEX();
        _o.NAME = this.NAME();
    }
}
export class RFMT {
    REFERENCE_FRAME_type;
    REFERENCE_FRAME;
    INDEX;
    NAME;
    constructor(REFERENCE_FRAME_type = RFMUnion.NONE, REFERENCE_FRAME = null, INDEX = 0, NAME = null){
        this.REFERENCE_FRAME_type = REFERENCE_FRAME_type;
        this.REFERENCE_FRAME = REFERENCE_FRAME;
        this.INDEX = INDEX;
        this.NAME = NAME;
    }
    pack(builder) {
        const REFERENCE_FRAME = builder.createObjectOffset(this.REFERENCE_FRAME);
        const NAME = this.NAME !== null ? builder.createString(this.NAME) : 0;
        return RFM.createRFM(builder, this.REFERENCE_FRAME_type, REFERENCE_FRAME, this.INDEX, NAME);
    }
}
