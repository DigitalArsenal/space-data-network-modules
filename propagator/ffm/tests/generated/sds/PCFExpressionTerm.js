import * as flatbuffers from 'flatbuffers';
import { pceParameter } from './pceParameter.js';
import { pcfExpressionOperation } from './pcfExpressionOperation.js';
export class PCFExpressionTerm {
    bb = null;
    bb_pos = 0;
    __init(i, bb) {
        this.bb_pos = i;
        this.bb = bb;
        return this;
    }
    static getRootAsPCFExpressionTerm(bb, obj) {
        return (obj || new PCFExpressionTerm()).__init(bb.readInt32(bb.position()) + bb.position(), bb);
    }
    static getSizePrefixedRootAsPCFExpressionTerm(bb, obj) {
        bb.setPosition(bb.position() + flatbuffers.SIZE_PREFIX_LENGTH);
        return (obj || new PCFExpressionTerm()).__init(bb.readInt32(bb.position()) + bb.position(), bb);
    }
    OPERATION() {
        const offset = this.bb.__offset(this.bb_pos, 4);
        return offset ? this.bb.readUint8(this.bb_pos + offset) : pcfExpressionOperation.UNSPECIFIED;
    }
    VALUE() {
        const offset = this.bb.__offset(this.bb_pos, 6);
        return offset ? this.bb.readFloat64(this.bb_pos + offset) : 0.0;
    }
    PARAMETER() {
        const offset = this.bb.__offset(this.bb_pos, 8);
        return offset ? this.bb.readUint16(this.bb_pos + offset) : pceParameter.UNSPECIFIED;
    }
    static startPCFExpressionTerm(builder) {
        builder.startObject(3);
    }
    static addOperation(builder, OPERATION) {
        builder.addFieldInt8(0, OPERATION, pcfExpressionOperation.UNSPECIFIED);
    }
    static addValue(builder, VALUE) {
        builder.addFieldFloat64(1, VALUE, 0.0);
    }
    static addParameter(builder, PARAMETER) {
        builder.addFieldInt16(2, PARAMETER, pceParameter.UNSPECIFIED);
    }
    static endPCFExpressionTerm(builder) {
        const offset = builder.endObject();
        return offset;
    }
    static createPCFExpressionTerm(builder, OPERATION, VALUE, PARAMETER) {
        PCFExpressionTerm.startPCFExpressionTerm(builder);
        PCFExpressionTerm.addOperation(builder, OPERATION);
        PCFExpressionTerm.addValue(builder, VALUE);
        PCFExpressionTerm.addParameter(builder, PARAMETER);
        return PCFExpressionTerm.endPCFExpressionTerm(builder);
    }
    unpack() {
        return new PCFExpressionTermT(this.OPERATION(), this.VALUE(), this.PARAMETER());
    }
    unpackTo(_o) {
        _o.OPERATION = this.OPERATION();
        _o.VALUE = this.VALUE();
        _o.PARAMETER = this.PARAMETER();
    }
}
export class PCFExpressionTermT {
    OPERATION;
    VALUE;
    PARAMETER;
    constructor(OPERATION = pcfExpressionOperation.UNSPECIFIED, VALUE = 0.0, PARAMETER = pceParameter.UNSPECIFIED){
        this.OPERATION = OPERATION;
        this.VALUE = VALUE;
        this.PARAMETER = PARAMETER;
    }
    pack(builder) {
        return PCFExpressionTerm.createPCFExpressionTerm(builder, this.OPERATION, this.VALUE, this.PARAMETER);
    }
}
