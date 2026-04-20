class JulianDate {
  bb = null;
  bb_pos = 0;
  __init(i, bb) {
    this.bb_pos = i;
    this.bb = bb;
    return this;
  }
  days() {
    return this.bb.readFloat64(this.bb_pos);
  }
  static sizeOf() {
    return 8;
  }
  static createJulianDate(builder, days) {
    builder.prep(8, 8);
    builder.writeFloat64(days);
    return builder.offset();
  }
  unpack() {
    return new JulianDateT(
      this.days()
    );
  }
  unpackTo(_o) {
    _o.days = this.days();
  }
}
class JulianDateT {
  constructor(days = 0) {
    this.days = days;
  }
  pack(builder) {
    return JulianDate.createJulianDate(
      builder,
      this.days
    );
  }
}
export {
  JulianDate,
  JulianDateT
};
