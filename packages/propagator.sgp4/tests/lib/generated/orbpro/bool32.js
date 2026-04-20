class Bool32 {
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
  static createBool32(builder, value) {
    builder.prep(4, 4);
    builder.writeInt32(value);
    return builder.offset();
  }
  unpack() {
    return new Bool32T(
      this.value()
    );
  }
  unpackTo(_o) {
    _o.value = this.value();
  }
}
class Bool32T {
  constructor(value = 0) {
    this.value = value;
  }
  pack(builder) {
    return Bool32.createBool32(
      builder,
      this.value
    );
  }
}
export {
  Bool32,
  Bool32T
};
