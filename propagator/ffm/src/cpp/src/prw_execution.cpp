#include "ffm/prw_execution.h"
#include "ffm/prw_codec.h"
#include "ffm/prw_covariance.h"
#include "astrodynamics.h"
#include "integrators.h"
#include "variational.h"
#include "finite_burn.h"
#include "force_partials.h"
#include "ephemeris.h"
#include "environment_models.h"
#include "../../../../../files/orbit-products/src/sha256.hpp"
#include "ffm/prw_dynamics.h"
#include "ffm/kernel_store.h"
#include "planetary_fields.h"
// build.mjs defines both from plugin-manifest.json, the manifest the SDK embeds
// as $PLG, so VERSION_QUERY and the PLG identity cannot disagree.
#if !defined(FFM_MODULE_ID) || !defined(FFM_MODULE_VERSION)
#error "FFM_MODULE_ID and FFM_MODULE_VERSION come from plugin-manifest.json; build with build.mjs"
#endif
#include <algorithm>
#include <array>
#include <cctype>
#include <limits>
extern "C" {
#include "nrlmsise-00.h"
}
#include <cstdio>
#include <memory>

namespace ffm {
namespace {
using namespace astro;
using namespace dynamics;
std::unique_ptr<PRWStateMatrixT> matrix(const double* values,unsigned n,bool covariance) {
    auto out=std::make_unique<PRWStateMatrixT>();out->DIMENSION=n;out->VALUES.resize(n*n);
    for(unsigned i=0;i<n;++i)for(unsigned j=0;j<n;++j)out->VALUES[i*n+j]=values[i*n+j]*(i<6?1000:1)*(covariance?(j<6?1000:1):(j<6?0.001:1));
    return out;
}
// States and matrices leave in the request's axes.
std::unique_ptr<PRWResidentStateT> sampleState(const Execution& execution,const PRWExecutionRequest* request,StateVector state) {
    const auto frame=std::unique_ptr<RFMCoordinateSystemT>(request->INITIAL()->COORDINATE_SYSTEM()->UnPack());
    state.position=toRequestAxes(execution,state.position);state.velocity=toRequestAxes(execution,state.velocity);
    return makeState(state,*frame,request->INITIAL());
}
std::unique_ptr<PRWStateMatrixT> sampleMatrix(const Execution& execution,const double* values,unsigned n,bool covariance) {
    std::vector<double> m(values,values+n*n);rotateMatrix(execution,m.data(),n,true,covariance);return matrix(m.data(),n,covariance);
}
bool finish(const Execution& execution,const PRWExecutionRequest* request,const TTEpoch& epochTT,PRWPropagationSampleT& out,std::string& error);
// One epoch integrated from the initial state: finite burns (whose burn state
// runs along the arc) and the plain path without STM or samples.
bool evaluate(Execution& execution,const PRWExecutionRequest* request,const TTEpoch& epochTT,PRWPropagationSampleT& out,std::string& error) {
    const double epoch=timesys::ttToTdb(epochTT.jdTt());
    TTEpoch reached=epochTT;
    if(!preflightKernel(execution,epochTT.instant(),error))return false;
    const auto stateOut=[&](StateVector state){return sampleState(execution,request,state);};
    const auto matrixOut=[&](const double* values,unsigned n,bool covariance){return sampleMatrix(execution,values,n,covariance);};
    // Elapsed time on the integration clock (TT), exact to sub-nanosecond.
    const double seconds=elapsedSeconds(execution.initialTT,epochTT);
    if(execution.massDynamics) {
        const auto value=Integrator::PropagateFiniteBurns(execution.initial,execution.mass,seconds,execution.integrator,execution.forces,execution.burns,execution.density,execution.impulses);
        if(!value.success){error="invoke-failed: "+value.errorMessage;return false;}
        auto state=value.finalState;state.epoch=epoch;out.STATE=stateOut(state);out.STATE->HAS_MASS_KG=true;out.STATE->MASS_KG=value.massKg;
        Mat6 phi{};for(int i=0;i<6;++i)for(int j=0;j<6;++j)phi.m[i][j]=value.stm[i*7+j];
        out.STM=matrixOut(&phi.m[0][0],6,false);out.MASS_STM=matrixOut(value.stm.data(),7,false);
        if(execution.covariance){const auto p=Integrator::TransportCovariance(phi,execution.p);out.COVARIANCE=matrixOut(&p.m[0][0],6,true);}
        if(execution.massCovariance){const auto p=Integrator::TransportFiniteCovariance(value.stm,execution.p7);out.MASS_COVARIANCE=matrixOut(p.data(),7,true);}
        out.ACCEPTED_STEPS=value.steps;out.REJECTED_STEPS=value.rejections;
        for(size_t i=0;i<value.burns.size();++i) {
            const auto& burn=value.burns[i];auto report=std::make_unique<PRWBurnReportT>();
            report->BURN_INDEX=i;report->STARTED=burn.started;report->STOPPED=burn.stopped;report->START_BY_EVENT=burn.startByEvent;report->STOP_BY_EVENT=burn.stopByEvent;
            report->HAS_START_SECONDS=burn.started;report->HAS_STOP_SECONDS=burn.stopped;
            if(burn.started){report->START_SECONDS=burn.startSeconds;report->START_EPOCH=makeInstant(execution.initial.epoch+burn.startSeconds/86400);}
            if(burn.stopped){report->STOP_SECONDS=burn.stopSeconds;report->STOP_EPOCH=makeInstant(execution.initial.epoch+burn.stopSeconds/86400);}
            report->DELTA_V_M_S=burn.deltaVKmS*1000;report->PROPELLANT_KG=burn.propellantKg;out.BURNS.push_back(std::move(report));
        }
    } else {
        StateVector state=execution.initial;TTEpoch at=execution.initialTT;uint32_t steps=0,rejections=0;
        if(!propagateState(execution,state,at,epochTT,steps,rejections,error))return false;
        // A STOP event ends the arc where it is: the sample is the state there.
        if(execution.eventOutcome.stoppedBy>=0)reached=at;
        state.epoch=timesys::ttToTdb(reached.jdTt());out.STATE=stateOut(state);out.ACCEPTED_STEPS=steps;out.REJECTED_STEPS=rejections;
    }
    return finish(execution,request,reached,out,error);
}
// The tail every sample shares: mass echo, epoch label and finiteness.
bool finish(const Execution& execution,const PRWExecutionRequest* request,const TTEpoch& epochTT,PRWPropagationSampleT& out,std::string& error) {
    if(request->INITIAL()->HAS_MASS_KG()&&!execution.massDynamics){out.STATE->HAS_MASS_KG=true;out.STATE->MASS_KG=execution.mass;}
    out.STATE->STATE->EPOCH=formatTdb(epochTT);out.STATE->STATE->EPOCH_TIME_SYSTEM="TDB";
    if(!Ephemeris::ephemerisError().empty()){error="ephemeris-failed: "+Ephemeris::ephemerisError();return false;}
    for(const auto* m:{out.STM.get(),out.MASS_STM.get(),out.COVARIANCE.get(),out.MASS_COVARIANCE.get()})
        if(m)for(const double value:m->VALUES)if(!std::isfinite(value))
            return prwError(error,"invoke-failed: State matrix transport overflowed its finite SI representation.");
    if(out.STATE->HAS_MASS_KG&&!positive(out.STATE->MASS_KG))
        return prwError(error,"invoke-failed: Propagation returned a nonpositive or nonfinite mass.");
    const auto& state=*out.STATE->STATE;
    if(!std::isfinite(state.POSITION->X)||!std::isfinite(state.POSITION->Y)||!std::isfinite(state.POSITION->Z)||!std::isfinite(state.VELOCITY->X)||!std::isfinite(state.VELOCITY->Y)||!std::isfinite(state.VELOCITY->Z))return prwError(error,"invoke-failed: Integration returned a nonfinite state.");
    return true;
}
// The impulses at the arc's initial epoch, applied to the cursor's initial state:
// the velocity, the transition matrix (phi = J phi) and the covariance (P = J P J^T),
// J the kick's Jacobian on the six state components and the identity on the parameters.
bool applyStartImpulses(const Execution& execution,Cursor& c,std::string& error) {
    const unsigned n=6+unsigned(execution.parameters.size());
    for(const auto& kick:execution.startImpulses) {
        if(kick.inRTN&&c.state.position.cross(c.state.velocity).magnitude()==0)return prwError(error,"invoke-failed: Singular RTN impulse frame.");
        const Mat6 jump=ForceModel::ImpulsiveManeuverJacobian(c.state.position,c.state.velocity,kick);
        c.state.velocity=ForceModel::ImpulsiveManeuver(c.state.velocity,c.state.position,kick);
        const auto jacobian=[&](unsigned i,unsigned k){return i<6?(k<6?jump.m[i][k]:0.0):(i==k?1.0:0.0);};
        const auto left=[&](std::vector<double>& m,unsigned dim) {
            std::vector<double> out(dim*dim,0.0);
            for(unsigned i=0;i<dim;++i)for(unsigned k=0;k<dim;++k){const double x=jacobian(i,k);if(x==0)continue;for(unsigned j=0;j<dim;++j)out[i*dim+j]+=x*m[k*dim+j];}
            m.swap(out);
        };
        left(c.phi,n);
        if(!c.p.empty()) {
            const unsigned dim=c.p.size()==36?6u:n;
            std::vector<double> j(dim*dim);
            for(unsigned i=0;i<dim;++i)for(unsigned k=0;k<dim;++k)j[i*dim+k]=jacobian(i,k);
            Integrator::TransportCovariance(j.data(),c.p.data(),dim,c.p.data());   // J P J^T
        }
    }
    return true;
}
bool evaluateInOrder(Execution& execution,const PRWExecutionRequest* request,PRWExecutionResultT& result,std::string& error) {
    // Index 0 is the target epoch, k > 0 the k-th sample.
    std::vector<TTEpoch> epochs{execution.targetTT};
    epochs.insert(epochs.end(),execution.samplesTT.begin(),execution.samplesTT.end());
    std::vector<std::pair<double,size_t>> forward,backward;
    for(size_t k=0;k<epochs.size();++k) {
        const double seconds=elapsedSeconds(execution.initialTT,epochs[k]);
        (seconds<0?backward:forward).push_back({std::abs(seconds),k});
    }
    std::stable_sort(forward.begin(),forward.end());std::stable_sort(backward.begin(),backward.end());
    const unsigned n=6+unsigned(execution.parameters.size());
    std::vector<std::unique_ptr<PRWPropagationSampleT>> samples(epochs.size());
    for(const auto* group:{&forward,&backward}) {
        Cursor c;c.state=execution.initial;c.tt=execution.initialTT;
        c.phi.assign(n*n,0.0);for(unsigned i=0;i<n;++i)c.phi[i*n+i]=1;
        if(execution.covariance)c.p=execution.parameters.empty()?std::vector<double>(&execution.p.m[0][0],&execution.p.m[0][0]+36):execution.pParameters;
        if(!group->empty()&&!execution.startImpulses.empty()) {
            if(group==&backward)return prwError(error,"invoke-failed: Backward propagation with scheduled impulses is unsupported.");
            if(!applyStartImpulses(execution,c,error))return false;
        }
        for(const auto& entry:*group) {
            const TTEpoch& epochTT=epochs[entry.second];
            if(!preflightKernel(execution,epochTT.instant(),error))return false;
            if(!advance(execution,c,epochTT,error))return false;
            auto out=std::make_unique<PRWPropagationSampleT>();
            out->STATE=sampleState(execution,request,c.state);out->STM=sampleMatrix(execution,c.phi.data(),n,false);
            if(execution.covariance){out->COVARIANCE=sampleMatrix(execution,c.p.data(),n,true);out->PROCESS_NOISE=prwProcessNoiseRecord(execution.noise);}
            out->ACCEPTED_STEPS=c.steps;out->REJECTED_STEPS=c.rejections;
            if(!finish(execution,request,epochTT,*out,error))return false;
            samples[entry.second]=std::move(out);
        }
    }
    result.FINAL_SAMPLE=std::move(samples[0]);
    for(size_t k=1;k<samples.size();++k)result.SAMPLES.push_back(std::move(samples[k]));
    return true;
}
// Sampled requests without STM, covariance, parameters, impulses or burns:
// the 6-state equations only, epoch by epoch in time order (forward and
// backward of the initial epoch separately), each span integrated once through
// the space-weather breaks. The samples carry no STM. The states agree with
// the variational path's to the integration tolerance (the STM no longer
// enters the step control), at a fraction of its cost.
bool evaluateStatesInOrder(Execution& execution,const PRWExecutionRequest* request,PRWExecutionResultT& result,std::string& error) {
    std::vector<TTEpoch> epochs{execution.targetTT};
    epochs.insert(epochs.end(),execution.samplesTT.begin(),execution.samplesTT.end());
    std::vector<std::pair<double,size_t>> forward,backward;
    for(size_t k=0;k<epochs.size();++k) {
        const double seconds=elapsedSeconds(execution.initialTT,epochs[k]);
        (seconds<0?backward:forward).push_back({std::abs(seconds),k});
    }
    std::stable_sort(forward.begin(),forward.end());std::stable_sort(backward.begin(),backward.end());
    std::vector<std::unique_ptr<PRWPropagationSampleT>> samples(epochs.size());
    for(const auto* group:{&forward,&backward}) {
        StateVector state=execution.initial;TTEpoch at=execution.initialTT;uint32_t steps=0,rejections=0;
        for(const auto& entry:*group) {
            const TTEpoch& epochTT=epochs[entry.second];
            if(!preflightKernel(execution,epochTT.instant(),error))return false;
            if(!propagateState(execution,state,at,epochTT,steps,rejections,error))return false;
            auto out=std::make_unique<PRWPropagationSampleT>();
            out->STATE=sampleState(execution,request,state);
            out->ACCEPTED_STEPS=steps;out->REJECTED_STEPS=rejections;
            if(!finish(execution,request,epochTT,*out,error))return false;
            samples[entry.second]=std::move(out);
        }
    }
    result.FINAL_SAMPLE=std::move(samples[0]);
    for(size_t k=1;k<samples.size();++k)result.SAMPLES.push_back(std::move(samples[k]));
    return true;
}
// The located events, in the request's axes, at their exact epochs.
void encodeEvents(const Execution& execution,const PRWExecutionRequest* request,PRWExecutionResultT& result) {
    const auto& outcome=execution.eventOutcome;
    for(const auto& hit:outcome.hits) {
        auto record=std::make_unique<PRWEventRecordT>();
        record->EVENT_INDEX=hit.spec;record->KIND=execution.eventKinds[hit.spec];
        record->DIRECTION=hit.direction==sdn::events::Direction::INCREASING?pcfEventDirection::INCREASING:pcfEventDirection::DECREASING;
        record->ELAPSED_SECONDS=hit.t;
        const TTEpoch at=normalizeTT(execution.initialTT.whole,execution.initialTT.fraction+hit.t);
        record->EPOCH=std::make_unique<TIMInstantT>();
        record->EPOCH->TIME_SYSTEM=timingStandard::TDB;record->EPOCH->EPOCH_FORMAT=timEpochRepresentation::ISO8601;record->EPOCH->ISO8601=formatTdb(at);
        StateVector state;
        state.position=Vec3(hit.state[0],hit.state[1],hit.state[2]);state.velocity=Vec3(hit.state[3],hit.state[4],hit.state[5]);
        state.epoch=timesys::ttToTdb(at.jdTt());
        record->STATE=sampleState(execution,request,state);
        record->STATE->STATE->EPOCH=formatTdb(at);record->STATE->STATE->EPOCH_TIME_SYSTEM="TDB";
        record->RESIDUAL=hit.residual;record->ITERATIONS=hit.iterations;
        result.EVENTS.push_back(std::move(record));
    }
    result.EVENT_OCCURRENCES=outcome.occurrences;
    result.STOPPED_BY_EVENT=outcome.stoppedBy;
}
bool execute(const PRWExecutionRequest* request,const Environment& environment,PRWT& response,std::string& error) {
    Execution execution;if(!parseExecution(request,environment.earth!=nullptr,execution,error))return false;
    // About the Moon or Mars the trajectory ends at the body's surface (lib/reentry.h), not at the Earth's Karman line.
    if(execution.forces.centralBodyNaifId!=399)
        astro::centralBodyStop()=astro::CentralBodyStop{planetary::bodyRadiusKm(execution.forces.centralBodyNaifId),planetary::bodyName(execution.forces.centralBodyNaifId)};
    if(!attachEnvironment(execution,environment,request->FORCES()->WEATHER()!=nullptr,error))return false;
    auto first=execution.initialTT.instant(),last=execution.targetTT.instant();
    if(first.secondsSince(last)>0)std::swap(first,last);
    for(const auto& t:execution.samplesTT){const auto at=t.instant();if(at.secondsSince(last)>0)last=at;if(at.secondsSince(first)<0)first=at;}
    if(!environmentCovers(execution,environment,first,last,error))return false;
    if((environment.weather||execution.densityCorrectionBreaks != nullptr)&&!execution.massDynamics)execution.breaks=driverBreaks(execution);
    auto result=std::make_unique<PRWExecutionResultT>();
    if(execution.variational&&!execution.massDynamics&&execution.stateOnly) {
        if(!evaluateStatesInOrder(execution,request,*result,error))return false;
    } else if(execution.variational&&!execution.massDynamics) {
        if(!evaluateInOrder(execution,request,*result,error))return false;
    } else {
        // Finite burns carry burn state along the arc; each epoch is integrated
        // from the initial state.
        result->FINAL_SAMPLE=std::make_unique<PRWPropagationSampleT>();
        if(!evaluate(execution,request,execution.targetTT,*result->FINAL_SAMPLE,error))return false;
        for(const auto& epoch:execution.samplesTT){auto sample=std::make_unique<PRWPropagationSampleT>();if(!evaluate(execution,request,epoch,*sample,error))return false;result->SAMPLES.push_back(std::move(sample));}
    }
    result->ELAPSED_SECONDS=elapsedSeconds(execution.initialTT,execution.targetTT);result->EPHEMERIS_SOURCE=Ephemeris::ephemerisSourceName(Ephemeris::selectedEphemerisSource());
    if(!execution.events.empty()) {
        encodeEvents(execution,request,*result);
        if(execution.eventOutcome.stoppedBy>=0)result->ELAPSED_SECONDS=execution.eventOutcome.hits.back().t;
    }
    if(execution.variational){result->STM_TECHNIQUE=request->STM_TECHNIQUE();result->DENSITY_TREATMENT=request->DENSITY_TREATMENT();}
    if(request->DYNAMIC_PARAMETERS())for(const auto p:*request->DYNAMIC_PARAMETERS())result->DYNAMIC_PARAMETERS.push_back(p);
    response.EXECUTION_RESULT=std::move(result);return true;
}
// The instance keeps the verified kernel: the same kernel again (same
// SHA-256, identical bytes) is compared, not hashed.
bool loadKernel(const uint8_t* data,size_t size,std::string& error) {
    const auto kernel=instanceKernels().accept(data,size,false,error);
    return kernel&&KernelStore::activate(kernel,error);
}
bool ephemeris(const PRWEphemerisRequest* request,PRWT& response,std::string& error) {
    if(Ephemeris::selectedEphemerisSource()==Ephemeris::EphemerisSource::Analytical)return prwError(error,"missing-kernel: NAIF ephemeris query requires a kernel input.");
    if(request->EPOCH()->TIME_SYSTEM()!=timingStandard::TDB)return prwError(error,"epoch-time-scale: Geometric ephemeris query requires TDB.");
    TTEpoch epoch;if(!decodeEpochTT(request->EPOCH(),epoch,error))return false;
    const auto instant=epoch.instant();const double jd=instant.jdTdb();
    const auto value=Ephemeris::getKernelState(request->TARGET_NAIF_ID(),request->CENTER_NAIF_ID(),instant);
    if(!value.valid){error="ephemeris-failed: "+Ephemeris::ephemerisError();return false;}
    auto result=std::make_unique<PRWEphemerisResultT>();result->TARGET_NAIF_ID=request->TARGET_NAIF_ID();result->CENTER_NAIF_ID=request->CENTER_NAIF_ID();
    StateVector state;state.position=value.position;state.velocity=value.velocity;state.epoch=jd;
    auto frame=makeFrame("ICRF/NAIF-"+std::to_string(request->CENTER_NAIF_ID()),rfmAxisType::ICRF,request->CENTER_NAIF_ID());
    if(request->CENTER_NAIF_ID()>=0&&request->CENTER_NAIF_ID()<=9){frame->ORIGIN->KIND=rfmOriginKind::BARYCENTRE;frame->ORIGIN->BARYCENTRE_ID=request->CENTER_NAIF_ID();frame->ORIGIN->CELESTIAL_BODY_ID=0;}
    result->STATE=makeState(state,*frame);result->EPHEMERIS_SOURCE=Ephemeris::ephemerisSourceName(value.source);response.EPHEMERIS_RESULT=std::move(result);return true;
}
bool atmosphere(const PRWAtmosphereRequest* request,PRWT& response,std::string& error) {
    if(request->EPOCH()->TIME_SYSTEM()!=timingStandard::UTC)return prwError(error,"epoch-time-scale: Atmospheric diagnostic epoch must be UTC.");
    double tdb=0,utc=0;if(!decodeEpoch(request->EPOCH(),tdb,utc,error))return false;
    const double altitude=request->ALTITUDE_M(),lat=request->LATITUDE_RAD(),lon=request->LONGITUDE_RAD();
    if(!nonnegative(altitude)||!std::isfinite(lat)||std::abs(lat)>PI/2||!std::isfinite(lon)||std::abs(lon)>PI||!nonnegative(request->F107())||!nonnegative(request->F107_AVERAGE())||!nonnegative(request->AP_INDEX()))
        return prwError(error,"invalid-atmosphere: Atmosphere inputs must be finite and within their physical domain.");
    if(!request->HAS_LOCAL_SOLAR_TIME_HOURS()&&request->LOCAL_SOLAR_TIME_HOURS()!=0)return prwError(error,"invalid-presence: Local solar time requires its presence bit.");
    if(request->HAS_LOCAL_SOLAR_TIME_HOURS()&&(!nonnegative(request->LOCAL_SOLAR_TIME_HOURS())||request->LOCAL_SOLAR_TIME_HOURS()>=24))return prwError(error,"invalid-atmosphere: Local solar time must be in [0,24).");
    auto result=std::make_unique<PRWAtmosphereResultT>();result->ATMOSPHERE_MODEL=request->ATMOSPHERE_MODEL();result->ALTITUDE_M=altitude;
    if(request->ATMOSPHERE_MODEL()==pcfAtmosphereFamily::USSA1976) {
        if(altitude>86000)return prwError(error,"unsupported-atmosphere: USSA1976 profile covers 0 to 86 km geometric altitude.");
        if(request->INCLUDE_ANOMALOUS_OXYGEN())return prwError(error,"unsupported-atmosphere: Anomalous oxygen is an NRLMSISE00 option.");
        const auto value=computeUSSA1976(altitude*0.001);result->DENSITY_KG_M3=value.density;result->HAS_TEMPERATURE_K=true;result->TEMPERATURE_K=value.temperature;result->HAS_SCALE_HEIGHT_M=true;result->SCALE_HEIGHT_M=value.scaleHeight*1000;
    } else if(request->ATMOSPHERE_MODEL()==pcfAtmosphereFamily::EXPONENTIAL) {
        if(request->INCLUDE_ANOMALOUS_OXYGEN())return prwError(error,"unsupported-atmosphere: Anomalous oxygen is an NRLMSISE00 option.");
        result->DENSITY_KG_M3=exponentialAtmosphereDensity(altitude*0.001);
    } else if(request->ATMOSPHERE_MODEL()==pcfAtmosphereFamily::NRLMSISE00) {
        nrlmsise_input input{};nrlmsise_flags flags{};nrlmsise_output value{};
        int month=0,day=0,hour=0,minute=0;double seconds=0;
        timesys::Epoch(utc,timesys::TimeScale::UTC).toComponents(input.year,month,day,hour,minute,seconds);
        input.doy=int(std::floor(utc-timesys::Epoch::fromComponents(input.year,1,1,0,0,0,timesys::TimeScale::UTC).jd))+1;
        input.sec=hour*3600+minute*60+seconds;input.alt=altitude*0.001;input.g_lat=lat*180/PI;input.g_long=lon*180/PI;
        input.lst=request->HAS_LOCAL_SOLAR_TIME_HOURS()?request->LOCAL_SOLAR_TIME_HOURS():std::fmod(input.sec/3600+input.g_long/15+24,24);
        input.f107=request->F107();input.f107A=request->F107_AVERAGE();input.ap=request->AP_INDEX();
        flags.switches[0]=0;for(int i=1;i<24;++i)flags.switches[i]=1;
        if(request->INCLUDE_ANOMALOUS_OXYGEN())gtd7d(&input,&flags,&value);else gtd7(&input,&flags,&value);
        result->VARIANT=request->INCLUDE_ANOMALOUS_OXYGEN()?"gtd7d":"gtd7";result->DENSITY_KG_M3=value.d[5]*1000;result->HAS_TEMPERATURE_K=true;result->TEMPERATURE_K=value.t[1];result->HAS_EXOSPHERIC_TEMPERATURE_K=true;result->EXOSPHERIC_TEMPERATURE_K=value.t[0];
        const int indices[]={0,1,2,3,4,6,7,8};
        for(int i=0;i<8;++i){auto species=std::make_unique<PRWSpeciesDensityT>();species->CONSTITUENT=static_cast<prwDensitySpecies>(i+1);species->NUMBER_PER_M3=value.d[indices[i]]*1e6;result->NUMBER_DENSITIES.push_back(std::move(species));}
    } else return prwError(error,"unsupported-atmosphere: Diagnostic supports NRLMSISE00, USSA1976 and EXPONENTIAL.");
    if(!nonnegative(result->DENSITY_KG_M3))return prwError(error,"invoke-failed: Atmosphere returned an invalid density.");
    response.ATMOSPHERE_RESULT=std::move(result);return true;
}
} // namespace
bool processPrwInvoke(const uint8_t* data,size_t size,const uint8_t* kernel,size_t kernelSize,const PrwEnvironment& frames,std::vector<uint8_t>& output,std::string& error) {
    struct KernelLifetime {KernelLifetime(){Ephemeris::clearEphemerisBuffer();}~KernelLifetime(){Ephemeris::clearEphemerisBuffer();}} kernelLifetime;
    const PRW* request=nullptr;if(!verifyPrw(data,size,request,error))return false;
    if(kernelSize&&!loadKernel(kernel,kernelSize,error))return false;
    PRWT response;bool ok=false;
    // The rows point into these PRW buffers, which outlive the invocation.
    Environment environment;
    if(!loadEnvironment(frames,false,environment,error))return false;
    if(request->EXECUTION_REQUEST()){
        astro::clearCallStop();
        ok=execute(request->EXECUTION_REQUEST(),environment,response,error);
        // The trajectory ended (lib/reentry.h): the request fails there, by name.
        if(astro::callStop().active){error=std::string(astro::callStop().code)=="invalid-force" ? astro::propagationStopMessage(astro::callStop()) : stopError(astro::callStop());return false;}
    }
    else if(environment.earth)return prwError(error,"unsupported-earth-orientation: Earth orientation applies to execution requests.");
    else if(environment.jb2008)return prwError(error,"unsupported-jb2008-indices: JB2008 indices apply to execution requests.");
    else if(environment.densityCorrection)return prwError(error,"unsupported-density-correction: Density correction applies to execution requests.");
    else if(environment.weather)return prwError(error,"unsupported-space-weather: Space weather applies to execution requests.");
    else if(request->EPHEMERIS_REQUEST())ok=ephemeris(request->EPHEMERIS_REQUEST(),response,error);
    else if(request->ATMOSPHERE_REQUEST())ok=atmosphere(request->ATMOSPHERE_REQUEST(),response,error);
    else if(request->VERSION_QUERY()){response.VERSION_RESULT=std::make_unique<PRWVersionResultT>();response.VERSION_RESULT->VERSION=FFM_MODULE_VERSION;response.VERSION_RESULT->MODULE_ID=FFM_MODULE_ID;ok=true;}
    else return prwError(error,"invalid-prw-arm: invoke requires execution, ephemeris, atmosphere or version query.");
    if(ok)encodePrw(response,output);return ok;
}
namespace {
// The most states one propagate_oem call writes: the execution's sample limit.
constexpr size_t kMaximumOemStates=10000;
// One OUTPUT epoch, ISO 8601 UTC ("Z" or no designator), as seconds of the
// UTC label since 2000-01-01T12:00:00. A UTC offset or a time scale written
// after the time is not UTC.
bool outputEpoch(const flatbuffers::String* text,TTEpoch& out,std::string& error) {
    const std::string iso=text?text->str():std::string();
    size_t at=19;
    if(at<iso.size()&&iso[at]=='.')for(++at;at<iso.size()&&iso[at]>='0'&&iso[at]<='9';++at){}
    const std::string zone=at<iso.size()?iso.substr(at):std::string();
    if(!zone.empty()&&zone!="Z"&&(zone[0]=='+'||zone[0]=='-'||zone[0]==' '||std::isalpha(static_cast<unsigned char>(zone[0]))))
        return prwError(error,("time-system-not-utc: OUTPUT epoch "+iso+" is not ISO 8601 UTC.").c_str());
    double whole=0,fraction=0,jd=0;
    if(!parseIsoSeconds(iso,whole,fraction,jd,error))return false;
    out=normalizeTT(whole,fraction);return true;
}
// The OUTPUT epochs: EPOCHS, or START_TIME to STOP_TIME at STEP_SECONDS
// (the last at or before STOP_TIME, as sdn-ap propagate_epochs counts them).
bool outputGrid(const PCFOutput* output,std::vector<TTEpoch>& grid,std::string& error) {
    if(!output)return prwError(error,"output-unspecified: The $PCF carries no OUTPUT.");
    if(output->EPOCHS()&&output->EPOCHS()->size()) {
        for(const auto* text:*output->EPOCHS()) {
            TTEpoch t;if(!outputEpoch(text,t,error))return false;
            if(!grid.empty()&&!(elapsedSeconds(grid.back(),t)>0))return prwError(error,"invalid-configuration: OUTPUT.EPOCHS must ascend.");
            grid.push_back(t);
            if(grid.size()>kMaximumOemStates||grid.size()>output->MAXIMUM_STATES())break;
        }
    } else {
        if(!output->START_TIME()||!output->START_TIME()->size()||!output->STOP_TIME()||!output->STOP_TIME()->size())
            return prwError(error,"output-unspecified: OUTPUT names EPOCHS, or START_TIME and STOP_TIME.");
        TTEpoch start,stop;if(!outputEpoch(output->START_TIME(),start,error)||!outputEpoch(output->STOP_TIME(),stop,error))return false;
        const double step=output->STEP_SECONDS();
        const double span=elapsedSeconds(start,stop);
        if(!std::isfinite(step)||!(step>0)||!(span>=0))return prwError(error,"invalid-configuration: OUTPUT.STEP_SECONDS must be positive and STOP_TIME at or after START_TIME.");
        const double count=std::floor(span/step+1e-9)+1;
        if(count>double(kMaximumOemStates)||count>double(output->MAXIMUM_STATES()))
            return prwError(error,("too-many-states: OUTPUT asks for more than "+std::to_string(std::min<size_t>(kMaximumOemStates,output->MAXIMUM_STATES()))+" states.").c_str());
        for(size_t k=0;k<size_t(count);++k)grid.push_back(normalizeTT(start.whole,start.fraction+double(k)*step));
    }
    if(grid.size()>kMaximumOemStates||grid.size()>output->MAXIMUM_STATES())
        return prwError(error,("too-many-states: OUTPUT asks for more than "+std::to_string(std::min<size_t>(kMaximumOemStates,output->MAXIMUM_STATES()))+" states.").c_str());
    return true;
}
// The $PCF: OUTPUT only; the dynamics are the request's.
bool readOutputConfiguration(const uint8_t* data,size_t size,const PCF*& pcf,std::string& error) {
    if(data&&size>=12&&flatbuffers::ReadScalar<uint32_t>(data)==size-4&&SizePrefixedPCFBufferHasIdentifier(data)){data+=4;size-=4;}
    flatbuffers::Verifier verifier(data,size);
    if(!data||size<8||!PCFBufferHasIdentifier(data)||!VerifyPCFBuffer(verifier))
        return prwError(error,"invalid-configuration: The configuration is not an SDS $PCF (plain or size-prefixed).");
    pcf=GetPCF(data);
    if(pcf->THEORY()!=pcfTheory::UNSPECIFIED&&pcf->THEORY()!=pcfTheory::FFM)
        return prwError(error,(std::string("configuration-refused:THEORY: propagate_oem flies FFM, not ")+EnumNamepcfTheory(pcf->THEORY())+".").c_str());
    const std::pair<bool,const char*> others[]={{pcf->INTEGRATOR()!=nullptr,"INTEGRATOR"},{pcf->FORCES()!=nullptr,"FORCES"},
        {pcf->FIT()!=nullptr,"FIT"},{pcf->EVENTS()!=nullptr,"EVENTS"},{pcf->EPOCH_STORE()!=nullptr,"EPOCH_STORE"}};
    for(const auto& table:others)if(table.first)
        return prwError(error,(std::string("configuration-refused:")+table.second+": The request's EXECUTION_REQUEST carries the dynamics; the $PCF names OUTPUT only.").c_str());
    return true;
}
} // namespace
bool processPrwOem(const uint8_t* data,size_t size,const uint8_t* configuration,size_t configurationSize,
                   const uint8_t* kernel,size_t kernelSize,const PrwEnvironment& environment,
                   std::vector<uint8_t>& output,std::string& error) {
    const PRW* root=nullptr;if(!verifyPrw(data,size,root,error))return false;
    const auto* request=root->EXECUTION_REQUEST();
    if(!request)return prwError(error,"invalid-prw-arm: propagate_oem requires EXECUTION_REQUEST.");
    if(request->SAMPLE_EPOCHS()&&request->SAMPLE_EPOCHS()->size())
        return prwError(error,"invalid-request: The $PCF OUTPUT names the epochs; the request carries no SAMPLE_EPOCHS.");
    if(request->EVENTS()&&request->EVENTS()->size())return prwError(error,"invalid-request: propagate_oem locates no EVENTS.");
    const PCF* pcf=nullptr;if(!readOutputConfiguration(configuration,configurationSize,pcf,error))return false;
    // The states leave in the request's axes: OUTPUT.FRAME names them.
    const auto frame=pcf->OUTPUT()?pcf->OUTPUT()->FRAME():pcfOutputFrame::UNSPECIFIED;
    const auto* axes=request->INITIAL()&&request->INITIAL()->COORDINATE_SYSTEM()?request->INITIAL()->COORDINATE_SYSTEM():nullptr;
    const bool gcrf=frame==pcfOutputFrame::GCRF&&axes&&axes->AXIS_TYPE()==rfmAxisType::ICRF;
    const bool eme2000=frame==pcfOutputFrame::EME2000&&axes&&axes->AXIS_TYPE()==rfmAxisType::MEAN_EQUATOR_EQUINOX_J2000;
    if(pcf->OUTPUT()&&!gcrf&&!eme2000)
        return prwError(error,(std::string("frame-unsupported:")+EnumNamepcfOutputFrame(frame)+": OUTPUT.FRAME is GCRF for a request in ICRF axes or EME2000 for one in mean J2000 axes.").c_str());
    if(request->FORCES()&&request->FORCES()->CENTRAL_BODY_NAIF_ID()!=399)
        return prwError(error,"unsupported-center: propagate_oem writes Earth-centered ephemerides.");
    std::vector<TTEpoch> grid;
    if(!outputGrid(pcf->OUTPUT(),grid,error))return false;
    // The request with the grid as its samples, its arc ending at the last.
    std::vector<std::string> epochs;epochs.reserve(grid.size());
    const auto utc=[](const std::string& iso){auto t=std::make_unique<TIMInstantT>();t->TIME_SYSTEM=timingStandard::UTC;t->EPOCH_FORMAT=timEpochRepresentation::ISO8601;t->ISO8601=iso;return t;};
    PRWT carried;carried.EXECUTION_REQUEST.reset(request->UnPack());
    for(const auto& t:grid){epochs.push_back(formatIsoSeconds(t));carried.EXECUTION_REQUEST->SAMPLE_EPOCHS.push_back(utc(epochs.back()));}
    carried.EXECUTION_REQUEST->TARGET_EPOCH=utc(epochs.back());
    std::vector<uint8_t> bytes,response;encodePrw(carried,bytes);
    if(!processPrwInvoke(bytes.data(),bytes.size(),kernel,kernelSize,environment,response,error))return false;
    const auto* result=GetSizePrefixedPRW(response.data())->EXECUTION_RESULT();
    if(!result||!result->SAMPLES()||result->SAMPLES()->size()!=grid.size())
        return prwError(error,"propagation-failed: The execution returned no state at every OUTPUT epoch.");
    // The $OEM: the samples' states (meters) in km and km/s at their UTC epochs.
    auto block=std::make_unique<ephemerisDataBlockT>();
    const auto* initial=request->INITIAL();
    if(initial->CATALOG_NUMBER()||initial->OBJECT_ID()) {
        block->OBJECT=std::make_unique<CATT>();block->OBJECT->NORAD_CAT_ID=initial->CATALOG_NUMBER();
        if(initial->OBJECT_ID())block->OBJECT->OBJECT_ID=initial->OBJECT_ID()->str();
    }
    block->CENTER_NAME="EARTH";block->CENTER_NAIF_ID=399;
    block->REFERENCE_FRAME=std::make_unique<RFMT>();block->REFERENCE_FRAME->NAME=gcrf?"GCRF":"EME2000";
    CelestialFrameWrapperT celestial;celestial.frame=gcrf?CelestialFrame::GCRF:CelestialFrame::EME2000;
    block->REFERENCE_FRAME->REFERENCE_FRAME.Set(std::move(celestial));
    block->TIME_SYSTEM=timingStandard::UTC;block->START_TIME=epochs.front();block->STOP_TIME=epochs.back();
    block->STATE_VECTOR_SIZE=6;
    for(size_t k=0;k<grid.size();++k) {
        const auto& s=*result->SAMPLES()->Get(k)->STATE()->STATE();
        auto line=std::make_unique<ephemerisDataLineT>();line->EPOCH=epochs[k];
        line->X=s.POSITION()->X()/1000;line->Y=s.POSITION()->Y()/1000;line->Z=s.POSITION()->Z()/1000;
        line->X_DOT=s.VELOCITY()->X()/1000;line->Y_DOT=s.VELOCITY()->Y()/1000;line->Z_DOT=s.VELOCITY()->Z()/1000;
        block->EPHEMERIS_DATA_LINES.push_back(std::move(line));
    }
    OEMT oem;oem.CCSDS_OEM_VERS=3.0;oem.ORIGINATOR="SDN";oem.EPHEMERIS_DATA_BLOCK.push_back(std::move(block));
    flatbuffers::FlatBufferBuilder builder;FinishOEMBuffer(builder,OEM::Pack(builder,&oem));
    output.assign(builder.GetBufferPointer(),builder.GetBufferPointer()+builder.GetSize());
    return true;
}
} // namespace ffm
