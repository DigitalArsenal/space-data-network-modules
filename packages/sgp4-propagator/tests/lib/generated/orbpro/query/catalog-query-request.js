import * as flatbuffers from "flatbuffers";
import { CatalogQueryKind } from "./catalog-query-kind.js";
class CatalogQueryRequest {
  bb = null;
  bb_pos = 0;
  __init(i, bb) {
    this.bb_pos = i;
    this.bb = bb;
    return this;
  }
  static getRootAsCatalogQueryRequest(bb, obj) {
    return (obj || new CatalogQueryRequest()).__init(bb.readInt32(bb.position()) + bb.position(), bb);
  }
  static getSizePrefixedRootAsCatalogQueryRequest(bb, obj) {
    bb.setPosition(bb.position() + flatbuffers.SIZE_PREFIX_LENGTH);
    return (obj || new CatalogQueryRequest()).__init(bb.readInt32(bb.position()) + bb.position(), bb);
  }
  static bufferHasIdentifier(bb) {
    return bb.__has_identifier("CQRQ");
  }
  queryKind() {
    const offset = this.bb.__offset(this.bb_pos, 4);
    return offset ? this.bb.readUint8(this.bb_pos + offset) : CatalogQueryKind.ROWS;
  }
  query(optionalEncoding) {
    const offset = this.bb.__offset(this.bb_pos, 6);
    return offset ? this.bb.__string(this.bb_pos + offset, optionalEncoding) : null;
  }
  entityIndex() {
    const offset = this.bb.__offset(this.bb_pos, 8);
    return offset ? this.bb.readUint32(this.bb_pos + offset) : 0;
  }
  maxCount() {
    const offset = this.bb.__offset(this.bb_pos, 10);
    return offset ? this.bb.readUint32(this.bb_pos + offset) : 0;
  }
  entityCount() {
    const offset = this.bb.__offset(this.bb_pos, 12);
    return offset ? this.bb.readUint32(this.bb_pos + offset) : 0;
  }
  static startCatalogQueryRequest(builder) {
    builder.startObject(5);
  }
  static addQueryKind(builder, queryKind) {
    builder.addFieldInt8(0, queryKind, CatalogQueryKind.ROWS);
  }
  static addQuery(builder, queryOffset) {
    builder.addFieldOffset(1, queryOffset, 0);
  }
  static addEntityIndex(builder, entityIndex) {
    builder.addFieldInt32(2, entityIndex, 0);
  }
  static addMaxCount(builder, maxCount) {
    builder.addFieldInt32(3, maxCount, 0);
  }
  static addEntityCount(builder, entityCount) {
    builder.addFieldInt32(4, entityCount, 0);
  }
  static endCatalogQueryRequest(builder) {
    const offset = builder.endObject();
    return offset;
  }
  static finishCatalogQueryRequestBuffer(builder, offset) {
    builder.finish(offset, "CQRQ");
  }
  static finishSizePrefixedCatalogQueryRequestBuffer(builder, offset) {
    builder.finish(offset, "CQRQ", true);
  }
  static createCatalogQueryRequest(builder, queryKind, queryOffset, entityIndex, maxCount, entityCount) {
    CatalogQueryRequest.startCatalogQueryRequest(builder);
    CatalogQueryRequest.addQueryKind(builder, queryKind);
    CatalogQueryRequest.addQuery(builder, queryOffset);
    CatalogQueryRequest.addEntityIndex(builder, entityIndex);
    CatalogQueryRequest.addMaxCount(builder, maxCount);
    CatalogQueryRequest.addEntityCount(builder, entityCount);
    return CatalogQueryRequest.endCatalogQueryRequest(builder);
  }
  unpack() {
    return new CatalogQueryRequestT(
      this.queryKind(),
      this.query(),
      this.entityIndex(),
      this.maxCount(),
      this.entityCount()
    );
  }
  unpackTo(_o) {
    _o.queryKind = this.queryKind();
    _o.query = this.query();
    _o.entityIndex = this.entityIndex();
    _o.maxCount = this.maxCount();
    _o.entityCount = this.entityCount();
  }
}
class CatalogQueryRequestT {
  constructor(queryKind = CatalogQueryKind.ROWS, query = null, entityIndex = 0, maxCount = 0, entityCount = 0) {
    this.queryKind = queryKind;
    this.query = query;
    this.entityIndex = entityIndex;
    this.maxCount = maxCount;
    this.entityCount = entityCount;
  }
  pack(builder) {
    const query = this.query !== null ? builder.createString(this.query) : 0;
    return CatalogQueryRequest.createCatalogQueryRequest(
      builder,
      this.queryKind,
      query,
      this.entityIndex,
      this.maxCount,
      this.entityCount
    );
  }
}
export {
  CatalogQueryRequest,
  CatalogQueryRequestT
};
