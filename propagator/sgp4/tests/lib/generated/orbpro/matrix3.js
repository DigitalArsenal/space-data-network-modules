import { Vec3 } from "./vec3.js";
class Matrix3 {
  bb = null;
  bb_pos = 0;
  __init(i, bb) {
    this.bb_pos = i;
    this.bb = bb;
    return this;
  }
  col0(obj) {
    return (obj || new Vec3()).__init(this.bb_pos, this.bb);
  }
  col1(obj) {
    return (obj || new Vec3()).__init(this.bb_pos + 24, this.bb);
  }
  col2(obj) {
    return (obj || new Vec3()).__init(this.bb_pos + 48, this.bb);
  }
  static sizeOf() {
    return 72;
  }
  static createMatrix3(builder, col0_x, col0_y, col0_z, col1_x, col1_y, col1_z, col2_x, col2_y, col2_z) {
    builder.prep(8, 72);
    builder.prep(8, 24);
    builder.writeFloat64(col2_z);
    builder.writeFloat64(col2_y);
    builder.writeFloat64(col2_x);
    builder.prep(8, 24);
    builder.writeFloat64(col1_z);
    builder.writeFloat64(col1_y);
    builder.writeFloat64(col1_x);
    builder.prep(8, 24);
    builder.writeFloat64(col0_z);
    builder.writeFloat64(col0_y);
    builder.writeFloat64(col0_x);
    return builder.offset();
  }
  unpack() {
    return new Matrix3T(
      this.col0() !== null ? this.col0().unpack() : null,
      this.col1() !== null ? this.col1().unpack() : null,
      this.col2() !== null ? this.col2().unpack() : null
    );
  }
  unpackTo(_o) {
    _o.col0 = this.col0() !== null ? this.col0().unpack() : null;
    _o.col1 = this.col1() !== null ? this.col1().unpack() : null;
    _o.col2 = this.col2() !== null ? this.col2().unpack() : null;
  }
}
class Matrix3T {
  constructor(col0 = null, col1 = null, col2 = null) {
    this.col0 = col0;
    this.col1 = col1;
    this.col2 = col2;
  }
  pack(builder) {
    return Matrix3.createMatrix3(
      builder,
      this.col0?.x ?? 0,
      this.col0?.y ?? 0,
      this.col0?.z ?? 0,
      this.col1?.x ?? 0,
      this.col1?.y ?? 0,
      this.col1?.z ?? 0,
      this.col2?.x ?? 0,
      this.col2?.y ?? 0,
      this.col2?.z ?? 0
    );
  }
}
export {
  Matrix3,
  Matrix3T
};
