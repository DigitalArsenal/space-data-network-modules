class Color {
  bb = null;
  bb_pos = 0;
  __init(i, bb) {
    this.bb_pos = i;
    this.bb = bb;
    return this;
  }
  red() {
    return this.bb.readFloat32(this.bb_pos);
  }
  green() {
    return this.bb.readFloat32(this.bb_pos + 4);
  }
  blue() {
    return this.bb.readFloat32(this.bb_pos + 8);
  }
  alpha() {
    return this.bb.readFloat32(this.bb_pos + 12);
  }
  static sizeOf() {
    return 16;
  }
  static createColor(builder, red, green, blue, alpha) {
    builder.prep(4, 16);
    builder.writeFloat32(alpha);
    builder.writeFloat32(blue);
    builder.writeFloat32(green);
    builder.writeFloat32(red);
    return builder.offset();
  }
  unpack() {
    return new ColorT(
      this.red(),
      this.green(),
      this.blue(),
      this.alpha()
    );
  }
  unpackTo(_o) {
    _o.red = this.red();
    _o.green = this.green();
    _o.blue = this.blue();
    _o.alpha = this.alpha();
  }
}
class ColorT {
  constructor(red = 0, green = 0, blue = 0, alpha = 0) {
    this.red = red;
    this.green = green;
    this.blue = blue;
    this.alpha = alpha;
  }
  pack(builder) {
    return Color.createColor(
      builder,
      this.red,
      this.green,
      this.blue,
      this.alpha
    );
  }
}
export {
  Color,
  ColorT
};
