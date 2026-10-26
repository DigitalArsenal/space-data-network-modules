import * as flatbuffers from 'flatbuffers';
import { pcfBlendShape } from './pcfBlendShape.js';
import { pcfEpochSelection } from './pcfEpochSelection.js';
import { pcfTheory } from './pcfTheory.js';
export class PCFEpochStore {
    bb = null;
    bb_pos = 0;
    __init(i, bb) {
        this.bb_pos = i;
        this.bb = bb;
        return this;
    }
    static getRootAsPCFEpochStore(bb, obj) {
        return (obj || new PCFEpochStore()).__init(bb.readInt32(bb.position()) + bb.position(), bb);
    }
    static getSizePrefixedRootAsPCFEpochStore(bb, obj) {
        bb.setPosition(bb.position() + flatbuffers.SIZE_PREFIX_LENGTH);
        return (obj || new PCFEpochStore()).__init(bb.readInt32(bb.position()) + bb.position(), bb);
    }
    CACHE_DAYS() {
        const offset = this.bb.__offset(this.bb_pos, 4);
        return offset ? this.bb.readFloat64(this.bb_pos + offset) : 7.0;
    }
    MAX_SETS_PER_OBJECT() {
        const offset = this.bb.__offset(this.bb_pos, 6);
        return offset ? this.bb.readUint32(this.bb_pos + offset) : 0;
    }
    SELECTION() {
        const offset = this.bb.__offset(this.bb_pos, 8);
        return offset ? this.bb.readUint8(this.bb_pos + offset) : pcfEpochSelection.NEAREST;
    }
    BLEND_WINDOW_SECONDS() {
        const offset = this.bb.__offset(this.bb_pos, 10);
        return offset ? this.bb.readFloat64(this.bb_pos + offset) : 3600.0;
    }
    BLEND_SHAPE() {
        const offset = this.bb.__offset(this.bb_pos, 12);
        return offset ? this.bb.readUint8(this.bb_pos + offset) : pcfBlendShape.SMOOTHSTEP;
    }
    THEORIES(index) {
        const offset = this.bb.__offset(this.bb_pos, 14);
        return offset ? this.bb.readUint8(this.bb.__vector(this.bb_pos + offset) + index) : null;
    }
    theoriesLength() {
        const offset = this.bb.__offset(this.bb_pos, 14);
        return offset ? this.bb.__vector_len(this.bb_pos + offset) : 0;
    }
    theoriesArray() {
        const offset = this.bb.__offset(this.bb_pos, 14);
        return offset ? new Uint8Array(this.bb.bytes().buffer, this.bb.bytes().byteOffset + this.bb.__vector(this.bb_pos + offset), this.bb.__vector_len(this.bb_pos + offset)) : null;
    }
    static startPCFEpochStore(builder) {
        builder.startObject(6);
    }
    static addCacheDays(builder, CACHE_DAYS) {
        builder.addFieldFloat64(0, CACHE_DAYS, 7.0);
    }
    static addMaxSetsPerObject(builder, MAX_SETS_PER_OBJECT) {
        builder.addFieldInt32(1, MAX_SETS_PER_OBJECT, 0);
    }
    static addSelection(builder, SELECTION) {
        builder.addFieldInt8(2, SELECTION, pcfEpochSelection.NEAREST);
    }
    static addBlendWindowSeconds(builder, BLEND_WINDOW_SECONDS) {
        builder.addFieldFloat64(3, BLEND_WINDOW_SECONDS, 3600.0);
    }
    static addBlendShape(builder, BLEND_SHAPE) {
        builder.addFieldInt8(4, BLEND_SHAPE, pcfBlendShape.SMOOTHSTEP);
    }
    static addTheories(builder, THEORIESOffset) {
        builder.addFieldOffset(5, THEORIESOffset, 0);
    }
    static createTheoriesVector(builder, data) {
        builder.startVector(1, data.length, 1);
        for(let i = data.length - 1; i >= 0; i--){
            builder.addInt8(data[i]);
        }
        return builder.endVector();
    }
    static startTheoriesVector(builder, numElems) {
        builder.startVector(1, numElems, 1);
    }
    static endPCFEpochStore(builder) {
        const offset = builder.endObject();
        return offset;
    }
    static createPCFEpochStore(builder, CACHE_DAYS, MAX_SETS_PER_OBJECT, SELECTION, BLEND_WINDOW_SECONDS, BLEND_SHAPE, THEORIESOffset) {
        PCFEpochStore.startPCFEpochStore(builder);
        PCFEpochStore.addCacheDays(builder, CACHE_DAYS);
        PCFEpochStore.addMaxSetsPerObject(builder, MAX_SETS_PER_OBJECT);
        PCFEpochStore.addSelection(builder, SELECTION);
        PCFEpochStore.addBlendWindowSeconds(builder, BLEND_WINDOW_SECONDS);
        PCFEpochStore.addBlendShape(builder, BLEND_SHAPE);
        PCFEpochStore.addTheories(builder, THEORIESOffset);
        return PCFEpochStore.endPCFEpochStore(builder);
    }
    unpack() {
        return new PCFEpochStoreT(this.CACHE_DAYS(), this.MAX_SETS_PER_OBJECT(), this.SELECTION(), this.BLEND_WINDOW_SECONDS(), this.BLEND_SHAPE(), this.bb.createScalarList(this.THEORIES.bind(this), this.theoriesLength()));
    }
    unpackTo(_o) {
        _o.CACHE_DAYS = this.CACHE_DAYS();
        _o.MAX_SETS_PER_OBJECT = this.MAX_SETS_PER_OBJECT();
        _o.SELECTION = this.SELECTION();
        _o.BLEND_WINDOW_SECONDS = this.BLEND_WINDOW_SECONDS();
        _o.BLEND_SHAPE = this.BLEND_SHAPE();
        _o.THEORIES = this.bb.createScalarList(this.THEORIES.bind(this), this.theoriesLength());
    }
}
export class PCFEpochStoreT {
    CACHE_DAYS;
    MAX_SETS_PER_OBJECT;
    SELECTION;
    BLEND_WINDOW_SECONDS;
    BLEND_SHAPE;
    THEORIES;
    constructor(CACHE_DAYS = 7.0, MAX_SETS_PER_OBJECT = 0, SELECTION = pcfEpochSelection.NEAREST, BLEND_WINDOW_SECONDS = 3600.0, BLEND_SHAPE = pcfBlendShape.SMOOTHSTEP, THEORIES = []){
        this.CACHE_DAYS = CACHE_DAYS;
        this.MAX_SETS_PER_OBJECT = MAX_SETS_PER_OBJECT;
        this.SELECTION = SELECTION;
        this.BLEND_WINDOW_SECONDS = BLEND_WINDOW_SECONDS;
        this.BLEND_SHAPE = BLEND_SHAPE;
        this.THEORIES = THEORIES;
    }
    pack(builder) {
        const THEORIES = PCFEpochStore.createTheoriesVector(builder, this.THEORIES);
        return PCFEpochStore.createPCFEpochStore(builder, this.CACHE_DAYS, this.MAX_SETS_PER_OBJECT, this.SELECTION, this.BLEND_WINDOW_SECONDS, this.BLEND_SHAPE, THEORIES);
    }
}
