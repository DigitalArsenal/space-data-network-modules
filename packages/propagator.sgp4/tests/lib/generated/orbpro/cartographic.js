class Cartographic {
  bb = null;
  bb_pos = 0;
  __init(i, bb) {
    this.bb_pos = i;
    this.bb = bb;
    return this;
  }
  longitude() {
    return this.bb.readFloat64(this.bb_pos);
  }
  latitude() {
    return this.bb.readFloat64(this.bb_pos + 8);
  }
  height() {
    return this.bb.readFloat64(this.bb_pos + 16);
  }
  static sizeOf() {
    return 24;
  }
  static createCartographic(builder, longitude, latitude, height) {
    builder.prep(8, 24);
    builder.writeFloat64(height);
    builder.writeFloat64(latitude);
    builder.writeFloat64(longitude);
    return builder.offset();
  }
  unpack() {
    return new CartographicT(
      this.longitude(),
      this.latitude(),
      this.height()
    );
  }
  unpackTo(_o) {
    _o.longitude = this.longitude();
    _o.latitude = this.latitude();
    _o.height = this.height();
  }
}
class CartographicT {
  constructor(longitude = 0, latitude = 0, height = 0) {
    this.longitude = longitude;
    this.latitude = latitude;
    this.height = height;
  }
  pack(builder) {
    return Cartographic.createCartographic(
      builder,
      this.longitude,
      this.latitude,
      this.height
    );
  }
}
export {
  Cartographic,
  CartographicT
};
