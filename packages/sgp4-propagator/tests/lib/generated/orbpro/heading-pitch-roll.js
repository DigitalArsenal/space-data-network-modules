class HeadingPitchRoll {
  bb = null;
  bb_pos = 0;
  __init(i, bb) {
    this.bb_pos = i;
    this.bb = bb;
    return this;
  }
  heading() {
    return this.bb.readFloat64(this.bb_pos);
  }
  pitch() {
    return this.bb.readFloat64(this.bb_pos + 8);
  }
  roll() {
    return this.bb.readFloat64(this.bb_pos + 16);
  }
  static sizeOf() {
    return 24;
  }
  static createHeadingPitchRoll(builder, heading, pitch, roll) {
    builder.prep(8, 24);
    builder.writeFloat64(roll);
    builder.writeFloat64(pitch);
    builder.writeFloat64(heading);
    return builder.offset();
  }
  unpack() {
    return new HeadingPitchRollT(
      this.heading(),
      this.pitch(),
      this.roll()
    );
  }
  unpackTo(_o) {
    _o.heading = this.heading();
    _o.pitch = this.pitch();
    _o.roll = this.roll();
  }
}
class HeadingPitchRollT {
  constructor(heading = 0, pitch = 0, roll = 0) {
    this.heading = heading;
    this.pitch = pitch;
    this.roll = roll;
  }
  pack(builder) {
    return HeadingPitchRoll.createHeadingPitchRoll(
      builder,
      this.heading,
      this.pitch,
      this.roll
    );
  }
}
export {
  HeadingPitchRoll,
  HeadingPitchRollT
};
