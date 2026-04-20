class Bool8 {
  bb = null;
  bb_pos = 0;
  __init(i, bb) {
    this.bb_pos = i;
    this.bb = bb;
    return this;
  }
  value() {
    return this.bb.readUint8(this.bb_pos);
  }
  static sizeOf() {
    return 1;
  }
  static createBool8(builder, value) {
    builder.prep(1, 1);
    builder.writeInt8(value);
    return builder.offset();
  }
  unpack() {
    return new Bool8T(
      this.value()
    );
  }
  unpackTo(_o) {
    _o.value = this.value();
  }
}
class Bool8T {
  constructor(value = 0) {
    this.value = value;
  }
  pack(builder) {
    return Bool8.createBool8(
      builder,
      this.value
    );
  }
}
export {
  Bool8,
  Bool8T
};
