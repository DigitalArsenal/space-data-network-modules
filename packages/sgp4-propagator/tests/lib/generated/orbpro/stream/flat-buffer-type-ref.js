import * as flatbuffers from "flatbuffers";
import { PayloadWireFormat } from "./payload-wire-format.js";
class FlatBufferTypeRef {
  bb = null;
  bb_pos = 0;
  __init(i, bb) {
    this.bb_pos = i;
    this.bb = bb;
    return this;
  }
  static getRootAsFlatBufferTypeRef(bb, obj) {
    return (obj || new FlatBufferTypeRef()).__init(bb.readInt32(bb.position()) + bb.position(), bb);
  }
  static getSizePrefixedRootAsFlatBufferTypeRef(bb, obj) {
    bb.setPosition(bb.position() + flatbuffers.SIZE_PREFIX_LENGTH);
    return (obj || new FlatBufferTypeRef()).__init(bb.readInt32(bb.position()) + bb.position(), bb);
  }
  schemaName(optionalEncoding) {
    const offset = this.bb.__offset(this.bb_pos, 4);
    return offset ? this.bb.__string(this.bb_pos + offset, optionalEncoding) : null;
  }
  fileIdentifier(optionalEncoding) {
    const offset = this.bb.__offset(this.bb_pos, 6);
    return offset ? this.bb.__string(this.bb_pos + offset, optionalEncoding) : null;
  }
  /**
   * Optional schema hash bytes for stronger compatibility checks.
   */
  schemaHash(index) {
    const offset = this.bb.__offset(this.bb_pos, 8);
    return offset ? this.bb.readUint8(this.bb.__vector(this.bb_pos + offset) + index) : 0;
  }
  schemaHashLength() {
    const offset = this.bb.__offset(this.bb_pos, 8);
    return offset ? this.bb.__vector_len(this.bb_pos + offset) : 0;
  }
  schemaHashArray() {
    const offset = this.bb.__offset(this.bb_pos, 8);
    return offset ? new Uint8Array(this.bb.bytes().buffer, this.bb.bytes().byteOffset + this.bb.__vector(this.bb_pos + offset), this.bb.__vector_len(this.bb_pos + offset)) : null;
  }
  /**
   * True when this port/type set accepts any FlatBuffer frame.
   */
  acceptsAnyFlatbuffer() {
    const offset = this.bb.__offset(this.bb_pos, 10);
    return offset ? !!this.bb.readInt8(this.bb_pos + offset) : false;
  }
  /**
   * Payload wire format. Defaults to regular FlatBuffer framing.
   */
  wireFormat() {
    const offset = this.bb.__offset(this.bb_pos, 12);
    return offset ? this.bb.readUint8(this.bb_pos + offset) : PayloadWireFormat.Flatbuffer;
  }
  rootTypeName(optionalEncoding) {
    const offset = this.bb.__offset(this.bb_pos, 14);
    return offset ? this.bb.__string(this.bb_pos + offset, optionalEncoding) : null;
  }
  /**
   * Fixed string length for aligned-binary schemas when required.
   */
  fixedStringLength() {
    const offset = this.bb.__offset(this.bb_pos, 16);
    return offset ? this.bb.readUint16(this.bb_pos + offset) : 0;
  }
  /**
   * Fixed byte length for aligned-binary payloads.
   */
  byteLength() {
    const offset = this.bb.__offset(this.bb_pos, 18);
    return offset ? this.bb.readUint32(this.bb_pos + offset) : 0;
  }
  /**
   * Required byte alignment for aligned-binary payloads.
   */
  requiredAlignment() {
    const offset = this.bb.__offset(this.bb_pos, 20);
    return offset ? this.bb.readUint16(this.bb_pos + offset) : 0;
  }
  static startFlatBufferTypeRef(builder) {
    builder.startObject(9);
  }
  static addSchemaName(builder, schemaNameOffset) {
    builder.addFieldOffset(0, schemaNameOffset, 0);
  }
  static addFileIdentifier(builder, fileIdentifierOffset) {
    builder.addFieldOffset(1, fileIdentifierOffset, 0);
  }
  static addSchemaHash(builder, schemaHashOffset) {
    builder.addFieldOffset(2, schemaHashOffset, 0);
  }
  static createSchemaHashVector(builder, data) {
    builder.startVector(1, data.length, 1);
    for (let i = data.length - 1; i >= 0; i--) {
      builder.addInt8(data[i]);
    }
    return builder.endVector();
  }
  static startSchemaHashVector(builder, numElems) {
    builder.startVector(1, numElems, 1);
  }
  static addAcceptsAnyFlatbuffer(builder, acceptsAnyFlatbuffer) {
    builder.addFieldInt8(3, +acceptsAnyFlatbuffer, 0);
  }
  static addWireFormat(builder, wireFormat) {
    builder.addFieldInt8(4, wireFormat, PayloadWireFormat.Flatbuffer);
  }
  static addRootTypeName(builder, rootTypeNameOffset) {
    builder.addFieldOffset(5, rootTypeNameOffset, 0);
  }
  static addFixedStringLength(builder, fixedStringLength) {
    builder.addFieldInt16(6, fixedStringLength, 0);
  }
  static addByteLength(builder, byteLength) {
    builder.addFieldInt32(7, byteLength, 0);
  }
  static addRequiredAlignment(builder, requiredAlignment) {
    builder.addFieldInt16(8, requiredAlignment, 0);
  }
  static endFlatBufferTypeRef(builder) {
    const offset = builder.endObject();
    return offset;
  }
  static createFlatBufferTypeRef(builder, schemaNameOffset, fileIdentifierOffset, schemaHashOffset, acceptsAnyFlatbuffer, wireFormat, rootTypeNameOffset, fixedStringLength, byteLength, requiredAlignment) {
    FlatBufferTypeRef.startFlatBufferTypeRef(builder);
    FlatBufferTypeRef.addSchemaName(builder, schemaNameOffset);
    FlatBufferTypeRef.addFileIdentifier(builder, fileIdentifierOffset);
    FlatBufferTypeRef.addSchemaHash(builder, schemaHashOffset);
    FlatBufferTypeRef.addAcceptsAnyFlatbuffer(builder, acceptsAnyFlatbuffer);
    FlatBufferTypeRef.addWireFormat(builder, wireFormat);
    FlatBufferTypeRef.addRootTypeName(builder, rootTypeNameOffset);
    FlatBufferTypeRef.addFixedStringLength(builder, fixedStringLength);
    FlatBufferTypeRef.addByteLength(builder, byteLength);
    FlatBufferTypeRef.addRequiredAlignment(builder, requiredAlignment);
    return FlatBufferTypeRef.endFlatBufferTypeRef(builder);
  }
  unpack() {
    return new FlatBufferTypeRefT(
      this.schemaName(),
      this.fileIdentifier(),
      this.bb.createScalarList(this.schemaHash.bind(this), this.schemaHashLength()),
      this.acceptsAnyFlatbuffer(),
      this.wireFormat(),
      this.rootTypeName(),
      this.fixedStringLength(),
      this.byteLength(),
      this.requiredAlignment()
    );
  }
  unpackTo(_o) {
    _o.schemaName = this.schemaName();
    _o.fileIdentifier = this.fileIdentifier();
    _o.schemaHash = this.bb.createScalarList(this.schemaHash.bind(this), this.schemaHashLength());
    _o.acceptsAnyFlatbuffer = this.acceptsAnyFlatbuffer();
    _o.wireFormat = this.wireFormat();
    _o.rootTypeName = this.rootTypeName();
    _o.fixedStringLength = this.fixedStringLength();
    _o.byteLength = this.byteLength();
    _o.requiredAlignment = this.requiredAlignment();
  }
}
class FlatBufferTypeRefT {
  constructor(schemaName = null, fileIdentifier = null, schemaHash = [], acceptsAnyFlatbuffer = false, wireFormat = PayloadWireFormat.Flatbuffer, rootTypeName = null, fixedStringLength = 0, byteLength = 0, requiredAlignment = 0) {
    this.schemaName = schemaName;
    this.fileIdentifier = fileIdentifier;
    this.schemaHash = schemaHash;
    this.acceptsAnyFlatbuffer = acceptsAnyFlatbuffer;
    this.wireFormat = wireFormat;
    this.rootTypeName = rootTypeName;
    this.fixedStringLength = fixedStringLength;
    this.byteLength = byteLength;
    this.requiredAlignment = requiredAlignment;
  }
  pack(builder) {
    const schemaName = this.schemaName !== null ? builder.createString(this.schemaName) : 0;
    const fileIdentifier = this.fileIdentifier !== null ? builder.createString(this.fileIdentifier) : 0;
    const schemaHash = FlatBufferTypeRef.createSchemaHashVector(builder, this.schemaHash);
    const rootTypeName = this.rootTypeName !== null ? builder.createString(this.rootTypeName) : 0;
    return FlatBufferTypeRef.createFlatBufferTypeRef(
      builder,
      schemaName,
      fileIdentifier,
      schemaHash,
      this.acceptsAnyFlatbuffer,
      this.wireFormat,
      rootTypeName,
      this.fixedStringLength,
      this.byteLength,
      this.requiredAlignment
    );
  }
}
export {
  FlatBufferTypeRef,
  FlatBufferTypeRefT
};
