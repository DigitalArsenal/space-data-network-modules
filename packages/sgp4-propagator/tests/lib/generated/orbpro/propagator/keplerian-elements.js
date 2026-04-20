import * as flatbuffers from "flatbuffers";
class KeplerianElements {
  bb = null;
  bb_pos = 0;
  __init(i, bb) {
    this.bb_pos = i;
    this.bb = bb;
    return this;
  }
  static getRootAsKeplerianElements(bb, obj) {
    return (obj || new KeplerianElements()).__init(bb.readInt32(bb.position()) + bb.position(), bb);
  }
  static getSizePrefixedRootAsKeplerianElements(bb, obj) {
    bb.setPosition(bb.position() + flatbuffers.SIZE_PREFIX_LENGTH);
    return (obj || new KeplerianElements()).__init(bb.readInt32(bb.position()) + bb.position(), bb);
  }
  /**
   * Semi-major axis (km)
   */
  semiMajorAxis() {
    const offset = this.bb.__offset(this.bb_pos, 4);
    return offset ? this.bb.readFloat64(this.bb_pos + offset) : 0;
  }
  /**
   * Eccentricity (0 = circular, <1 = ellipse)
   */
  eccentricity() {
    const offset = this.bb.__offset(this.bb_pos, 6);
    return offset ? this.bb.readFloat64(this.bb_pos + offset) : 0;
  }
  /**
   * Inclination (radians)
   */
  inclination() {
    const offset = this.bb.__offset(this.bb_pos, 8);
    return offset ? this.bb.readFloat64(this.bb_pos + offset) : 0;
  }
  /**
   * Right ascension of ascending node (radians)
   */
  raan() {
    const offset = this.bb.__offset(this.bb_pos, 10);
    return offset ? this.bb.readFloat64(this.bb_pos + offset) : 0;
  }
  /**
   * Argument of periapsis (radians)
   */
  argPeriapsis() {
    const offset = this.bb.__offset(this.bb_pos, 12);
    return offset ? this.bb.readFloat64(this.bb_pos + offset) : 0;
  }
  /**
   * True anomaly (radians)
   */
  trueAnomaly() {
    const offset = this.bb.__offset(this.bb_pos, 14);
    return offset ? this.bb.readFloat64(this.bb_pos + offset) : 0;
  }
  /**
   * Epoch as Julian date
   */
  epoch() {
    const offset = this.bb.__offset(this.bb_pos, 16);
    return offset ? this.bb.readFloat64(this.bb_pos + offset) : 0;
  }
  /**
   * Gravitational parameter (km³/s²), default Earth
   */
  mu() {
    const offset = this.bb.__offset(this.bb_pos, 18);
    return offset ? this.bb.readFloat64(this.bb_pos + offset) : 398600.4418;
  }
  static startKeplerianElements(builder) {
    builder.startObject(8);
  }
  static addSemiMajorAxis(builder, semiMajorAxis) {
    builder.addFieldFloat64(0, semiMajorAxis, 0);
  }
  static addEccentricity(builder, eccentricity) {
    builder.addFieldFloat64(1, eccentricity, 0);
  }
  static addInclination(builder, inclination) {
    builder.addFieldFloat64(2, inclination, 0);
  }
  static addRaan(builder, raan) {
    builder.addFieldFloat64(3, raan, 0);
  }
  static addArgPeriapsis(builder, argPeriapsis) {
    builder.addFieldFloat64(4, argPeriapsis, 0);
  }
  static addTrueAnomaly(builder, trueAnomaly) {
    builder.addFieldFloat64(5, trueAnomaly, 0);
  }
  static addEpoch(builder, epoch) {
    builder.addFieldFloat64(6, epoch, 0);
  }
  static addMu(builder, mu) {
    builder.addFieldFloat64(7, mu, 398600.4418);
  }
  static endKeplerianElements(builder) {
    const offset = builder.endObject();
    return offset;
  }
  static createKeplerianElements(builder, semiMajorAxis, eccentricity, inclination, raan, argPeriapsis, trueAnomaly, epoch, mu) {
    KeplerianElements.startKeplerianElements(builder);
    KeplerianElements.addSemiMajorAxis(builder, semiMajorAxis);
    KeplerianElements.addEccentricity(builder, eccentricity);
    KeplerianElements.addInclination(builder, inclination);
    KeplerianElements.addRaan(builder, raan);
    KeplerianElements.addArgPeriapsis(builder, argPeriapsis);
    KeplerianElements.addTrueAnomaly(builder, trueAnomaly);
    KeplerianElements.addEpoch(builder, epoch);
    KeplerianElements.addMu(builder, mu);
    return KeplerianElements.endKeplerianElements(builder);
  }
  unpack() {
    return new KeplerianElementsT(
      this.semiMajorAxis(),
      this.eccentricity(),
      this.inclination(),
      this.raan(),
      this.argPeriapsis(),
      this.trueAnomaly(),
      this.epoch(),
      this.mu()
    );
  }
  unpackTo(_o) {
    _o.semiMajorAxis = this.semiMajorAxis();
    _o.eccentricity = this.eccentricity();
    _o.inclination = this.inclination();
    _o.raan = this.raan();
    _o.argPeriapsis = this.argPeriapsis();
    _o.trueAnomaly = this.trueAnomaly();
    _o.epoch = this.epoch();
    _o.mu = this.mu();
  }
}
class KeplerianElementsT {
  constructor(semiMajorAxis = 0, eccentricity = 0, inclination = 0, raan = 0, argPeriapsis = 0, trueAnomaly = 0, epoch = 0, mu = 398600.4418) {
    this.semiMajorAxis = semiMajorAxis;
    this.eccentricity = eccentricity;
    this.inclination = inclination;
    this.raan = raan;
    this.argPeriapsis = argPeriapsis;
    this.trueAnomaly = trueAnomaly;
    this.epoch = epoch;
    this.mu = mu;
  }
  pack(builder) {
    return KeplerianElements.createKeplerianElements(
      builder,
      this.semiMajorAxis,
      this.eccentricity,
      this.inclination,
      this.raan,
      this.argPeriapsis,
      this.trueAnomaly,
      this.epoch,
      this.mu
    );
  }
}
export {
  KeplerianElements,
  KeplerianElementsT
};
