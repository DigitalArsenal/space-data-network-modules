import * as flatbuffers from 'flatbuffers';
export class FrequencyRange {
    bb = null;
    bb_pos = 0;
    __init(i, bb) {
        this.bb_pos = i;
        this.bb = bb;
        return this;
    }
    static getRootAsFrequencyRange(bb, obj) {
        return (obj || new FrequencyRange()).__init(bb.readInt32(bb.position()) + bb.position(), bb);
    }
    static getSizePrefixedRootAsFrequencyRange(bb, obj) {
        bb.setPosition(bb.position() + flatbuffers.SIZE_PREFIX_LENGTH);
        return (obj || new FrequencyRange()).__init(bb.readInt32(bb.position()) + bb.position(), bb);
    }
    LOWER() {
        const offset = this.bb.__offset(this.bb_pos, 4);
        return offset ? this.bb.readFloat64(this.bb_pos + offset) : 0.0;
    }
    UPPER() {
        const offset = this.bb.__offset(this.bb_pos, 6);
        return offset ? this.bb.readFloat64(this.bb_pos + offset) : 0.0;
    }
    static startFrequencyRange(builder) {
        builder.startObject(2);
    }
    static addLower(builder, LOWER) {
        builder.addFieldFloat64(0, LOWER, 0.0);
    }
    static addUpper(builder, UPPER) {
        builder.addFieldFloat64(1, UPPER, 0.0);
    }
    static endFrequencyRange(builder) {
        const offset = builder.endObject();
        return offset;
    }
    static createFrequencyRange(builder, LOWER, UPPER) {
        FrequencyRange.startFrequencyRange(builder);
        FrequencyRange.addLower(builder, LOWER);
        FrequencyRange.addUpper(builder, UPPER);
        return FrequencyRange.endFrequencyRange(builder);
    }
    unpack() {
        return new FrequencyRangeT(this.LOWER(), this.UPPER());
    }
    unpackTo(_o) {
        _o.LOWER = this.LOWER();
        _o.UPPER = this.UPPER();
    }
}
export class FrequencyRangeT {
    LOWER;
    UPPER;
    constructor(LOWER = 0.0, UPPER = 0.0){
        this.LOWER = LOWER;
        this.UPPER = UPPER;
    }
    pack(builder) {
        return FrequencyRange.createFrequencyRange(builder, this.LOWER, this.UPPER);
    }
}
