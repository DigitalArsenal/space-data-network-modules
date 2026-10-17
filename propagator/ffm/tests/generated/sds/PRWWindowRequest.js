import * as flatbuffers from 'flatbuffers';
import { PRWWindowQuery, PRWWindowQueryT } from './PRWWindowQuery.js';
export class PRWWindowRequest {
    bb = null;
    bb_pos = 0;
    __init(i, bb) {
        this.bb_pos = i;
        this.bb = bb;
        return this;
    }
    static getRootAsPRWWindowRequest(bb, obj) {
        return (obj || new PRWWindowRequest()).__init(bb.readInt32(bb.position()) + bb.position(), bb);
    }
    static getSizePrefixedRootAsPRWWindowRequest(bb, obj) {
        bb.setPosition(bb.position() + flatbuffers.SIZE_PREFIX_LENGTH);
        return (obj || new PRWWindowRequest()).__init(bb.readInt32(bb.position()) + bb.position(), bb);
    }
    QUERIES(index, obj) {
        const offset = this.bb.__offset(this.bb_pos, 4);
        return offset ? (obj || new PRWWindowQuery()).__init(this.bb.__indirect(this.bb.__vector(this.bb_pos + offset) + index * 4), this.bb) : null;
    }
    queriesLength() {
        const offset = this.bb.__offset(this.bb_pos, 4);
        return offset ? this.bb.__vector_len(this.bb_pos + offset) : 0;
    }
    PROPAGATOR_PORT_ID(optionalEncoding) {
        const offset = this.bb.__offset(this.bb_pos, 6);
        return offset ? this.bb.__string(this.bb_pos + offset, optionalEncoding) : null;
    }
    NEIGHBOUR_SETS() {
        const offset = this.bb.__offset(this.bb_pos, 8);
        return offset ? this.bb.readUint32(this.bb_pos + offset) : 0;
    }
    TARGET_FRAME(optionalEncoding) {
        const offset = this.bb.__offset(this.bb_pos, 10);
        return offset ? this.bb.__string(this.bb_pos + offset, optionalEncoding) : null;
    }
    INSTRUCTIONS(optionalEncoding) {
        const offset = this.bb.__offset(this.bb_pos, 12);
        return offset ? this.bb.__string(this.bb_pos + offset, optionalEncoding) : null;
    }
    static startPRWWindowRequest(builder) {
        builder.startObject(5);
    }
    static addQueries(builder, QUERIESOffset) {
        builder.addFieldOffset(0, QUERIESOffset, 0);
    }
    static createQueriesVector(builder, data) {
        builder.startVector(4, data.length, 4);
        for(let i = data.length - 1; i >= 0; i--){
            builder.addOffset(data[i]);
        }
        return builder.endVector();
    }
    static startQueriesVector(builder, numElems) {
        builder.startVector(4, numElems, 4);
    }
    static addPropagatorPortId(builder, PROPAGATOR_PORT_IDOffset) {
        builder.addFieldOffset(1, PROPAGATOR_PORT_IDOffset, 0);
    }
    static addNeighbourSets(builder, NEIGHBOUR_SETS) {
        builder.addFieldInt32(2, NEIGHBOUR_SETS, 0);
    }
    static addTargetFrame(builder, TARGET_FRAMEOffset) {
        builder.addFieldOffset(3, TARGET_FRAMEOffset, 0);
    }
    static addInstructions(builder, INSTRUCTIONSOffset) {
        builder.addFieldOffset(4, INSTRUCTIONSOffset, 0);
    }
    static endPRWWindowRequest(builder) {
        const offset = builder.endObject();
        return offset;
    }
    static createPRWWindowRequest(builder, QUERIESOffset, PROPAGATOR_PORT_IDOffset, NEIGHBOUR_SETS, TARGET_FRAMEOffset, INSTRUCTIONSOffset) {
        PRWWindowRequest.startPRWWindowRequest(builder);
        PRWWindowRequest.addQueries(builder, QUERIESOffset);
        PRWWindowRequest.addPropagatorPortId(builder, PROPAGATOR_PORT_IDOffset);
        PRWWindowRequest.addNeighbourSets(builder, NEIGHBOUR_SETS);
        PRWWindowRequest.addTargetFrame(builder, TARGET_FRAMEOffset);
        PRWWindowRequest.addInstructions(builder, INSTRUCTIONSOffset);
        return PRWWindowRequest.endPRWWindowRequest(builder);
    }
    unpack() {
        return new PRWWindowRequestT(this.bb.createObjList(this.QUERIES.bind(this), this.queriesLength()), this.PROPAGATOR_PORT_ID(), this.NEIGHBOUR_SETS(), this.TARGET_FRAME(), this.INSTRUCTIONS());
    }
    unpackTo(_o) {
        _o.QUERIES = this.bb.createObjList(this.QUERIES.bind(this), this.queriesLength());
        _o.PROPAGATOR_PORT_ID = this.PROPAGATOR_PORT_ID();
        _o.NEIGHBOUR_SETS = this.NEIGHBOUR_SETS();
        _o.TARGET_FRAME = this.TARGET_FRAME();
        _o.INSTRUCTIONS = this.INSTRUCTIONS();
    }
}
export class PRWWindowRequestT {
    QUERIES;
    PROPAGATOR_PORT_ID;
    NEIGHBOUR_SETS;
    TARGET_FRAME;
    INSTRUCTIONS;
    constructor(QUERIES = [], PROPAGATOR_PORT_ID = null, NEIGHBOUR_SETS = 0, TARGET_FRAME = null, INSTRUCTIONS = null){
        this.QUERIES = QUERIES;
        this.PROPAGATOR_PORT_ID = PROPAGATOR_PORT_ID;
        this.NEIGHBOUR_SETS = NEIGHBOUR_SETS;
        this.TARGET_FRAME = TARGET_FRAME;
        this.INSTRUCTIONS = INSTRUCTIONS;
    }
    pack(builder) {
        const QUERIES = PRWWindowRequest.createQueriesVector(builder, builder.createObjectOffsetList(this.QUERIES));
        const PROPAGATOR_PORT_ID = this.PROPAGATOR_PORT_ID !== null ? builder.createString(this.PROPAGATOR_PORT_ID) : 0;
        const TARGET_FRAME = this.TARGET_FRAME !== null ? builder.createString(this.TARGET_FRAME) : 0;
        const INSTRUCTIONS = this.INSTRUCTIONS !== null ? builder.createString(this.INSTRUCTIONS) : 0;
        return PRWWindowRequest.createPRWWindowRequest(builder, QUERIES, PROPAGATOR_PORT_ID, this.NEIGHBOUR_SETS, TARGET_FRAME, INSTRUCTIONS);
    }
}
