import * as flatbuffers from 'flatbuffers';
export class PCFLaunch {
    bb = null;
    bb_pos = 0;
    __init(i, bb) {
        this.bb_pos = i;
        this.bb = bb;
        return this;
    }
    static getRootAsPCFLaunch(bb, obj) {
        return (obj || new PCFLaunch()).__init(bb.readInt32(bb.position()) + bb.position(), bb);
    }
    static getSizePrefixedRootAsPCFLaunch(bb, obj) {
        bb.setPosition(bb.position() + flatbuffers.SIZE_PREFIX_LENGTH);
        return (obj || new PCFLaunch()).__init(bb.readInt32(bb.position()) + bb.position(), bb);
    }
    DRAG_AREA_OVER_MASS_PRIOR_M2_KG() {
        const offset = this.bb.__offset(this.bb_pos, 4);
        return offset ? this.bb.readFloat64(this.bb_pos + offset) : 0.01;
    }
    SRP_AREA_OVER_MASS_PRIOR_M2_KG() {
        const offset = this.bb.__offset(this.bb_pos, 6);
        return offset ? this.bb.readFloat64(this.bb_pos + offset) : 0.01;
    }
    SEPARATION_SIGMA_M_S() {
        const offset = this.bb.__offset(this.bb_pos, 8);
        return offset ? this.bb.readFloat64(this.bb_pos + offset) : 1.0;
    }
    SHRINK_SIGMA_M2_KG() {
        const offset = this.bb.__offset(this.bb_pos, 10);
        return offset ? this.bb.readFloat64(this.bb_pos + offset) : 0.0;
    }
    HAS_SHRINK_SIGMA_M2_KG() {
        const offset = this.bb.__offset(this.bb_pos, 12);
        return offset ? !!this.bb.readInt8(this.bb_pos + offset) : false;
    }
    BATCH_MEAN_SIGMA_M2_KG() {
        const offset = this.bb.__offset(this.bb_pos, 14);
        return offset ? this.bb.readFloat64(this.bb_pos + offset) : 1.0;
    }
    static startPCFLaunch(builder) {
        builder.startObject(6);
    }
    static addDragAreaOverMassPriorM2Kg(builder, DRAG_AREA_OVER_MASS_PRIOR_M2_KG) {
        builder.addFieldFloat64(0, DRAG_AREA_OVER_MASS_PRIOR_M2_KG, 0.01);
    }
    static addSrpAreaOverMassPriorM2Kg(builder, SRP_AREA_OVER_MASS_PRIOR_M2_KG) {
        builder.addFieldFloat64(1, SRP_AREA_OVER_MASS_PRIOR_M2_KG, 0.01);
    }
    static addSeparationSigmaMS(builder, SEPARATION_SIGMA_M_S) {
        builder.addFieldFloat64(2, SEPARATION_SIGMA_M_S, 1.0);
    }
    static addShrinkSigmaM2Kg(builder, SHRINK_SIGMA_M2_KG) {
        builder.addFieldFloat64(3, SHRINK_SIGMA_M2_KG, 0.0);
    }
    static addHasShrinkSigmaM2Kg(builder, HAS_SHRINK_SIGMA_M2_KG) {
        builder.addFieldInt8(4, +HAS_SHRINK_SIGMA_M2_KG, +false);
    }
    static addBatchMeanSigmaM2Kg(builder, BATCH_MEAN_SIGMA_M2_KG) {
        builder.addFieldFloat64(5, BATCH_MEAN_SIGMA_M2_KG, 1.0);
    }
    static endPCFLaunch(builder) {
        const offset = builder.endObject();
        return offset;
    }
    static createPCFLaunch(builder, DRAG_AREA_OVER_MASS_PRIOR_M2_KG, SRP_AREA_OVER_MASS_PRIOR_M2_KG, SEPARATION_SIGMA_M_S, SHRINK_SIGMA_M2_KG, HAS_SHRINK_SIGMA_M2_KG, BATCH_MEAN_SIGMA_M2_KG) {
        PCFLaunch.startPCFLaunch(builder);
        PCFLaunch.addDragAreaOverMassPriorM2Kg(builder, DRAG_AREA_OVER_MASS_PRIOR_M2_KG);
        PCFLaunch.addSrpAreaOverMassPriorM2Kg(builder, SRP_AREA_OVER_MASS_PRIOR_M2_KG);
        PCFLaunch.addSeparationSigmaMS(builder, SEPARATION_SIGMA_M_S);
        PCFLaunch.addShrinkSigmaM2Kg(builder, SHRINK_SIGMA_M2_KG);
        PCFLaunch.addHasShrinkSigmaM2Kg(builder, HAS_SHRINK_SIGMA_M2_KG);
        PCFLaunch.addBatchMeanSigmaM2Kg(builder, BATCH_MEAN_SIGMA_M2_KG);
        return PCFLaunch.endPCFLaunch(builder);
    }
    unpack() {
        return new PCFLaunchT(this.DRAG_AREA_OVER_MASS_PRIOR_M2_KG(), this.SRP_AREA_OVER_MASS_PRIOR_M2_KG(), this.SEPARATION_SIGMA_M_S(), this.SHRINK_SIGMA_M2_KG(), this.HAS_SHRINK_SIGMA_M2_KG(), this.BATCH_MEAN_SIGMA_M2_KG());
    }
    unpackTo(_o) {
        _o.DRAG_AREA_OVER_MASS_PRIOR_M2_KG = this.DRAG_AREA_OVER_MASS_PRIOR_M2_KG();
        _o.SRP_AREA_OVER_MASS_PRIOR_M2_KG = this.SRP_AREA_OVER_MASS_PRIOR_M2_KG();
        _o.SEPARATION_SIGMA_M_S = this.SEPARATION_SIGMA_M_S();
        _o.SHRINK_SIGMA_M2_KG = this.SHRINK_SIGMA_M2_KG();
        _o.HAS_SHRINK_SIGMA_M2_KG = this.HAS_SHRINK_SIGMA_M2_KG();
        _o.BATCH_MEAN_SIGMA_M2_KG = this.BATCH_MEAN_SIGMA_M2_KG();
    }
}
export class PCFLaunchT {
    DRAG_AREA_OVER_MASS_PRIOR_M2_KG;
    SRP_AREA_OVER_MASS_PRIOR_M2_KG;
    SEPARATION_SIGMA_M_S;
    SHRINK_SIGMA_M2_KG;
    HAS_SHRINK_SIGMA_M2_KG;
    BATCH_MEAN_SIGMA_M2_KG;
    constructor(DRAG_AREA_OVER_MASS_PRIOR_M2_KG = 0.01, SRP_AREA_OVER_MASS_PRIOR_M2_KG = 0.01, SEPARATION_SIGMA_M_S = 1.0, SHRINK_SIGMA_M2_KG = 0.0, HAS_SHRINK_SIGMA_M2_KG = false, BATCH_MEAN_SIGMA_M2_KG = 1.0){
        this.DRAG_AREA_OVER_MASS_PRIOR_M2_KG = DRAG_AREA_OVER_MASS_PRIOR_M2_KG;
        this.SRP_AREA_OVER_MASS_PRIOR_M2_KG = SRP_AREA_OVER_MASS_PRIOR_M2_KG;
        this.SEPARATION_SIGMA_M_S = SEPARATION_SIGMA_M_S;
        this.SHRINK_SIGMA_M2_KG = SHRINK_SIGMA_M2_KG;
        this.HAS_SHRINK_SIGMA_M2_KG = HAS_SHRINK_SIGMA_M2_KG;
        this.BATCH_MEAN_SIGMA_M2_KG = BATCH_MEAN_SIGMA_M2_KG;
    }
    pack(builder) {
        return PCFLaunch.createPCFLaunch(builder, this.DRAG_AREA_OVER_MASS_PRIOR_M2_KG, this.SRP_AREA_OVER_MASS_PRIOR_M2_KG, this.SEPARATION_SIGMA_M_S, this.SHRINK_SIGMA_M2_KG, this.HAS_SHRINK_SIGMA_M2_KG, this.BATCH_MEAN_SIGMA_M2_KG);
    }
}
