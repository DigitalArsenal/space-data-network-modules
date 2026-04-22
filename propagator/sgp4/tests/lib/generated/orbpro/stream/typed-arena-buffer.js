import * as flatbuffers from "flatbuffers";
import { BufferMutability } from "./buffer-mutability.js";
import { BufferOwnership } from "./buffer-ownership.js";
import { FlatBufferTypeRef } from "./flat-buffer-type-ref.js";
class TypedArenaBuffer {
  bb = null;
  bb_pos = 0;
  __init(i, bb) {
    this.bb_pos = i;
    this.bb = bb;
    return this;
  }
  static getRootAsTypedArenaBuffer(bb, obj) {
    return (obj || new TypedArenaBuffer()).__init(bb.readInt32(bb.position()) + bb.position(), bb);
  }
  static getSizePrefixedRootAsTypedArenaBuffer(bb, obj) {
    bb.setPosition(bb.position() + flatbuffers.SIZE_PREFIX_LENGTH);
    return (obj || new TypedArenaBuffer()).__init(bb.readInt32(bb.position()) + bb.position(), bb);
  }
  /**
   * Runtime schema identity for this frame.
   */
  typeRef(obj) {
    const offset = this.bb.__offset(this.bb_pos, 4);
    return offset ? (obj || new FlatBufferTypeRef()).__init(this.bb.__indirect(this.bb_pos + offset), this.bb) : null;
  }
  portId(optionalEncoding) {
    const offset = this.bb.__offset(this.bb_pos, 6);
    return offset ? this.bb.__string(this.bb_pos + offset, optionalEncoding) : null;
  }
  /**
   * Required alignment of the underlying frame bytes.
   */
  alignment() {
    const offset = this.bb.__offset(this.bb_pos, 8);
    return offset ? this.bb.readUint16(this.bb_pos + offset) : 8;
  }
  /**
   * Frame byte offset from the arena base.
   */
  offset() {
    const offset = this.bb.__offset(this.bb_pos, 10);
    return offset ? this.bb.readUint32(this.bb_pos + offset) : 0;
  }
  /**
   * Frame size in bytes.
   */
  size() {
    const offset = this.bb.__offset(this.bb_pos, 12);
    return offset ? this.bb.readUint32(this.bb_pos + offset) : 0;
  }
  /**
   * Ownership contract for the buffer.
   */
  ownership() {
    const offset = this.bb.__offset(this.bb_pos, 14);
    return offset ? this.bb.readUint8(this.bb_pos + offset) : BufferOwnership.BORROWED;
  }
  /**
   * Generation counter for stale-reference detection.
   */
  generation() {
    const offset = this.bb.__offset(this.bb_pos, 16);
    return offset ? this.bb.readUint32(this.bb_pos + offset) : 0;
  }
  /**
   * Mutability contract for downstream consumers.
   */
  mutability() {
    const offset = this.bb.__offset(this.bb_pos, 18);
    return offset ? this.bb.readUint8(this.bb_pos + offset) : BufferMutability.IMMUTABLE;
  }
  /**
   * Flow/runtime trace identifier.
   */
  traceId() {
    const offset = this.bb.__offset(this.bb_pos, 20);
    return offset ? this.bb.readUint64(this.bb_pos + offset) : BigInt("0");
  }
  /**
   * Logical stream identifier.
   */
  streamId() {
    const offset = this.bb.__offset(this.bb_pos, 22);
    return offset ? this.bb.readUint32(this.bb_pos + offset) : 0;
  }
  /**
   * Monotonic frame sequence number within a stream.
   */
  sequence() {
    const offset = this.bb.__offset(this.bb_pos, 24);
    return offset ? this.bb.readUint64(this.bb_pos + offset) : BigInt("0");
  }
  /**
   * True if this frame closes the stream.
   */
  endOfStream() {
    const offset = this.bb.__offset(this.bb_pos, 26);
    return offset ? !!this.bb.readInt8(this.bb_pos + offset) : false;
  }
  static startTypedArenaBuffer(builder) {
    builder.startObject(12);
  }
  static addTypeRef(builder, typeRefOffset) {
    builder.addFieldOffset(0, typeRefOffset, 0);
  }
  static addPortId(builder, portIdOffset) {
    builder.addFieldOffset(1, portIdOffset, 0);
  }
  static addAlignment(builder, alignment) {
    builder.addFieldInt16(2, alignment, 8);
  }
  static addOffset(builder, offset) {
    builder.addFieldInt32(3, offset, 0);
  }
  static addSize(builder, size) {
    builder.addFieldInt32(4, size, 0);
  }
  static addOwnership(builder, ownership) {
    builder.addFieldInt8(5, ownership, BufferOwnership.BORROWED);
  }
  static addGeneration(builder, generation) {
    builder.addFieldInt32(6, generation, 0);
  }
  static addMutability(builder, mutability) {
    builder.addFieldInt8(7, mutability, BufferMutability.IMMUTABLE);
  }
  static addTraceId(builder, traceId) {
    builder.addFieldInt64(8, traceId, BigInt("0"));
  }
  static addStreamId(builder, streamId) {
    builder.addFieldInt32(9, streamId, 0);
  }
  static addSequence(builder, sequence) {
    builder.addFieldInt64(10, sequence, BigInt("0"));
  }
  static addEndOfStream(builder, endOfStream) {
    builder.addFieldInt8(11, +endOfStream, 0);
  }
  static endTypedArenaBuffer(builder) {
    const offset = builder.endObject();
    return offset;
  }
  static createTypedArenaBuffer(builder, typeRefOffset, portIdOffset, alignment, offset, size, ownership, generation, mutability, traceId, streamId, sequence, endOfStream) {
    TypedArenaBuffer.startTypedArenaBuffer(builder);
    TypedArenaBuffer.addTypeRef(builder, typeRefOffset);
    TypedArenaBuffer.addPortId(builder, portIdOffset);
    TypedArenaBuffer.addAlignment(builder, alignment);
    TypedArenaBuffer.addOffset(builder, offset);
    TypedArenaBuffer.addSize(builder, size);
    TypedArenaBuffer.addOwnership(builder, ownership);
    TypedArenaBuffer.addGeneration(builder, generation);
    TypedArenaBuffer.addMutability(builder, mutability);
    TypedArenaBuffer.addTraceId(builder, traceId);
    TypedArenaBuffer.addStreamId(builder, streamId);
    TypedArenaBuffer.addSequence(builder, sequence);
    TypedArenaBuffer.addEndOfStream(builder, endOfStream);
    return TypedArenaBuffer.endTypedArenaBuffer(builder);
  }
  unpack() {
    return new TypedArenaBufferT(
      this.typeRef() !== null ? this.typeRef().unpack() : null,
      this.portId(),
      this.alignment(),
      this.offset(),
      this.size(),
      this.ownership(),
      this.generation(),
      this.mutability(),
      this.traceId(),
      this.streamId(),
      this.sequence(),
      this.endOfStream()
    );
  }
  unpackTo(_o) {
    _o.typeRef = this.typeRef() !== null ? this.typeRef().unpack() : null;
    _o.portId = this.portId();
    _o.alignment = this.alignment();
    _o.offset = this.offset();
    _o.size = this.size();
    _o.ownership = this.ownership();
    _o.generation = this.generation();
    _o.mutability = this.mutability();
    _o.traceId = this.traceId();
    _o.streamId = this.streamId();
    _o.sequence = this.sequence();
    _o.endOfStream = this.endOfStream();
  }
}
class TypedArenaBufferT {
  constructor(typeRef = null, portId = null, alignment = 8, offset = 0, size = 0, ownership = BufferOwnership.BORROWED, generation = 0, mutability = BufferMutability.IMMUTABLE, traceId = BigInt("0"), streamId = 0, sequence = BigInt("0"), endOfStream = false) {
    this.typeRef = typeRef;
    this.portId = portId;
    this.alignment = alignment;
    this.offset = offset;
    this.size = size;
    this.ownership = ownership;
    this.generation = generation;
    this.mutability = mutability;
    this.traceId = traceId;
    this.streamId = streamId;
    this.sequence = sequence;
    this.endOfStream = endOfStream;
  }
  pack(builder) {
    const typeRef = this.typeRef !== null ? this.typeRef.pack(builder) : 0;
    const portId = this.portId !== null ? builder.createString(this.portId) : 0;
    return TypedArenaBuffer.createTypedArenaBuffer(
      builder,
      typeRef,
      portId,
      this.alignment,
      this.offset,
      this.size,
      this.ownership,
      this.generation,
      this.mutability,
      this.traceId,
      this.streamId,
      this.sequence,
      this.endOfStream
    );
  }
}
export {
  TypedArenaBuffer,
  TypedArenaBufferT
};
