import * as flatbuffers from 'flatbuffers';
import { PCEParameterSample, PCEParameterSampleT } from './PCEParameterSample.js';
import { evlSamplePoint } from './evlSamplePoint.js';
export class EVLEventSample {
    bb = null;
    bb_pos = 0;
    __init(i, bb) {
        this.bb_pos = i;
        this.bb = bb;
        return this;
    }
    static getRootAsEVLEventSample(bb, obj) {
        return (obj || new EVLEventSample()).__init(bb.readInt32(bb.position()) + bb.position(), bb);
    }
    static getSizePrefixedRootAsEVLEventSample(bb, obj) {
        bb.setPosition(bb.position() + flatbuffers.SIZE_PREFIX_LENGTH);
        return (obj || new EVLEventSample()).__init(bb.readInt32(bb.position()) + bb.position(), bb);
    }
    POINT() {
        const offset = this.bb.__offset(this.bb_pos, 4);
        return offset ? this.bb.readUint8(this.bb_pos + offset) : evlSamplePoint.UNSPECIFIED;
    }
    SAMPLE(obj) {
        const offset = this.bb.__offset(this.bb_pos, 6);
        return offset ? (obj || new PCEParameterSample()).__init(this.bb.__indirect(this.bb_pos + offset), this.bb) : null;
    }
    static startEVLEventSample(builder) {
        builder.startObject(2);
    }
    static addPoint(builder, POINT) {
        builder.addFieldInt8(0, POINT, evlSamplePoint.UNSPECIFIED);
    }
    static addSample(builder, SAMPLEOffset) {
        builder.addFieldOffset(1, SAMPLEOffset, 0);
    }
    static endEVLEventSample(builder) {
        const offset = builder.endObject();
        return offset;
    }
    unpack() {
        return new EVLEventSampleT(this.POINT(), this.SAMPLE() !== null ? this.SAMPLE().unpack() : null);
    }
    unpackTo(_o) {
        _o.POINT = this.POINT();
        _o.SAMPLE = this.SAMPLE() !== null ? this.SAMPLE().unpack() : null;
    }
}
export class EVLEventSampleT {
    POINT;
    SAMPLE;
    constructor(POINT = evlSamplePoint.UNSPECIFIED, SAMPLE = null){
        this.POINT = POINT;
        this.SAMPLE = SAMPLE;
    }
    pack(builder) {
        const SAMPLE = this.SAMPLE !== null ? this.SAMPLE.pack(builder) : 0;
        EVLEventSample.startEVLEventSample(builder);
        EVLEventSample.addPoint(builder, this.POINT);
        EVLEventSample.addSample(builder, SAMPLE);
        return EVLEventSample.endEVLEventSample(builder);
    }
}
