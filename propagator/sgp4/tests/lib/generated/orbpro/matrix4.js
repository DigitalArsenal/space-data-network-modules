import { Vec4 } from "./vec4.js";
class Matrix4 {
  bb = null;
  bb_pos = 0;
  __init(i, bb) {
    this.bb_pos = i;
    this.bb = bb;
    return this;
  }
  col0(obj) {
    return (obj || new Vec4()).__init(this.bb_pos, this.bb);
  }
  col1(obj) {
    return (obj || new Vec4()).__init(this.bb_pos + 32, this.bb);
  }
  col2(obj) {
    return (obj || new Vec4()).__init(this.bb_pos + 64, this.bb);
  }
  col3(obj) {
    return (obj || new Vec4()).__init(this.bb_pos + 96, this.bb);
  }
  static sizeOf() {
    return 128;
  }
  static createMatrix4(builder, col0_x, col0_y, col0_z, col0_w, col1_x, col1_y, col1_z, col1_w, col2_x, col2_y, col2_z, col2_w, col3_x, col3_y, col3_z, col3_w) {
    builder.prep(8, 128);
    builder.prep(8, 32);
    builder.writeFloat64(col3_w);
    builder.writeFloat64(col3_z);
    builder.writeFloat64(col3_y);
    builder.writeFloat64(col3_x);
    builder.prep(8, 32);
    builder.writeFloat64(col2_w);
    builder.writeFloat64(col2_z);
    builder.writeFloat64(col2_y);
    builder.writeFloat64(col2_x);
    builder.prep(8, 32);
    builder.writeFloat64(col1_w);
    builder.writeFloat64(col1_z);
    builder.writeFloat64(col1_y);
    builder.writeFloat64(col1_x);
    builder.prep(8, 32);
    builder.writeFloat64(col0_w);
    builder.writeFloat64(col0_z);
    builder.writeFloat64(col0_y);
    builder.writeFloat64(col0_x);
    return builder.offset();
  }
  unpack() {
    return new Matrix4T(
      this.col0() !== null ? this.col0().unpack() : null,
      this.col1() !== null ? this.col1().unpack() : null,
      this.col2() !== null ? this.col2().unpack() : null,
      this.col3() !== null ? this.col3().unpack() : null
    );
  }
  unpackTo(_o) {
    _o.col0 = this.col0() !== null ? this.col0().unpack() : null;
    _o.col1 = this.col1() !== null ? this.col1().unpack() : null;
    _o.col2 = this.col2() !== null ? this.col2().unpack() : null;
    _o.col3 = this.col3() !== null ? this.col3().unpack() : null;
  }
}
class Matrix4T {
  constructor(col0 = null, col1 = null, col2 = null, col3 = null) {
    this.col0 = col0;
    this.col1 = col1;
    this.col2 = col2;
    this.col3 = col3;
  }
  pack(builder) {
    return Matrix4.createMatrix4(
      builder,
      this.col0?.x ?? 0,
      this.col0?.y ?? 0,
      this.col0?.z ?? 0,
      this.col0?.w ?? 0,
      this.col1?.x ?? 0,
      this.col1?.y ?? 0,
      this.col1?.z ?? 0,
      this.col1?.w ?? 0,
      this.col2?.x ?? 0,
      this.col2?.y ?? 0,
      this.col2?.z ?? 0,
      this.col2?.w ?? 0,
      this.col3?.x ?? 0,
      this.col3?.y ?? 0,
      this.col3?.z ?? 0,
      this.col3?.w ?? 0
    );
  }
}
export {
  Matrix4,
  Matrix4T
};
