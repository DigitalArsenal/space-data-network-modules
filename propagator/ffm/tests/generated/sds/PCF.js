import * as flatbuffers from 'flatbuffers';
import { PCFEpochStore, PCFEpochStoreT } from './PCFEpochStore.js';
import { PCFEventDefinition, PCFEventDefinitionT } from './PCFEventDefinition.js';
import { PCFFitPolicy, PCFFitPolicyT } from './PCFFitPolicy.js';
import { PCFForceModel, PCFForceModelT } from './PCFForceModel.js';
import { PCFIntegratorSettings, PCFIntegratorSettingsT } from './PCFIntegratorSettings.js';
import { PCFOutput, PCFOutputT } from './PCFOutput.js';
import { pcfTheory } from './pcfTheory.js';
export class PCF {
    bb = null;
    bb_pos = 0;
    __init(i, bb) {
        this.bb_pos = i;
        this.bb = bb;
        return this;
    }
    static getRootAsPCF(bb, obj) {
        return (obj || new PCF()).__init(bb.readInt32(bb.position()) + bb.position(), bb);
    }
    static getSizePrefixedRootAsPCF(bb, obj) {
        bb.setPosition(bb.position() + flatbuffers.SIZE_PREFIX_LENGTH);
        return (obj || new PCF()).__init(bb.readInt32(bb.position()) + bb.position(), bb);
    }
    CONFIGURATION_ID(optionalEncoding) {
        const offset = this.bb.__offset(this.bb_pos, 4);
        return offset ? this.bb.__string(this.bb_pos + offset, optionalEncoding) : null;
    }
    PROFILE(optionalEncoding) {
        const offset = this.bb.__offset(this.bb_pos, 6);
        return offset ? this.bb.__string(this.bb_pos + offset, optionalEncoding) : null;
    }
    THEORY() {
        const offset = this.bb.__offset(this.bb_pos, 8);
        return offset ? this.bb.readUint8(this.bb_pos + offset) : pcfTheory.UNSPECIFIED;
    }
    INTEGRATOR(obj) {
        const offset = this.bb.__offset(this.bb_pos, 10);
        return offset ? (obj || new PCFIntegratorSettings()).__init(this.bb.__indirect(this.bb_pos + offset), this.bb) : null;
    }
    FORCES(obj) {
        const offset = this.bb.__offset(this.bb_pos, 12);
        return offset ? (obj || new PCFForceModel()).__init(this.bb.__indirect(this.bb_pos + offset), this.bb) : null;
    }
    FIT(obj) {
        const offset = this.bb.__offset(this.bb_pos, 14);
        return offset ? (obj || new PCFFitPolicy()).__init(this.bb.__indirect(this.bb_pos + offset), this.bb) : null;
    }
    EVENTS(index, obj) {
        const offset = this.bb.__offset(this.bb_pos, 16);
        return offset ? (obj || new PCFEventDefinition()).__init(this.bb.__indirect(this.bb.__vector(this.bb_pos + offset) + index * 4), this.bb) : null;
    }
    eventsLength() {
        const offset = this.bb.__offset(this.bb_pos, 16);
        return offset ? this.bb.__vector_len(this.bb_pos + offset) : 0;
    }
    OUTPUT(obj) {
        const offset = this.bb.__offset(this.bb_pos, 18);
        return offset ? (obj || new PCFOutput()).__init(this.bb.__indirect(this.bb_pos + offset), this.bb) : null;
    }
    EPOCH_STORE(obj) {
        const offset = this.bb.__offset(this.bb_pos, 20);
        return offset ? (obj || new PCFEpochStore()).__init(this.bb.__indirect(this.bb_pos + offset), this.bb) : null;
    }
    static startPCF(builder) {
        builder.startObject(9);
    }
    static addConfigurationId(builder, CONFIGURATION_IDOffset) {
        builder.addFieldOffset(0, CONFIGURATION_IDOffset, 0);
    }
    static addProfile(builder, PROFILEOffset) {
        builder.addFieldOffset(1, PROFILEOffset, 0);
    }
    static addTheory(builder, THEORY) {
        builder.addFieldInt8(2, THEORY, pcfTheory.UNSPECIFIED);
    }
    static addIntegrator(builder, INTEGRATOROffset) {
        builder.addFieldOffset(3, INTEGRATOROffset, 0);
    }
    static addForces(builder, FORCESOffset) {
        builder.addFieldOffset(4, FORCESOffset, 0);
    }
    static addFit(builder, FITOffset) {
        builder.addFieldOffset(5, FITOffset, 0);
    }
    static addEvents(builder, EVENTSOffset) {
        builder.addFieldOffset(6, EVENTSOffset, 0);
    }
    static createEventsVector(builder, data) {
        builder.startVector(4, data.length, 4);
        for(let i = data.length - 1; i >= 0; i--){
            builder.addOffset(data[i]);
        }
        return builder.endVector();
    }
    static startEventsVector(builder, numElems) {
        builder.startVector(4, numElems, 4);
    }
    static addOutput(builder, OUTPUTOffset) {
        builder.addFieldOffset(7, OUTPUTOffset, 0);
    }
    static addEpochStore(builder, EPOCH_STOREOffset) {
        builder.addFieldOffset(8, EPOCH_STOREOffset, 0);
    }
    static endPCF(builder) {
        const offset = builder.endObject();
        return offset;
    }
    unpack() {
        return new PCFT(this.CONFIGURATION_ID(), this.PROFILE(), this.THEORY(), this.INTEGRATOR() !== null ? this.INTEGRATOR().unpack() : null, this.FORCES() !== null ? this.FORCES().unpack() : null, this.FIT() !== null ? this.FIT().unpack() : null, this.bb.createObjList(this.EVENTS.bind(this), this.eventsLength()), this.OUTPUT() !== null ? this.OUTPUT().unpack() : null, this.EPOCH_STORE() !== null ? this.EPOCH_STORE().unpack() : null);
    }
    unpackTo(_o) {
        _o.CONFIGURATION_ID = this.CONFIGURATION_ID();
        _o.PROFILE = this.PROFILE();
        _o.THEORY = this.THEORY();
        _o.INTEGRATOR = this.INTEGRATOR() !== null ? this.INTEGRATOR().unpack() : null;
        _o.FORCES = this.FORCES() !== null ? this.FORCES().unpack() : null;
        _o.FIT = this.FIT() !== null ? this.FIT().unpack() : null;
        _o.EVENTS = this.bb.createObjList(this.EVENTS.bind(this), this.eventsLength());
        _o.OUTPUT = this.OUTPUT() !== null ? this.OUTPUT().unpack() : null;
        _o.EPOCH_STORE = this.EPOCH_STORE() !== null ? this.EPOCH_STORE().unpack() : null;
    }
}
export class PCFT {
    CONFIGURATION_ID;
    PROFILE;
    THEORY;
    INTEGRATOR;
    FORCES;
    FIT;
    EVENTS;
    OUTPUT;
    EPOCH_STORE;
    constructor(CONFIGURATION_ID = null, PROFILE = null, THEORY = pcfTheory.UNSPECIFIED, INTEGRATOR = null, FORCES = null, FIT = null, EVENTS = [], OUTPUT = null, EPOCH_STORE = null){
        this.CONFIGURATION_ID = CONFIGURATION_ID;
        this.PROFILE = PROFILE;
        this.THEORY = THEORY;
        this.INTEGRATOR = INTEGRATOR;
        this.FORCES = FORCES;
        this.FIT = FIT;
        this.EVENTS = EVENTS;
        this.OUTPUT = OUTPUT;
        this.EPOCH_STORE = EPOCH_STORE;
    }
    pack(builder) {
        const CONFIGURATION_ID = this.CONFIGURATION_ID !== null ? builder.createString(this.CONFIGURATION_ID) : 0;
        const PROFILE = this.PROFILE !== null ? builder.createString(this.PROFILE) : 0;
        const INTEGRATOR = this.INTEGRATOR !== null ? this.INTEGRATOR.pack(builder) : 0;
        const FORCES = this.FORCES !== null ? this.FORCES.pack(builder) : 0;
        const FIT = this.FIT !== null ? this.FIT.pack(builder) : 0;
        const EVENTS = PCF.createEventsVector(builder, builder.createObjectOffsetList(this.EVENTS));
        const OUTPUT = this.OUTPUT !== null ? this.OUTPUT.pack(builder) : 0;
        const EPOCH_STORE = this.EPOCH_STORE !== null ? this.EPOCH_STORE.pack(builder) : 0;
        PCF.startPCF(builder);
        PCF.addConfigurationId(builder, CONFIGURATION_ID);
        PCF.addProfile(builder, PROFILE);
        PCF.addTheory(builder, this.THEORY);
        PCF.addIntegrator(builder, INTEGRATOR);
        PCF.addForces(builder, FORCES);
        PCF.addFit(builder, FIT);
        PCF.addEvents(builder, EVENTS);
        PCF.addOutput(builder, OUTPUT);
        PCF.addEpochStore(builder, EPOCH_STORE);
        return PCF.endPCF(builder);
    }
}
