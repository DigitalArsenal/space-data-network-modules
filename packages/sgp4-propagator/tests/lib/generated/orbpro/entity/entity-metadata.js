import * as flatbuffers from "flatbuffers";
import { EntityKind } from "./entity-kind.js";
class EntityMetadata {
  bb = null;
  bb_pos = 0;
  __init(i, bb) {
    this.bb_pos = i;
    this.bb = bb;
    return this;
  }
  static getRootAsEntityMetadata(bb, obj) {
    return (obj || new EntityMetadata()).__init(bb.readInt32(bb.position()) + bb.position(), bb);
  }
  static getSizePrefixedRootAsEntityMetadata(bb, obj) {
    bb.setPosition(bb.position() + flatbuffers.SIZE_PREFIX_LENGTH);
    return (obj || new EntityMetadata()).__init(bb.readInt32(bb.position()) + bb.position(), bb);
  }
  entityId(optionalEncoding) {
    const offset = this.bb.__offset(this.bb_pos, 4);
    return this.bb.__string(this.bb_pos + offset, optionalEncoding);
  }
  name(optionalEncoding) {
    const offset = this.bb.__offset(this.bb_pos, 6);
    return offset ? this.bb.__string(this.bb_pos + offset, optionalEncoding) : null;
  }
  /**
   * Broad entity category.
   */
  entityKind() {
    const offset = this.bb.__offset(this.bb_pos, 8);
    return offset ? this.bb.readUint8(this.bb_pos + offset) : EntityKind.ENTITY;
  }
  subtype(optionalEncoding) {
    const offset = this.bb.__offset(this.bb_pos, 10);
    return offset ? this.bb.__string(this.bb_pos + offset, optionalEncoding) : null;
  }
  parentEntityId(optionalEncoding) {
    const offset = this.bb.__offset(this.bb_pos, 12);
    return offset ? this.bb.__string(this.bb_pos + offset, optionalEncoding) : null;
  }
  /**
   * Collection-scoped WASM handle used for batch visibility application.
   */
  wasmHandle() {
    const offset = this.bb.__offset(this.bb_pos, 14);
    return offset ? this.bb.readUint32(this.bb_pos + offset) : 0;
  }
  /**
   * Optional NORAD catalog id for standards-backed entities.
   */
  noradCatId() {
    const offset = this.bb.__offset(this.bb_pos, 16);
    return offset ? this.bb.readUint32(this.bb_pos + offset) : 0;
  }
  objectName(optionalEncoding) {
    const offset = this.bb.__offset(this.bb_pos, 18);
    return offset ? this.bb.__string(this.bb_pos + offset, optionalEncoding) : null;
  }
  objectId(optionalEncoding) {
    const offset = this.bb.__offset(this.bb_pos, 20);
    return offset ? this.bb.__string(this.bb_pos + offset, optionalEncoding) : null;
  }
  catObjectName(optionalEncoding) {
    const offset = this.bb.__offset(this.bb_pos, 22);
    return offset ? this.bb.__string(this.bb_pos + offset, optionalEncoding) : null;
  }
  catObjectId(optionalEncoding) {
    const offset = this.bb.__offset(this.bb_pos, 24);
    return offset ? this.bb.__string(this.bb_pos + offset, optionalEncoding) : null;
  }
  facilityType(optionalEncoding) {
    const offset = this.bb.__offset(this.bb_pos, 26);
    return offset ? this.bb.__string(this.bb_pos + offset, optionalEncoding) : null;
  }
  searchText(optionalEncoding) {
    const offset = this.bb.__offset(this.bb_pos, 28);
    return offset ? this.bb.__string(this.bb_pos + offset, optionalEncoding) : null;
  }
  owner(optionalEncoding) {
    const offset = this.bb.__offset(this.bb_pos, 30);
    return offset ? this.bb.__string(this.bb_pos + offset, optionalEncoding) : null;
  }
  statusCode(optionalEncoding) {
    const offset = this.bb.__offset(this.bb_pos, 32);
    return offset ? this.bb.__string(this.bb_pos + offset, optionalEncoding) : null;
  }
  launchDate(optionalEncoding) {
    const offset = this.bb.__offset(this.bb_pos, 34);
    return offset ? this.bb.__string(this.bb_pos + offset, optionalEncoding) : null;
  }
  launchYear(optionalEncoding) {
    const offset = this.bb.__offset(this.bb_pos, 36);
    return offset ? this.bb.__string(this.bb_pos + offset, optionalEncoding) : null;
  }
  orbitRegime(optionalEncoding) {
    const offset = this.bb.__offset(this.bb_pos, 38);
    return offset ? this.bb.__string(this.bb_pos + offset, optionalEncoding) : null;
  }
  /**
   * Orbital period in minutes.
   */
  period() {
    const offset = this.bb.__offset(this.bb_pos, 40);
    return offset ? this.bb.readFloat64(this.bb_pos + offset) : 0;
  }
  /**
   * Inclination in degrees.
   */
  inclination() {
    const offset = this.bb.__offset(this.bb_pos, 42);
    return offset ? this.bb.readFloat64(this.bb_pos + offset) : 0;
  }
  /**
   * Apogee altitude in kilometers.
   */
  apogee() {
    const offset = this.bb.__offset(this.bb_pos, 44);
    return offset ? this.bb.readFloat64(this.bb_pos + offset) : 0;
  }
  /**
   * Perigee altitude in kilometers.
   */
  perigee() {
    const offset = this.bb.__offset(this.bb_pos, 46);
    return offset ? this.bb.readFloat64(this.bb_pos + offset) : 0;
  }
  /**
   * Mean motion in revolutions per day.
   */
  meanMotion() {
    const offset = this.bb.__offset(this.bb_pos, 48);
    return offset ? this.bb.readFloat64(this.bb_pos + offset) : 0;
  }
  /**
   * Orbital eccentricity.
   */
  eccentricity() {
    const offset = this.bb.__offset(this.bb_pos, 50);
    return offset ? this.bb.readFloat64(this.bb_pos + offset) : 0;
  }
  /**
   * B* drag term from OMM.
   */
  bstar() {
    const offset = this.bb.__offset(this.bb_pos, 52);
    return offset ? this.bb.readFloat64(this.bb_pos + offset) : 0;
  }
  /**
   * Whether GP/OMM state is present for the entity.
   */
  hasGp() {
    const offset = this.bb.__offset(this.bb_pos, 54);
    return offset ? !!this.bb.readInt8(this.bb_pos + offset) : false;
  }
  static startEntityMetadata(builder) {
    builder.startObject(26);
  }
  static addEntityId(builder, entityIdOffset) {
    builder.addFieldOffset(0, entityIdOffset, 0);
  }
  static addName(builder, nameOffset) {
    builder.addFieldOffset(1, nameOffset, 0);
  }
  static addEntityKind(builder, entityKind) {
    builder.addFieldInt8(2, entityKind, EntityKind.ENTITY);
  }
  static addSubtype(builder, subtypeOffset) {
    builder.addFieldOffset(3, subtypeOffset, 0);
  }
  static addParentEntityId(builder, parentEntityIdOffset) {
    builder.addFieldOffset(4, parentEntityIdOffset, 0);
  }
  static addWasmHandle(builder, wasmHandle) {
    builder.addFieldInt32(5, wasmHandle, 0);
  }
  static addNoradCatId(builder, noradCatId) {
    builder.addFieldInt32(6, noradCatId, 0);
  }
  static addObjectName(builder, objectNameOffset) {
    builder.addFieldOffset(7, objectNameOffset, 0);
  }
  static addObjectId(builder, objectIdOffset) {
    builder.addFieldOffset(8, objectIdOffset, 0);
  }
  static addCatObjectName(builder, catObjectNameOffset) {
    builder.addFieldOffset(9, catObjectNameOffset, 0);
  }
  static addCatObjectId(builder, catObjectIdOffset) {
    builder.addFieldOffset(10, catObjectIdOffset, 0);
  }
  static addFacilityType(builder, facilityTypeOffset) {
    builder.addFieldOffset(11, facilityTypeOffset, 0);
  }
  static addSearchText(builder, searchTextOffset) {
    builder.addFieldOffset(12, searchTextOffset, 0);
  }
  static addOwner(builder, ownerOffset) {
    builder.addFieldOffset(13, ownerOffset, 0);
  }
  static addStatusCode(builder, statusCodeOffset) {
    builder.addFieldOffset(14, statusCodeOffset, 0);
  }
  static addLaunchDate(builder, launchDateOffset) {
    builder.addFieldOffset(15, launchDateOffset, 0);
  }
  static addLaunchYear(builder, launchYearOffset) {
    builder.addFieldOffset(16, launchYearOffset, 0);
  }
  static addOrbitRegime(builder, orbitRegimeOffset) {
    builder.addFieldOffset(17, orbitRegimeOffset, 0);
  }
  static addPeriod(builder, period) {
    builder.addFieldFloat64(18, period, 0);
  }
  static addInclination(builder, inclination) {
    builder.addFieldFloat64(19, inclination, 0);
  }
  static addApogee(builder, apogee) {
    builder.addFieldFloat64(20, apogee, 0);
  }
  static addPerigee(builder, perigee) {
    builder.addFieldFloat64(21, perigee, 0);
  }
  static addMeanMotion(builder, meanMotion) {
    builder.addFieldFloat64(22, meanMotion, 0);
  }
  static addEccentricity(builder, eccentricity) {
    builder.addFieldFloat64(23, eccentricity, 0);
  }
  static addBstar(builder, bstar) {
    builder.addFieldFloat64(24, bstar, 0);
  }
  static addHasGp(builder, hasGp) {
    builder.addFieldInt8(25, +hasGp, 0);
  }
  static endEntityMetadata(builder) {
    const offset = builder.endObject();
    builder.requiredField(offset, 4);
    return offset;
  }
  static createEntityMetadata(builder, entityIdOffset, nameOffset, entityKind, subtypeOffset, parentEntityIdOffset, wasmHandle, noradCatId, objectNameOffset, objectIdOffset, catObjectNameOffset, catObjectIdOffset, facilityTypeOffset, searchTextOffset, ownerOffset, statusCodeOffset, launchDateOffset, launchYearOffset, orbitRegimeOffset, period, inclination, apogee, perigee, meanMotion, eccentricity, bstar, hasGp) {
    EntityMetadata.startEntityMetadata(builder);
    EntityMetadata.addEntityId(builder, entityIdOffset);
    EntityMetadata.addName(builder, nameOffset);
    EntityMetadata.addEntityKind(builder, entityKind);
    EntityMetadata.addSubtype(builder, subtypeOffset);
    EntityMetadata.addParentEntityId(builder, parentEntityIdOffset);
    EntityMetadata.addWasmHandle(builder, wasmHandle);
    EntityMetadata.addNoradCatId(builder, noradCatId);
    EntityMetadata.addObjectName(builder, objectNameOffset);
    EntityMetadata.addObjectId(builder, objectIdOffset);
    EntityMetadata.addCatObjectName(builder, catObjectNameOffset);
    EntityMetadata.addCatObjectId(builder, catObjectIdOffset);
    EntityMetadata.addFacilityType(builder, facilityTypeOffset);
    EntityMetadata.addSearchText(builder, searchTextOffset);
    EntityMetadata.addOwner(builder, ownerOffset);
    EntityMetadata.addStatusCode(builder, statusCodeOffset);
    EntityMetadata.addLaunchDate(builder, launchDateOffset);
    EntityMetadata.addLaunchYear(builder, launchYearOffset);
    EntityMetadata.addOrbitRegime(builder, orbitRegimeOffset);
    EntityMetadata.addPeriod(builder, period);
    EntityMetadata.addInclination(builder, inclination);
    EntityMetadata.addApogee(builder, apogee);
    EntityMetadata.addPerigee(builder, perigee);
    EntityMetadata.addMeanMotion(builder, meanMotion);
    EntityMetadata.addEccentricity(builder, eccentricity);
    EntityMetadata.addBstar(builder, bstar);
    EntityMetadata.addHasGp(builder, hasGp);
    return EntityMetadata.endEntityMetadata(builder);
  }
  unpack() {
    return new EntityMetadataT(
      this.entityId(),
      this.name(),
      this.entityKind(),
      this.subtype(),
      this.parentEntityId(),
      this.wasmHandle(),
      this.noradCatId(),
      this.objectName(),
      this.objectId(),
      this.catObjectName(),
      this.catObjectId(),
      this.facilityType(),
      this.searchText(),
      this.owner(),
      this.statusCode(),
      this.launchDate(),
      this.launchYear(),
      this.orbitRegime(),
      this.period(),
      this.inclination(),
      this.apogee(),
      this.perigee(),
      this.meanMotion(),
      this.eccentricity(),
      this.bstar(),
      this.hasGp()
    );
  }
  unpackTo(_o) {
    _o.entityId = this.entityId();
    _o.name = this.name();
    _o.entityKind = this.entityKind();
    _o.subtype = this.subtype();
    _o.parentEntityId = this.parentEntityId();
    _o.wasmHandle = this.wasmHandle();
    _o.noradCatId = this.noradCatId();
    _o.objectName = this.objectName();
    _o.objectId = this.objectId();
    _o.catObjectName = this.catObjectName();
    _o.catObjectId = this.catObjectId();
    _o.facilityType = this.facilityType();
    _o.searchText = this.searchText();
    _o.owner = this.owner();
    _o.statusCode = this.statusCode();
    _o.launchDate = this.launchDate();
    _o.launchYear = this.launchYear();
    _o.orbitRegime = this.orbitRegime();
    _o.period = this.period();
    _o.inclination = this.inclination();
    _o.apogee = this.apogee();
    _o.perigee = this.perigee();
    _o.meanMotion = this.meanMotion();
    _o.eccentricity = this.eccentricity();
    _o.bstar = this.bstar();
    _o.hasGp = this.hasGp();
  }
}
class EntityMetadataT {
  constructor(entityId = null, name = null, entityKind = EntityKind.ENTITY, subtype = null, parentEntityId = null, wasmHandle = 0, noradCatId = 0, objectName = null, objectId = null, catObjectName = null, catObjectId = null, facilityType = null, searchText = null, owner = null, statusCode = null, launchDate = null, launchYear = null, orbitRegime = null, period = 0, inclination = 0, apogee = 0, perigee = 0, meanMotion = 0, eccentricity = 0, bstar = 0, hasGp = false) {
    this.entityId = entityId;
    this.name = name;
    this.entityKind = entityKind;
    this.subtype = subtype;
    this.parentEntityId = parentEntityId;
    this.wasmHandle = wasmHandle;
    this.noradCatId = noradCatId;
    this.objectName = objectName;
    this.objectId = objectId;
    this.catObjectName = catObjectName;
    this.catObjectId = catObjectId;
    this.facilityType = facilityType;
    this.searchText = searchText;
    this.owner = owner;
    this.statusCode = statusCode;
    this.launchDate = launchDate;
    this.launchYear = launchYear;
    this.orbitRegime = orbitRegime;
    this.period = period;
    this.inclination = inclination;
    this.apogee = apogee;
    this.perigee = perigee;
    this.meanMotion = meanMotion;
    this.eccentricity = eccentricity;
    this.bstar = bstar;
    this.hasGp = hasGp;
  }
  pack(builder) {
    const entityId = this.entityId !== null ? builder.createString(this.entityId) : 0;
    const name = this.name !== null ? builder.createString(this.name) : 0;
    const subtype = this.subtype !== null ? builder.createString(this.subtype) : 0;
    const parentEntityId = this.parentEntityId !== null ? builder.createString(this.parentEntityId) : 0;
    const objectName = this.objectName !== null ? builder.createString(this.objectName) : 0;
    const objectId = this.objectId !== null ? builder.createString(this.objectId) : 0;
    const catObjectName = this.catObjectName !== null ? builder.createString(this.catObjectName) : 0;
    const catObjectId = this.catObjectId !== null ? builder.createString(this.catObjectId) : 0;
    const facilityType = this.facilityType !== null ? builder.createString(this.facilityType) : 0;
    const searchText = this.searchText !== null ? builder.createString(this.searchText) : 0;
    const owner = this.owner !== null ? builder.createString(this.owner) : 0;
    const statusCode = this.statusCode !== null ? builder.createString(this.statusCode) : 0;
    const launchDate = this.launchDate !== null ? builder.createString(this.launchDate) : 0;
    const launchYear = this.launchYear !== null ? builder.createString(this.launchYear) : 0;
    const orbitRegime = this.orbitRegime !== null ? builder.createString(this.orbitRegime) : 0;
    return EntityMetadata.createEntityMetadata(
      builder,
      entityId,
      name,
      this.entityKind,
      subtype,
      parentEntityId,
      this.wasmHandle,
      this.noradCatId,
      objectName,
      objectId,
      catObjectName,
      catObjectId,
      facilityType,
      searchText,
      owner,
      statusCode,
      launchDate,
      launchYear,
      orbitRegime,
      this.period,
      this.inclination,
      this.apogee,
      this.perigee,
      this.meanMotion,
      this.eccentricity,
      this.bstar,
      this.hasGp
    );
  }
}
export {
  EntityMetadata,
  EntityMetadataT
};
