class Rectangle {
  bb = null;
  bb_pos = 0;
  __init(i, bb) {
    this.bb_pos = i;
    this.bb = bb;
    return this;
  }
  west() {
    return this.bb.readFloat64(this.bb_pos);
  }
  south() {
    return this.bb.readFloat64(this.bb_pos + 8);
  }
  east() {
    return this.bb.readFloat64(this.bb_pos + 16);
  }
  north() {
    return this.bb.readFloat64(this.bb_pos + 24);
  }
  static sizeOf() {
    return 32;
  }
  static createRectangle(builder, west, south, east, north) {
    builder.prep(8, 32);
    builder.writeFloat64(north);
    builder.writeFloat64(east);
    builder.writeFloat64(south);
    builder.writeFloat64(west);
    return builder.offset();
  }
  unpack() {
    return new RectangleT(
      this.west(),
      this.south(),
      this.east(),
      this.north()
    );
  }
  unpackTo(_o) {
    _o.west = this.west();
    _o.south = this.south();
    _o.east = this.east();
    _o.north = this.north();
  }
}
class RectangleT {
  constructor(west = 0, south = 0, east = 0, north = 0) {
    this.west = west;
    this.south = south;
    this.east = east;
    this.north = north;
  }
  pack(builder) {
    return Rectangle.createRectangle(
      builder,
      this.west,
      this.south,
      this.east,
      this.north
    );
  }
}
export {
  Rectangle,
  RectangleT
};
