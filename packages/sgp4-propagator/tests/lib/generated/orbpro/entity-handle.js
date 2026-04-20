class EntityHandle {
  bb = null;
  bb_pos = 0;
  __init(i, bb) {
    this.bb_pos = i;
    this.bb = bb;
    return this;
  }
  value() {
    return this.bb.readUint32(this.bb_pos);
  }
  static sizeOf() {
    return 4;
  }
  static createEntityHandle(builder, value) {
    builder.prep(4, 4);
    builder.writeInt32(value);
    return builder.offset();
  }
  unpack() {
    return new EntityHandleT(
      this.value()
    );
  }
  unpackTo(_o) {
    _o.value = this.value();
  }
}
class EntityHandleT {
  constructor(value = 0) {
    this.value = value;
  }
  pack(builder) {
    return EntityHandle.createEntityHandle(
      builder,
      this.value
    );
  }
}
export {
  EntityHandle,
  EntityHandleT
};
