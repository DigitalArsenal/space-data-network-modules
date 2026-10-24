import * as flatbuffers from 'flatbuffers';
import { PCFExpressionTerm, PCFExpressionTermT } from './PCFExpressionTerm.js';
export class PCFExpression {
    bb = null;
    bb_pos = 0;
    __init(i, bb) {
        this.bb_pos = i;
        this.bb = bb;
        return this;
    }
    static getRootAsPCFExpression(bb, obj) {
        return (obj || new PCFExpression()).__init(bb.readInt32(bb.position()) + bb.position(), bb);
    }
    static getSizePrefixedRootAsPCFExpression(bb, obj) {
        bb.setPosition(bb.position() + flatbuffers.SIZE_PREFIX_LENGTH);
        return (obj || new PCFExpression()).__init(bb.readInt32(bb.position()) + bb.position(), bb);
    }
    TERMS(index, obj) {
        const offset = this.bb.__offset(this.bb_pos, 4);
        return offset ? (obj || new PCFExpressionTerm()).__init(this.bb.__indirect(this.bb.__vector(this.bb_pos + offset) + index * 4), this.bb) : null;
    }
    termsLength() {
        const offset = this.bb.__offset(this.bb_pos, 4);
        return offset ? this.bb.__vector_len(this.bb_pos + offset) : 0;
    }
    static startPCFExpression(builder) {
        builder.startObject(1);
    }
    static addTerms(builder, TERMSOffset) {
        builder.addFieldOffset(0, TERMSOffset, 0);
    }
    static createTermsVector(builder, data) {
        builder.startVector(4, data.length, 4);
        for(let i = data.length - 1; i >= 0; i--){
            builder.addOffset(data[i]);
        }
        return builder.endVector();
    }
    static startTermsVector(builder, numElems) {
        builder.startVector(4, numElems, 4);
    }
    static endPCFExpression(builder) {
        const offset = builder.endObject();
        return offset;
    }
    static createPCFExpression(builder, TERMSOffset) {
        PCFExpression.startPCFExpression(builder);
        PCFExpression.addTerms(builder, TERMSOffset);
        return PCFExpression.endPCFExpression(builder);
    }
    unpack() {
        return new PCFExpressionT(this.bb.createObjList(this.TERMS.bind(this), this.termsLength()));
    }
    unpackTo(_o) {
        _o.TERMS = this.bb.createObjList(this.TERMS.bind(this), this.termsLength());
    }
}
export class PCFExpressionT {
    TERMS;
    constructor(TERMS = []){
        this.TERMS = TERMS;
    }
    pack(builder) {
        const TERMS = PCFExpression.createTermsVector(builder, builder.createObjectOffsetList(this.TERMS));
        return PCFExpression.createPCFExpression(builder, TERMS);
    }
}
