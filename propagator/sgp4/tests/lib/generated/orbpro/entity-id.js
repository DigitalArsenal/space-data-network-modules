class EntityId {
  bb = null;
  bb_pos = 0;
  __init(i, bb) {
    this.bb_pos = i;
    this.bb = bb;
    return this;
  }
  index() {
    return this.bb.readUint32(this.bb_pos);
  }
  generation() {
    return this.bb.readUint32(this.bb_pos + 4);
  }
  static sizeOf() {
    return 8;
  }
  static createEntityId(builder, index, generation) {
    builder.prep(4, 8);
    builder.writeInt32(generation);
    builder.writeInt32(index);
    return builder.offset();
  }
  unpack() {
    return new EntityIdT(
      this.index(),
      this.generation()
    );
  }
  unpackTo(_o) {
    _o.index = this.index();
    _o.generation = this.generation();
  }
}
class EntityIdT {
  constructor(index = 0, generation = 0) {
    this.index = index;
    this.generation = generation;
  }
  pack(builder) {
    return EntityId.createEntityId(
      builder,
      this.index,
      this.generation
    );
  }
}
export {
  EntityId,
  EntityIdT
};
