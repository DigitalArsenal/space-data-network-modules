import * as flatbuffers from 'flatbuffers';
import { pcfOutputFrame } from './pcfOutputFrame.js';
export class PCFOutput {
    bb = null;
    bb_pos = 0;
    __init(i, bb) {
        this.bb_pos = i;
        this.bb = bb;
        return this;
    }
    static getRootAsPCFOutput(bb, obj) {
        return (obj || new PCFOutput()).__init(bb.readInt32(bb.position()) + bb.position(), bb);
    }
    static getSizePrefixedRootAsPCFOutput(bb, obj) {
        bb.setPosition(bb.position() + flatbuffers.SIZE_PREFIX_LENGTH);
        return (obj || new PCFOutput()).__init(bb.readInt32(bb.position()) + bb.position(), bb);
    }
    FRAME() {
        const offset = this.bb.__offset(this.bb_pos, 4);
        return offset ? this.bb.readUint8(this.bb_pos + offset) : pcfOutputFrame.UNSPECIFIED;
    }
    STEP_SECONDS() {
        const offset = this.bb.__offset(this.bb_pos, 6);
        return offset ? this.bb.readFloat64(this.bb_pos + offset) : 60.0;
    }
    MAXIMUM_STATES() {
        const offset = this.bb.__offset(this.bb_pos, 8);
        return offset ? this.bb.readUint32(this.bb_pos + offset) : 500000;
    }
    static startPCFOutput(builder) {
        builder.startObject(3);
    }
    static addFrame(builder, FRAME) {
        builder.addFieldInt8(0, FRAME, pcfOutputFrame.UNSPECIFIED);
    }
    static addStepSeconds(builder, STEP_SECONDS) {
        builder.addFieldFloat64(1, STEP_SECONDS, 60.0);
    }
    static addMaximumStates(builder, MAXIMUM_STATES) {
        builder.addFieldInt32(2, MAXIMUM_STATES, 500000);
    }
    static endPCFOutput(builder) {
        const offset = builder.endObject();
        return offset;
    }
    static createPCFOutput(builder, FRAME, STEP_SECONDS, MAXIMUM_STATES) {
        PCFOutput.startPCFOutput(builder);
        PCFOutput.addFrame(builder, FRAME);
        PCFOutput.addStepSeconds(builder, STEP_SECONDS);
        PCFOutput.addMaximumStates(builder, MAXIMUM_STATES);
        return PCFOutput.endPCFOutput(builder);
    }
    unpack() {
        return new PCFOutputT(this.FRAME(), this.STEP_SECONDS(), this.MAXIMUM_STATES());
    }
    unpackTo(_o) {
        _o.FRAME = this.FRAME();
        _o.STEP_SECONDS = this.STEP_SECONDS();
        _o.MAXIMUM_STATES = this.MAXIMUM_STATES();
    }
}
export class PCFOutputT {
    FRAME;
    STEP_SECONDS;
    MAXIMUM_STATES;
    constructor(FRAME = pcfOutputFrame.UNSPECIFIED, STEP_SECONDS = 60.0, MAXIMUM_STATES = 500000){
        this.FRAME = FRAME;
        this.STEP_SECONDS = STEP_SECONDS;
        this.MAXIMUM_STATES = MAXIMUM_STATES;
    }
    pack(builder) {
        return PCFOutput.createPCFOutput(builder, this.FRAME, this.STEP_SECONDS, this.MAXIMUM_STATES);
    }
}
