import * as flatbuffers from 'flatbuffers';
import { propagatorErrorCode } from './propagatorErrorCode.js';
import { propagatorStateFlags } from './propagatorStateFlags.js';
export class PRWBatchResponse {
    bb = null;
    bb_pos = 0;
    __init(i, bb) {
        this.bb_pos = i;
        this.bb = bb;
        return this;
    }
    static getRootAsPRWBatchResponse(bb, obj) {
        return (obj || new PRWBatchResponse()).__init(bb.readInt32(bb.position()) + bb.position(), bb);
    }
    static getSizePrefixedRootAsPRWBatchResponse(bb, obj) {
        bb.setPosition(bb.position() + flatbuffers.SIZE_PREFIX_LENGTH);
        return (obj || new PRWBatchResponse()).__init(bb.readInt32(bb.position()) + bb.position(), bb);
    }
    COUNT() {
        const offset = this.bb.__offset(this.bb_pos, 4);
        return offset ? this.bb.readUint32(this.bb_pos + offset) : 0;
    }
    OUTPUT_OFFSET() {
        const offset = this.bb.__offset(this.bb_pos, 6);
        return offset ? this.bb.readUint32(this.bb_pos + offset) : 0;
    }
    STATE_VECTOR_SIZE() {
        const offset = this.bb.__offset(this.bb_pos, 8);
        return offset ? this.bb.readUint8(this.bb_pos + offset) : 0;
    }
    REFERENCE_FRAME(optionalEncoding) {
        const offset = this.bb.__offset(this.bb_pos, 10);
        return offset ? this.bb.__string(this.bb_pos + offset, optionalEncoding) : null;
    }
    FLAGS(index) {
        const offset = this.bb.__offset(this.bb_pos, 12);
        return offset ? this.bb.readUint32(this.bb.__vector(this.bb_pos + offset) + index * 4) : null;
    }
    flagsLength() {
        const offset = this.bb.__offset(this.bb_pos, 12);
        return offset ? this.bb.__vector_len(this.bb_pos + offset) : 0;
    }
    flagsArray() {
        const offset = this.bb.__offset(this.bb_pos, 12);
        return offset ? new Uint32Array(this.bb.bytes().buffer, this.bb.bytes().byteOffset + this.bb.__vector(this.bb_pos + offset), this.bb.__vector_len(this.bb_pos + offset)) : null;
    }
    ERROR_CODE() {
        const offset = this.bb.__offset(this.bb_pos, 14);
        return offset ? this.bb.readInt32(this.bb_pos + offset) : propagatorErrorCode.OK;
    }
    ERROR_MESSAGE(optionalEncoding) {
        const offset = this.bb.__offset(this.bb_pos, 16);
        return offset ? this.bb.__string(this.bb_pos + offset, optionalEncoding) : null;
    }
    static startPRWBatchResponse(builder) {
        builder.startObject(7);
    }
    static addCount(builder, COUNT) {
        builder.addFieldInt32(0, COUNT, 0);
    }
    static addOutputOffset(builder, OUTPUT_OFFSET) {
        builder.addFieldInt32(1, OUTPUT_OFFSET, 0);
    }
    static addStateVectorSize(builder, STATE_VECTOR_SIZE) {
        builder.addFieldInt8(2, STATE_VECTOR_SIZE, 0);
    }
    static addReferenceFrame(builder, REFERENCE_FRAMEOffset) {
        builder.addFieldOffset(3, REFERENCE_FRAMEOffset, 0);
    }
    static addFlags(builder, FLAGSOffset) {
        builder.addFieldOffset(4, FLAGSOffset, 0);
    }
    static createFlagsVector(builder, data) {
        builder.startVector(4, data.length, 4);
        for(let i = data.length - 1; i >= 0; i--){
            builder.addInt32(data[i]);
        }
        return builder.endVector();
    }
    static startFlagsVector(builder, numElems) {
        builder.startVector(4, numElems, 4);
    }
    static addErrorCode(builder, ERROR_CODE) {
        builder.addFieldInt32(5, ERROR_CODE, propagatorErrorCode.OK);
    }
    static addErrorMessage(builder, ERROR_MESSAGEOffset) {
        builder.addFieldOffset(6, ERROR_MESSAGEOffset, 0);
    }
    static endPRWBatchResponse(builder) {
        const offset = builder.endObject();
        return offset;
    }
    static createPRWBatchResponse(builder, COUNT, OUTPUT_OFFSET, STATE_VECTOR_SIZE, REFERENCE_FRAMEOffset, FLAGSOffset, ERROR_CODE, ERROR_MESSAGEOffset) {
        PRWBatchResponse.startPRWBatchResponse(builder);
        PRWBatchResponse.addCount(builder, COUNT);
        PRWBatchResponse.addOutputOffset(builder, OUTPUT_OFFSET);
        PRWBatchResponse.addStateVectorSize(builder, STATE_VECTOR_SIZE);
        PRWBatchResponse.addReferenceFrame(builder, REFERENCE_FRAMEOffset);
        PRWBatchResponse.addFlags(builder, FLAGSOffset);
        PRWBatchResponse.addErrorCode(builder, ERROR_CODE);
        PRWBatchResponse.addErrorMessage(builder, ERROR_MESSAGEOffset);
        return PRWBatchResponse.endPRWBatchResponse(builder);
    }
    unpack() {
        return new PRWBatchResponseT(this.COUNT(), this.OUTPUT_OFFSET(), this.STATE_VECTOR_SIZE(), this.REFERENCE_FRAME(), this.bb.createScalarList(this.FLAGS.bind(this), this.flagsLength()), this.ERROR_CODE(), this.ERROR_MESSAGE());
    }
    unpackTo(_o) {
        _o.COUNT = this.COUNT();
        _o.OUTPUT_OFFSET = this.OUTPUT_OFFSET();
        _o.STATE_VECTOR_SIZE = this.STATE_VECTOR_SIZE();
        _o.REFERENCE_FRAME = this.REFERENCE_FRAME();
        _o.FLAGS = this.bb.createScalarList(this.FLAGS.bind(this), this.flagsLength());
        _o.ERROR_CODE = this.ERROR_CODE();
        _o.ERROR_MESSAGE = this.ERROR_MESSAGE();
    }
}
export class PRWBatchResponseT {
    COUNT;
    OUTPUT_OFFSET;
    STATE_VECTOR_SIZE;
    REFERENCE_FRAME;
    FLAGS;
    ERROR_CODE;
    ERROR_MESSAGE;
    constructor(COUNT = 0, OUTPUT_OFFSET = 0, STATE_VECTOR_SIZE = 0, REFERENCE_FRAME = null, FLAGS = [], ERROR_CODE = propagatorErrorCode.OK, ERROR_MESSAGE = null){
        this.COUNT = COUNT;
        this.OUTPUT_OFFSET = OUTPUT_OFFSET;
        this.STATE_VECTOR_SIZE = STATE_VECTOR_SIZE;
        this.REFERENCE_FRAME = REFERENCE_FRAME;
        this.FLAGS = FLAGS;
        this.ERROR_CODE = ERROR_CODE;
        this.ERROR_MESSAGE = ERROR_MESSAGE;
    }
    pack(builder) {
        const REFERENCE_FRAME = this.REFERENCE_FRAME !== null ? builder.createString(this.REFERENCE_FRAME) : 0;
        const FLAGS = PRWBatchResponse.createFlagsVector(builder, this.FLAGS);
        const ERROR_MESSAGE = this.ERROR_MESSAGE !== null ? builder.createString(this.ERROR_MESSAGE) : 0;
        return PRWBatchResponse.createPRWBatchResponse(builder, this.COUNT, this.OUTPUT_OFFSET, this.STATE_VECTOR_SIZE, REFERENCE_FRAME, FLAGS, this.ERROR_CODE, ERROR_MESSAGE);
    }
}
